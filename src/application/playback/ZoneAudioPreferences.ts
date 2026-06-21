import type { OutputProfile } from '@/ports/EngineTypes';
import { audioOutputSettings, type AudioOutputSettings, type HttpProfile } from '@/ports/types/audioFormat';

export type ZoneInputPreferences = { fileRealTime?: boolean; urlRealTime?: boolean };

export type ZoneHttpPreferences = {
  httpProfile?: HttpProfile;
  icyEnabled?: boolean;
  icyInterval?: number;
  icyName?: string;
  drainMsAfterEnd?: number;
};

export type ZonePowerStateResolver = (zoneId: number) => boolean;
/** Returns the band gains to bake into the ffmpeg pipeline, or null when EQ is off/forwarded. */
export type ZoneEqualizerResolver = (zoneId: number) => ReadonlyArray<number> | null;

/**
 * Per-zone audio preferences pushed in by other modules. Held outside of
 * AudioManager so callers that only need to read/write preferences do not
 * pull a dependency on session-lifecycle state.
 */
export class ZoneAudioPreferences {
  private readonly pcmPreference = new Map<number, boolean>();
  private readonly outputOverrides = new Map<number, Partial<AudioOutputSettings>>();
  private readonly profileOverrides = new Map<number, OutputProfile>();
  private readonly inputPreferences = new Map<number, ZoneInputPreferences>();
  private readonly playbackPreDelayMs = new Map<number, number>();
  private readonly alertPreDelayFloorMs = new Map<number, number>();
  private readonly transientGainDb = new Map<number, number>();
  private readonly httpPreferences = new Map<number, ZoneHttpPreferences>();
  private powerStateResolver: ZonePowerStateResolver | null = null;
  private equalizerResolver: ZoneEqualizerResolver | null = null;

  // ---- public mutators ----------------------------------------------------

  public setPreferredOutputSettings(
    zoneId: number,
    override: (Partial<AudioOutputSettings> & { profile?: OutputProfile }) | null,
  ): void {
    if (!override || Object.keys(override).length === 0) {
      this.outputOverrides.delete(zoneId);
      this.profileOverrides.delete(zoneId);
      return;
    }
    this.outputOverrides.set(zoneId, override);
    if (override.profile) {
      this.profileOverrides.set(zoneId, override.profile);
    }
  }

  public setInputPreferences(zoneId: number, prefs: ZoneInputPreferences | null): void {
    if (!prefs || Object.keys(prefs).length === 0) {
      this.inputPreferences.delete(zoneId);
      return;
    }
    this.inputPreferences.set(zoneId, prefs);
  }

  public setPlaybackPreDelayMs(zoneId: number, delayMs: number | null): void {
    if (!Number.isFinite(delayMs) || (delayMs ?? 0) <= 0) {
      this.playbackPreDelayMs.delete(zoneId);
      return;
    }
    this.playbackPreDelayMs.set(zoneId, Math.max(0, Math.round(delayMs ?? 0)));
  }

  public setZonePowerStateResolver(resolver: ZonePowerStateResolver | null): void {
    this.powerStateResolver = resolver;
  }

  /**
   * Transient minimum playback pre-delay for a zone, used to keep a multi-zone
   * alert in sync: when one target zone is cold (amp asleep) every target waits
   * the same wake-up delay so they start together. Applies regardless of the
   * zone's own power state and is cleared when the alert ends.
   */
  public setAlertPreDelayFloorMs(zoneId: number, delayMs: number | null): void {
    if (!Number.isFinite(delayMs) || (delayMs ?? 0) <= 0) {
      this.alertPreDelayFloorMs.delete(zoneId);
      return;
    }
    this.alertPreDelayFloorMs.set(zoneId, Math.max(0, Math.round(delayMs ?? 0)));
  }

  /**
   * Registers a per-zone resolver that returns the EQ band gains to apply inside the ffmpeg
   * pipeline. Return null (or an empty array) when EQ should not be baked in (provider is
   * 'off' or a forwarder).
   */
  public setZoneEqualizerResolver(resolver: ZoneEqualizerResolver | null): void {
    this.equalizerResolver = resolver;
  }

  public setTransientGainDb(zoneId: number, gainDb: number | null): void {
    if (gainDb === null) {
      this.transientGainDb.delete(zoneId);
    } else {
      this.transientGainDb.set(zoneId, gainDb);
    }
  }

  public setHttpPreferences(zoneId: number, prefs: ZoneHttpPreferences | null): void {
    if (!prefs || Object.keys(prefs).length === 0) {
      this.httpPreferences.delete(zoneId);
      return;
    }
    this.httpPreferences.set(zoneId, prefs);
  }

  public setPcmPreference(zoneId: number, requiresPcm: boolean): void {
    this.pcmPreference.set(zoneId, requiresPcm);
  }

  // ---- public accessors ---------------------------------------------------

  public getHttpPreferences(zoneId: number): ZoneHttpPreferences | undefined {
    return this.httpPreferences.get(zoneId);
  }

  public getEffectiveOutputSettings(zoneId: number): AudioOutputSettings {
    const outputOverride = this.outputOverrides.get(zoneId);
    let result: AudioOutputSettings;
    if (outputOverride && Object.keys(outputOverride).length > 0) {
      const { profile: _ignoredProfile, ...rest } = outputOverride as Partial<AudioOutputSettings> & {
        profile?: unknown;
      };
      result = { ...audioOutputSettings, ...(rest as Partial<AudioOutputSettings>) };
    } else {
      result = audioOutputSettings;
    }
    const transientGain = this.transientGainDb.get(zoneId);
    if (transientGain !== undefined) {
      result = { ...result, fixedGainDb: (result.fixedGainDb ?? 0) + transientGain };
    }
    return result;
  }

  public getPcmPreference(zoneId: number): boolean | undefined {
    return this.pcmPreference.get(zoneId);
  }

  public getProfileOverride(zoneId: number): OutputProfile | undefined {
    return this.profileOverrides.get(zoneId);
  }

  public getInputPreferences(zoneId: number): ZoneInputPreferences | undefined {
    return this.inputPreferences.get(zoneId);
  }

  public getPlaybackPreDelayMs(zoneId: number): number | undefined {
    return this.playbackPreDelayMs.get(zoneId);
  }

  public getAlertPreDelayFloorMs(zoneId: number): number | undefined {
    return this.alertPreDelayFloorMs.get(zoneId);
  }

  public getTransientGainDb(zoneId: number): number | undefined {
    return this.transientGainDb.get(zoneId);
  }

  public getPowerStateResolver(): ZonePowerStateResolver | null {
    return this.powerStateResolver;
  }

  public getEqualizerResolver(): ZoneEqualizerResolver | null {
    return this.equalizerResolver;
  }
}
