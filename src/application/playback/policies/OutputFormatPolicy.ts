import type { AudioOutputSettings } from '@/ports/types/audioFormat';
import type { OutputProfile } from '@/ports/EngineTypes';
import type { HttpPreferences, PreferredOutput, ZoneOutput } from '@/ports/OutputsTypes';
import { decodeAudiopath } from '@/domain/loxone/audiopath';
import { selectPlayOutputs } from '@/application/zones/services/outputOrchestrator';

export type InputPreferences = {
  fileRealTime?: boolean;
};

export type PreferredPlaybackSettings = {
  outputOverride: (Partial<AudioOutputSettings> & { profile?: OutputProfile }) | null;
  httpPrefs?: HttpPreferences | null;
  inputPrefs?: InputPreferences | null;
};

type ComputeArgs = {
  zoneId: number;
  zoneName: string;
  audiopath: string;
  isRadio: boolean;
  queueAuthority?: string | null;
  outputs: ZoneOutput[];
  activeOutputType?: string | null;
  defaults: AudioOutputSettings;
};

function shouldReducePrebuffer(
  audiopath: string,
  isRadio: boolean,
  queueAuthority?: string | null,
): boolean {
  const decoded = decodeAudiopath(audiopath) || audiopath;
  if (!decoded) {
    return false;
  }
  if (!/^https?:/i.test(decoded)) {
    return false;
  }
  if (isRadio) {
    return true;
  }
  return queueAuthority === 'local';
}

export function computePreferredPlaybackSettings(args: ComputeArgs): PreferredPlaybackSettings {
  const primaryOutput =
    (args.activeOutputType
      ? args.outputs.find((output) => output.type === args.activeOutputType)
      : null) ?? selectPlayOutputs(args.outputs)[0] ?? null;
  let override: (Partial<AudioOutputSettings> & { profile?: OutputProfile }) | null = null;
  if (primaryOutput && typeof (primaryOutput as any).getPreferredOutput === 'function') {
    const pref = (primaryOutput as { getPreferredOutput?: () => PreferredOutput | null }).getPreferredOutput?.();
    if (pref) {
      override = {};
      if (typeof pref.sampleRate === 'number') {
        override.sampleRate = pref.sampleRate;
      }
      if (typeof pref.channels === 'number') {
        override.channels = pref.channels;
      }
      if (pref.bitDepth) {
        override.pcmBitDepth = pref.bitDepth;
      }
      if (pref.profile) {
        override.profile = pref.profile;
      }
      if (typeof pref.prebufferBytes === 'number' && pref.prebufferBytes > 0) {
        override.prebufferBytes = pref.prebufferBytes;
      }
    }
  }
  if (shouldReducePrebuffer(args.audiopath, args.isRadio, args.queueAuthority)) {
    const radioPrebufferBytes = 8 * 1024;
    const current =
      typeof override?.prebufferBytes === 'number'
        ? override.prebufferBytes
        : args.defaults.prebufferBytes;
    const clamped = Math.min(current, radioPrebufferBytes);
    if (!override) {
      override = {};
    }
    override.prebufferBytes = clamped;
  }

  let httpPrefs: HttpPreferences | null | undefined;
  if (primaryOutput && typeof (primaryOutput as any).getHttpPreferences === 'function') {
    const prefs = (primaryOutput as { getHttpPreferences?: () => HttpPreferences | null }).getHttpPreferences?.();
    if (prefs) {
      httpPrefs = prefs;
    }
  } else {
    httpPrefs = null;
  }

  const inputPrefs: InputPreferences | null =
    primaryOutput?.type === 'squeezelite' ? { fileRealTime: false } : null;

  const settings: PreferredPlaybackSettings = { outputOverride: override, inputPrefs };
  if (typeof httpPrefs !== 'undefined') {
    settings.httpPrefs = httpPrefs;
  }
  return settings;
}
