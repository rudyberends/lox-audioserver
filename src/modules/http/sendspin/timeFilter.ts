/**
 * Simple Kalman-style filter for Sendspin clock offset/drift estimation.
 */
const ADAPTIVE_FORGETTING_CUTOFF = 0.75;

export class SendspinTimeFilter {
  private lastUpdate = 0;
  private count = 0;

  private offset = 0;
  private drift = 0;

  private offsetCov = Number.POSITIVE_INFINITY;
  private offsetDriftCov = 0;
  private driftCov = 0;

  private readonly processVar: number;
  private readonly forgetVar: number;

  constructor(processStdDev = 0.01, forgetFactor = 1.001) {
    this.processVar = processStdDev * processStdDev;
    this.forgetVar = forgetFactor * forgetFactor;
  }

  /**
   * Update filter with an NTP-style offset measurement.
   *
   * @param measurement ((T2-T1)+(T3-T4))/2 in microseconds
   * @param maxError ((T4-T1)-(T3-T2))/2 in microseconds (half RTT)
   * @param timeAdded client timestamp in microseconds when measurement taken
   */
  public update(measurement: number, maxError: number, timeAdded: number): void {
    if (timeAdded === this.lastUpdate) return;
    const dt = timeAdded - this.lastUpdate;
    this.lastUpdate = timeAdded;

    const measurementVar = maxError * maxError;

    // First measurement: establish offset only.
    if (this.count <= 0) {
      this.count = 1;
      this.offset = measurement;
      this.offsetCov = measurementVar;
      this.drift = 0;
      return;
    }

    // Second measurement: estimate drift from finite difference.
    if (this.count === 1) {
      this.count = 2;
      this.drift = (measurement - this.offset) / dt;
      this.offset = measurement;
      this.driftCov = (this.offsetCov + measurementVar) / dt;
      this.offsetCov = measurementVar;
      return;
    }

    // Prediction step.
    const offsetPred = this.offset + this.drift * dt;
    const dt2 = dt * dt;

    let newDriftCov = this.driftCov;
    let newOffsetDriftCov = this.offsetDriftCov + this.driftCov * dt;
    let newOffsetCov =
      this.offsetCov + 2 * this.offsetDriftCov * dt + this.driftCov * dt2 + dt * this.processVar;

    const residual = measurement - offsetPred;
    const adaptiveCutoff = ADAPTIVE_FORGETTING_CUTOFF * maxError;

    // Build history before enabling adaptive forgetting.
    if (this.count < 100) {
      this.count += 1;
    } else if (residual > adaptiveCutoff) {
      newDriftCov *= this.forgetVar;
      newOffsetDriftCov *= this.forgetVar;
      newOffsetCov *= this.forgetVar;
    }

    // Update step.
    const inv = 1 / (newOffsetCov + measurementVar);
    const offsetGain = newOffsetCov * inv;
    const driftGain = newOffsetDriftCov * inv;

    this.offset = offsetPred + offsetGain * residual;
    this.drift += driftGain * residual;

    this.driftCov = newDriftCov - driftGain * newOffsetDriftCov;
    this.offsetDriftCov = newOffsetDriftCov - driftGain * newOffsetCov;
    this.offsetCov = newOffsetCov - offsetGain * newOffsetCov;
  }

  /** Convert client timestamp to server timestamp using current offset/drift. */
  public computeServerTime(clientTime: number): number {
    const dt = clientTime - this.lastUpdate;
    const offset = Math.round(this.offset + this.drift * dt);
    return clientTime + offset;
  }

  /** Convert server timestamp to client timestamp using inverse transform. */
  public computeClientTime(serverTime: number): number {
    return Math.round(
      (serverTime - this.offset + this.drift * this.lastUpdate) / (1 + this.drift),
    );
  }

  public reset(): void {
    this.count = 0;
    this.offset = 0;
    this.drift = 0;
    this.offsetCov = Number.POSITIVE_INFINITY;
    this.offsetDriftCov = 0;
    this.driftCov = 0;
    this.lastUpdate = 0;
  }

  public get isSynchronized(): boolean {
    return this.count >= 2 && Number.isFinite(this.offsetCov);
  }

  public get error(): number {
    return Math.round(Math.sqrt(this.offsetCov));
  }

  public get covariance(): number {
    return Math.round(this.offsetCov);
  }

  public get offsetEstimate(): number {
    return this.offset;
  }
}
