export interface MusicAssistantPlayerSuggestion {
  zoneId: number;
  players: Array<{ id: string; name: string }>;
}

const suggestions = new Map<number, MusicAssistantPlayerSuggestion['players']>();

export function setMusicAssistantSuggestions(zoneId: number, players: Array<{ id: string; name: string }>) {
  suggestions.set(zoneId, players);
}

export function clearMusicAssistantSuggestion(zoneId: number) {
  suggestions.delete(zoneId);
}

export function getMusicAssistantSuggestions(): MusicAssistantPlayerSuggestion[] {
  return Array.from(suggestions.entries()).map(([zoneId, players]) => ({ zoneId, players }));
}
