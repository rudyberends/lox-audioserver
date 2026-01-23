import { createLogger } from '@/shared/logging/logger';
import { safeReadText } from '@/shared/bestEffort';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SpotifyBridgeConfig } from '@/domain/config/types';
import type { PlaybackSource } from '@/application/playback/audioManager';
import { decodeAudiopath } from '@/domain/loxone/audiopath';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, createCipheriv, createHash } from 'node:crypto';
import { Transform, Readable, PassThrough } from 'node:stream';
import { once } from 'node:events';
const { Blowfish } = require('egoroof-blowfish');

const DEEZER_TRACK_URL = 'https://www.deezer.com/us/track';
const DEEZER_API_BASE = 'https://api.deezer.com';
const DEEZER_CDN_BASES = [
  'https://e-cdns-proxy-',
  'https://e-cdn-proxy-',
  'https://cdns-proxy-',
  'https://cdn-proxy-',
];
const DEEZER_CDN_PREFIXES = ['a', 'b', 'c', 'd'];
const DEEZER_AES_KEY = 'jo6aey6haid2Teih';
const DEEZER_BF_KEY = Buffer.from('g4el58wc0zvf9na1', 'utf8');
const DEEZER_BF_IV = Buffer.from('0001020304050607', 'hex');
const BLOCK_SIZE = 2048;
const DEEZER_JITTER_BUFFER_BYTES = 1024 * 1024 * 2;

type DeezerPlaybackResult = {
  playbackSource: PlaybackSource | null;
  outputOnly?: boolean;
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
  TRACK_TOKEN?: string;
  FALLBACK?: DeezerSongData;
};

type DeezerProxySession = {
  id: string;
  urls: string[];
  headers: Record<string, string>;
  blowfishKey: Buffer;
  format?: number;
  createdAt: number;
  estimatedSize?: number;
};

type OutputErrorHandler = (zoneId: number, reason?: string) => void;

class DeezerDecryptStream extends Transform {
  private buffer = Buffer.alloc(0);
  private blockIndex = 0;
  private readonly blowfish: any;
  constructor(private readonly key: Buffer) {
    super();
    const mode = Blowfish.MODE.CBC;
    const padding = Blowfish.PADDING.NULL;
    this.blowfish = new Blowfish(this.key, mode, padding);
  }

  public _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= BLOCK_SIZE) {
      const block: Buffer = this.buffer.subarray(0, BLOCK_SIZE);
      this.buffer = this.buffer.subarray(BLOCK_SIZE);
      let out: Buffer = block;
      if ((this.blockIndex % 3) === 0) {
        out = this.decryptBlock(block);
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

  private decryptBlock(data: Buffer): Buffer {
    this.blowfish.setIv(DEEZER_BF_IV);
    const decrypted = this.blowfish.decode(data, Blowfish.TYPE.UINT8_ARRAY);
    return Buffer.from(decrypted);
  }
}

class DeezerJitterBuffer extends Transform {
  private bufferedBytes = 0;
  private bufferedChunks: Buffer[] = [];
  private released = false;
  constructor(private readonly minBytes: number) {
    super();
  }

  public _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.released) {
      this.bufferedChunks.push(chunk);
      this.bufferedBytes += chunk.length;
      if (this.bufferedBytes >= this.minBytes) {
        for (const buffered of this.bufferedChunks) {
          this.push(buffered);
        }
        this.bufferedChunks = [];
        this.released = true;
      }
      callback();
      return;
    }
    this.push(chunk);
    callback();
  }

  public _flush(callback: (error?: Error | null) => void): void {
    if (!this.released) {
      for (const buffered of this.bufferedChunks) {
        this.push(buffered);
      }
      this.bufferedChunks = [];
    }
    callback();
  }
}

function formatContentType(format?: number): string {
  if (format === 9) return 'audio/flac';
  return 'audio/mpeg';
}

export class DeezerStreamService {
  private readonly log = createLogger('Content', 'DeezerStream');
  private readonly bridgesByProvider = new Map<string, SpotifyBridgeConfig>();
  private readonly bridgesById = new Map<string, SpotifyBridgeConfig>();
  private readonly proxySessions = new Map<string, DeezerProxySession>();
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

    let urls: string[] = [];
    let blowfishKey: Buffer | null = null;
    let usedMethod = 'md5origin';
    let formatHint: number | undefined;

    const gwStream = await this.fetchGwStream(request);
    if (gwStream) {
      urls = [gwStream.url];
      blowfishKey = calcBlowfishKey(gwStream.songId);
      usedMethod = 'gw';
      formatHint = gwStream.format;
    } else {
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
      urls = buildStreamUrls(songId, md5Origin, mediaVersion, formats);
      formatHint = formats[0];
      this.log.debug('deezer stream candidates', {
        trackId: request.trackId,
        songId,
        md5Origin,
        mediaVersion,
        formats,
      });
      if (urls.length === 0) {
        this.reportPlaybackError(zoneId, 'deezer stream url unavailable');
        return { playbackSource: null };
      }
      blowfishKey = calcBlowfishKey(songId);
    }

    if (!blowfishKey) {
      this.reportPlaybackError(zoneId, 'deezer stream key unavailable');
      return { playbackSource: null };
    }
    const sessionId = randomUUID();
    const headers = this.buildHeaders(request.bridge);
    this.proxySessions.set(sessionId, {
      id: sessionId,
      urls,
      headers,
      blowfishKey,
      format: formatHint,
      createdAt: Date.now(),
      estimatedSize: gwStream?.size,
    });

    const proxy = await this.ensureProxyServer();
    const streamUrl = `http://${proxy.host}:${proxy.port}/deezer/${sessionId}/stream`;
    this.log.info('deezer stream ready', {
      zoneId,
      trackId: request.trackId,
      sessionId,
      method: usedMethod,
    });
    return {
      playbackSource: {
        kind: 'url',
        url: streamUrl,
        realTime: false,
        lowLatency: false,
      },
    };
  }

  private reportPlaybackError(zoneId: number, reason: string): void {
    const trimmed = reason.trim();
    if (!trimmed) return;
    this.notifyOutputError(zoneId, trimmed);
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

  private async fetchGwStream(
    request: DeezerTrackRequest,
  ): Promise<{ url: string; songId: string; size?: number; format?: number } | null> {
    const arl = request.bridge.deezerArl?.trim();
    if (!arl) {
      this.log.debug('deezer gw stream skipped; missing arl');
      return null;
    }

    const userDataResponse = await this.fetchGwUserData(arl);
    const userData = userDataResponse?.data;
    const cookieHeader = userDataResponse?.cookie ?? '';
    if (!userData) {
      this.log.warn('deezer gw user data missing');
    }
    const checkForm = this.extractCheckForm(userData?.results);
    const licenseToken = userData?.results?.USER?.OPTIONS?.license_token;
    this.log.debug('deezer gw user data summary', {
      hasCheckForm: Boolean(checkForm),
      hasLicense: Boolean(licenseToken),
      userId: userData?.results?.USER?.USER_ID,
      offerId: userData?.results?.OFFER_ID,
    });
    if (!checkForm || !licenseToken) {
      this.log.warn('deezer gw user data incomplete', {
        hasCheckForm: Boolean(checkForm),
        hasLicense: Boolean(licenseToken),
      });
      return null;
    }

    const songData = await this.fetchGwSongData(arl, cookieHeader, checkForm, request.trackId);
    if (!songData) {
      this.log.warn('deezer gw song data missing', { trackId: request.trackId });
      return null;
    }
    const resolvedSong = songData.FALLBACK ?? songData;
    const trackToken = resolvedSong.TRACK_TOKEN;
    const songId = String(resolvedSong.SNG_ID ?? request.trackId);
    if (!trackToken || !songId) {
      this.log.warn('deezer gw track token missing', {
        trackId: request.trackId,
        hasToken: Boolean(trackToken),
        songId,
      });
      return null;
    }

    const formats = this.resolveGwFormats(userData);
    const stream = await this.fetchGwStreamUrl(licenseToken, trackToken, formats);
    if (!stream?.url) {
      this.log.warn('deezer gw stream url missing', { trackId: request.trackId });
      return null;
    }
    return { url: stream.url, songId, size: stream.size, format: mapGwFormatToId(stream.format) };
  }

  private async fetchGwUserData(
    arl: string,
  ): Promise<{ data: any; cookie: string } | null> {
    try {
      const params = new URLSearchParams({
        api_version: '1.0',
        api_token: 'null',
        input: '3',
        method: 'deezer.getUserData',
      });
      const res = await fetch(`https://www.deezer.com/ajax/gw-light.php?${params.toString()}`, {
        method: 'POST',
        headers: {
          ...this.buildHeaders({ deezerArl: arl } as SpotifyBridgeConfig),
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) {
        const body = await safeReadText(res, '', {
          onError: 'debug',
          log: this.log,
          label: 'deezer gw user data read failed',
          context: { status: res.status },
        });
        this.log.warn('deezer gw user data failed', { status: res.status, body: body.slice(0, 200) });
        return null;
      }
      const data = (await res.json()) as any;
      if (hasGwError(data?.error)) {
        this.log.warn('deezer gw user data error', { error: data.error });
      }
      const cookie = extractCookiesFromResponse(res, arl);
      return { data, cookie };
    } catch (err) {
      this.log.debug('deezer gw user data failed', { message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private async fetchGwSongData(
    arl: string,
    cookieHeader: string,
    apiToken: string,
    trackId: string,
  ): Promise<DeezerSongData | null> {
    try {
      const params = new URLSearchParams({
        api_version: '1.0',
        api_token: apiToken || 'null',
        input: '3',
        method: 'song.getData',
      });
      const res = await fetch(`https://www.deezer.com/ajax/gw-light.php?${params.toString()}`, {
        method: 'POST',
        headers: {
          ...this.buildHeaders({ deezerArl: arl } as SpotifyBridgeConfig),
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ SNG_ID: trackId }),
      });
      if (!res.ok) {
        const body = await safeReadText(res, '', {
          onError: 'debug',
          log: this.log,
          label: 'deezer gw song data read failed',
          context: { status: res.status },
        });
        this.log.warn('deezer gw song data failed', { status: res.status, body: body.slice(0, 200) });
        return null;
      }
      const data = (await res.json()) as any;
      const results = data?.results ?? null;
      if (hasGwError(data?.error)) {
        this.log.warn('deezer gw song data error', { error: data.error });
      }
      if (!results || hasGwError(data?.error)) {
        return null;
      }
      return results as DeezerSongData;
    } catch {
      return null;
    }
  }

  private extractCheckForm(results: any): string | null {
    if (!results || typeof results !== 'object') {
      return null;
    }
    const candidates = [
      results.checkForm,
      results.checkform,
      results.CHECKFORM,
      results.check_form,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    return null;
  }

  private resolveGwFormats(userData: any): Array<{ cipher: string; format: string }> {
    const formats: Array<{ cipher: string; format: string }> = [
      { cipher: 'BF_CBC_STRIPE', format: 'MP3_128' },
    ];
    const web = userData?.results?.USER?.OPTIONS?.web_sound_quality ?? {};
    const mobile = userData?.results?.USER?.OPTIONS?.mobile_sound_quality ?? {};
    if (web?.high || mobile?.high) {
      formats.unshift({ cipher: 'BF_CBC_STRIPE', format: 'MP3_320' });
    }
    if (web?.lossless || mobile?.lossless) {
      formats.unshift({ cipher: 'BF_CBC_STRIPE', format: 'FLAC' });
    }
    return formats;
  }

  private async fetchGwStreamUrl(
    licenseToken: string,
    trackToken: string,
    formats: Array<{ cipher: string; format: string }>,
  ): Promise<{ url: string; format: string; size?: number } | null> {
    try {
      const payload = {
        license_token: licenseToken,
        media: [
          {
            type: 'FULL',
            formats,
          },
        ],
        track_tokens: [trackToken],
      };
      const res = await fetch('https://media.deezer.com/v1/get_url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.buildHeaders({} as SpotifyBridgeConfig)['User-Agent'],
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await safeReadText(res, '', {
          onError: 'debug',
          log: this.log,
          label: 'deezer song data read failed',
          context: { status: res.status },
        });
        this.log.warn('deezer gw get_url failed', { status: res.status, body: body.slice(0, 200) });
        return null;
      }
      const data = (await res.json()) as any;
      if (hasGwError(data?.data?.[0]?.errors)) {
        this.log.warn('deezer gw get_url error', { error: data.data[0].errors });
      }
      const media = data?.data?.[0]?.media?.[0];
      const source = media?.sources?.[0];
      if (source?.url && media?.format) {
        return { url: source.url, format: media.format, size: media.filesize };
      }
      return null;
    } catch (err) {
      this.log.debug('deezer gw get_url failed', { message: err instanceof Error ? err.message : String(err) });
      return null;
    }
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

    const contentType = formatContentType(session.format);
    const responseHeaders: Record<string, string> = { 'Content-Type': contentType };
    res.writeHead(200, responseHeaders);
    const decryptStream = new DeezerDecryptStream(session.blowfishKey);
    const jitterBuffer = new DeezerJitterBuffer(DEEZER_JITTER_BUFFER_BYTES);
    const stream = createRetryStream(session, controller.signal, this.log);
    stream.pipe(decryptStream).pipe(jitterBuffer).pipe(res);

    stream.on('error', () => {
      cleanup();
    });
    res.on('close', cleanup);
  }
}

function extractCookiesFromResponse(response: Response, arl: string): string {
  const headerAny = response.headers as any;
  const cookieParts: string[] = [];
  const arlValue = arl.trim();
  if (arlValue) {
    cookieParts.push(`arl=${arlValue}`);
  }
  if (typeof headerAny.getSetCookie === 'function') {
    const rawCookies = headerAny.getSetCookie() as string[];
    for (const raw of rawCookies) {
      const part = raw.split(';')[0]?.trim();
      if (part) cookieParts.push(part);
    }
  } else {
    const raw = response.headers.get('set-cookie');
    if (raw) {
      const splits = raw.split(/,(?=[^;]+?=)/g);
      for (const entry of splits) {
        const part = entry.split(';')[0]?.trim();
        if (part) cookieParts.push(part);
      }
    }
  }
  return cookieParts.filter(Boolean).join('; ');
}

function hasGwError(error: any): boolean {
  if (!error) return false;
  if (Array.isArray(error)) return error.length > 0;
  if (typeof error === 'object') return Object.keys(error).length > 0;
  return true;
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

function buildStreamUrl(
  base: string,
  songId: string,
  cdnPrefix: string,
  md5Origin: string,
  mediaVersion: string,
  format: number,
): string {
  const key = genUrlKey(songId, md5Origin, mediaVersion, format);
  return `${base}${cdnPrefix}.dzcdn.net/mobile/1/${key}`;
}

function buildStreamUrls(
  songId: string,
  md5Origin: string,
  mediaVersion: string,
  formats: number[],
): string[] {
  const primaryPrefix = (md5Origin[0] || 'a').toLowerCase();
  const prefixes = primaryPrefix && !DEEZER_CDN_PREFIXES.includes(primaryPrefix)
    ? [primaryPrefix, ...DEEZER_CDN_PREFIXES]
    : [primaryPrefix, ...DEEZER_CDN_PREFIXES.filter((p) => p !== primaryPrefix)];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const fmt of formats) {
    for (const prefix of prefixes) {
      for (const base of DEEZER_CDN_BASES) {
        const url = buildStreamUrl(base, songId, prefix, md5Origin, mediaVersion, fmt);
        if (seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
      }
    }
  }
  return urls;
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

function mapGwFormatToId(format?: string): number | undefined {
  switch ((format || '').toUpperCase()) {
    case 'FLAC':
      return 9;
    case 'MP3_320':
      return 3;
    case 'MP3_128':
      return 1;
    default:
      return undefined;
  }
}

function createRetryStream(
  session: DeezerProxySession,
  signal: AbortSignal,
  log: ReturnType<typeof createLogger>,
): PassThrough {
  const out = new PassThrough();
  let offset = 0;
  let buffer = Buffer.alloc(0);
  let pumping = false;

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    let attempts = 0;
    const maxAttempts = Math.max(3, session.urls.length * 4);
    const stallTimeoutMs = 4000;

    while (!signal.aborted && !out.destroyed) {
      let fetched = false;
      for (const url of session.urls) {
        if (signal.aborted || out.destroyed) {
          pumping = false;
          return;
        }
        attempts += 1;
        if (attempts > maxAttempts) {
          out.destroy(new Error('deezer retry limit reached'));
          pumping = false;
          return;
        }
        try {
          const headers: Record<string, string> = { ...session.headers };
          const resumeOffset = offset + buffer.length;
          if (resumeOffset > 0) {
            headers.Range = `bytes=${resumeOffset}-`;
          }
          const requestController = new AbortController();
          const onAbort = () => requestController.abort();
          signal.addEventListener('abort', onAbort, { once: true });
          const res = await fetch(url, { headers, signal: requestController.signal });
          if (!res.ok || !res.body) {
            signal.removeEventListener('abort', onAbort);
            continue;
          }
          if (resumeOffset > 0 && res.status !== 206) {
            signal.removeEventListener('abort', onAbort);
            continue;
          }
          fetched = true;
          const body = Readable.fromWeb(res.body as any);
          let idleTimer: NodeJS.Timeout | null = null;
          const resetIdleTimer = (): void => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              requestController.abort();
            }, stallTimeoutMs);
          };
          resetIdleTimer();
          for await (const chunk of body) {
            if (signal.aborted || out.destroyed) {
              if (idleTimer) clearTimeout(idleTimer);
              signal.removeEventListener('abort', onAbort);
              pumping = false;
              return;
            }
            resetIdleTimer();
            const incoming = Buffer.from(chunk as Buffer);
            buffer = Buffer.concat([buffer, incoming]);
            while (buffer.length >= BLOCK_SIZE) {
              const block = buffer.subarray(0, BLOCK_SIZE);
              buffer = buffer.subarray(BLOCK_SIZE);
              offset += block.length;
              if (!out.write(block)) {
                await once(out, 'drain');
              }
            }
          }
          if (idleTimer) clearTimeout(idleTimer);
          signal.removeEventListener('abort', onAbort);
        } catch (err) {
          log.debug('deezer proxy retry fetch failed', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!fetched) {
        out.destroy(new Error('deezer proxy upstream failed'));
        pumping = false;
        return;
      }
      if (buffer.length > 0) {
        offset += buffer.length;
        out.write(buffer);
        buffer = Buffer.alloc(0);
      }
      out.end();
      pumping = false;
      return;
    }
    pumping = false;
  };

  pump().catch((err) => out.destroy(err));
  return out;
}
