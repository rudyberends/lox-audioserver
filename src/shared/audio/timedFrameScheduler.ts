export type TimedFrame = {
  data: Buffer;
  timestampUs: number;
  durationUs: number;
};

export type TimedFrameSchedulerOptions = {
  nowUs: () => number;
  targetLeadUs: number;
  anchorLeadUs: number;
  onFrame: (frame: TimedFrame) => Promise<void> | void;
  onAnchor?: (anchorUs: number) => void;
  onTimelineShift?: (deltaUs: number) => void;
  onAdjust?: (deltaUs: number) => void;
  onLeadWait?: (deltaUs: number) => void;
  onCapacityWait?: (deltaUs: number) => void;
  waitForCapacity?: (bytesNeeded: number) => Promise<void>;
  pauseSource?: () => void;
  resumeSource?: () => void;
  shouldContinue?: () => boolean;
  overbufferMarginUs?: number;
  prepareBufferMarginUs?: number;
  sendTransmissionMarginUs?: number;
};

type TimedFrameTask = {
  data: Buffer;
  durationUs: number;
  skipLeadGate?: boolean;
};

export class TimedFrameScheduler {
  private readonly nowUs: () => number;
  private readonly targetLeadUs: number;
  private readonly anchorLeadUs: number;
  private readonly overbufferMarginUs: number;
  private readonly prepareBufferMarginUs: number;
  private readonly sendTransmissionMarginUs: number;
  private readonly onFrame: (frame: TimedFrame) => Promise<void> | void;
  private readonly onAnchor?: (anchorUs: number) => void;
  private readonly onTimelineShift?: (deltaUs: number) => void;
  private readonly onAdjust?: (deltaUs: number) => void;
  private readonly onLeadWait?: (deltaUs: number) => void;
  private readonly onCapacityWait?: (deltaUs: number) => void;
  private readonly waitForCapacity?: (bytesNeeded: number) => Promise<void>;
  private readonly pauseSource?: () => void;
  private readonly resumeSource?: () => void;
  private readonly shouldContinue?: () => boolean;
  private readonly queue: TimedFrameTask[] = [];
  private processing: Promise<void> | null = null;
  private stopped = false;
  private playStartUs: number | null = null;
  private nextFrameTimestampUs: number | null = null;
  private modeledTimelineUs = 0;

  constructor(options: TimedFrameSchedulerOptions) {
    this.nowUs = options.nowUs;
    this.targetLeadUs = options.targetLeadUs;
    this.anchorLeadUs = options.anchorLeadUs;
    this.onFrame = options.onFrame;
    this.onAnchor = options.onAnchor;
    this.onTimelineShift = options.onTimelineShift;
    this.onAdjust = options.onAdjust;
    this.onLeadWait = options.onLeadWait;
    this.onCapacityWait = options.onCapacityWait;
    this.waitForCapacity = options.waitForCapacity;
    this.pauseSource = options.pauseSource;
    this.resumeSource = options.resumeSource;
    this.shouldContinue = options.shouldContinue;
    this.overbufferMarginUs = options.overbufferMarginUs ?? 100_000;
    this.prepareBufferMarginUs =
      options.prepareBufferMarginUs ??
      Math.max(500_000, Math.min(2_500_000, this.targetLeadUs));
    this.sendTransmissionMarginUs = options.sendTransmissionMarginUs ?? 100_000;
  }

  public stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  public getTimelineState(): { playStartUs: number | null; modeledTimelineUs: number } {
    return { playStartUs: this.playStartUs, modeledTimelineUs: this.modeledTimelineUs };
  }

  public scheduleFrame(
    data: Buffer,
    durationUs: number,
    options: { skipLeadGate?: boolean } = {},
  ): void {
    if (!data?.length || durationUs <= 0 || this.stopped) {
      return;
    }
    this.queue.push({ data, durationUs, skipLeadGate: options.skipLeadGate });
    this.ensureProcessing();
  }

  private ensureProcessing(): void {
    if (this.processing) {
      return;
    }
    this.processing = this.processQueue().finally(() => {
      this.processing = null;
      if (!this.stopped && this.queue.length > 0) {
        this.ensureProcessing();
      }
    });
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) {
        continue;
      }
      if (this.stopped || !this.isActive()) {
        return;
      }
      await this.sendScheduledFrame(task);
      if (this.stopped || !this.isActive()) {
        return;
      }
    }
  }

  private isActive(): boolean {
    return this.shouldContinue ? this.shouldContinue() : true;
  }

  private shiftTimeline(deltaUs: number): void {
    if (this.playStartUs !== null) {
      this.playStartUs += deltaUs;
    }
    if (this.nextFrameTimestampUs !== null) {
      this.nextFrameTimestampUs += deltaUs;
    }
    this.onTimelineShift?.(deltaUs);
  }

  private computeAdjustForStale(tsUs: number, durationUs: number): number {
    const nowUs = this.nowUs();
    const headroomShortfallUs = nowUs + this.prepareBufferMarginUs - tsUs;
    const currentBufferEndUs = this.nextFrameTimestampUs ?? tsUs + durationUs;
    const currentBufferUs = Math.max(0, currentBufferEndUs - nowUs);
    const bufferShortfallUs = this.targetLeadUs - currentBufferUs;
    return bufferShortfallUs > 0
      ? Math.max(headroomShortfallUs, bufferShortfallUs)
      : headroomShortfallUs;
  }

  private async waitUntilLeadInRange(tsUs: number): Promise<void> {
    while (tsUs - this.nowUs() > this.targetLeadUs + this.overbufferMarginUs) {
      const deltaUs = tsUs - this.nowUs() - this.targetLeadUs;
      const waitMs = Math.max(5, Math.min(200, Math.floor(deltaUs / 1000)));
      if (this.targetLeadUs > 2_000_000) {
        this.pauseSource?.();
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      if (this.targetLeadUs > 2_000_000) {
        this.resumeSource?.();
      }
      if (this.stopped || !this.isActive()) {
        return;
      }
    }
  }

  private async sendScheduledFrame(task: TimedFrameTask): Promise<void> {
    if (this.stopped || !this.isActive()) {
      return;
    }
    if (this.nextFrameTimestampUs === null) {
      this.playStartUs = this.nowUs() + this.anchorLeadUs;
      this.nextFrameTimestampUs = this.playStartUs;
      this.modeledTimelineUs = 0;
      this.onAnchor?.(this.playStartUs);
    }
    let timestampUs = this.nextFrameTimestampUs;
    this.nextFrameTimestampUs += task.durationUs;
    this.modeledTimelineUs += task.durationUs;

    if (timestampUs < this.nowUs() + this.sendTransmissionMarginUs) {
      const adjustUs = this.computeAdjustForStale(timestampUs, task.durationUs);
      if (adjustUs > 0) {
        this.onAdjust?.(adjustUs);
        this.shiftTimeline(adjustUs);
        timestampUs += adjustUs;
      }
    }

    if (!task.skipLeadGate) {
      const before = this.nowUs();
      await this.waitUntilLeadInRange(timestampUs);
      this.onLeadWait?.(Math.max(0, this.nowUs() - before));
    }

    if (this.waitForCapacity) {
      const capBefore = this.nowUs();
      await this.waitForCapacity(task.data.length);
      this.onCapacityWait?.(Math.max(0, this.nowUs() - capBefore));
    }

    if (this.stopped || !this.isActive()) {
      return;
    }
    await this.onFrame({
      data: task.data,
      timestampUs,
      durationUs: task.durationUs,
    });
  }
}

export type PcmFrameAssemblerOptions = {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  frameDurationMs?: number;
  onFrame: (data: Buffer, samples: number, durationUs: number) => void;
};

export class PcmFrameAssembler {
  private readonly bytesPerSample: number;
  private readonly frameSamples: number;
  private readonly frameBytes: number;
  private readonly durationUs: number;
  private remainder: Buffer | null = null;
  private frameBuffer: Buffer = Buffer.alloc(0);
  private readonly onFrame: (data: Buffer, samples: number, durationUs: number) => void;

  constructor(options: PcmFrameAssemblerOptions) {
    const frameDurationMs = options.frameDurationMs ?? 25;
    this.bytesPerSample = (options.bitDepth / 8) * options.channels;
    this.frameSamples = Math.max(1, Math.floor((options.sampleRate * frameDurationMs) / 1000));
    this.frameBytes = this.frameSamples * this.bytesPerSample;
    this.durationUs = Math.floor((this.frameSamples * 1_000_000) / options.sampleRate);
    this.onFrame = options.onFrame;
  }

  public reset(): void {
    this.remainder = null;
    this.frameBuffer = Buffer.alloc(0);
  }

  public push(chunk: Buffer): void {
    if (!chunk?.length) {
      return;
    }
    let payload = chunk;
    if (this.remainder?.length) {
      payload = Buffer.concat([this.remainder, payload]);
      this.remainder = null;
    }
    const remainder = payload.length % this.bytesPerSample;
    if (remainder > 0) {
      this.remainder = payload.subarray(payload.length - remainder);
      payload = payload.subarray(0, payload.length - remainder);
    }
    if (!payload.length) {
      return;
    }
    this.frameBuffer = this.frameBuffer.length
      ? Buffer.concat([this.frameBuffer, payload])
      : payload;
    while (this.frameBuffer.length >= this.frameBytes) {
      const frame = this.frameBuffer.subarray(0, this.frameBytes);
      this.frameBuffer = this.frameBuffer.subarray(this.frameBytes);
      this.onFrame(frame, this.frameSamples, this.durationUs);
    }
  }
}
