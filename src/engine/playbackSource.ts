/**
 * Discriminated union of the source kinds an AudioSession can consume.
 *   - file: a local file path (ffmpeg `-i path`)
 *   - url:  an HTTP/HTTPS stream (ffmpeg `-i url`, supports reconnect/TLS/headers)
 *   - pipe: an inbound raw-PCM pipe (filesystem path, or an in-process Readable
 *           via `stream`; used by librespot, Spotify direct-passthrough, etc.)
 */
export type PlaybackSource =
  | {
      kind: 'file';
      path: string;
      loop?: boolean;
      preDelayMs?: number;
      /** Optional start offset in seconds. */
      startAtSec?: number;
      /** Whether ffmpeg should pace input with -re (default: true). */
      realTime?: boolean;
    }
  | {
      kind: 'url';
      url: string;
      preDelayMs?: number;
      headers?: Record<string, string>;
      decryptionKey?: string;
      tlsVerifyHost?: string;
      inputFormat?: string;
      logLevel?: string;
      /** Optional start offset in seconds. */
      startAtSec?: number;
      /** Optional loudness gain in dB applied via an ffmpeg volume filter (e.g. Spotify normalisation). */
      gainDb?: number;
      realTime?: boolean;
      lowLatency?: boolean;
      restartOnFailure?: boolean;
      /**
       * Native audio format of this stream, when the provider knows it up front.
       * Lets the engine skip a pointless resample (e.g. Apple Music always serves
       * 44.1 kHz AAC-LC stereo, so resampling to a 48 kHz sink alters every sample
       * for nothing). Omit when unknown — the engine then resamples as before.
       *
       * Declaring this avoids a second HTTP request to probe the URL, which for
       * DRM-protected or single-use segment URLs is either wasteful or unsafe.
       */
      nativeFormat?: {
        sampleRate: number;
        channels: number;
        /** Omit for lossy codecs; there is no original depth to preserve. */
        bitDepth?: 16 | 24 | 32;
        lossless: boolean;
        codecName?: string;
      };
    }
  | {
      kind: 'pipe';
      path: string;
      preDelayMs?: number;
      format?: 's16le' | 's24le' | 's32le' | 's16be';
      sampleRate?: number;
      channels?: number;
      /** Whether ffmpeg should pace input with -re (default: true). */
      realTime?: boolean;
      /** Optional shared readable stream to feed directly (bypasses URL). */
      stream?: NodeJS.ReadableStream;
    };
