import { createDecipheriv, randomUUID } from 'node:crypto';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import { pruneExpiredSessions, type StreamProxyRoute } from '@/shared/streamProxyRoute';
import { resolveProxyHost, resolveProxyPort } from '@/shared/urlProxy';

// librespot's fixed AES-128-CTR audio IV (the initial counter block). The CDN
// file is encrypted with the per-track key from resolveAudioFile() under this IV.
const SPOTIFY_AUDIO_AES_IV = Buffer.from([
  0x72, 0xe0, 0x67, 0xfb, 0xdd, 0xcb, 0xcf, 0x77,
  0xeb, 0xe8, 0xbc, 0x64, 0x3f, 0x63, 0x0d, 0x93,
]);
const OGG_MAGIC = Buffer.from('OggS', 'ascii');
// Spotify prepends a fixed 0xa7 (167) byte header before the real Ogg stream
// (librespot's SPOTIFY_OGG_HEADER_END). Crucially this header *itself* starts
// with a placeholder "OggS" at offset 0 — version 0, header_type 0x06, zeroed
// serial/granule — which is NOT a decodable page. The real Vorbis BOS page
// ("OggS" ver 0, header_type 0x02, then "\x01vorbis") begins exactly at 0xa7.
// We must skip the placeholder and align to the real page, otherwise ffmpeg
// starts at the bogus page and bails with "End of file".
const SPOTIFY_OGG_HEADER_END = 0xa7;
// Past this many bytes without finding the real page, the key/IV assumption is
// wrong; stop buffering and fall back rather than scanning/OOMing forever.
const MAX_OGG_HEADER_SCAN = 16 * 1024;
// Spotify's loudness-normalisation block: 16 bytes (4 little-endian f32 —
// track gain dB, track peak, album gain dB, album peak) at a fixed offset of
// 144 in the decrypted file (librespot's SPOTIFY_NORMALIZATION_HEADER_START).
// 144 is 16-byte aligned, so it maps cleanly to AES-CTR counter block 9.
const SPOTIFY_NORMALIZATION_OFFSET = 144;

/**
 * AES-128-CTR counter for a given 16-byte block index: the fixed IV treated as a
 * 128-bit big-endian integer, plus the block index. Lets us decrypt a slice of
 * the file from an arbitrary block without decrypting everything before it.
 */
function ctrIvForBlock(baseIv: Buffer, blockIndex: number): Buffer {
  if (blockIndex <= 0) {
    return Buffer.from(baseIv);
  }
  const mask = (1n << 128n) - 1n;
  const v = (BigInt('0x' + baseIv.toString('hex')) + BigInt(blockIndex)) & mask;
  return Buffer.from(v.toString(16).padStart(32, '0'), 'hex');
}

/** Result of node-librespot's `session.resolveAudioFile()`. */
export type SpotifyResolvedAudio = {
  cdnUrl: string;
  keyHex: string;
  format: string;
};

type SpotifyProxySession = {
  id: string;
  cdnUrl: string;
  key: Buffer;
  isOgg: boolean;
  contentType: string;
  createdAt: number;
};

/**
 * Drops Spotify's fixed 0xa7-byte header and aligns the output to the real Ogg
 * Vorbis BOS page, then passes everything through unchanged. We search for
 * "OggS" starting *after* SPOTIFY_OGG_HEADER_END so the placeholder "OggS" at
 * offset 0 can't be mistaken for the first page.
 */
class OggHeaderStripStream extends Transform {
  private found = false;
  private pending: Buffer = Buffer.alloc(0);
  /** Diagnostics, read after the stream ends. */
  public headerOffset = -1;
  public gaveUp = false;

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.found) {
      cb(null, chunk);
      return;
    }
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    // Skip the placeholder page; the real Vorbis page sits at 0xa7.
    const idx = this.pending.indexOf(OGG_MAGIC, SPOTIFY_OGG_HEADER_END);
    if (idx >= 0) {
      this.found = true;
      this.headerOffset = idx;
      const out = this.pending.subarray(idx);
      this.pending = Buffer.alloc(0);
      cb(null, out);
      return;
    }
    if (this.pending.length > MAX_OGG_HEADER_SCAN) {
      // No real page found in range; fall back to the fixed header size so the
      // failure is visible downstream rather than silently buffering forever.
      this.found = true;
      this.gaveUp = true;
      const out = this.pending.subarray(SPOTIFY_OGG_HEADER_END);
      this.pending = Buffer.alloc(0);
      cb(null, out);
      return;
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    if (!this.found && this.pending.length) {
      // Stream ended before we found the real page (very short file); emit
      // whatever follows the fixed header.
      const start = this.pending.length > SPOTIFY_OGG_HEADER_END ? SPOTIFY_OGG_HEADER_END : 0;
      this.push(this.pending.subarray(start));
    }
    cb();
  }
}

/**
 * Serves Spotify tracks for the direct (Loxone-driven) playback path on the
 * shared HTTP gateway (:7090), so ffmpeg pulls a normal URL like the Tidal/
 * Deezer/Apple providers instead of consuming a librespot PCM pipe.
 *
 * Flow: node-librespot's `resolveAudioFile()` yields a signed CDN URL + AES key;
 * we fetch the encrypted file, AES-128-CTR decrypt it, strip the Ogg header, and
 * stream the result. librespot is reduced to an auth/resolve helper — decode,
 * buffering and lifecycle are ours.
 */
export class SpotifyStreamProxyService {
  private readonly log = createLogger('Audio', 'SpotifyStreamProxy');
  private readonly proxySessions = new Map<string, SpotifyProxySession>();

  /** Register a resolved track and return the gateway URL ffmpeg should pull. */
  public registerSession(resolved: SpotifyResolvedAudio): { url: string } {
    const key = Buffer.from(resolved.keyHex, 'hex');
    if (key.length !== 16) {
      throw new Error(`resolveAudioFile returned a ${key.length}-byte key (expected 16)`);
    }
    const isOgg = /OGG/i.test(resolved.format);
    const sessionId = randomUUID();
    pruneExpiredSessions(this.proxySessions);
    this.proxySessions.set(sessionId, {
      id: sessionId,
      cdnUrl: resolved.cdnUrl,
      key,
      isOgg,
      contentType: isOgg ? 'audio/ogg' : 'audio/mpeg',
      createdAt: Date.now(),
    });
    const url = `http://${resolveProxyHost()}:${resolveProxyPort()}/spotify/${sessionId}/stream`;
    return { url };
  }

  /**
   * Resolve the clip-safe loudness-normalisation gain (in dB) for a track, to be
   * applied as an ffmpeg `volume` filter so direct playback matches Spotify's own
   * volume normalisation. Reads the 16-byte normalisation block at offset 144 via
   * a tiny CDN Range request + AES-CTR decrypt — no full download. Returns null if
   * unavailable (then no gain is applied). Mirrors librespot's ReplayGain logic:
   * allow attenuation freely, but cap boost at the track peak's headroom so we
   * never exceed 0 dBFS.
   */
  public async resolveNormalizationGainDb(resolved: SpotifyResolvedAudio): Promise<number | null> {
    if (!/OGG/i.test(resolved.format)) {
      return null;
    }
    const key = Buffer.from(resolved.keyHex, 'hex');
    if (key.length !== 16) {
      return null;
    }
    try {
      const resp = await fetch(resolved.cdnUrl, {
        redirect: 'follow',
        headers: { Range: `bytes=${SPOTIFY_NORMALIZATION_OFFSET}-${SPOTIFY_NORMALIZATION_OFFSET + 15}` },
        signal: AbortSignal.timeout(4000),
      });
      if (!resp.ok || !resp.body) {
        return null;
      }
      const enc = Buffer.from(await resp.arrayBuffer());
      if (enc.length < 16) {
        return null;
      }
      const decipher = createDecipheriv(
        'aes-128-ctr',
        key,
        ctrIvForBlock(SPOTIFY_AUDIO_AES_IV, SPOTIFY_NORMALIZATION_OFFSET / 16),
      );
      const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
      const trackGainDb = dec.readFloatLE(0);
      const trackPeak = dec.readFloatLE(4);
      if (!Number.isFinite(trackGainDb)) {
        return null;
      }
      // Clip-safe: never boost past the headroom implied by the track's peak.
      const clipHeadroomDb = trackPeak > 0 ? -20 * Math.log10(trackPeak) : 0;
      return Math.min(trackGainDb, clipHeadroomDb);
    } catch {
      return null;
    }
  }

  public getProxyRoute(): StreamProxyRoute {
    return {
      matches: (pathname) => pathname.startsWith('/spotify/'),
      handle: (req, res) => this.handleProxyRequest(req, res),
    };
  }

  private async handleProxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = String(req.url || '').match(/^\/spotify\/([^/]+)\/stream/i);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }
    const sessionId = match[1] ?? '';
    const session = this.proxySessions.get(sessionId);
    if (!session) {
      res.writeHead(404);
      res.end();
      return;
    }

    const controller = new AbortController();
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      controller.abort();
      this.proxySessions.delete(sessionId);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);

    let cdnHost = '';
    try {
      cdnHost = new URL(session.cdnUrl).host;
    } catch {
      /* leave host empty if the url is malformed */
    }
    this.log.debug('spotify cdn fetch start', { sessionId, cdnHost, isOgg: session.isOgg });

    let upstream: Response;
    try {
      upstream = await fetch(session.cdnUrl, { redirect: 'follow', signal: controller.signal });
    } catch (err) {
      cleanup();
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('spotify cdn fetch failed', { sessionId, message });
      if (!res.headersSent) {
        res.writeHead(502);
      }
      res.end();
      return;
    }
    this.log.debug('spotify cdn response', {
      sessionId,
      status: upstream.status,
      ok: upstream.ok,
      hasBody: Boolean(upstream.body),
      contentLength: upstream.headers.get('content-length') ?? undefined,
      contentType: upstream.headers.get('content-type') ?? undefined,
      acceptRanges: upstream.headers.get('accept-ranges') ?? undefined,
    });
    if (!upstream.ok || !upstream.body) {
      cleanup();
      this.log.warn('spotify cdn rejected', { sessionId, status: upstream.status });
      res.writeHead(upstream.status || 502);
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': session.contentType });
    const upstreamStream = Readable.fromWeb(
      upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0],
    );
    const decipher = createDecipheriv('aes-128-ctr', session.key, SPOTIFY_AUDIO_AES_IV);
    const stripper = session.isOgg ? new OggHeaderStripStream() : null;
    const decrypted = upstreamStream.pipe(decipher);
    const out = stripper ? decrypted.pipe(stripper) : decrypted;

    // Byte counters at the CDN edge and at the ffmpeg edge. The gap between them
    // tells us whether an empty stream came from the CDN (upstreamBytes === 0) or
    // was swallowed by decrypt/strip (upstreamBytes > 0, outBytes === 0).
    let upstreamBytes = 0;
    let outBytes = 0;
    upstreamStream.on('data', (chunk: Buffer) => {
      upstreamBytes += chunk.length;
    });
    out.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
    });

    let summarized = false;
    const summarize = (reason: string) => {
      if (summarized) {
        return;
      }
      summarized = true;
      this.log.debug('spotify proxy stream ended', {
        sessionId,
        reason,
        upstreamBytes,
        outBytes,
        oggFound: stripper ? stripper.headerOffset >= 0 && !stripper.gaveUp : undefined,
        oggOffset: stripper ? stripper.headerOffset : undefined,
        oggScanGaveUp: stripper ? stripper.gaveUp : undefined,
      });
    };

    out.pipe(res);

    upstreamStream.on('end', () => summarize('upstream-end'));
    res.on('close', () => summarize('res-close'));
    upstreamStream.on('error', (err) => {
      this.log.warn('spotify upstream stream error', {
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
      cleanup();
    });
    decipher.on('error', cleanup);
  }
}
