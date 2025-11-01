export interface MusicAssistantEvent {
  type: 'PLAYER_UPDATED' | 'QUEUE_UPDATED' | 'BACKEND_STATUS';
  playerId: string;
  payload: Record<string, any>;
}