import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { StreamingServiceConfig } from '@/domain/config/types';
import type { PlaybackSource } from '@/application/playback/audioManager';
import { decodeAudiopath, parseServiceNativeAudiopath } from '@/domain/zones/audiopath';
import { slugFromBridgeId } from '@/domain/media/serviceIdentity';
import { buildProxyUrl } from '@/shared/urlProxy';
import {
  extractVideoId,
  runYtDlp,
  type YtDlpExecOptions,
  YtDlpError,
} from '@/adapters/content/providers/ytmusic/ytmusicYtDlp';

function buildYoutubeWatchUrl(videoId: string): string {
  const url = new URL('https://www.youtube.com/watch');
  url.searchParams.set('v', String(videoId || '').trim());
  return url.toString();
}

type YoutubePlaybackResult = {
  playbackSource: PlaybackSource | null;
  outputOnly?: boolean;
};

type YoutubeTrackRequest = {
  providerId: string;
  videoId: string;
  bridge: StreamingServiceConfig;
};

type OutputErrorHandler = (zoneId: number, reason?: string) => void;

export class YoutubeStreamService {
  private readonly log = createLogger('Content', 'YoutubeStream');
  private readonly bridgesByProvider = new Map<string, StreamingServiceConfig>();
  private readonly bridgesById = new Map<string, StreamingServiceConfig>();
  private readonly configPort: ConfigPort;
  private readonly streamCache = new Map<string, { playbackSource: PlaybackSource; expiresAt: number }>();
  private streamCachePruneCounter = 0;
  private readonly streamCacheMaxEntries = 200;
  private warmupDone = false;
  // Arbitrary public video used to prime yt-dlp's player JS cache on startup;
  // the actual video played to the user is irrelevant — we only need *some*
  // working watch URL so yt-dlp's first cold-cache resolve isn't on the play path.
  private readonly warmupVideoId = 'dQw4w9WgXcQ';

  constructor(private readonly notifyOutputError: OutputErrorHandler, configPort: ConfigPort) {
    this.configPort = configPort;
  }

  public configureFromConfig(): void {
    this.bridgesByProvider.clear();
    this.bridgesById.clear();
    const bridges = this.configPort.getConfig().content?.streamingServices ?? [];
    const youtubeBridges = bridges.filter((b) => (b.provider || '').toLowerCase() === 'youtube');
    const single = youtubeBridges.length <= 1;
    for (const bridge of youtubeBridges) {
      const providerId = `spotify@${bridge.id}`;
      this.bridgesByProvider.set(providerId, bridge);
      this.bridgesById.set(bridge.id, bridge);
      // Also index under the SERVICE-NATIVE prefix the provider now emits, so a
      // `youtube[:<slug>]:track:...` audiopath resolves to its bridge.
      const slug = slugFromBridgeId(bridge.id, 'youtube');
      this.bridgesByProvider.set(`youtube:${slug}`, bridge);
      if (single) {
        this.bridgesByProvider.set('youtube', bridge);
      }
    }
    if (this.bridgesByProvider.size > 0 && !this.warmupDone) {
      this.scheduleWarmup();
    }
  }

  public isYoutubeProvider(providerId: string): boolean {
    if (!providerId) return false;
    if (this.bridgesByProvider.has(providerId)) return true;
    const id = providerId.split('@')[1] ?? providerId;
    return this.bridgesById.has(id);
  }

  public async startStreamForAudiopath(
    zoneId: number | undefined,
    audiopath: string,
    options?: { suppressErrors?: boolean },
  ): Promise<YoutubePlaybackResult> {
    const suppressErrors = options?.suppressErrors === true;
    const request = this.parseTrackRequest(audiopath);
    if (!request) {
      this.log.warn('youtube stream request unresolved', { zoneId, audiopath });
      this.reportPlaybackError(zoneId, 'youtube invalid request', suppressErrors);
      return { playbackSource: null };
    }
    const cacheKey = `${request.bridge.id}:${request.videoId}`;
    const cached = this.streamCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return { playbackSource: cached.playbackSource };
    }

    try {
      this.log.debug('youtube stream resolve start', { zoneId, providerId: request.providerId });
      const watchUrl = buildYoutubeWatchUrl(request.videoId);
      const args = [
        '-g',
        '--js-runtimes',
        'node',
        '--no-playlist',
        '--no-warnings',
        '--skip-download',
        '-f',
        'bestaudio/best',
        watchUrl,
      ];
      const { stdout } = await runYtDlp(args, this.execOptions());
      const url = pickLastNonEmptyLine(stdout);
      if (!url) {
        this.reportPlaybackError(zoneId, 'youtube stream url unavailable', suppressErrors);
        return { playbackSource: null };
      }
      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-us,en;q=0.5',
        Referer: 'https://www.youtube.com/',
      };
      const proxiedUrl = buildProxyUrl(url, headers);
      const playbackSource: PlaybackSource = {
        kind: 'url',
        url: proxiedUrl ?? url,
        headers: proxiedUrl ? undefined : headers,
        restartOnFailure: true,
      };
      this.rememberStreamCache(cacheKey, playbackSource);
      return { playbackSource: { ...playbackSource } };
    } catch (err) {
      if (err instanceof YtDlpError) {
        this.log.warn('youtube stream resolve failed (yt-dlp)', {
          zoneId,
          providerId: request.providerId,
          stderr: err.stderr || undefined,
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn('youtube stream resolve failed', { zoneId, providerId: request.providerId, message });
      }
      this.reportPlaybackError(zoneId, 'youtube stream unavailable', suppressErrors);
      return { playbackSource: null };
    }
  }

  private reportPlaybackError(zoneId: number | undefined, reason: string, suppressErrors = false): void {
    if (suppressErrors) return;
    // No zone to route the error to (ephemeral/non-zone requester) — stay silent.
    if (zoneId == null) return;
    const trimmed = reason.trim();
    if (!trimmed) return;
    this.notifyOutputError(zoneId, trimmed);
  }

  private parseTrackRequest(audiopath: string): YoutubeTrackRequest | null {
    const raw = String(audiopath || '');
    const native = parseServiceNativeAudiopath(raw);
    let providerKey: string; let type: string; let rawId: string;
    if (native) {
      providerKey = native.slug ? `${native.service}:${native.slug}` : native.service;
      type = native.isLibrary ? `library-${native.kind}` : native.kind;
      rawId = native.id;
    } else {
      const parts = raw.split(':');
      if (parts.length < 3) return null;
      providerKey = parts[0] ?? '';
      type = (parts[1] ?? '').toLowerCase();
      rawId = parts.slice(2).join(':').trim();
    }
    const idValue = decodeAudiopath(rawId) || rawId;
    if (!providerKey || !idValue || type !== 'track') return null;
    const bridge =
      this.bridgesByProvider.get(providerKey) ??
      this.bridgesById.get(providerKey.split('@')[1] ?? '') ??
      null;
    if (!bridge) return null;
    const videoId = extractVideoId(idValue);
    if (!videoId) return null;
    return { providerId: providerKey, videoId, bridge };
  }

  private execOptions(): YtDlpExecOptions {
    return { timeoutMs: 20_000 };
  }

  private scheduleWarmup(): void {
    const timeout = setTimeout(() => {
      void (async () => {
        const startedAt = Date.now();
        try {
          const args = [
            '-g', '--js-runtimes', 'node', '--no-playlist', '--no-warnings',
            '--skip-download', '-f', 'bestaudio/best',
            buildYoutubeWatchUrl(this.warmupVideoId),
          ];
          await runYtDlp(args, { timeoutMs: 25_000 });
          this.warmupDone = true;
          this.log.debug('youtube warmup ok', { tookMs: Date.now() - startedAt });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.debug('youtube warmup failed', { tookMs: Date.now() - startedAt, message });
        }
      })();
    }, 0);
    timeout.unref?.();
  }

  private rememberStreamCache(cacheKey: string, playbackSource: PlaybackSource): void {
    const expiresAt = this.estimateStreamExpiryMs(playbackSource);
    this.streamCache.set(cacheKey, { playbackSource, expiresAt });
    this.pruneStreamCache();
  }

  private estimateStreamExpiryMs(source: PlaybackSource): number {
    const now = Date.now();
    const softTtlMs = 2 * 60_000;
    if (source.kind !== 'url') return now + softTtlMs;
    try {
      const parsed = new URL(this.unwrapProxyUrl(source.url));
      const exp = parsed.searchParams.get('expire');
      const expSec = exp ? Number(exp) : NaN;
      if (Number.isFinite(expSec) && expSec > 0) {
        return Math.max(now + 10_000, Math.round(expSec * 1000) - 30_000);
      }
    } catch {
      /* ignore */
    }
    return now + softTtlMs;
  }

  private unwrapProxyUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.pathname === '/streams/proxy') {
        const upstream = parsed.searchParams.get('u');
        if (upstream) return upstream;
      }
    } catch {
      /* ignore */
    }
    return url;
  }

  private pruneStreamCache(): void {
    this.streamCachePruneCounter += 1;
    if (this.streamCachePruneCounter % 25 !== 0) return;
    const now = Date.now();
    for (const [k, v] of this.streamCache) {
      if (now >= v.expiresAt) this.streamCache.delete(k);
    }
    if (this.streamCache.size <= this.streamCacheMaxEntries) return;
    const over = this.streamCache.size - this.streamCacheMaxEntries;
    let dropped = 0;
    for (const k of this.streamCache.keys()) {
      this.streamCache.delete(k);
      if (++dropped >= over) break;
    }
  }
}

function pickLastNonEmptyLine(stdout: string): string {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1]! : '';
}
