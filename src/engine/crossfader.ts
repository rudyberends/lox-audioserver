import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import {
  blendPcmStreams,
  processStdoutChunkSource,
  streamChunkSource,
} from '@/engine/pcmCrossfade';
import type { AudioSession } from '@/engine/audioSession';

export type FadeInSource =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string; headers?: Record<string, string>; decryptionKey?: string }
  | { kind: 'pipe'; stream: NodeJS.ReadableStream; sampleRate: number; channels: number };

/**
 * Orchestrates inline PCM crossfade for the three live pipeline topologies:
 *   1. Two-stage decoder (file/URL): swap decoderProc, replace pcmPipe, encoder stays.
 *   2. Pipe-with-ffmpeg (librespot through encoder): swap upstream pipe source,
 *      replace pcmPipe, encoder stays.
 *   3. Direct passthrough (Spotify pcm, no encoder): blend straight to subscribers,
 *      then wire a pseudo-two-stage pipeline so the next crossfade has somewhere to go.
 *
 * The blend loop itself is in pcmCrossfade.ts; this class wires the per-topology
 * source/dest plumbing around it.
 */
export class Crossfader {
  constructor(private readonly session: AudioSession) {}

  public async inlineCrossfade(fadeIn: FadeInSource, durationSec: number): Promise<boolean> {
    const s = this.session;
    const activePipe = s.pipeSource.current();
    if (s.directPipeMode && activePipe) {
      return this.crossfadeFromDirectPipe(fadeIn, durationSec);
    }
    if (activePipe && s.pipeline.pcmPipe && s.pipeline.encoderInput && !s.pipeline.decoder) {
      return this.crossfadeFromPipeFFmpeg(fadeIn, durationSec);
    }
    if (!s.pipeline.pcmPipe || !s.pipeline.encoderInput || !s.pipeline.decoder) return false;
    if (fadeIn.kind === 'pipe') return false; // pipe fade-in requires pipe fade-out path
    return this.crossfadeFromTwoStageDecoder(fadeIn, durationSec);
  }

  /**
   * PCM crossfade for sources using the two-stage pipeline (decoder ffmpeg →
   * pcmPipe → encoderInput → encoder ffmpeg). The running decoder continues
   * naturally; a new decoder is spawned for the fade-in source. Both PCM
   * streams are blended frame-by-frame and written directly to encoderInput
   * (which stays connected to the encoder FFmpeg throughout).
   */
  private async crossfadeFromTwoStageDecoder(
    fadeIn: Exclude<FadeInSource, { kind: 'pipe' }>,
    durationSec: number,
  ): Promise<boolean> {
    const s = this.session;
    const { sampleRate } = s.outputSettings;
    const totalFrames = Math.round(durationSec * sampleRate);

    // Spawn new decoder for the incoming track.
    const newDecoderArgs = s.args.buildPcmDecoderArgsForSource(fadeIn);
    const newDecoder = spawn(s.ffmpegPath, newDecoderArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    newDecoder.stderr?.on('data', (c: Buffer) => {
      const msg = c.toString().trim();
      if (msg) s.log.debug('new decoder stderr', { zoneId: s.zoneId, message: msg });
    });

    s.crossfadeActive = true;
    const oldDecoder = s.pipeline.decoder as ChildProcessWithoutNullStreams;

    s.log.info('PCM crossfade blend starting', {
      zoneId: s.zoneId, durationSec, totalFrames,
    });
    // If the encoder's stdout was paused (subscriber count dropped to 0 mid-song),
    // resume it now so the blend loop can write PCM without hitting backpressure.
    if (s.stdoutPaused) s.resumeStdout();

    // Keep decoder→pcmPipe intact (avoids OS-pipe stall from unpipe+resume).
    // Only disconnect pcmPipe→encoderInput so we can write blended PCM directly.
    s.pipeline.pcmPipe!.unpipe(s.pipeline.encoderInput);
    // Explicitly resume the backpressure chain: unpiping from encoderInput may have
    // left pcmPipe and decoder.stdout in a paused state.
    s.pipeline.pcmPipe!.resume();
    oldDecoder.stdout.resume();

    // Old PCM arrives on pcmPipe but the *end* signal must come from the decoder's
    // process exit (decoder→pcmPipe uses { end: false }, so pcmPipe never emits 'end').
    const oldSource = processStdoutChunkSource(oldDecoder, s.pipeline.pcmPipe!);
    const newSource = processStdoutChunkSource(newDecoder);

    const { framesProcessed, newRem } = await blendPcmStreams(oldSource, newSource, {
      channels: s.outputSettings.channels,
      bytesPerSample: s.outputSettings.pcmBitDepth / 8,
      totalFrames,
      onBlendedFrame: (blended) => { s.pipeline.encoderInput?.write(blended); },
      log: s.log,
      logContext: { zoneId: s.zoneId },
    });

    s.crossfadeActive = false;
    // Remove old decoder's process-level listeners before killing so its exit does
    // NOT call encoderInput.end() (which would prematurely terminate the encoder).
    oldDecoder.removeAllListeners('exit');
    oldDecoder.removeAllListeners('error');
    oldDecoder.stdout.unpipe(s.pipeline.pcmPipe!);
    oldDecoder.kill('SIGTERM');

    if (newRem.length) s.pipeline.encoderInput!.write(newRem);
    newDecoder.stdout.removeAllListeners('data');
    newDecoder.stdout.removeAllListeners('end');

    // Reconnect: newDecoder → fresh pcmPipe → encoderInput.
    const newPcmPipe = new PassThrough();
    s.pipeline.pcmPipe = newPcmPipe;
    s.pipeline.decoder = newDecoder;

    newDecoder.stdout.pipe(newPcmPipe, { end: false });
    newPcmPipe.pipe(s.pipeline.encoderInput!, { end: false });

    newDecoder.on('exit', (code, signal) => {
      s.log.debug('new decoder exited (after crossfade)', { zoneId: s.zoneId, code, signal });
      if (!s.crossfadeActive) s.pipeline.encoderInput?.end();
    });
    newDecoder.on('error', (err: NodeJS.ErrnoException) => {
      s.log.warn('new decoder error', { zoneId: s.zoneId, message: err.message });
    });

    s.log.info('PCM crossfade complete', {
      zoneId: s.zoneId, framesProcessed, totalFrames, durationSec,
    });
    return true;
  }

  /**
   * PCM crossfade for pipe sources in FFmpeg mode (pipeSource → pcmPipe →
   * encoderInput → FFmpeg). Supports file/URL (spawns a decoder) and pipe
   * (uses stream directly) as fade-in.
   */
  private async crossfadeFromPipeFFmpeg(fadeIn: FadeInSource, durationSec: number): Promise<boolean> {
    const s = this.session;
    const oldPipeStream = s.pipeSource.current();
    if (!s.pipeline.pcmPipe || !s.pipeline.encoderInput || !oldPipeStream) return false;

    const { sampleRate } = s.outputSettings;
    const totalFrames = Math.round(durationSec * sampleRate);

    // New source: either a decoder process (file/url) or a live pipe stream (Spotify-to-Spotify).
    let newSourceStream: NodeJS.ReadableStream;
    let newDecoder: ChildProcessWithoutNullStreams | undefined;
    if (fadeIn.kind === 'pipe') {
      newSourceStream = fadeIn.stream;
    } else {
      newDecoder = spawn(s.ffmpegPath, s.args.buildPcmDecoderArgsForSource(fadeIn), {
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      newDecoder.stderr?.on('data', (c: Buffer) => {
        const msg = c.toString().trim();
        if (msg) s.log.debug('new decoder stderr', { zoneId: s.zoneId, message: msg });
      });
      newSourceStream = newDecoder.stdout;
    }

    s.crossfadeActive = true;
    s.log.info('PCM crossfade blend starting (pipe-ffmpeg)', {
      zoneId: s.zoneId, durationSec, totalFrames, fadeInKind: fadeIn.kind,
    });
    if (s.stdoutPaused) s.resumeStdout();

    s.pipeline.pcmPipe.unpipe(s.pipeline.encoderInput);
    s.pipeline.pcmPipe.resume();

    // Old PCM arrives on pcmPipe but the end-signal must come from the upstream
    // pipe source (librespot's stream); pcmPipe itself uses { end: false } piping.
    const oldSource = streamChunkSource(oldPipeStream);
    const newSource = streamChunkSource(newSourceStream);

    const { framesProcessed, newRem } = await blendPcmStreams(oldSource, newSource, {
      channels: s.outputSettings.channels,
      bytesPerSample: s.outputSettings.pcmBitDepth / 8,
      totalFrames,
      onBlendedFrame: (blended) => s.pipeline.encoderInput?.write(blended),
      log: s.log,
      logContext: { zoneId: s.zoneId },
    });

    s.crossfadeActive = false;
    s.pipeline.pcmPipe.removeAllListeners('data');
    s.pipeSource.detach(s.pipeline.pcmPipe);

    if (newRem.length) s.pipeline.encoderInput!.write(newRem);
    newSourceStream.removeAllListeners('data');
    newSourceStream.removeAllListeners('end');

    const newPcmPipe = new PassThrough();
    s.pipeline.pcmPipe = newPcmPipe;

    if (fadeIn.kind === 'pipe') {
      // Pipe fade-in: wire the new Spotify stream as the new pcmPipe source.
      s.pipeSource.adopt(fadeIn.stream);
      fadeIn.stream.pipe(newPcmPipe, { end: false });
      newPcmPipe.pipe(s.pipeline.encoderInput!, { end: false });
      s.pipeSource.onEndOrClose(() => {
        if (!s.crossfadeActive && !s.ending) s.pipeline.encoderInput?.end();
      });
      s.pipeSource.onError((err: unknown) => {
        s.log.warn('crossfade pipe stream error', { zoneId: s.zoneId, message: err instanceof Error ? err.message : String(err) });
        if (!s.crossfadeActive && !s.ending) s.pipeline.encoderInput?.end();
      });
    } else {
      // Decoder fade-in: wire the decoder as the new pipeline.decoder.
      s.pipeline.decoder = newDecoder!;
      newDecoder!.stdout.pipe(newPcmPipe, { end: false });
      newPcmPipe.pipe(s.pipeline.encoderInput!, { end: false });
      newDecoder!.on('exit', (code, signal) => {
        s.log.debug('new decoder exited (after pipe-ffmpeg crossfade)', { zoneId: s.zoneId, code, signal });
        if (!s.crossfadeActive) s.pipeline.encoderInput?.end();
      });
      newDecoder!.on('error', (err: NodeJS.ErrnoException) => {
        s.log.warn('new decoder error', { zoneId: s.zoneId, message: err.message });
      });
    }

    s.log.info('PCM crossfade complete (pipe-ffmpeg)', {
      zoneId: s.zoneId, framesProcessed, totalFrames, durationSec,
    });
    return true;
  }

  /**
   * PCM crossfade for pipe sources in direct-passthrough mode (profile=pcm,
   * no FFmpeg). Blended PCM is written directly to subscribers. Afterwards a
   * pseudo-two-stage pipeline is wired so future crossfades on the new track
   * work normally.
   */
  private async crossfadeFromDirectPipe(fadeIn: FadeInSource, durationSec: number): Promise<boolean> {
    const s = this.session;
    const oldStreamAtEntry = s.pipeSource.current();
    if (!s.directPipeMode || !oldStreamAtEntry) return false;

    const { sampleRate } = s.outputSettings;
    const totalFrames = Math.round(durationSec * sampleRate);

    let newSourceStream: NodeJS.ReadableStream;
    let newDecoder: ChildProcessWithoutNullStreams | undefined;
    if (fadeIn.kind === 'pipe') {
      newSourceStream = fadeIn.stream;
    } else {
      newDecoder = spawn(s.ffmpegPath, s.args.buildPcmDecoderArgsForSource(fadeIn), {
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      newDecoder.stderr?.on('data', (c: Buffer) => {
        const msg = c.toString().trim();
        if (msg) s.log.debug('new decoder stderr', { zoneId: s.zoneId, message: msg });
      });
      newSourceStream = newDecoder.stdout;
    }

    s.crossfadeActive = true;
    const oldStream = oldStreamAtEntry;

    s.log.info('PCM crossfade blend starting (direct-pipe)', {
      zoneId: s.zoneId, durationSec, totalFrames, fadeInKind: fadeIn.kind,
    });
    if (s.stdoutPaused) s.resumeStdout();

    // Strip the session-level data listener so the old stream goes silent for the
    // session; we add a private collector below for the duration of the blend.
    s.pipeSource.detach();

    const oldSource = streamChunkSource(oldStream);
    const newSource = streamChunkSource(newSourceStream);
    oldStream.resume();

    const { framesProcessed, newRem } = await blendPcmStreams(oldSource, newSource, {
      channels: s.outputSettings.channels,
      bytesPerSample: s.outputSettings.pcmBitDepth / 8,
      totalFrames,
      onBlendedFrame: (blended) => {
        s.buffer.push(blended);
        s.writeToSubscribers(blended);
      },
      log: s.log,
      logContext: { zoneId: s.zoneId },
    });

    s.crossfadeActive = false;
    s.directPipeMode = false;

    if (newRem.length) {
      s.buffer.push(newRem);
      s.writeToSubscribers(newRem);
    }
    newSourceStream.removeAllListeners('data');
    newSourceStream.removeAllListeners('end');

    // Wire a pseudo-two-stage pipeline so future inlineCrossfade calls work on the new track.
    const newPcmPipe = new PassThrough();
    const newEncoderInput = new PassThrough();
    s.pipeline.pcmPipe = newPcmPipe;
    s.pipeline.encoderInput = newEncoderInput;

    newEncoderInput.on('data', (chunk: Buffer) => {
      const aligned = s.alignPcmChunk(chunk);
      if (aligned?.length) {
        s.buffer.push(aligned);
        s.writeToSubscribers(aligned);
      }
    });
    newEncoderInput.on('end', () => {
      if (!s.crossfadeActive && !s.ending) s.cleanup();
    });

    if (fadeIn.kind === 'pipe') {
      s.pipeSource.adopt(fadeIn.stream);
      fadeIn.stream.pipe(newPcmPipe, { end: false });
      newPcmPipe.pipe(newEncoderInput, { end: false });
      s.pipeSource.onEndOrClose(() => {
        if (!s.crossfadeActive && !s.ending) newEncoderInput.end();
      });
      s.pipeSource.onError((err: unknown) => {
        s.log.warn('crossfade pipe stream error', { zoneId: s.zoneId, message: err instanceof Error ? err.message : String(err) });
        if (!s.crossfadeActive && !s.ending) newEncoderInput.end();
      });
    } else {
      s.pipeline.decoder = newDecoder!;
      newDecoder!.stdout.pipe(newPcmPipe, { end: false });
      newPcmPipe.pipe(newEncoderInput, { end: false });
      newDecoder!.on('exit', (code, signal) => {
        s.log.debug('new decoder exited (after direct-pipe crossfade)', { zoneId: s.zoneId, code, signal });
        if (!s.crossfadeActive) newEncoderInput.end();
      });
      newDecoder!.on('error', (err: NodeJS.ErrnoException) => {
        s.log.warn('new decoder error', { zoneId: s.zoneId, message: err.message });
      });
    }

    s.log.info('PCM crossfade complete (direct-pipe)', {
      zoneId: s.zoneId, framesProcessed, totalFrames, durationSec,
    });
    return true;
  }
}
