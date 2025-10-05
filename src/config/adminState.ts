/**
 * Lightweight in-memory cache used by the admin UI to surface Music Assistant player suggestions per zone.
 */
export interface MusicAssistantPlayerSuggestion {
  zoneId: number;
  players: Array<{ id: string; name: string }>;
}

const suggestions = new Map<number, MusicAssistantPlayerSuggestion['players']>();

/**
 * Stores suggestion results for a given zone.
 */
export function setMusicAssistantSuggestions(zoneId: number, players: Array<{ id: string; name: string }>) {
  suggestions.set(zoneId, players);
}

/**
 * Removes cached suggestions for a zone, typically after they are consumed.
 */
export function clearMusicAssistantSuggestion(zoneId: number) {
  suggestions.delete(zoneId);
}

/**
 * Returns all zones with their cached suggestion lists.
 */
export function getMusicAssistantSuggestions(): MusicAssistantPlayerSuggestion[] {
  return Array.from(suggestions.entries()).map(([zoneId, players]) => ({ zoneId, players }));
}
