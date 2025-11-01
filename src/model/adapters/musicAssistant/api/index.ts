/**
 * -----------------------------------------------------------------------------
 * Music Assistant API entrypoint
 * -----------------------------------------------------------------------------
 * Provides unified access to the WebSocket client and the high-level API wrapper.
 * -----------------------------------------------------------------------------
 */

export { default as MusicAssistantClient } from './client';
export { MusicAssistantApi } from './api';

// Re-export shared types for convenience
export * from './types';