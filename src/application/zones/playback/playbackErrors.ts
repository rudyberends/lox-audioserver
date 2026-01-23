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

const PLAYBACK_ERROR_ALIASES: Record<string, string> = {
  uri: 'invalid or missing playback URI',
  auth: 'authentication required',
  device: 'playback device unavailable',
  error: 'transport error',
  queue_invalid_next: 'next queue item unavailable',
  queue_next_failed: 'failed to start next queue item',
  'airplay no source': 'AirPlay source missing',
  'airplay engine not ready': 'AirPlay engine not ready',
  'airplay pcm not ready': 'AirPlay not ready',
  'airplay pcm stream unavailable': 'AirPlay stream unavailable',
  'airplay stream not ready': 'AirPlay stream not ready',
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
  const alias = cleaned ? PLAYBACK_ERROR_ALIASES[cleaned.toLowerCase()] : undefined;
  const detail = alias ?? cleaned;
  const title = detail ? `Playback error: ${detail}` : 'Playback error';
  coordinator.applyPatch(zoneId, {
    title,
    artist: '',
    album: '',
    station: '',
    time: 0,
    mode: 'stop',
    clientState: 'on',
    power: 'on',
  });
  if (ctx.player.getState().mode !== 'stopped') {
    ctx.player.stop();
  }
  coordinator.log.warn('playback error', { zoneId, reason: cleaned || undefined, source, ...extraLog });
}
