import {
  clearAllRecents,
  loadRecents,
  saveRecents,
  type RecentItem,
} from '@/application/zones/recents/recentsStore';
import type { QueueItem } from '@/application/zones/zoneManager';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ContentPort } from '@/ports/ContentPort';
import { detectLoxoneItemType, detectServiceFromAudiopath, decodeAudiopath } from '@/domain/loxone/audiopath';
import { bestEffort } from '@/shared/bestEffort';

const MAX_RECENTS = 5;
const MAX_DECODE_DEPTH = 4;
const CANONICAL_RE = /^([^:]+):\/\/([^/]+)\/(.+)$/;
function recentsEqual(next: RecentItem[], previous: RecentItem[]): boolean {
  if (next.length !== previous.length) {
    return false;
  }
  return next.every((item, index) => {
    const other = previous[index];
    if (!other) return false;
    return (
      item.audiopath === other.audiopath &&
      item.coverurl === other.coverurl &&
      item.owner === other.owner &&
      item.owner_id === other.owner_id &&
      item.service === other.service &&
      item.serviceType === other.serviceType &&
      item.title === other.title &&
      item.type === other.type &&
      (item.album ?? '') === (other.album ?? '') &&
      (item.artist ?? '') === (other.artist ?? '')
    );
  });
}

export class RecentsManager {
  private notifier: NotifierPort;
  private readonly recordLocks = new Map<number, Promise<void>>();
  private contentPort: ContentPort;

  constructor(notifier: NotifierPort, contentPort: ContentPort) {
    this.notifier = notifier;
    this.contentPort = contentPort;
  }

  public setNotifier(notifier: NotifierPort): void {
    this.notifier = notifier;
  }

  public decodeBase64Deep(value: string): string {
    let current = value;
    for (let i = 0; i < MAX_DECODE_DEPTH; i += 1) {
      const decoded = decodeAudiopath(current);
      if (decoded === current) {
        const idx = current.indexOf('b64_');
        if (idx < 0) break;
        const encoded = current.slice(idx + 4);
        try {
          current = current.slice(0, idx) + Buffer.from(encoded, 'base64').toString('utf-8');
        } catch {
          break;
        }
      } else {
        current = decoded;
      }
    }
    return current;
  }

  public toCanonicalAudiopath(value: string): string {
    const decoded = this.decodeBase64Deep(value);
    const canonical = decoded || value;
    const match = CANONICAL_RE.exec(canonical);
    if (match) {
      const [, provider, type, rest] = match;
      const restMatch = CANONICAL_RE.exec(rest);
      if (restMatch) {
        const [, innerProvider, innerType, innerRest] = restMatch;
        // Nested provider (e.g., spotify@bridge...:track:library://track/1234) — use inner for canonical key
        return `${innerProvider}:${innerType}:${innerRest}`;
      }
      if (rest.startsWith('library://')) {
        const [, innerType = 'track', innerRest = ''] = /^library:\/\/([^/]+)\/(.+)$/.exec(rest) || [];
        return `library:${innerType}:${innerRest || rest.replace(/^library:\/\//, '')}`;
      }
      return `${provider}:${type}:${rest}`;
    }
    return canonical;
  }

  public dedupeByCanonical(items: RecentItem[]): RecentItem[] {
    const seen = new Set<string>();
    const result: RecentItem[] = [];
    for (const item of items) {
      const key = this.toCanonicalAudiopath(item.audiopath);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  }

  public async get(zoneId: number) {
    const stored = await loadRecents(zoneId);
    return stored;
  }

  public async record(zoneId: number, item: QueueItem): Promise<void> {
    const previous = this.recordLocks.get(zoneId) ?? Promise.resolve();
    // Best-effort lock chain; avoid deadlock if a prior record failed.
    const next = bestEffort(() => previous, { fallback: undefined }).then(async () => {
      await this.performRecord(zoneId, item);
    });
    this.recordLocks.set(zoneId, next.finally(() => {
      if (this.recordLocks.get(zoneId) === next) {
        this.recordLocks.delete(zoneId);
      }
    }));
    return next;
  }

  public async performRecord(zoneId: number, item: QueueItem): Promise<void> {
    const storedRaw = await loadRecents(zoneId);
    const dedupedItems = this.dedupeByCanonical(storedRaw.items ?? []);
    const stored = { ...storedRaw, items: dedupedItems };
    if (dedupedItems.length !== (storedRaw.items ?? []).length) {
      // Clean up old duplicates eagerly.
      const ts = Math.floor(Date.now() / 1000);
      await saveRecents(zoneId, { ts, items: dedupedItems });
    }
    const service = this.resolveService(item.audiopath, item.user);
    const defaultSpotifyUser = this.contentPort.getDefaultSpotifyAccountId();
    const userForSpotify =
      service.service === 'spotify' && item.user && item.user !== 'nouser'
        ? item.user
        : service.service === 'spotify'
          ? defaultSpotifyUser ?? item.user ?? 'nouser'
          : item.user ?? 'nouser';
    const rawAudiopath =
      service.service === 'spotify' && userForSpotify && !item.audiopath.startsWith('spotify@')
        ? `spotify@${userForSpotify}:${item.audiopath.replace(/^spotify:/i, '')}`
        : item.audiopath;
    const audiopath = this.normalizeAppleMusicAudiopath(rawAudiopath);
    const canonicalAudiopath = this.toCanonicalAudiopath(audiopath);
    // Best-effort metadata lookup; missing metadata should not block recents.
    let meta = await bestEffort(() => this.contentPort.resolveMetadata(canonicalAudiopath), {
      fallback: null,
    });
    if (!meta) {
      const decoded = decodeAudiopath(canonicalAudiopath);
      if (decoded && decoded !== canonicalAudiopath) {
        meta = await bestEffort(() => this.contentPort.resolveMetadata(decoded), { fallback: null });
      }
    }
    const matchesAudiopath = (candidate: RecentItem): boolean => {
      const candidateCanonical = this.toCanonicalAudiopath(candidate.audiopath);
      return candidateCanonical === canonicalAudiopath;
    };
    const existing = stored.items.find((existingItem) => matchesAudiopath(existingItem));
    const merged = (field: keyof typeof entry): any => {
      const candidate = entry[field];
      if (candidate !== undefined && candidate !== '') return candidate;
      const fallbackExisting = existing?.[field];
      if (fallbackExisting !== undefined && fallbackExisting !== '') return fallbackExisting;
      return undefined;
    };

    const metaTitle = (meta?.title ?? '').trim();
    const safeTitle = (() => {
      const candidate = (item.title ?? '').trim();
      if (metaTitle) return metaTitle;
      if (candidate) return candidate;
      return '';
    })();
    const ownerBase =
      service.service === 'musicassistant'
        ? 'musicassistant'
        : userForSpotify ?? item.artist ?? meta?.artist ?? '';
    const preferredAudiopath = existing?.audiopath ?? audiopath;
    const entry = {
      audiopath: preferredAudiopath,
      coverurl: item.coverurl ?? meta?.coverurl ?? '',
      owner: ownerBase,
      owner_id: ownerBase,
      service: service.service,
      serviceType: service.serviceType,
      title: safeTitle && !safeTitle.toLowerCase().startsWith('spotify:') && !safeTitle.toLowerCase().startsWith('spotify@')
        ? safeTitle
        : '',
      type: service.type,
      album: item.album ?? meta?.album ?? '',
      artist: item.artist ?? meta?.artist ?? '',
    };

    // Merge with existing entry to avoid wiping metadata when replaying an old recent.
    const mergedEntry = {
      ...existing,
      ...entry,
      coverurl: merged('coverurl') ?? '',
      title: merged('title') ?? '',
      album: merged('album') ?? '',
      artist: merged('artist') ?? '',
      owner: merged('owner') ?? '',
      owner_id: merged('owner_id') ?? '',
    };

    const filtered = stored.items.filter((existingItem) => !matchesAudiopath(existingItem));
    const dedupedNew = this.dedupeByCanonical([mergedEntry, ...filtered]);
    const items = dedupedNew.slice(0, MAX_RECENTS);
    // Avoid rewriting storage or emitting websocket events when nothing changed.
    if (recentsEqual(items, stored.items)) {
      return;
    }
    const ts = Math.floor(Date.now() / 1000);
    await saveRecents(zoneId, { ts, items });
    this.notifier.notifyRecentlyPlayedChanged(zoneId, ts);
  }

  public resolveService(
    audiopath: string,
    user?: string,
  ): { service: string; serviceType: number; type: number } {
    const lower = (audiopath || '').toLowerCase();
    if (lower.includes('musicassistant')) {
      const loxType = detectLoxoneItemType(audiopath, 'musicassistant');
      const type = loxType === 'musicassistant_album' ? 7 : 2;
      // Expose as spotify for Loxone compatibility, but keep type from MA.
      return { service: 'spotify', serviceType: 3, type };
    }
    const detectedService = detectServiceFromAudiopath(audiopath);
    if (lower.startsWith('linein:')) {
      return { service: 'linein', serviceType: 99, type: 6 };
    }
    if (detectedService === 'musicassistant') {
      const loxType = detectLoxoneItemType(audiopath, 'musicassistant');
      const type = loxType === 'musicassistant_album' ? 7 : 2;
      return { service: 'musicassistant', serviceType: 3, type };
    }
    if (detectedService === 'library') {
      return { service: 'library', serviceType: 2, type: 2 };
    }
    if (detectedService === 'spotify' || lower.startsWith('spotify:') || lower.startsWith('spotify@')) {
      const type = lower.includes(':album:') ? 7 : 2;
      return { service: 'spotify', serviceType: 3, type };
    }
    if (detectedService === 'applemusic') {
      const type = lower.includes('album') ? 7 : 2;
      return { service: 'spotify', serviceType: 3, type };
    }
    if (detectedService === 'deezer') {
      const type = lower.includes('album') ? 7 : 2;
      return { service: 'spotify', serviceType: 3, type };
    }
    if (detectedService === 'tidal') {
      const type = lower.includes('album') ? 7 : 2;
      return { service: 'spotify', serviceType: 3, type };
    }
    return { service: 'custom', serviceType: 3, type: 3 };
  }

  public normalizeAppleMusicAudiopath(audiopath: string): string {
    const detectedService = detectServiceFromAudiopath(audiopath);
    if (detectedService !== 'applemusic') {
      return audiopath;
    }
    return audiopath.replace(/:library-track:/i, ':track:');
  }

  public async clearAll(): Promise<void> {
    await clearAllRecents();
  }

  public async clear(zoneId: number): Promise<void> {
    const ts = Math.floor(Date.now() / 1000);
    await saveRecents(zoneId, { ts, items: [] });
    this.notifier.notifyRecentlyPlayedChanged(zoneId, ts);
  }
}

type RecentsManagerDeps = {
  notifier: NotifierPort;
  contentPort: ContentPort;
};

export function createRecentsManager(deps: RecentsManagerDeps): RecentsManager {
  return new RecentsManager(deps.notifier, deps.contentPort);
}
