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
      realTime?: boolean;
      lowLatency?: boolean;
      restartOnFailure?: boolean;
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
