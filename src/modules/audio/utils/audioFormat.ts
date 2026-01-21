export type PcmBitDepth = 16 | 24 | 32;
export type HttpProfile = 'default' | 'chunked' | 'forced_content_length';

import os from 'node:os';

export interface AudioOutputSettings {
  sampleRate: number;
  channels: number;
  pcmBitDepth: PcmBitDepth;
  mp3Bitrate: string;
  /** Rolling prebuffer size for late joiners (bytes). */
  prebufferBytes: number;
  /** HTTP streaming profile. */
  httpProfile: HttpProfile;
  /** Fallback length (seconds) when forcing content-length without a known duration. */
  httpFallbackSeconds: number;
  /** Optional fixed gain in dB applied to outgoing audio (e.g. -6). */
  fixedGainDb: number;
  /** Enable ICY metadata (when requested by client). */
  httpIcyEnabled: boolean;
  /** ICY metadata interval (bytes). */
  httpIcyInterval: number;
  /** ICY stream name. */
  httpIcyName: string;
}

export const audioResampler = {
  name: 'soxr',
  precision: 28,
  cutoff: 0.97,
};

// Default to 44.1 kHz PCM; Sendspin clients document fixed support for 44.1kHz/16-bit stereo.
const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_CHANNELS = 2;
const DEFAULT_PCM_BIT_DEPTH: PcmBitDepth = 16;
const DEFAULT_MP3_BITRATE = '256k';
// Default prebuffer based on system memory: keep it lean on low-RAM devices.
const TOTAL_MEM_GB = os.totalmem() / (1024 * 1024 * 1024);
const DEFAULT_PREBUFFER_BYTES =
  TOTAL_MEM_GB >= 8 ? 1024 * 256 : TOTAL_MEM_GB >= 4 ? 1024 * 160 : TOTAL_MEM_GB >= 2 ? 1024 * 96 : 0;
const DEFAULT_HTTP_PROFILE: HttpProfile = 'default';
const DEFAULT_HTTP_FALLBACK_SECONDS = 12 * 3600; // 12h
const DEFAULT_FIXED_GAIN_DB = 0;
const DEFAULT_HTTP_ICY_ENABLED = false;
const DEFAULT_HTTP_ICY_INTERVAL = 16384;
const DEFAULT_HTTP_ICY_NAME = 'lox-audioserver';

export function loadAudioOutputSettings(): AudioOutputSettings {
  return {
    sampleRate: DEFAULT_SAMPLE_RATE,
    channels: DEFAULT_CHANNELS,
    pcmBitDepth: DEFAULT_PCM_BIT_DEPTH,
    mp3Bitrate: DEFAULT_MP3_BITRATE,
    prebufferBytes: DEFAULT_PREBUFFER_BYTES,
    httpProfile: DEFAULT_HTTP_PROFILE,
    httpFallbackSeconds: DEFAULT_HTTP_FALLBACK_SECONDS,
    fixedGainDb: DEFAULT_FIXED_GAIN_DB,
    httpIcyEnabled: DEFAULT_HTTP_ICY_ENABLED,
    httpIcyInterval: DEFAULT_HTTP_ICY_INTERVAL,
    httpIcyName: DEFAULT_HTTP_ICY_NAME,
  };
}

export const audioOutputSettings = loadAudioOutputSettings();

export function pcmCodecFromBitDepth(bitDepth: PcmBitDepth): string {
  switch (bitDepth) {
    case 24:
      return 'pcm_s24le';
    case 32:
      return 'pcm_s32le';
    case 16:
    default:
      return 'pcm_s16le';
  }
}

export function pcmFormatFromBitDepth(bitDepth: PcmBitDepth): string {
  switch (bitDepth) {
    case 24:
      return 's24le';
    case 32:
      return 's32le';
    case 16:
    default:
      return 's16le';
  }
}

export function mp3BitrateToBps(bitrate: string): number {
  const match = /^(\d+)(k?)$/i.exec(bitrate.trim());
  if (!match) {
    return 0;
  }
  const value = Number.parseInt(match[1], 10);
  const isK = match[2]?.toLowerCase() === 'k';
  return isK ? value * 1000 : value;
}

export function buildWavHeader(options: {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}): Buffer {
  const { sampleRate, channels, bitDepth } = options;
  const blockAlign = (channels * bitDepth) / 8;
  const byteRate = sampleRate * blockAlign;
  // Use 0 for sizes to indicate streaming/unknown length.
  const dataSize = 0;
  const chunkSize = 36;
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(chunkSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}
