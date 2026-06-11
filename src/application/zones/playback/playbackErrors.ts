import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { ComponentLogger } from '@/shared/logging/logger';

const IGNORED_PLAYER_ERROR_REASONS = new Set([
  'alert_stop',
  'input_stop',
  'reconfigure',
  'shutdown',
  'command_stop',
  'queue_empty',
  'queue_end',
  'airplay_forced_stop',
  'airplay_stop',
]);

// User-facing, non-technical titles shown in the zone's now-playing metadata.
// The raw technical reason is never surfaced here — it only goes to the log.
const DEFAULT_ERROR_TITLE = 'Playback unavailable';

const PLAYBACK_ERROR_TITLES: Record<string, string> = {
  uri: DEFAULT_ERROR_TITLE,
  auth: 'Sign-in required',
  device: 'Output unavailable',
  error: DEFAULT_ERROR_TITLE,
  queue_invalid_next: "Couldn't play next track",
  queue_next_failed: "Couldn't play next track",
  'airplay no source': 'AirPlay unavailable',
  'airplay engine not ready': 'AirPlay unavailable',
  'airplay pcm not ready': 'AirPlay unavailable',
  'airplay pcm stream unavailable': 'AirPlay unavailable',
  'airplay stream not ready': 'AirPlay unavailable',
  'spotify audio stream unavailable': 'Spotify unavailable',
  'spotify audio_key_error': 'Spotify unavailable',
};

type PlaybackErrorCoordinator = {
  getZone: (zoneId: number) => ZoneContext | undefined;
  applyPatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void;
  log: ComponentLogger;
};

export function handlePlaybackError(args: {
  coordinator: PlaybackErrorCoordinator;
  zoneId: number;
  reason: string | undefined;
  source: 'player' | 'output';
  extraLog?: Record<string, unknown>;
}): void {
  const { coordinator, zoneId, reason, source, extraLog } = args;
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  const normalized = typeof reason === 'string' ? reason.trim() : '';
  if (normalized && IGNORED_PLAYER_ERROR_REASONS.has(normalized)) {
    return;
  }
  const cleaned = normalized ? normalized.replace(/\s+/g, ' ') : '';
  const title =
    (cleaned ? PLAYBACK_ERROR_TITLES[cleaned.toLowerCase()] : undefined) ?? DEFAULT_ERROR_TITLE;
  coordinator.applyPatch(zoneId, {
    title,
    artist: '',
    album: '',
    coverurl: '',
    audiopath: '',
    station: '',
    time: 0,
    duration: 0,
    mode: 'stop',
    clientState: 'on',
    power: 'on',
    sourceName: ctx.sourceMac,
  });
  if (ctx.player.getState().mode !== 'stopped') {
    ctx.player.stop();
  }
  coordinator.log.warn('playback error', { zoneId, reason: cleaned || undefined, title, source, ...extraLog });
}
