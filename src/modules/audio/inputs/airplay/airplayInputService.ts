import { createLogger } from '@/core/logging/logger';
import type { ZoneConfig, GlobalAirplayConfig } from '@/domain/config/types';
import type { PlaybackMetadata, PlaybackSource, CoverArtPayload } from '@/modules/audio';
import { AirplayInstance } from '@/modules/audio/inputs/airplay/airplayInstance';
import type { ZonePlayer } from '@/modules/audio/player/zonePlayer';
import { spotifyInputService } from '@/modules/audio/inputs/spotify/spotifyInputService';

export interface AirplayController {
  startPlayback(
    zoneId: number,
    label: string,
    source: PlaybackSource,
    metadata?: PlaybackMetadata,
  ): void;
  updateMetadata(zoneId: number, metadata: Partial<PlaybackMetadata>): void;
  updateCover(zoneId: number, cover?: CoverArtPayload): string | void;
  updateVolume(zoneId: number, volume: number): void;
  updateTiming(zoneId: number, elapsed: number, duration: number): void;
  pausePlayback(zoneId: number): void;
  resumePlayback(zoneId: number): void;
  stopPlayback(zoneId: number): void;
}

class AirplayInputService {
  private readonly log = createLogger('Audio', 'AirPlayService');
  private readonly instances = new Map<number, AirplayInstance>();
  private controller: AirplayController | null = null;
  private globalEnabled = false;
  private resolvePlayer: ((zoneId: number) => ZonePlayer | null) | null = null;

  constructor() {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => this.markAllInstancesStopping());
    }
  }

  public configure(controller: AirplayController): void {
    this.controller = controller;
  }

  public setPlayerResolver(resolver: (zoneId: number) => ZonePlayer | null): void {
    this.resolvePlayer = resolver;
  }

  public syncZones(zones: ZoneConfig[], airplayConfig?: GlobalAirplayConfig | null): void {
    const enabled = airplayConfig?.enabled ?? false;
    this.globalEnabled = enabled;
    if (!enabled) {
      this.log.debug('global airplay disabled; shutting down instances');
      this.disableAllInstances();
      return;
    }
    if (!this.controller) {
      this.log.debug('airplay controller not configured; skipping sync');
      return;
    }
    const desired = new Set<number>();
    for (const zone of zones) {
      const airplay = zone.inputs?.airplay;
      if (!airplay?.enabled) {
        this.removeInstance(zone.id);
        continue;
      }
      desired.add(zone.id);
      const existing = this.instances.get(zone.id);
      if (existing) {
        existing.updateConfig(airplay).catch((error) => {
          this.log.warn('failed to update airplay instance', {
            zoneId: zone.id,
            message: error instanceof Error ? error.message : String(error),
          });
        });
        continue;
      }
      const instance = new AirplayInstance(
        zone.id,
        zone.name,
        zone.sourceMac,
        airplay,
        this.controller,
      );
      this.instances.set(zone.id, instance);
      instance.start().catch((error) => {
        this.log.error('failed to start airplay instance', {
          zoneId: zone.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }

    for (const zoneId of this.instances.keys()) {
      if (!desired.has(zoneId)) {
        this.removeInstance(zoneId);
      }
    }
  }

  public async shutdown(): Promise<void> {
    this.globalEnabled = false;
    await Promise.all(
      Array.from(this.instances.values()).map((instance) => instance.stop().catch(() => undefined)),
    );
    this.instances.clear();
  }

  public async renameZone(zoneId: number, name: string): Promise<void> {
    const instance = this.instances.get(zoneId);
    if (!instance) {
      return;
    }
    try {
      await instance.updateZoneName(name);
    } catch (error) {
      this.log.warn('failed to rename airplay instance', {
        zoneId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public remoteControl(
    zoneId: number,
    command: 'Play' | 'Pause' | 'PlayPause' | 'Stop' | 'Next' | 'Previous' | 'ToggleMute',
  ): void {
    if (command === 'Play') {
      try {
        spotifyInputService.stopActiveSession?.(zoneId, 'switch_to_airplay');
      } catch { /* empty */ }
    }
    const instance = this.instances.get(zoneId);
    instance?.sendRemoteCommand(command);
  }

  public remoteVolume(zoneId: number, volumePercent: number): void {
    const instance = this.instances.get(zoneId);
    instance?.setRemoteVolume(volumePercent);
  }

  /**
   * Force-stop any active AirPlay stream for a zone while keeping the receiver running.
   * Useful when switching inputs (e.g. to Spotify).
   */
  public stopActiveSession(zoneId: number, reason?: string): void {
    const instance = this.instances.get(zoneId);
    instance?.stopActiveSession(reason);
  }

  private removeInstance(zoneId: number): void {
    const existing = this.instances.get(zoneId);
    if (!existing) {
      return;
    }
    existing.stop().catch((error) => {
      this.log.warn('failed to stop airplay instance', {
        zoneId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.instances.delete(zoneId);
  }

  private disableAllInstances(): void {
    for (const [zoneId, instance] of this.instances.entries()) {
      instance.stop().catch((error) => {
        this.log.warn('failed to stop airplay instance', {
          zoneId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    this.instances.clear();
  }

  private markAllInstancesStopping(): void {
    for (const instance of this.instances.values()) {
      instance.markStopping();
    }
  }
}

export const airplayInputService = new AirplayInputService();
