import type { MusicAssistantApi } from './musicAssistantApi';

/** Extract a player id from a raw MA player record. */
export function pickPlayerId(player: unknown): string {
  if (!player || typeof player !== 'object') return '';
  const r = player as Record<string, unknown>;
  if (typeof r.player_id === 'string' && r.player_id.trim()) return r.player_id.trim();
  if (typeof r.id === 'string' && r.id.trim()) return r.id.trim();
  return '';
}

/**
 * Map a saved MA player id (e.g. `ap…` AirPlay-specific) to the player that
 * currently owns the audio path. MA wraps physical players in universal
 * `up…` ids while playing — both share the same MAC suffix. Returns the saved
 * id when nothing better is found, or null when the API call itself fails.
 */
export async function resolveActiveMaPlayerId(
  api: MusicAssistantApi,
  savedPlayerId: string,
): Promise<string | null> {
  if (!savedPlayerId) return null;
  const target = savedPlayerId.toLowerCase();
  const targetSuffix = target.match(/[0-9a-f]{8,}$/)?.[0] ?? '';
  try {
    const players = await api.getAllPlayers();
    if (!Array.isArray(players)) return savedPlayerId;
    const exact = players.find((p) => {
      const r = p as Record<string, unknown>;
      return String(r.player_id ?? r.id ?? '').toLowerCase() === target;
    });
    if (exact) return pickPlayerId(exact) || savedPlayerId;
    if (!targetSuffix) return savedPlayerId;
    const candidates = players
      .map((p) => ({ p, id: pickPlayerId(p) }))
      .filter((entry): entry is { p: unknown; id: string } => Boolean(entry.id))
      .filter((entry) => {
        const m = entry.id.toLowerCase().match(/[0-9a-f]{8,}$/);
        return m ? m[0] === targetSuffix : false;
      });
    const universal = candidates.find((entry) => entry.id.toLowerCase().startsWith('up'));
    return universal?.id ?? candidates[0]?.id ?? savedPlayerId;
  } catch {
    return savedPlayerId;
  }
}
