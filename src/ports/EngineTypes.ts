import type { SessionKey } from '@/ports/types/SessionKey';

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
      /**
       * Native audio format of this file, when the caller knows it up front.
       *
       * Same purpose as the URL variant's: without it the engine cannot tell whether a conversion is
       * needed, so it resamples on the assumption that one is. For a local FLAC that already matches
       * the output that is soxr plus dither over every sample, for nothing.
       *
       * The library records this during its scan, from the same parse it does for tags, so declaring
       * it costs no extra read at playback time. Omit when unknown — the engine then behaves as
       * before.
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
    }
;

export type OutputProfile = 'mp3' | 'aac' | 'pcm' | 'opus' | 'flac';

export type EngineInputSpec =
  | {
      kind: 'file';
      path: string;
      loop?: boolean;
      preDelayMs?: number;
      /** Optional start offset in seconds. */
      startAtSec?: number;
      /** Whether ffmpeg should pace input with -re (default: true). */
      realTime?: boolean;
      /** Native format of the file when the caller knows it — see `PlaybackSource`. */
      nativeFormat?: {
        sampleRate: number;
        channels: number;
        bitDepth?: 16 | 24 | 32;
        lossless: boolean;
        codecName?: string;
      };
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
      stream?: NodeJS.ReadableStream;
      label?: string;
      format?: 's16le' | 's24le' | 's32le' | 's16be';
      sampleRate?: number;
      channels?: number;
      /** Whether ffmpeg should pace input with -re (default: true). */
      realTime?: boolean;
    }
  | { kind: 'silence' };

export type EngineOutputSpec = {
  profile: OutputProfile;
  sampleRate: number;
  channels: number;
  pcmBitDepth?: 16 | 24 | 32;
  prebufferBytes: number;
  fixedGainDb?: number;
  http?: { userAgent?: string; timeoutMs?: number; headers?: Record<string, string> } | null;
};

export type EngineHandoffSpec = {
  waitProfile?: OutputProfile;
  timeoutMs?: number;
};

export type EngineEqualizerSpec = {
  /** 10 dB values aligned with ISO bands (31 Hz .. 16 kHz). */
  bands: ReadonlyArray<number>;
};

export type EngineStartOptions = {
  /** Engine session key. For zone playback this is the zoneId (see SessionKey). */
  zoneId: SessionKey;
  input: EngineInputSpec;
  outputs: EngineOutputSpec[];
  handoff?: EngineHandoffSpec | null;
  /** Apply built-in 10-band EQ to all outputs in this start call. */
  equalizer?: EngineEqualizerSpec | null;
};
