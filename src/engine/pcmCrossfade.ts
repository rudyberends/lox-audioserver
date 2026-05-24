import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * A PCM-emitting source seen from the blender's point of view. Implementations
 * differ in *what* signals "ended" (decoder process exit, stream `end` event,
 * stalled-and-silent), but the blender only sees an `isEnded()` predicate plus
 * data via a `chunks` array filled by the attached listener.
 */
export interface PcmChunkSource {
  /** Listener that pushes incoming PCM chunks into the supplied array. */
  attach(chunks: Buffer[]): void;
  /** Remove the data listener and any ended-tracking listeners. */
  detach(): void;
  /** True when the source has signalled completion (stream end / process exit). */
  isEnded(): boolean;
}

/**
 * Adopts a Readable stream; `isEnded()` flips when the stream emits `end`.
 * Used when the source's lifetime is governed by the stream itself
 * (pipe-source from librespot, fade-in pipe stream).
 */
export function streamChunkSource(stream: NodeJS.ReadableStream): PcmChunkSource {
  let ended = false;
  let data: ((chunk: Buffer) => void) | undefined;
  const onEnd = () => { ended = true; };
  return {
    attach(chunks: Buffer[]): void {
      data = (chunk: Buffer) => chunks.push(chunk);
      stream.on('data', data);
      stream.once('end', onEnd);
    },
    detach(): void {
      if (data) stream.off('data', data);
      stream.off('end', onEnd);
      data = undefined;
    },
    isEnded: () => ended,
  };
}

/**
 * Adopts a child process's stdout; `isEnded()` flips when the *process* exits.
 * Used when stdout is piped with `{ end: false }`, so the stream's `end` event
 * never fires — the decoder exit is the only reliable end-signal.
 */
export function processStdoutChunkSource(
  proc: ChildProcessWithoutNullStreams,
  stream: NodeJS.ReadableStream = proc.stdout,
): PcmChunkSource {
  let ended = false;
  let data: ((chunk: Buffer) => void) | undefined;
  const onExit = () => { ended = true; };
  return {
    attach(chunks: Buffer[]): void {
      data = (chunk: Buffer) => chunks.push(chunk);
      stream.on('data', data);
      proc.once('exit', onExit);
    },
    detach(): void {
      if (data) stream.off('data', data);
      proc.off('exit', onExit);
      data = undefined;
    },
    isEnded: () => ended,
  };
}

export interface PcmBlendLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface PcmBlendOptions {
  channels: number;
  /** Linear-ramp length in PCM frames. */
  totalFrames: number;
  /** Returns true when the old source has stopped producing chunks. */
  getOldEnded: () => boolean;
  /** Returns true when the new source has stopped producing chunks. */
  getNewEnded: () => boolean;
  /** Called every 10 ms tick with the linearly cross-faded PCM. */
  onBlendedFrame: (blended: Buffer) => void;
  log: PcmBlendLogger;
  logContext: Record<string, unknown>;
}

/**
 * Linear PCM crossfade blend loop. Caller fills `oldChunks`/`newChunks` via
 * concurrent data-event listeners; this function drains them on a 10 ms timer
 * and emits a frame-aligned blended buffer until `totalFrames` is reached.
 *
 * Stall handling: a Spotify pipe-source PassThrough never fires `'end'` when
 * the track ends — librespot just stops writing. If we waited for `*Ended` we
 * would spin forever (which previously caused the blend to hang for minutes
 * and orphan the whole audio session). When one source has been silent longer
 * than STALL_MS *after producing at least one chunk* we treat its samples as
 * silence so the linear ramp keeps running and the blend completes within
 * `totalFrames`.
 *
 * Sources that have never produced data get a separate STARTUP_TIMEOUT_MS
 * budget (librespot needs ~600 ms before its first PCM chunk arrives).
 * Without this we would bail at framesProcessed=0 whenever the OLD librespot
 * was already stalled before the trigger fired (e.g., a 4 s pcm_stall right
 * before song-end).
 */
export async function runPcmBlend(
  oldChunks: Buffer[],
  newChunks: Buffer[],
  options: PcmBlendOptions,
): Promise<{ framesProcessed: number; newRem: Buffer }> {
  const { channels, totalFrames, getOldEnded, getNewEnded, onBlendedFrame, log, logContext } = options;
  const frameBytes = channels * 2;
  let framesProcessed = 0;
  let oldRem = Buffer.alloc(0);
  let newRem = Buffer.alloc(0);
  const STALL_MS = 300;
  const STARTUP_TIMEOUT_MS = 1500;
  const startTs = Date.now();
  let oldLastDataAt = startTs;
  let newLastDataAt = startTs;
  let oldHasProduced = false;
  let newHasProduced = false;
  let oldStallLogged = false;
  let newStallLogged = false;

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const now = Date.now();
      if (oldChunks.length) {
        oldRem = Buffer.concat([oldRem, ...oldChunks.splice(0)]);
        oldLastDataAt = now;
        oldHasProduced = true;
      }
      if (newChunks.length) {
        newRem = Buffer.concat([newRem, ...newChunks.splice(0)]);
        newLastDataAt = now;
        newHasProduced = true;
      }

      const elapsedMs = now - startTs;
      const oldStalledAfterProducing =
        oldHasProduced && oldRem.length < frameBytes && now - oldLastDataAt > STALL_MS;
      const oldNeverStarted = !oldHasProduced && elapsedMs > STARTUP_TIMEOUT_MS;
      const oldEffectivelyDone = getOldEnded() || oldStalledAfterProducing || oldNeverStarted;

      const newStalledAfterProducing =
        newHasProduced && newRem.length < frameBytes && now - newLastDataAt > STALL_MS;
      const newNeverStarted = !newHasProduced && elapsedMs > STARTUP_TIMEOUT_MS;
      const newEffectivelyDone = getNewEnded() || newStalledAfterProducing || newNeverStarted;

      if (oldEffectivelyDone && !oldStallLogged) {
        oldStallLogged = true;
        log.debug('PCM crossfade old source stalled — using silence for remaining blend', {
          ...logContext, framesProcessed, totalFrames,
          oldEnded: getOldEnded(), oldHasProduced, elapsedMs,
        });
      }
      if (newEffectivelyDone && !newStallLogged) {
        newStallLogged = true;
        log.debug('PCM crossfade new source stalled — using silence for remaining blend', {
          ...logContext, framesProcessed, totalFrames,
          newEnded: getNewEnded(), newHasProduced, elapsedMs,
        });
      }

      if (oldEffectivelyDone && newEffectivelyDone) {
        log.warn('PCM crossfade blend ended early', {
          ...logContext, framesProcessed, totalFrames,
          oldEnded: getOldEnded(), newEnded: getNewEnded(),
          oldHasProduced, newHasProduced, elapsedMs,
        });
        clearInterval(timer);
        resolve();
        return;
      }

      // Bound how many frames to process this tick so we never write a multi-second
      // burst to the encoder when one side stalls and the other has buffered ahead.
      const remainingFrames = totalFrames - framesProcessed;
      const oldAvailFrames = oldEffectivelyDone ? remainingFrames : Math.floor(oldRem.length / frameBytes);
      const newAvailFrames = newEffectivelyDone ? remainingFrames : Math.floor(newRem.length / frameBytes);
      const framesThisTick = Math.min(oldAvailFrames, newAvailFrames, remainingFrames);
      if (framesThisTick <= 0) {
        return;
      }

      const blended = Buffer.alloc(framesThisTick * frameBytes);
      let oldOff = 0;
      let newOff = 0;
      for (let f = 0; f < framesThisTick; f++) {
        const t = Math.min(1, framesProcessed / totalFrames);
        const dstOff = f * frameBytes;
        for (let ch = 0; ch < channels; ch++) {
          const co = ch * 2;
          const a = oldEffectivelyDone ? 0 : oldRem.readInt16LE(oldOff + co);
          const b = newEffectivelyDone ? 0 : newRem.readInt16LE(newOff + co);
          blended.writeInt16LE(
            Math.max(-32768, Math.min(32767, Math.round(a * (1 - t) + b * t))),
            dstOff + co,
          );
        }
        if (!oldEffectivelyDone) oldOff += frameBytes;
        if (!newEffectivelyDone) newOff += frameBytes;
        framesProcessed++;
      }
      if (!oldEffectivelyDone) oldRem = oldRem.subarray(oldOff);
      if (!newEffectivelyDone) newRem = newRem.subarray(newOff);
      onBlendedFrame(blended);

      if (framesProcessed >= totalFrames) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
  });

  return { framesProcessed, newRem };
}

export interface BlendStreamsOptions {
  channels: number;
  /** Linear-ramp length in PCM frames. */
  totalFrames: number;
  onBlendedFrame: (blended: Buffer) => void;
  log: PcmBlendLogger;
  logContext: Record<string, unknown>;
}

/**
 * Orchestrate a PCM crossfade between two `PcmChunkSource`s. Wires data
 * collectors, runs `runPcmBlend`, then guarantees the sources are detached
 * even on error. Returns framesProcessed plus any leftover new-source PCM
 * that arrived during the final tick (callers may want to forward it).
 */
export async function blendPcmStreams(
  oldSource: PcmChunkSource,
  newSource: PcmChunkSource,
  options: BlendStreamsOptions,
): Promise<{ framesProcessed: number; newRem: Buffer }> {
  const oldChunks: Buffer[] = [];
  const newChunks: Buffer[] = [];
  oldSource.attach(oldChunks);
  newSource.attach(newChunks);
  try {
    return await runPcmBlend(oldChunks, newChunks, {
      channels: options.channels,
      totalFrames: options.totalFrames,
      getOldEnded: () => oldSource.isEnded(),
      getNewEnded: () => newSource.isEnded(),
      onBlendedFrame: options.onBlendedFrame,
      log: options.log,
      logContext: options.logContext,
    });
  } finally {
    oldSource.detach();
    newSource.detach();
  }
}
