/**
 * `PlaybackSource` ⇄ `EngineInputSpec`, in one place.
 *
 * These two types describe the same thing on either side of the engine port, and they were converted by
 * two hand-written mappers a layer apart — `AudioManager.toEngineInputSpec` on the way in and
 * `EngineAdapter.toPlaybackSource` on the way out. Nothing made them agree: both are exhaustive-looking
 * object literals, so a field added to the types compiles fine while being silently dropped in transit.
 *
 * That cost real audio. `nativeFormat` (a provider declaring "this stream is 44.1 kHz AAC-LC stereo") and
 * `gainDb` (a provider's loudness normalisation) were declared, typed on both sides, and lost on the way
 * to the engine — so every Apple Music track was resampled 44.1 → 44.1 through soxr for nothing, and the
 * public API reported "source not reported" for a format the provider had stated up front. `realTime:
 * false` on a file source was lost the other way, quietly re-enabling ffmpeg's `-re` pacing.
 *
 * One module, both directions, and a round-trip test that populates every optional field — which is the
 * closest thing to compiler pressure a hand mapper can get. A field added to `EngineInputSpec` now fails
 * that test until it is carried here.
 */
import type { EngineInputSpec, PlaybackSource } from '@/ports/EngineTypes';

/** A resolved source, as the engine port accepts it. */
export function toEngineInputSpec(source: PlaybackSource): EngineInputSpec {
  switch (source.kind) {
    case 'url':
      return {
        kind: 'url',
        url: source.url,
        preDelayMs: source.preDelayMs,
        headers: source.headers,
        decryptionKey: source.decryptionKey,
        tlsVerifyHost: source.tlsVerifyHost,
        inputFormat: source.inputFormat,
        logLevel: source.logLevel,
        startAtSec: source.startAtSec,
        gainDb: source.gainDb,
        realTime: source.realTime,
        lowLatency: source.lowLatency,
        restartOnFailure: source.restartOnFailure,
        nativeFormat: source.nativeFormat,
      };
    case 'pipe':
      return {
        kind: 'pipe',
        path: source.path,
        preDelayMs: source.preDelayMs,
        format: source.format,
        sampleRate: source.sampleRate,
        channels: source.channels,
        realTime: source.realTime,
        stream: source.stream,
      };
    case 'file':
      return {
        kind: 'file',
        path: source.path,
        loop: source.loop,
        preDelayMs: source.preDelayMs,
        startAtSec: source.startAtSec,
        realTime: source.realTime,
        nativeFormat: source.nativeFormat,
      };
    default:
      throw new Error('Unknown PlaybackSource.');
  }
}

/**
 * The same source, as the engine's own type.
 *
 * `silence` has no engine representation — it is a scheduling concept for outputs that must keep a stream
 * open — so it throws rather than being mapped to something that would play.
 */
export function toPlaybackSource(input: EngineInputSpec): PlaybackSource {
  switch (input.kind) {
    case 'url':
      return {
        kind: 'url',
        url: input.url,
        preDelayMs: input.preDelayMs,
        headers: input.headers,
        decryptionKey: input.decryptionKey,
        tlsVerifyHost: input.tlsVerifyHost,
        inputFormat: input.inputFormat,
        logLevel: input.logLevel,
        startAtSec: input.startAtSec,
        gainDb: input.gainDb,
        realTime: input.realTime,
        lowLatency: input.lowLatency,
        restartOnFailure: input.restartOnFailure,
        nativeFormat: input.nativeFormat,
      };
    case 'pipe':
      return {
        kind: 'pipe',
        path: input.path,
        preDelayMs: input.preDelayMs,
        format: input.format,
        sampleRate: input.sampleRate,
        channels: input.channels,
        realTime: input.realTime,
        stream: input.stream,
      };
    case 'file':
      return {
        kind: 'file',
        path: input.path,
        loop: input.loop,
        preDelayMs: input.preDelayMs,
        startAtSec: input.startAtSec,
        realTime: input.realTime,
        nativeFormat: input.nativeFormat,
      };
    case 'silence':
      throw new Error('EngineInputSpec kind "silence" is not supported by the audio engine.');
    default:
      throw new Error('Unknown EngineInputSpec.');
  }
}
