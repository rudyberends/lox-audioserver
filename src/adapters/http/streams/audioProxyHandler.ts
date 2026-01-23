import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { networkInterfaces } from 'node:os';
import { createLogger } from '@/shared/logging/logger';
import { bestEffort } from '@/shared/bestEffort';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import {
  decodeHeaders,
  encodeHeaders,
  resolveProxyHost,
  resolveProxyPort,
} from '@/shared/urlProxy';

const MAX_PLAYLIST_BYTES = 1024 * 1024;

export class AudioProxyHandler {
  private readonly log = createLogger('Http', 'AudioProxy');

  constructor(private readonly zoneManager: ZoneManagerFacade) {}

  public matches(pathname: string): boolean {
    return pathname === '/streams/proxy';
  }

  public async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method-not-allowed' }));
      return;
    }
    if (!this.isLocalClient(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const target = url.searchParams.get('u') ?? '';
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing-target' }));
      return;
    }

    const extraHeaders = decodeHeaders(url.searchParams.get('h'));
    const upstreamHeaders = this.buildUpstreamHeaders(req, extraHeaders);
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        headers: upstreamHeaders,
        redirect: 'follow',
      });
    } catch (error) {
      this.log.warn('proxy fetch failed', {
        target,
        message: error instanceof Error ? error.message : String(error),
      });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy-fetch-failed' }));
      return;
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');
    const acceptRanges = upstream.headers.get('accept-ranges');
    const icyMetaInt = upstream.headers.get('icy-metaint');
    const zoneId = this.resolveZoneId(req);

    if (upstream.ok && this.isPlaylistResponse(contentType, upstream.url)) {
      await this.respondPlaylist(res, upstream, contentType, extraHeaders);
      return;
    }

    if (!upstream.ok || !upstream.body) {
      res.writeHead(upstream.status || 502, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify({ error: 'upstream-error', status: upstream.status }));
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    };
    if (contentLength) headers['Content-Length'] = contentLength;
    if (acceptRanges) headers['Accept-Ranges'] = acceptRanges;
    if (icyMetaInt) headers['icy-metaint'] = icyMetaInt;

    res.writeHead(upstream.status || 200, headers);
    const stream = Readable.fromWeb(upstream.body as any);
    if (zoneId && icyMetaInt) {
      const metaInt = Number(icyMetaInt);
      if (Number.isFinite(metaInt) && metaInt > 0) {
        this.attachIcyMetadataListener(stream, metaInt, zoneId);
      }
    }
    stream.on('error', (error) => {
      this.log.warn('proxy stream failed', {
        target,
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy-stream-failed' }));
      } else {
        res.destroy(error as Error);
      }
    });
    stream.pipe(res);
  }

  private buildUpstreamHeaders(
    req: IncomingMessage,
    extras?: Record<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    if (extras) {
      Object.assign(headers, extras);
    }
    if (!headers['User-Agent'] && typeof req.headers['user-agent'] === 'string') {
      headers['User-Agent'] = req.headers['user-agent'];
    }
    const range = req.headers.range;
    if (typeof range === 'string') {
      headers.Range = range;
    }
    const icy = req.headers['icy-metadata'];
    if (typeof icy === 'string') {
      headers['Icy-MetaData'] = icy;
    }
    return headers;
  }

  private async respondPlaylist(
    res: ServerResponse,
    upstream: Response,
    contentType: string,
    extraHeaders?: Record<string, string>,
  ): Promise<void> {
    const text = await this.readTextResponse(upstream);
    if (text == null) {
      res.writeHead(upstream.status || 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'playlist-read-failed' }));
      return;
    }
    const rewritten = this.rewritePlaylist(text, upstream.url, extraHeaders);
    res.writeHead(upstream.status || 200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    res.end(rewritten);
  }

  private async readTextResponse(upstream: Response): Promise<string | null> {
    const length = upstream.headers.get('content-length');
    const size = length ? Number(length) : null;
    if (size && size > MAX_PLAYLIST_BYTES) {
      return null;
    }
    const text = await bestEffort(() => upstream.text(), {
      // Best-effort read; if the playlist can't be read, treat as unavailable.
      fallback: null,
      onError: 'debug',
      log: this.log,
      label: 'playlist read failed',
      context: { url: upstream.url },
    });
    if (text == null || text.length > MAX_PLAYLIST_BYTES) {
      return null;
    }
    return text;
  }

  private rewritePlaylist(
    body: string,
    baseUrl: string,
    headers?: Record<string, string>,
  ): string {
    const lower = baseUrl.toLowerCase();
    if (lower.endsWith('.pls') || body.includes('File1=')) {
      return this.rewritePls(body, baseUrl, headers);
    }
    return this.rewriteM3u(body, baseUrl, headers);
  }

  private rewriteM3u(
    body: string,
    baseUrl: string,
    headers?: Record<string, string>,
  ): string {
    const lines = body.split(/\r?\n/);
    const proxied = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return line;
      }
      if (trimmed.startsWith('#')) {
        return this.rewriteHlsUriLine(line, baseUrl, headers);
      }
      return this.wrapProxyUrl(trimmed, baseUrl, headers);
    });
    return proxied.join('\n');
  }

  private rewritePls(
    body: string,
    baseUrl: string,
    headers?: Record<string, string>,
  ): string {
    const lines = body.split(/\r?\n/);
    const proxied = lines.map((line) => {
      const match = /^File(\d+)=(.+)$/i.exec(line.trim());
      if (!match) {
        return line;
      }
      const url = match[2].trim();
      const wrapped = this.wrapProxyUrl(url, baseUrl, headers);
      return `File${match[1]}=${wrapped}`;
    });
    return proxied.join('\n');
  }

  private rewriteHlsUriLine(
    line: string,
    baseUrl: string,
    headers?: Record<string, string>,
  ): string {
    return line.replace(/URI="([^"]+)"/gi, (_match, uri) => {
      const proxied = this.wrapProxyUrl(uri, baseUrl, headers);
      return `URI="${proxied}"`;
    });
  }

  private resolveZoneId(req: IncomingMessage): number | null {
    const header = req.headers['x-loxone-zone'];
    const raw = Array.isArray(header) ? header[0] : header;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  }

  private attachIcyMetadataListener(
    stream: Readable,
    metaInt: number,
    zoneId: number,
  ): void {
    let bytesUntilMeta = metaInt;
    let metaRemaining = 0;
    let metaChunks: Buffer[] = [];
    let lastSignature = '';

    const handleMetadata = (payload: Buffer) => {
      const update = this.parseIcyMetadata(payload);
      if (!update) {
        return;
      }
      const signature = `${update.title}|||${update.artist}`;
      if (lastSignature === signature) {
        return;
      }
      lastSignature = signature;
      this.zoneManager.updateRadioMetadata(zoneId, update);
    };

    const onData = (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (metaRemaining > 0) {
          const take = Math.min(metaRemaining, chunk.length - offset);
          metaChunks.push(chunk.subarray(offset, offset + take));
          offset += take;
          metaRemaining -= take;
          if (metaRemaining === 0) {
            const payload = Buffer.concat(metaChunks);
            metaChunks = [];
            handleMetadata(payload);
            bytesUntilMeta = metaInt;
          }
          continue;
        }
        if (bytesUntilMeta > 0) {
          const skip = Math.min(bytesUntilMeta, chunk.length - offset);
          offset += skip;
          bytesUntilMeta -= skip;
          if (bytesUntilMeta > 0) {
            continue;
          }
        }
        if (bytesUntilMeta === 0) {
          if (offset >= chunk.length) {
            break;
          }
          const length = chunk.readUInt8(offset);
          offset += 1;
          metaRemaining = length * 16;
          if (metaRemaining === 0) {
            bytesUntilMeta = metaInt;
          }
        }
      }
    };

    const cleanup = () => {
      stream.off('data', onData);
    };

    stream.on('data', onData);
    stream.on('end', cleanup);
    stream.on('close', cleanup);
    stream.on('error', cleanup);
  }

  private parseIcyMetadata(payload: Buffer): { title: string; artist: string } | null {
    const text = payload.toString('utf8').replace(/\0/g, '').trim();
    if (!text) {
      return null;
    }
    const match =
      /StreamTitle='([^']*)'/i.exec(text) ??
      /StreamTitle=\"([^\"]*)\"/i.exec(text);
    const rawTitle = match?.[1]?.trim() ?? '';
    if (!rawTitle) {
      return null;
    }
    const normalized = rawTitle.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return null;
    }
    let artist = '';
    let title = normalized;
    const separator = ' - ';
    const idx = normalized.indexOf(separator);
    if (idx > 0) {
      artist = normalized.slice(0, idx).trim();
      title = normalized.slice(idx + separator.length).trim();
    }
    return { title, artist };
  }

  private wrapProxyUrl(
    rawUrl: string,
    baseUrl: string,
    headers?: Record<string, string>,
  ): string {
    let absolute: string;
    try {
      absolute = new URL(rawUrl, baseUrl).toString();
    } catch {
      return rawUrl;
    }
    const host = resolveProxyHost();
    const port = resolveProxyPort();
    const params = new URLSearchParams();
    params.set('u', absolute);
    const headerPayload = encodeHeaders(headers);
    if (headerPayload) {
      params.set('h', headerPayload);
    }
    return `http://${host}:${port}/streams/proxy?${params.toString()}`;
  }

  private isPlaylistResponse(contentType: string, finalUrl: string): boolean {
    const ct = (contentType ?? '').toLowerCase();
    if (ct.includes('mpegurl') || ct.includes('m3u')) {
      return true;
    }
    if (ct.includes('scpls') || ct.includes('pls')) {
      return true;
    }
    try {
      const path = new URL(finalUrl).pathname.toLowerCase();
      return path.endsWith('.m3u8') || path.endsWith('.m3u') || path.endsWith('.pls');
    } catch {
      return false;
    }
  }

  private isLocalClient(req: IncomingMessage): boolean {
    const remote = req.socket?.remoteAddress ?? '';
    if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') {
      return true;
    }
    const nets = networkInterfaces();
    for (const entries of Object.values(nets)) {
      for (const net of entries ?? []) {
        if (!net?.address || net.internal) {
          continue;
        }
        if (remote === net.address || remote === `::ffff:${net.address}`) {
          return true;
        }
      }
    }
    return false;
  }
}
