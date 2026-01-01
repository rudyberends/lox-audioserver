import { createLogger } from '@/core/logging/logger';
import { getConfig } from '@/domain/config/configStore';
import type { SpotifyBridgeConfig } from '@/domain/config/types';
import type { PlaybackSource } from '@/modules/audio/engine/audioSession';
import { decodeAudiopath } from '@/modules/audio/utils/audiopath';
import { notifyTransportError } from '@/modules/audio/outputs/queueUpdater';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { Transform, Readable } from 'node:stream';

const DEEZER_TRACK_URL = 'https://www.deezer.com/us/track';
const DEEZER_API_BASE = 'https://api.deezer.com';
const DEEZER_CDN_BASE = 'https://e-cdns-proxy-';
const DEEZER_AES_KEY = 'jo6aey6haid2Teih';
const DEEZER_BF_KEY = Buffer.from('g4el58wc0zvf9na1', 'utf8');
const DEEZER_BF_IV = Buffer.from('0001020304050607', 'hex');
const BLOCK_SIZE = 2048;

type DeezerPlaybackResult = {
  playbackSource: PlaybackSource | null;
  transportOnly?: boolean;
};

type DeezerTrackRequest = {
  providerId: string;
  trackId: string;
  bridge: SpotifyBridgeConfig;
};

type DeezerSongData = {
  SNG_ID?: string | number;
  MD5_ORIGIN?: string;
  MEDIA_VERSION?: string | number;
  FILESIZE_FLAC?: string | number;
  FILESIZE_MP3_320?: string | number;
  FILESIZE_MP3_128?: string | number;
};

type DeezerProxySession = {
  id: string;
  urls: string[];
  headers: Record<string, string>;
  blowfishKey: Buffer;
  format?: number;
  createdAt: number;
};

class DeezerDecryptStream extends Transform {
  private buffer = Buffer.alloc(0);
  private blockIndex = 0;
  constructor(private readonly key: Buffer) {
    super();
  }

  public _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= BLOCK_SIZE) {
      const block: Buffer = this.buffer.subarray(0, BLOCK_SIZE);
      this.buffer = this.buffer.subarray(BLOCK_SIZE);
      let out: Buffer = block;
      if ((this.blockIndex % 3) === 0) {
        out = decryptBlowfishBlock(block, this.key);
      }
      this.push(out);
      this.blockIndex += 1;
    }
    callback();
  }

  public _flush(callback: (error?: Error | null) => void): void {
    if (this.buffer.length > 0) {
      this.push(this.buffer);
      this.buffer = Buffer.alloc(0);
    }
    callback();
  }
}

export class DeezerStreamService {
  private readonly log = createLogger('Content', 'DeezerStream');
  private readonly bridgesByProvider = new Map<string, SpotifyBridgeConfig>();
  private readonly bridgesById = new Map<string, SpotifyBridgeConfig>();
  private readonly proxySessions = new Map<string, DeezerProxySession>();
  private proxyServer?: ReturnType<typeof createServer>;
  private proxyPort?: number;
  private readonly proxyHost = '127.0.0.1';

  public configureFromConfig(): void {
    this.bridgesByProvider.clear();
    this.bridgesById.clear();
    const bridges = getConfig().content?.spotify?.bridges ?? [];
    for (const bridge of bridges) {
      const provider = (bridge.provider || '').toLowerCase();
      if (provider !== 'deezer') continue;
      const providerId = `spotify@${bridge.id}`;
      this.bridgesByProvider.set(providerId, bridge);
      this.bridgesById.set(bridge.id, bridge);
    }
  }

  public isDeezerProvider(providerId: string): boolean {
    if (!providerId) return false;
    if (this.bridgesByProvider.has(providerId)) return true;
    const id = providerId.split('@')[1] ?? providerId;
    if (this.bridgesById.has(id)) return true;
    return providerId.toLowerCase().includes('deezer');
  }

  public async startStreamForAudiopath(
    zoneId: number,
    _zoneName: string,
    audiopath: string,
  ): Promise<DeezerPlaybackResult> {
    const request = this.parseTrackRequest(audiopath);
    if (!request) {
      this.log.warn('deezer stream request unresolved', { zoneId, audiopath });
      this.reportPlaybackError(zoneId, 'deezer invalid request');
      return { playbackSource: null };
    }

    const song = await this.fetchSongData(request);
    if (!song) {
      this.reportPlaybackError(zoneId, 'deezer track data unavailable');
      return { playbackSource: null };
    }

    const songId = String(song.SNG_ID ?? request.trackId);
    const md5OriginRaw = String(song.MD5_ORIGIN ?? '');
    const mediaVersion = String(song.MEDIA_VERSION ?? '');
    if (!songId || !md5OriginRaw || !mediaVersion) {
      this.log.warn('deezer track missing stream metadata', {
        zoneId,
        songId,
        md5OriginRaw,
        mediaVersion,
      });
      this.reportPlaybackError(zoneId, 'deezer missing stream metadata');
      return { playbackSource: null };
    }

    const md5Origin = md5OriginRaw.split('.')[0] || md5OriginRaw;
    const formats = resolveFormatCandidates(song);
    const urls = formats.map((fmt) => buildStreamUrl(songId, md5Origin, mediaVersion, fmt));
    if (urls.length === 0) {
      this.reportPlaybackError(zoneId, 'deezer stream url unavailable');
      return { playbackSource: null };
    }

    const blowfishKey = calcBlowfishKey(songId);
    const sessionId = randomUUID();
    const headers = this.buildHeaders(request.bridge);
    this.proxySessions.set(sessionId, {
      id: sessionId,
      urls,
      headers,
      blowfishKey,
      format: formats[0],
      createdAt: Date.now(),
    });

    const proxy = await this.ensureProxyServer();
    const streamUrl = `http://${proxy.host}:${proxy.port}/deezer/${sessionId}/stream`;
    this.log.info('deezer stream ready', { zoneId, trackId: request.trackId, sessionId });
    return {
      playbackSource: {
        kind: 'url',
        url: streamUrl,
      },
    };
  }

  private reportPlaybackError(zoneId: number, reason: string): void {
    const trimmed = reason.trim();
    if (!trimmed) return;
    notifyTransportError(zoneId, trimmed);
  }

  private parseTrackRequest(audiopath: string): DeezerTrackRequest | null {
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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:95.0) Gecko/20100101 Firefox/95.0',
      Accept: '*/*',
      'Accept-Language': 'en-US',
      Referer: 'https://www.deezer.com/',
      Origin: 'https://www.deezer.com',
    };
    const arl = bridge.deezerArl?.trim();
    if (arl) {
      headers.Cookie = `arl=${arl}; comeback=1`;
    }
    return headers;
  }

  private async fetchSongData(request: DeezerTrackRequest): Promise<DeezerSongData | null> {
    const html = await this.fetchTrackPage(request.trackId, request.bridge);
    const song = html ? this.extractSongData(html) : null;
    if (song?.SNG_ID && song?.MD5_ORIGIN && song?.MEDIA_VERSION) {
      return song;
    }
    const apiSong = await this.fetchTrackApi(request.trackId);
    if (apiSong?.SNG_ID && apiSong?.MD5_ORIGIN && apiSong?.MEDIA_VERSION) {
      return apiSong;
    }
    return song ?? apiSong;
  }

  private async fetchTrackPage(trackId: string, bridge: SpotifyBridgeConfig): Promise<string | null> {
    try {
      const url = `${DEEZER_TRACK_URL}/${encodeURIComponent(trackId)}`;
      const res = await fetch(url, {
        headers: this.buildHeaders(bridge),
      });
      if (!res.ok) {
        this.log.warn('deezer track page request failed', { status: res.status, trackId });
        return null;
      }
      return await res.text();
    } catch (err) {
      this.log.warn('deezer track page request failed', { trackId, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private async fetchTrackApi(trackId: string): Promise<DeezerSongData | null> {
    try {
      const res = await fetch(`${DEEZER_API_BASE}/track/${encodeURIComponent(trackId)}`);
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      return data as DeezerSongData;
    } catch {
      return null;
    }
  }

  private extractSongData(html: string): DeezerSongData | null {
    const marker = html.indexOf('{"DATA":');
    if (marker < 0) return null;
    const raw = html.slice(marker);
    const json = extractJsonObject(raw);
    if (!json) return null;
    try {
      const data = JSON.parse(json) as { DATA?: DeezerSongData };
      return data?.DATA ?? null;
    } catch (err) {
      this.log.warn('deezer track page parse failed', { message: err instanceof Error ? err.message : String(err) });
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
        this.log.warn('deezer proxy request failed', { message });
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
    const match = url.match(/^\/deezer\/([^/]+)\/stream/i);
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

    const controller = new AbortController();
    const cleanup = () => {
      controller.abort();
      this.proxySessions.delete(sessionId);
    };
    req.on('close', cleanup);

    const upstream = await fetchWithFallback(session.urls, session.headers, controller.signal);
    if (!upstream?.ok || !upstream.body) {
      res.writeHead(502);
      res.end();
      cleanup();
      return;
    }

    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
    res.writeHead(200, { 'Content-Type': contentType });
    const decryptStream = new DeezerDecryptStream(session.blowfishKey);
    const stream = Readable.fromWeb(upstream.body as any);
    stream.pipe(decryptStream).pipe(res);

    stream.on('error', () => {
      cleanup();
    });
    res.on('close', cleanup);
  }
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

function md5hex(data: Buffer): Buffer {
  const hex = createHash('md5').update(data).digest('hex');
  return Buffer.from(hex, 'utf8');
}

function hexaescrypt(data: Buffer, key: string): string {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
  cipher.setAutoPadding(false);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  return enc.toString('hex');
}

function calcBlowfishKey(songId: string): Buffer {
  const songMd5 = md5hex(Buffer.from(songId, 'utf8'));
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = songMd5[i] ^ songMd5[i + 16] ^ DEEZER_BF_KEY[i];
  }
  return out;
}

function decryptBlowfishBlock(data: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('bf-cbc', key, DEEZER_BF_IV);
  decipher.setAutoPadding(false);
  return Buffer.from(Buffer.concat([decipher.update(data), decipher.final()])) as Buffer;
}

function genUrlKey(songId: string, md5Origin: string, mediaVersion: string, format: number): string {
  const parts = [
    Buffer.from(md5Origin, 'utf8'),
    Buffer.from(String(format), 'utf8'),
    Buffer.from(String(songId), 'utf8'),
    Buffer.from(String(mediaVersion), 'utf8'),
  ];
  const separator = Buffer.from([0xa4]);
  const dataConcat = Buffer.concat(parts.map((part, idx) => (idx === 0 ? part : Buffer.concat([separator, part]))));
  const digest = md5hex(dataConcat);
  let data = Buffer.concat([digest, separator, dataConcat, separator]);
  if (data.length % 16 !== 0) {
    const pad = Buffer.alloc(16 - (data.length % 16), 0);
    data = Buffer.concat([data, pad]);
  }
  return hexaescrypt(data, DEEZER_AES_KEY);
}

function buildStreamUrl(songId: string, md5Origin: string, mediaVersion: string, format: number): string {
  const key = genUrlKey(songId, md5Origin, mediaVersion, format);
  const cdnPrefix = md5Origin[0] || 'a';
  return `${DEEZER_CDN_BASE}${cdnPrefix}.dzcdn.net/mobile/1/${key}`;
}

function resolveFormatCandidates(song: DeezerSongData): number[] {
  const entries = [
    { format: 9, size: song.FILESIZE_FLAC },
    { format: 3, size: song.FILESIZE_MP3_320 },
    { format: 1, size: song.FILESIZE_MP3_128 },
  ];
  const resolved = entries.filter((entry) => Number(entry.size) > 0).map((entry) => entry.format);
  return resolved.length ? resolved : [3, 1];
}

async function fetchWithFallback(
  urls: string[],
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response | null> {
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers, signal });
      if (res.ok) {
        return res;
      }
    } catch (err) {
      if ((err as any)?.name === 'AbortError') {
        return null;
      }
    }
  }
  return null;
}

export const deezerStreamService = new DeezerStreamService();
