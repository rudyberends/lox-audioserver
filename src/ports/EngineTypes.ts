export type PlaybackSource =
  | {
      kind: 'file';
      path: string;
      loop?: boolean;
      padTailSec?: number;
      preDelayMs?: number;
      /** Optional start offset in seconds. */
      startAtSec?: number;
      /** Whether ffmpeg should pace input with -re (default: true). */
      realTime?: boolean;
    }
  | {
      kind: 'url';
      url: string;
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
      format?: 's16le' | 's24le' | 's32le' | 's16be';
      sampleRate?: number;
      channels?: number;
      /** Whether ffmpeg should pace input with -re (default: true). */
      realTime?: boolean;
      /** Optional shared readable stream to feed directly (bypasses URL). */
      stream?: NodeJS.ReadableStream;
    };

export type OutputProfile = 'mp3' | 'aac' | 'pcm' | 'opus' | 'flac';

export type EngineInputSpec =
  | {
      kind: 'file';
      path: string;
      loop?: boolean;
      padTailSec?: number;
      preDelayMs?: number;
      /** Optional start offset in seconds. */
      startAtSec?: number;
      /** Whether ffmpeg should pace input with -re (default: true). */
      realTime?: boolean;
    }
  | {
      kind: 'url';
      url: string;
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
  http?: { userAgent?: string; timeoutMs?: number; headers?: Record<string, string> } | null;
};

export type EngineHandoffSpec = {
  waitProfile?: OutputProfile;
  timeoutMs?: number;
};

export type EngineStartOptions = {
  zoneId: number;
  input: EngineInputSpec;
  outputs: EngineOutputSpec[];
  handoff?: EngineHandoffSpec | null;
};
