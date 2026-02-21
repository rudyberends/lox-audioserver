import { createLogger } from '@/shared/logging/logger';
import type { ZoneConfig } from '@/domain/config/types';
import type { ZoneStateController } from '@/application/zones/state/StateController';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import { InternalStateController } from '@/application/zones/state/InternalStateController';
import { BeoLinkStateController } from '@/application/zones/state/BeoLinkStateController';
import { SonosStateController } from '@/application/zones/state/SonosStateController';
import { resolveZoneStateControllerId } from '@/application/zones/state/types';

type StateControllerManagerOptions = {
  onStatePatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void;
};

export class StateControllerManager {
  private readonly log = createLogger('Zones', 'StateControllers');
  private readonly controllers = new Map<number, ZoneStateController>();
  private readonly onStatePatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void;

  constructor(options: StateControllerManagerOptions) {
    this.onStatePatch = options.onStatePatch;
  }

  public handleCommand(zoneId: number, command: string, payload?: string): boolean {
    const controller = this.controllers.get(zoneId);
    if (!controller?.handleCommand) {
      return false;
    }
    try {
      const result = controller.handleCommand(command, payload);
      if (typeof result === 'boolean') {
        return result;
      }
      void Promise.resolve(result).catch((err) => {
        this.log.warn('state controller command failed', {
          zoneId,
          command,
          message: err instanceof Error ? err.message : String(err),
        });
      });
      // Async handlers return true to prevent duplicate internal handling.
      return true;
    } catch (err) {
      this.log.warn('state controller command dispatch failed', {
        zoneId,
        command,
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  public async replaceAll(zones: ZoneConfig[]): Promise<void> {
    await this.stopAll();
    for (const zone of zones) {
      await this.startForZone(zone);
    }
  }

  public async replaceZones(zones: ZoneConfig[]): Promise<void> {
    for (const zone of zones) {
      await this.stopForZone(zone.id);
      await this.startForZone(zone);
    }
  }

  public async stopForZone(zoneId: number): Promise<void> {
    const existing = this.controllers.get(zoneId);
    if (!existing) return;
    this.controllers.delete(zoneId);
    await Promise.resolve(existing.stop());
  }

  public async stopAll(): Promise<void> {
    const entries = Array.from(this.controllers.entries());
    this.controllers.clear();
    await Promise.all(
      entries.map(async ([zoneId, controller]) => {
        try {
          await Promise.resolve(controller.stop());
        } catch (err) {
          this.log.warn('state controller stop failed', {
            zoneId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  private async startForZone(zone: ZoneConfig): Promise<void> {
    const controllerId = resolveZoneStateControllerId(zone);
    const controller = this.createController(zone, controllerId);
    this.controllers.set(zone.id, controller);
    this.log.info('state controller starting', { zoneId: zone.id, controller: controllerId });
    try {
      await Promise.resolve(controller.start());
      this.log.info('state controller started', { zoneId: zone.id, controller: controllerId });
    } catch (err) {
      this.controllers.delete(zone.id);
      this.log.warn('state controller start failed', {
        zoneId: zone.id,
        controller: controllerId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private createController(zone: ZoneConfig, controllerId: string): ZoneStateController {
    if (controllerId === 'internal') {
      return new InternalStateController();
    }
    if (controllerId === 'beolink') {
      return new BeoLinkStateController({
        zone,
        onStatePatch: this.onStatePatch,
      });
    }
    if (controllerId === 'sonos') {
      return new SonosStateController({
        zone,
        onStatePatch: this.onStatePatch,
      });
    }
    // Unknown controllers fall back to internal behavior until implemented.
    this.log.warn('unknown state controller; falling back to internal', { controller: controllerId });
    return new InternalStateController();
  }
}
