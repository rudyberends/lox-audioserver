import { PassThrough } from 'node:stream';
import { FFMPEG_LOW_LATENCY_ARGS } from '@/engine/ffmpegArgs';
import { PcmDspStage } from '@/engine/pcmDsp';
import type { AudioSession } from '@/engine/audioSession';

/**
 * Strategy class that owns the four "how to start an AudioSession" paths.
 * Each method assumes the session has already done its common pre-init
 * (buffer.clear, pcmAligner.reset, firstChunk.arm, etc.) — this class
 * just wires up the source-specific pipeline.
 */
export class SessionStarter {
  constructor(private readonly session: AudioSession) {}

  /**
   * Pipe source, profile=pcm, format/rate/channels already match output settings, no
   * filter chain needed. Stream bytes straight to subscribers without an ffmpeg hop.
   */
  public startDirectPipe(
    stream: NodeJS.ReadableStream,
    fmt: string,
    sr: number,
    ch: number,
  ): void {
    const s = this.session;
    s.pipeSource.adopt(stream);
    s.directPipeMode = true;
    s.startTs = Date.now();
    s.log.info('using direct pipe passthrough', {
      zoneId: s.zoneId,
      profile: s.profile,
      format: fmt,
      sampleRate: sr,
      channels: ch,
    });

    let sourceBytesSinceLog = 0;
    let sourceLastLogTs = 0;
    let sourceFirstChunkLogged = false;
    s.pipeSource.onData((chunk: Buffer) => {
      if (!chunk?.length) {
        return;
      }
      sourceBytesSinceLog += chunk.length;
      if (!sourceFirstChunkLogged) {
        sourceFirstChunkLogged = true;
        s.log.info('pipe source first chunk', {
          zoneId: s.zoneId,
          bytes: chunk.length,
          format: fmt,
          sampleRate: sr,
          channels: ch,
        });
      }
      const now = Date.now();
      if (!sourceLastLogTs) {
        sourceLastLogTs = now;
      } else {
        const elapsed = now - sourceLastLogTs;
        if (elapsed >= 1000) {
          const bps = Math.round((sourceBytesSinceLog / elapsed) * 1000);
          s.log.spam('pipe source throughput', {
            zoneId: s.zoneId,
            bytesPerSec: bps,
          });
          sourceLastLogTs = now;
          sourceBytesSinceLog = 0;
        }
      }

      s.emitOutputChunk(chunk, { firstChunkLabel: 'direct pipe first chunk' });
    });
    s.pipeSource.onError((err: unknown) => {
      s.log.warn('pipe source error', {
        zoneId: s.zoneId,
        message: (err as { message?: string } | null)?.message || String(err),
      });
      if (!s.ending) {
        s.cleanup();
      }
    });
    s.pipeSource.onEndOrClose(() => {
      s.log.debug('pipe source ended', { zoneId: s.zoneId, profile: s.profile });
      if (!s.ending) {
        s.cleanup();
      }
    });
  }

  /**
   * Pipe source that needs filter/codec conversion. PCM is bridged through pcmPipe →
   * encoderInput so a crossfade can swap the source without dropping ffmpeg.
   */
  public startPipeWithFfmpeg(
    stream: NodeJS.ReadableStream,
    fmt: string,
    sr: number,
    ch: number,
  ): void {
    const s = this.session;
    s.pipeSource.detach(s.pipeline.pcmPipe);
    s.pipeSource.adopt(stream);
    const paceInput = (s.source as { realTime?: boolean }).realTime !== false;
    // When pacing is enabled, apply -re so ffmpeg throttles to real-time. Without it,
    // ffmpeg may read from the upstream pipe as fast as possible which makes the
    // Sendspin timestamps run ahead of wall clock and causes the client to speed up.
    // The low-latency-args include -probesize 32k -analyzeduration 0 even though the
    // format is explicitly specified via -f. This is intentional: even with an explicit
    // format, ffmpeg still runs an analyze phase that buffers ~1.1 s of PCM before
    // producing any output. Setting analyzeduration=0 reduces that to ~50 ms.
    const inputArgs = [
      ...FFMPEG_LOW_LATENCY_ARGS,
      ...(paceInput ? ['-re'] : []),
      '-f', fmt,
      '-ar', String(sr),
      '-ac', String(ch),
      '-i', 'pipe:0',
    ];
    const args = [
      // `-nostats` because the log level may be `info` purely to get the input banner (see
      // `getLogLevel`), and info-level progress lines would otherwise arrive twice a second.
      '-hide_banner', '-nostats', '-loglevel', s.args.getLogLevel(),
      ...inputArgs,
      ...s.args.buildOutputArgs(s.equalizerBands),
      'pipe:1',
    ];

    s.log.debug('spawning ffmpeg (pipe stream)', {
      zoneId: s.zoneId,
      args,
      inputFormat: fmt,
      inputSampleRate: sr,
      inputChannels: ch,
      outputSampleRate: s.outputSettings.sampleRate,
      outputChannels: s.outputSettings.channels,
      outputBitDepth: s.outputSettings.pcmBitDepth,
      profile: s.profile,
    });
    // Insert PassThrough chain so crossfade can blend PCM before the encoder.
    // stream → pcmPipe → encoderInput → FFmpeg.stdin
    const pcmBridge = new PassThrough();
    const encInput = new PassThrough();
    s.pipeline.pcmPipe = pcmBridge;
    s.pipeline.encoderInput = encInput;
    stream.pipe(pcmBridge, { end: false });
    pcmBridge.pipe(encInput, { end: false });

    s.pipeSource.onEndOrClose(() => {
      try { stream.unpipe(pcmBridge); } catch { /* ignore */ }
      if (!s.crossfadeActive && !s.ending) encInput.end();
    });
    s.pipeSource.onError((err: unknown) => {
      s.log.warn('pipe source error', {
        zoneId: s.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
      encInput.destroy();
    });

    s.startTs = Date.now();
    let proc: ReturnType<AudioSession['spawnFfmpeg']>;
    proc = s.spawnFfmpeg(args, {
      restartOnFailure: false,
      logFirstChunk: false,
      onExit: () => {
        try { encInput.unpipe(proc.stdin); } catch { /* ignore */ }
      },
    });
    encInput.pipe(proc.stdin);
    proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err?.code === 'EPIPE') {
        s.log.debug('ffmpeg stdin closed (EPIPE)', { zoneId: s.zoneId });
      } else {
        s.log.warn('ffmpeg stdin error', {
          zoneId: s.zoneId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Monitor incoming source stream for pacing visibility.
    let sourceBytesSinceLog = 0;
    let sourceLastLogTs = 0;
    let sourceFirstChunkLogged = false;
    s.pipeSource.onData((chunk: Buffer) => {
      if (!chunk?.length) {
        return;
      }
      sourceBytesSinceLog += chunk.length;
      if (!sourceFirstChunkLogged) {
        sourceFirstChunkLogged = true;
        s.log.info('pipe source first chunk', {
          zoneId: s.zoneId,
          bytes: chunk.length,
          format: fmt,
          sampleRate: sr,
          channels: ch,
          spawnToFirstInputMs: s.startTs ? Math.max(0, Date.now() - s.startTs) : null,
        });
      }
      const now = Date.now();
      if (!sourceLastLogTs) {
        sourceLastLogTs = now;
        return;
      }
      const elapsed = now - sourceLastLogTs;
      if (elapsed >= 1000) {
        const bps = Math.round((sourceBytesSinceLog / elapsed) * 1000);
        s.log.spam('pipe source throughput', {
          zoneId: s.zoneId,
          bytesPerSec: bps,
        });
        sourceLastLogTs = now;
        sourceBytesSinceLog = 0;
      }
    });

    s.process = proc;
  }

  /**
   * Pipe source without an attached stream (rare fallback). Builds input args from
   * the source path and runs a single ffmpeg without the pcmPipe/encoderInput bridge.
   */
  public startSingleStage(): void {
    const s = this.session;
    const args = [
      // `-nostats` because the log level may be `info` purely to get the input banner (see
      // `getLogLevel`), and info-level progress lines would otherwise arrive twice a second.
      '-hide_banner', '-nostats', '-loglevel', s.args.getLogLevel(),
      ...s.args.buildInputArgs(),
      ...s.args.buildOutputArgs(s.equalizerBands),
      'pipe:1',
    ];

    s.log.debug('spawning ffmpeg', {
      zoneId: s.zoneId,
      args,
      outputSampleRate: s.outputSettings.sampleRate,
      outputChannels: s.outputSettings.channels,
      outputBitDepth: s.outputSettings.pcmBitDepth,
      profile: s.profile,
    });
    s.startTs = Date.now();
    s.process = s.spawnFfmpeg(args, {
      // After the file/url guard, only pipe/crossfade sources reach here.
      restartOnFailure: s.source.kind === 'pipe',
      logFirstChunk: true,
    });
  }

  /**
   * File/URL source with DSP: ffmpeg decodes and resamples to float, our own stage owns the gain, the
   * equalizer and the requantisation, and only a codec profile needs an encoder behind it.
   *
   *   decoder ffmpeg (→ f32le) → PcmDspStage (→ int) → subscribers
   *                                                  ↳ encoder ffmpeg → subscribers   (flac/mp3/aac/opus)
   *
   * The point is not fewer processes (though a PCM zone does drop one): it is that the DSP no longer
   * lives inside a process whose command line is fixed for its lifetime, so an EQ change is a
   * coefficient swap instead of a respawn with a re-seek.
   */
  public startEngineDsp(): void {
    const s = this.session;
    const spec = s.args.engineDspSpec(s.equalizerBands) ?? { gainDb: 0, bands: null };
    const dsp = new PcmDspStage({
      sampleRate: s.outputSettings.sampleRate,
      channels: s.outputSettings.channels,
      bitDepth: s.outputSettings.pcmBitDepth,
      floatOutput: s.args.engineDspEmitsFloat(),
      gainDb: spec.gainDb,
      bands: spec.bands,
    });
    s.dsp = dsp;
    s.engineDspMode = true;
    s.startTs = Date.now();

    const decoderArgs = s.args.buildF32DecoderArgs();
    s.log.debug('spawning ffmpeg (engine-dsp decoder)', {
      zoneId: s.zoneId,
      args: decoderArgs,
      profile: s.profile,
      gainDb: spec.gainDb,
      equalizer: spec.bands ? [...spec.bands] : null,
    });
    const decoder = s.pipeline.spawnDecoder(decoderArgs, {
      onEnded: () => {
        // End the stage so a codec encoder flushes and finishes; the PCM profile's own 'end' handler
        // below takes it from there.
        if (!dsp.destroyed && !dsp.writableEnded) {
          dsp.end();
        }
      },
    });
    decoder.stdout.pipe(dsp);
    dsp.on('error', (err: Error) => {
      s.log.warn('engine dsp stage error', { zoneId: s.zoneId, message: err.message });
      if (!s.ending) {
        s.cleanup();
      }
    });

    if (s.profile === 'pcm') {
      // No encoder: the stage's output *is* the session's output.
      s.outputReadable = dsp;
      dsp.on('data', (chunk: Buffer) => {
        s.emitOutputChunk(chunk, { firstChunkLabel: 'engine dsp first chunk' });
      });
      dsp.on('end', () => {
        s.log.debug('engine dsp stage ended', { zoneId: s.zoneId, profile: s.profile });
        s.handleProducerEnded();
      });
      return;
    }

    const encoderArgs = s.args.buildEngineDspEncoderArgs();
    s.log.debug('spawning ffmpeg (engine-dsp encoder)', {
      zoneId: s.zoneId,
      args: encoderArgs,
      profile: s.profile,
    });
    s.process = s.spawnFfmpeg(encoderArgs, { logFirstChunk: true, stdinStream: dsp });
  }

  /**
   * File/URL source. Starts the two-stage pipeline (decoder ffmpeg → pcmPipe →
   * encoderInput → encoder ffmpeg) so crossfade can blend raw PCM.
   */
  public startTwoStage(): void {
    const s = this.session;
    s.startTs = Date.now();

    const decoderArgs = s.args.buildPcmDecoderArgs();
    s.log.debug('spawning ffmpeg (decoder)', { zoneId: s.zoneId, args: decoderArgs, profile: s.profile });
    s.pipeline.startDecoder(decoderArgs, () => s.crossfadeActive);

    const encoderArgs = s.args.buildPcmEncoderArgs(s.equalizerBands);
    s.log.debug('spawning ffmpeg (encoder)', { zoneId: s.zoneId, args: encoderArgs, profile: s.profile });
    s.process = s.spawnFfmpeg(encoderArgs, {
      logFirstChunk: true,
      stdinStream: s.pipeline.encoderInput,
    });
  }
}
