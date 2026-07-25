import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SpotifyBridgeConfig } from '@/domain/config/types';
import type { PlaybackSource } from '@/application/playback/audioManager';
import { decodeAudiopath } from '@/domain/loxone/audiopath';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { convertCookieToNetscape } from '@/adapters/content/providers/ytmusic/ytmusicCookie';
import { buildProxyUrl } from '@/shared/urlProxy';
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
  bridge: SpotifyBridgeConfig;
};

type OutputErrorHandler = (zoneId: number, reason?: string) => void;

export class YtMusicStreamService {
  private readonly log = createLogger('Content', 'YTMusicStream');
  private readonly bridgesByProvider = new Map<string, SpotifyBridgeConfig>();
  private readonly bridgesById = new Map<string, SpotifyBridgeConfig>();
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

  constructor(private readonly notifyOutputError: OutputErrorHandler, configPort: ConfigPort) {
    this.configPort = configPort;
  }

  public configureFromConfig(): void {
    this.bridgesByProvider.clear();
    this.bridgesById.clear();
    // Cookie files and cache entries are keyed by bridge id; keep them so playback isn't disrupted
    // across config refreshes (cookie updates will rewrite the file on demand).
    const bridges = this.configPort.getConfig().content?.spotify?.bridges ?? [];
    for (const bridge of bridges) {
      const provider = (bridge.provider || '').toLowerCase();
      if (provider !== 'ytmusic') continue;
      const providerId = `spotify@${bridge.id}`;
      this.bridgesByProvider.set(providerId, bridge);
      this.bridgesById.set(bridge.id, bridge);
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
      const buildArgs = (withCookies: boolean): string[] => [
        '-g',
        '--js-runtimes',
        'node',
        '--no-playlist',
        '--no-warnings',
        '--skip-download',
        '-f',
        'bestaudio/best',
        ...(withCookies ? this.buildCookieArgs(cookieFile) : []),
        watchUrl,
      ];
      let url = '';
      try {
        const { stdout } = await runYtDlp(buildArgs(true), this.execOptions());
        url = pickLastNonEmptyLine(stdout);
      } catch (err) {
        // Cookied requests can hit "Requested format is not available" because the
        // signed-in player client demands a PO token. Public audio formats are still
        // reachable without cookies, so retry once unauthenticated.
        const stderr = err instanceof YtDlpError ? err.stderr : '';
        const formatUnavailable = /Requested format is not available/i.test(stderr);
        if (!cookieFile || !formatUnavailable) {
          throw err;
        }
        this.log.debug('ytmusic stream retrying without cookies', {
          zoneId,
          providerId: request.providerId,
        });
        const { stdout } = await runYtDlp(buildArgs(false), this.execOptions());
        url = pickLastNonEmptyLine(stdout);
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
    const parts = raw.split(':');
    if (parts.length < 3) return null;
    const providerId = parts[0] ?? '';
    const type = (parts[1] ?? '').toLowerCase();
    const rawId = parts.slice(2).join(':').trim();
    const decodedId = decodeAudiopath(rawId);
    const idValue = decodedId || rawId;
    if (!providerId || !idValue) return null;
    if (type !== 'track') return null;

    const bridge =
      this.bridgesByProvider.get(providerId) ??
      this.bridgesById.get(providerId.split('@')[1] ?? '') ??
      null;
    if (!bridge) return null;

    const videoId = extractVideoId(idValue);
    if (!videoId) return null;
    return { providerId, videoId, bridge };
  }

  private execOptions(): YtDlpExecOptions {
    return { timeoutMs: 20_000 };
  }

  private scheduleWarmup(bridge: SpotifyBridgeConfig): void {
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
        const cookieFile = await this.ensureCookieFile(bridge);
        const args = [
          '-g',
          '--js-runtimes',
          'node',
          '--no-playlist',
          '--no-warnings',
          '--skip-download',
          '-f',
          'bestaudio/best',
          ...this.buildCookieArgs(cookieFile),
          buildYtMusicWatchUrl(this.warmupVideoId),
        ];
        await runYtDlp(args, { timeoutMs: 25_000 });
        const tookMs = Date.now() - startedAt;
        this.log.debug('ytmusic warmup ok', { bridgeId: bridge.id, tookMs, hasCookie: Boolean(cookieFile) });
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

  private async ensureCookieFile(bridge: SpotifyBridgeConfig): Promise<string | null> {
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
        // Keep a small safety margin; googlevideo URLs expire.
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
