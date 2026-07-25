import type { ConfigPort } from '@/ports/ConfigPort';
import type { StreamingServiceConfig } from '@/domain/config/types';
import { MusicAssistantApi } from './musicAssistantApi';

/**
 * Look up a Music Assistant bridge by id. When `bridgeId` is empty, falls back
 * to the first MA sink-mode bridge — convenient for single-bridge installs.
 */
export function findMusicAssistantBridge(
  config: ConfigPort,
  bridgeId: string,
): StreamingServiceConfig | null {
  const bridges = config.getConfig().content?.streamingServices ?? [];
  const target = bridgeId.trim().toLowerCase();
  if (target) {
    const match = bridges.find(
      (b) => typeof b?.id === 'string' && b.id.trim().toLowerCase() === target,
    );
    if (match) return match;
  }
  return (
    bridges.find(
      (b) =>
        (b?.provider || '').toLowerCase() === 'musicassistant' &&
        b?.mode === 'sink' &&
        b?.enabled !== false,
    ) ?? null
  );
}

export type MaBridgeConnection = {
  bridge: StreamingServiceConfig;
  host: string;
  port: number;
  apiKey: string | undefined;
};

/** Normalise a bridge config into the connection params the API expects. */
export function resolveMaBridgeConnection(bridge: StreamingServiceConfig): MaBridgeConnection {
  const host = (bridge.host || '').trim() || '127.0.0.1';
  const port = typeof bridge.port === 'number' && bridge.port > 0 ? bridge.port : 8095;
  const apiKey =
    typeof bridge.apiKey === 'string' && bridge.apiKey.trim() ? bridge.apiKey.trim() : undefined;
  return { bridge, host, port, apiKey };
}

/** Acquire a refcounted MusicAssistantApi instance for the given bridge config. */
export function acquireMaApiForBridge(bridge: StreamingServiceConfig): MusicAssistantApi {
  const conn = resolveMaBridgeConnection(bridge);
  return MusicAssistantApi.acquire(conn.host, conn.port, conn.apiKey);
}
