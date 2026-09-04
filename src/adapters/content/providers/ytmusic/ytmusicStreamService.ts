import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { StreamingServiceConfig } from '@/domain/config/types';
import type { PlaybackSource } from '@/application/playback/audioManager';
import { decodeAudiopath, parseServiceNativeAudiopath } from '@/domain/zones/audiopath';
import { slugFromBridgeId } from '@/domain/media/serviceIdentity';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { convertCookieToNetscape } from '@/adapters/content/providers/ytmusic/ytmusicCookie';
import { buildProxyUrl } from '@/shared/urlProxy';
import { potPluginArgs } from '@/adapters/content/providers/ytmusic/ytdlpPotProvider';
import {
  normalizePotServerUrl,
  pingPotServer,
  potExtractorArgs,
} from '@/adapters/content/providers/ytmusic/ytmusicPoToken';
import {
  buildYtMusicWatchUrl,
  extractVideoId,
  runYtDlp,
  type YtDlpExecOptions,
  YtDlpError,
} from '@/adapters/content/providers/ytmusic/ytmusicYtDlp';

type YtMusicPlaybackResult = {
  playbackSource: PlaybackSource | null;
  outputOnly?: boolean;
};

type YtMusicTrackRequest = {
  providerId: string;
  videoId: string;
  bridge: StreamingServiceConfig;
};

type OutputErrorHandler = (zoneId: number, reason?: string) => void;

export class YtMusicStreamService {
  private readonly log = createLogger('Content', 'YTMusicStream');
  private readonly bridgesByProvider = new Map<string, StreamingServiceConfig>();
  private readonly bridgesById = new Map<string, StreamingServiceConfig>();
  private readonly configPort: ConfigPort;
  private readonly cookieFilesByBridgeId = new Map<string, { cookie: string; path: string }>();
  private readonly streamCache = new Map<string, { playbackSource: PlaybackSource; expiresAt: number }>();
  private streamCachePruneCounter = 0;
  private readonly streamCacheMaxEntries = 200;
  private readonly warmupStateByBridgeId = new Map<
    string,
    { signature: string; inflight?: Promise<void>; lastOkAt?: number; lastErrorAt?: number }
  >();

  private readonly warmupVideoId = 'dQw4w9WgXcQ';
  /** Last reason the PO Token path was skipped, per bridge, so it is logged on change only. */
  private readonly potUnusableWarned = new Map<string, string>();

  constructor(private readonly notifyOutputError: OutputErrorHandler, configPort: ConfigPort) {
    this.configPort = configPort;
  }

  public configureFromConfig(): void {
    this.bridgesByProvider.clear();
    this.bridgesById.clear();
    // Cookie files and cache entries are keyed by bridge id; keep them so playback isn't disrupted
    // across config refreshes (cookie updates will rewrite the file on demand).
    const bridges = this.configPort.getConfig().content?.streamingServices ?? [];
    const ytmusicBridges = bridges.filter((b) => (b.provider || '').toLowerCase() === 'ytmusic');
    const single = ytmusicBridges.length <= 1;
    for (const bridge of ytmusicBridges) {
      const providerId = `spotify@${bridge.id}`;
      this.bridgesByProvider.set(providerId, bridge);
      this.bridgesById.set(bridge.id, bridge);
      // Also index under the SERVICE-NATIVE prefix the provider now emits, so a
      // `ytmusic[:<slug>]:track:...` audiopath resolves to its bridge. Cookie files and
      // cache stay keyed by bridge.id (below/elsewhere); this only adds provider-map keys.
      const slug = slugFromBridgeId(bridge.id, 'ytmusic');
      this.bridgesByProvider.set(`ytmusic:${slug}`, bridge);
      if (single) {
        this.bridgesByProvider.set('ytmusic', bridge);
      }
      this.scheduleWarmup(bridge);
    }
  }

  public isYtMusicProvider(providerId: string): boolean {
    if (!providerId) return false;
    if (this.bridgesByProvider.has(providerId)) return true;
    const id = providerId.split('@')[1] ?? providerId;
    if (this.bridgesById.has(id)) return true;
    return providerId.toLowerCase().includes('ytmusic');
  }

  public async startStreamForAudiopath(
    zoneId: number | undefined,
    audiopath: string,
    options?: { suppressErrors?: boolean },
  ): Promise<YtMusicPlaybackResult> {
    const suppressErrors = options?.suppressErrors === true;
    const request = await this.parseTrackRequest(audiopath);
    if (!request) {
      this.log.warn('ytmusic stream request unresolved', { zoneId, audiopath });
      this.reportPlaybackError(zoneId, 'ytmusic invalid request', suppressErrors);
      return { playbackSource: null };
    }
    const cacheKey = `${request.bridge.id}:${request.videoId}`;
    const cached = this.streamCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return { playbackSource: cached.playbackSource };
    }

    const cookieFile = await this.ensureCookieFile(request.bridge);
    try {
      this.log.debug('ytmusic stream resolve start', {
        zoneId,
        providerId: request.providerId,
        hasCookie: Boolean(cookieFile),
      });
      const watchUrl = buildYtMusicWatchUrl(request.videoId);
      const buildArgs = (withCookies: boolean, extra: string[] = []): string[] => [
        '-g',
        '--js-runtimes',
        'node',
        '--no-playlist',
        '--no-warnings',
        '--skip-download',
        '-f',
        'bestaudio/best',
        ...extra,
        ...(withCookies ? this.buildCookieArgs(cookieFile) : []),
        watchUrl,
      ];

      // Ordered attempts, best first, each a complete way to get a url.
      //
      // The `web_music` client leads when it can work at all, because it is the only
      // one that serves a Premium account its 256k stream (itag 141) and the only one
      // that sees account-only content — but it hands out no formats whatsoever
      // without a proof-of-origin token, so it is offered only once the PO Token
      // server has actually answered.
      //
      // Anonymous comes next, and stays ahead of the plain signed-in attempt.
      // Measured against a real account: a cookied extraction yields a TVHTML5 url
      // that googlevideo answers 403 to for its first ~45 seconds (6 of 6 immediate
      // tries, on two separate tracks), while the anonymous one is served straight
      // away (6 of 6) — so asking with cookies handed ffmpeg a url that was dead on
      // arrival, and the track died on opening. Cookies still earn their keep for
      // anything not reachable anonymously, so that attempt stays, last.
      const attempts: Array<{ label: string; args: string[] }> = [];
      const potArgs = await this.potAttemptArgs(request.bridge, cookieFile);
      if (potArgs) {
        attempts.push({ label: 'web_music+po-token', args: buildArgs(true, potArgs) });
      }
      attempts.push({ label: 'anonymous', args: buildArgs(false) });
      if (cookieFile) {
        attempts.push({ label: 'signed-in', args: buildArgs(true) });
      }

      // One loop covers both ways an attempt comes up short: a yt-dlp that fails
      // outright, and one that exits cleanly having printed nothing (private or
      // otherwise account-only content). Both used to need their own fallback block,
      // and the second was easy to forget — it is the same "try the next way" either.
      let url = '';
      let lastError: unknown = null;
      for (const [index, attempt] of attempts.entries()) {
        try {
          const { stdout } = await runYtDlp(attempt.args, this.execOptions());
          url = pickLastNonEmptyLine(stdout);
        } catch (err) {
          lastError = err;
          url = '';
        }
        if (url) {
          if (index > 0) {
            this.log.debug('ytmusic stream resolved on fallback', {
              zoneId,
              providerId: request.providerId,
              attempt: attempt.label,
            });
          }
          break;
        }
        this.log.debug('ytmusic stream attempt came up empty', {
          zoneId,
          providerId: request.providerId,
          attempt: attempt.label,
        });
      }
      if (!url && lastError) {
        throw lastError;
      }
      if (!url) {
        this.reportPlaybackError(zoneId, 'ytmusic stream url unavailable', suppressErrors);
        return { playbackSource: null };
      }
      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-us,en;q=0.5',
        Referer: 'https://music.youtube.com/',
      };

      // ffmpeg-static builds in minimal images can lack DNS; always route external URLs through the local proxy.
      const proxiedUrl = buildProxyUrl(url, headers);
      const playbackSource: PlaybackSource = {
        kind: 'url',
        url: proxiedUrl ?? url,
        headers: proxiedUrl ? undefined : headers,
        restartOnFailure: true,
      };

      this.rememberStreamCache(cacheKey, playbackSource);
      return {
        playbackSource: {
          ...playbackSource,
        },
      };
    } catch (err) {
      if (err instanceof YtDlpError) {
        this.log.warn('ytmusic stream resolve failed (yt-dlp)', {
          zoneId,
          providerId: request.providerId,
          stderr: err.stderr || undefined,
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn('ytmusic stream resolve failed', { zoneId, providerId: request.providerId, message });
      }
      this.reportPlaybackError(zoneId, 'ytmusic stream unavailable', suppressErrors);
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

  private async parseTrackRequest(audiopath: string): Promise<YtMusicTrackRequest | null> {
    const raw = String(audiopath || '');
    const native = parseServiceNativeAudiopath(raw);
    let providerKey: string;
    let type: string;
    let rawId: string;
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
    const decodedId = decodeAudiopath(rawId);
    const idValue = decodedId || rawId;
    if (!providerKey || !idValue) return null;
    if (type !== 'track') return null;

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

  /**
   * The extra yt-dlp args for the PO Token attempt, or null when it cannot work.
   *
   * Both halves have to be in place, and neither announces itself when missing: with
   * no plugin installed yt-dlp ignores the `youtubepot-bgutilhttp` args silently, and
   * with no server answering the plugin has nothing to ask. Either way `web_music`
   * comes back with no formats — so this refuses to queue an attempt that is already
   * known to be pointless, rather than spending a 20 second yt-dlp run discovering it
   * again before every track.
   */
  private async potAttemptArgs(
    bridge: StreamingServiceConfig,
    cookieFile: string | null,
  ): Promise<string[] | null> {
    const url = normalizePotServerUrl(bridge.ytmusicPoTokenUrl);
    if (!url) return null;
    // Without a cookie there is nothing to gain: `web_music` anonymously resolves to
    // a plain 128k AAC stream, where the default clients already give opus at a
    // higher bitrate. The upgrade this path buys belongs to a signed-in account.
    if (!cookieFile) return null;

    const pluginArgs = await potPluginArgs();
    if (pluginArgs.length === 0) {
      this.warnPotUnusableOnce(bridge.id, 'the PO Token provider plugin for yt-dlp is not installed');
      return null;
    }
    const ping = await pingPotServer(url);
    if (!ping.ok) {
      this.warnPotUnusableOnce(bridge.id, `PO Token server not reachable at ${url} (${ping.error ?? 'no answer'})`);
      return null;
    }
    this.potUnusableWarned.delete(bridge.id);
    return [...pluginArgs, ...potExtractorArgs(url)];
  }

  private warnPotUnusableOnce(bridgeId: string, reason: string): void {
    if (this.potUnusableWarned.get(bridgeId) === reason) return;
    this.potUnusableWarned.set(bridgeId, reason);
    this.log.warn('ytmusic PO Token path unavailable; falling back', { bridgeId, reason });
  }

  private scheduleWarmup(bridge: StreamingServiceConfig): void {
    // Best-effort only. We do it on config refresh so the first real playback is fast.
    // Avoid piling on multiple warmups for the same cookie.
    const cookie = typeof bridge?.ytmusicCookie === 'string' ? bridge.ytmusicCookie.trim() : '';
    const signature = crypto.createHash('sha256').update(cookie).digest('hex');
    const existing = this.warmupStateByBridgeId.get(bridge.id);
    if (existing && existing.signature === signature && (existing.inflight || existing.lastOkAt)) {
      return;
    }
    if (existing && existing.signature === signature && existing.lastErrorAt && Date.now() - existing.lastErrorAt < 60_000) {
      // Don't spam warmup if it's failing repeatedly (network, rate limits, etc.).
      return;
    }

    const runner = async (): Promise<void> => {
      const startedAt = Date.now();
      try {
        // Anonymously, like playback itself now resolves — a warmup down a path no
        // real request takes would prime the wrong caches and hide its own failures.
        const args = [
          '-g',
          '--js-runtimes',
          'node',
          '--no-playlist',
          '--no-warnings',
          '--skip-download',
          '-f',
          'bestaudio/best',
          buildYtMusicWatchUrl(this.warmupVideoId),
        ];
        await runYtDlp(args, { timeoutMs: 25_000 });
        const tookMs = Date.now() - startedAt;
        this.log.debug('ytmusic warmup ok', { bridgeId: bridge.id, tookMs });
        const entry = this.warmupStateByBridgeId.get(bridge.id);
        if (entry && entry.signature === signature) {
          entry.lastOkAt = Date.now();
          delete entry.inflight;
        }
      } catch (err) {
        const tookMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        this.log.debug('ytmusic warmup failed', { bridgeId: bridge.id, tookMs, message });
        const entry = this.warmupStateByBridgeId.get(bridge.id);
        if (entry && entry.signature === signature) {
          entry.lastErrorAt = Date.now();
          delete entry.inflight;
        }
      }
    };

    // Run warmup asynchronously; never block server init or provider refresh.
    const entry = { signature } as { signature: string; inflight?: Promise<void>; lastOkAt?: number; lastErrorAt?: number };
    // Placeholder so rapid config refreshes don't schedule multiple warmups.
    entry.inflight = Promise.resolve();
    this.warmupStateByBridgeId.set(bridge.id, entry);
    const timeout = setTimeout(() => {
      const p = runner();
      entry.inflight = p;
      void p;
    }, 0);
    timeout.unref?.();
  }

  private async ensureCookieFile(bridge: StreamingServiceConfig): Promise<string | null> {
    const cookie = typeof bridge?.ytmusicCookie === 'string' ? bridge.ytmusicCookie.trim() : '';
    if (!cookie) {
      return null;
    }
    const existing = this.cookieFilesByBridgeId.get(bridge.id);
    if (existing && existing.cookie === cookie) {
      return existing.path;
    }
    const content = convertCookieToNetscape(cookie, '.youtube.com');
    const safeBridgeId = String(bridge.id || 'bridge').replace(/[^a-zA-Z0-9_-]/g, '_');
    const tmpPath = path.join('/tmp', `lox-ytmusic-cookies-${safeBridgeId}.txt`);
    await fsp.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    this.cookieFilesByBridgeId.set(bridge.id, { cookie, path: tmpPath });
    return tmpPath;
  }

  private buildCookieArgs(cookieFile: string | null): string[] {
    if (!cookieFile) return [];
    return ['--cookies', cookieFile];
  }

  private rememberStreamCache(cacheKey: string, playbackSource: PlaybackSource): void {
    const expiresAt = this.estimateStreamExpiryMs(playbackSource);
    this.streamCache.set(cacheKey, { playbackSource, expiresAt });
    this.pruneStreamCache();
  }

  private estimateStreamExpiryMs(source: PlaybackSource): number {
    const now = Date.now();
    const softTtlMs = 2 * 60_000;
    if (source.kind !== 'url') {
      return now + softTtlMs;
    }
    try {
      const parsed = new URL(this.unwrapProxyUrl(source.url));
      const exp = parsed.searchParams.get('expire');
      const expSec = exp ? Number(exp) : NaN;
      if (Number.isFinite(expSec) && expSec > 0) {
        // `expire` says roughly six hours, and this used to trust it — so a track played
        // once handed the very same url to every later play for the rest of the day.
        // That is the shape of the failure left standing: the tracks that never work are
        // the ones with an entry here, while the same track resolved fresh streams fine.
        // The cache is only worth the ~2s a yt-dlp resolve costs, and it only has to
        // survive a retry of the attempt that filled it, so cap it there rather than
        // believing a deadline that clearly outlives what the url can actually do.
        const cap = now + 60_000;
        return Math.min(cap, Math.max(now + 10_000, Math.round(expSec * 1000) - 30_000));
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
      if (now >= v.expiresAt) {
        this.streamCache.delete(k);
      }
    }
    if (this.streamCache.size <= this.streamCacheMaxEntries) return;
    // Drop oldest entries (in insertion order).
    const over = this.streamCache.size - this.streamCacheMaxEntries;
    let dropped = 0;
    for (const k of this.streamCache.keys()) {
      this.streamCache.delete(k);
      dropped += 1;
      if (dropped >= over) break;
    }
  }
}

function pickLastNonEmptyLine(stdout: string): string {
  const lines = String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1]! : '';
}
