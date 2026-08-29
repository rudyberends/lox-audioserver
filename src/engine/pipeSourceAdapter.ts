/**
 * Tracks a single upstream pipe source (librespot, Spotify pcm, etc.) plus its
 * data/error/end/close listeners. Callers `adopt()` a stream, attach handlers
 * through the typed methods, and `detach()` to clean up. Adopting a new stream
 * automatically detaches the previous one — this lets crossfade swap the
 * underlying librespot stream without leaking listeners.
 */
export class PipeSourceAdapter {
  private stream?: NodeJS.ReadableStream;
  private dataListener?: (chunk: Buffer) => void;
  private errorListener?: (err: unknown) => void;
  private endListener?: () => void;

  public adopt(stream: NodeJS.ReadableStream): void {
    this.detach();
    this.stream = stream;
  }

  public current(): NodeJS.ReadableStream | undefined {
    return this.stream;
  }

  public onData(listener: (chunk: Buffer) => void): void {
    if (!this.stream) return;
    this.dataListener = listener;
    this.stream.on('data', listener);
  }

  public onError(listener: (err: unknown) => void): void {
    if (!this.stream) return;
    this.errorListener = listener;
    this.stream.on('error', listener);
  }

  /** Single listener fired by either 'end' or 'close' (librespot uses both inconsistently). */
  public onEndOrClose(listener: () => void): void {
    if (!this.stream) return;
    this.endListener = listener;
    this.stream.once('end', listener);
    this.stream.once('close', listener);
  }

  public detach(unpipeTarget?: NodeJS.WritableStream): void {
    if (!this.stream) return;
    if (this.dataListener) this.stream.off('data', this.dataListener);
    if (this.errorListener) this.stream.off('error', this.errorListener);
    if (this.endListener) {
      this.stream.off('end', this.endListener);
      this.stream.off('close', this.endListener);
    }
    if (unpipeTarget) {
      try {
        this.stream.unpipe(unpipeTarget);
      } catch {
        /* ignore */
      }
      // unpipe() stops the stream flowing, which is right when we were its only
      // reader. A session replaced mid-setup is the exception: a format change
      // builds the replacement before the old session lets go, so by now the new
      // one has adopted this same source and resumed it. Leaving it paused here
      // strands it -- listener attached, nobody left to resume it -- and the zone
      // stays silent until the source disconnects and starts over. Our own
      // listener is already gone by this point, so anything still listening is
      // someone else's.
      if (this.stream.listenerCount('data') > 0) {
        this.stream.resume();
      }
    }
    this.stream = undefined;
    this.dataListener = undefined;
    this.errorListener = undefined;
    this.endListener = undefined;
  }

  public pause(): boolean {
    if (this.stream && typeof this.stream.pause === 'function') {
      this.stream.pause();
      return true;
    }
    return false;
  }

  public resume(): boolean {
    if (this.stream && typeof this.stream.resume === 'function') {
      this.stream.resume();
      return true;
    }
    return false;
  }
}
