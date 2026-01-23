import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SpotifyBridgeConfig } from '@/domain/config/types';
import type { PlaybackSource } from '@/application/playback/audioManager';
import { decodeAudiopath } from '@/domain/loxone/audiopath';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

const TIDAL_API_BASE = 'https://api.tidal.com/v1';

type TidalPlaybackResult = {
  playbackSource: PlaybackSource | null;
  outputOnly?: boolean;
};

type TidalTrackRequest = {
  providerId: string;
  trackId: string;
  bridge: SpotifyBridgeConfig;
};

type OutputErrorHandler = (zoneId: number, reason?: string) => void;

type TidalProxySession = {
  id: string;
  manifest: string;
  mimeType: string;
  createdAt: number;
};

export class TidalStreamService {
  private readonly log = createLogger('Content', 'TidalStream');
  private readonly bridgesByProvider = new Map<string, SpotifyBridgeConfig>();
  private readonly bridgesById = new Map<string, SpotifyBridgeConfig>();
  private readonly proxySessions = new Map<string, TidalProxySession>();
  private proxyServer?: ReturnType<typeof createServer>;
  private proxyPort?: number;
  private readonly proxyHost = '127.0.0.1';
  private readonly configPort: ConfigPort;

  constructor(private readonly notifyOutputError: OutputErrorHandler, configPort: ConfigPort) {
    this.configPort = configPort;
  }

  public configureFromConfig(): void {
    this.bridgesByProvider.clear();
    this.bridgesById.clear();
    const bridges = this.configPort.getConfig().content?.spotify?.bridges ?? [];
    for (const bridge of bridges) {
      const provider = (bridge.provider || '').toLowerCase();
      if (provider !== 'tidal') continue;
      const providerId = `spotify@${bridge.id}`;
      this.bridgesByProvider.set(providerId, bridge);
      this.bridgesById.set(bridge.id, bridge);
    }
  }

  public isTidalProvider(providerId: string): boolean {
    if (!providerId) return false;
    if (this.bridgesByProvider.has(providerId)) return true;
    const id = providerId.split('@')[1] ?? providerId;
    if (this.bridgesById.has(id)) return true;
    return providerId.toLowerCase().includes('tidal');
  }

  public async startStreamForAudiopath(
    zoneId: number,
    _zoneName: string,
    audiopath: string,
  ): Promise<TidalPlaybackResult> {
    const request = this.parseTrackRequest(audiopath);
    if (!request) {
      this.log.warn('tidal stream request unresolved', { zoneId, audiopath });
      this.reportPlaybackError(zoneId, 'tidal invalid request');
      return { playbackSource: null };
    }

    const playback = await this.fetchPlaybackInfo(request);
    if (!playback) {
      this.reportPlaybackError(zoneId, 'tidal playback info unavailable');
      return { playbackSource: null };
    }

    const manifest = decodeManifest(playback.manifest);
    if (!manifest) {
      this.reportPlaybackError(zoneId, 'tidal manifest decode failed');
      return { playbackSource: null };
    }

    const directUrl = extractDirectUrlFromManifest(manifest);
    if (directUrl) {
      return { playbackSource: { kind: 'url', url: directUrl } };
    }

    if (!manifest.trim().startsWith('<?xml')) {
      this.log.warn('tidal manifest format not supported', { zoneId });
      this.reportPlaybackError(zoneId, 'tidal manifest unsupported');
      return { playbackSource: null };
    }

    if (/widevine|cenc|dashif/i.test(manifest)) {
      this.log.warn('tidal manifest appears DRM protected', { zoneId });
    }

    const sessionId = randomUUID();
    this.proxySessions.set(sessionId, {
      id: sessionId,
      manifest,
      mimeType: playback.manifestMimeType || 'application/dash+xml',
      createdAt: Date.now(),
    });
    const proxy = await this.ensureProxyServer();
    const url = `http://${proxy.host}:${proxy.port}/tidal/${sessionId}/manifest.mpd`;
    return {
      playbackSource: {
        kind: 'url',
        url,
        inputFormat: 'dash',
      },
    };
  }

  private reportPlaybackError(zoneId: number, reason: string): void {
    const trimmed = reason.trim();
    if (!trimmed) return;
    this.notifyOutputError(zoneId, trimmed);
  }

  private parseTrackRequest(audiopath: string): TidalTrackRequest | null {
    const raw = String(audiopath || '');
    const parts = raw.split(':');
    if (parts.length < 3) return null;
    const providerId = parts[0] ?? '';
    const type = (parts[1] ?? '').toLowerCase();
    const rawId = parts.slice(2).join(':').trim();
    const decodedId = decodeAudiopath(rawId);
    const trackId = decodedId || rawId;
    if (!providerId || !trackId) return null;
    if (type !== 'track') return null;

    const bridge =
      this.bridgesByProvider.get(providerId) ??
      this.bridgesById.get(providerId.split('@')[1] ?? '') ??
      null;
    if (!bridge) return null;

    return { providerId, trackId, bridge };
  }

  private buildHeaders(bridge: SpotifyBridgeConfig): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    const token = bridge.tidalAccessToken?.trim();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private async fetchPlaybackInfo(request: TidalTrackRequest): Promise<any | null> {
    const token = request.bridge.tidalAccessToken?.trim();
    if (!token) {
      return null;
    }
    const url = new URL(`${TIDAL_API_BASE}/tracks/${encodeURIComponent(request.trackId)}/playbackinfopostpaywall`);
    url.searchParams.set('audioquality', 'LOSSLESS');
    url.searchParams.set('playbackmode', 'STREAM');
    url.searchParams.set('assetpresentation', 'FULL');
    if (request.bridge.tidalCountryCode) {
      url.searchParams.set('countryCode', request.bridge.tidalCountryCode);
    }
    try {
      const res = await fetch(url.toString(), { headers: this.buildHeaders(request.bridge) });
      if (!res.ok) {
        this.log.warn('tidal playback info failed', { status: res.status, trackId: request.trackId });
        return null;
      }
      return (await res.json()) as any;
    } catch (err) {
      this.log.warn('tidal playback info failed', { trackId: request.trackId, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private async ensureProxyServer(): Promise<{ host: string; port: number }> {
    if (this.proxyServer && this.proxyPort) {
      return { host: this.proxyHost, port: this.proxyPort };
    }
    this.proxyServer = createServer((req, res) => {
      void this.handleProxyRequest(req, res).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn('tidal proxy request failed', { message });
        try {
          res.writeHead(500);
          res.end();
        } catch {
          /* ignore */
        }
      });
    });
    await new Promise<void>((resolve) => {
      this.proxyServer!.listen(0, this.proxyHost, () => {
        const address = this.proxyServer?.address();
        if (address && typeof address === 'object') {
          this.proxyPort = address.port;
        }
        resolve();
      });
    });
    return { host: this.proxyHost, port: this.proxyPort ?? 0 };
  }

  private async handleProxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = String(req.url || '');
    const match = url.match(/^\/tidal\/([^/]+)\/manifest\.mpd/i);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }
    const sessionId = match[1];
    const session = this.proxySessions.get(sessionId);
    if (!session) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': session.mimeType });
    res.end(session.manifest);
  }
}

function decodeManifest(encoded: string | null | undefined): string | null {
  if (!encoded) return null;
  try {
    return Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function extractDirectUrlFromManifest(manifest: string): string | null {
  const trimmed = manifest.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as any;
      const urls = parsed?.urls;
      if (Array.isArray(urls) && typeof urls[0] === 'string') {
        return urls[0];
      }
      if (typeof parsed?.url === 'string') {
        return parsed.url;
      }
    } catch {
      return null;
    }
  }
  return null;
}
