/**
 * AlertStateStore
 * ---------------
 * Stores per-zone snapshots of:
 *  - original volume
 *  - (extendable)
 */

export class AlertStateStore {
  private readonly map = new Map<number, { volume: number }>();

  public save(zoneId: number, volume: number): void {
    if (!this.map.has(zoneId)) {
      this.map.set(zoneId, { volume });
    }
  }

  public get(zoneId: number) {
    return this.map.get(zoneId);
  }

  public clear(zoneId: number): void {
    this.map.delete(zoneId);
  }
}

/** Singleton instance */
export const alertStateStore = new AlertStateStore();