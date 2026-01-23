import type { ZoneContext } from '@/application/zones/internal/zoneTypes';

export class ZoneRepository {
  private readonly zones = new Map<number, ZoneContext>();

  public get(zoneId: number): ZoneContext | undefined {
    return this.zones.get(zoneId);
  }

  public require(zoneId: number): ZoneContext {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      throw new Error(`zone ${zoneId} not found`);
    }
    return ctx;
  }

  public set(zoneId: number, ctx: ZoneContext): void {
    this.zones.set(zoneId, ctx);
  }

  public list(): ZoneContext[] {
    return Array.from(this.zones.values());
  }

  public delete(zoneId: number): void {
    this.zones.delete(zoneId);
  }
}
