import type { ZonePlayer } from '@/modules/audio/player/zonePlayer';

const players = new Map<number, ZonePlayer>();

export function registerPlayer(zoneId: number, player: ZonePlayer): void {
  players.set(zoneId, player);
}

export function unregisterPlayer(zoneId: number): void {
  players.delete(zoneId);
}

export function getPlayer(zoneId: number): ZonePlayer | null {
  return players.get(zoneId) ?? null;
}

export function clearPlayers(): void {
  players.clear();
}
