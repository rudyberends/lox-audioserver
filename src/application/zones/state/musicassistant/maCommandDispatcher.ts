import type { createLogger } from '@/shared/logging/logger';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { MusicAssistantApi } from '@/shared/musicassistant/musicAssistantApi';
import { clampVolume, normalizeCommand } from './maHelpers';

type Logger = ReturnType<typeof createLogger>;

export type CommandDispatcherDeps = {
  zoneId: number;
  log: Logger;
  getApi: () => MusicAssistantApi | null;
  /** Base player id (saved on the zone). */
  getPlayerId: () => string | null;
  /** Effective player id — may differ when MA wrapped the player in a group. */
  getEffectivePlayerId: () => string | null;
  /** Last known volume, used as the base for relative volume payloads. */
  getLastVolume: () => number | null;
  setLastVolume: (value: number) => void;
  /** Optimistic state patch — Loxone slider should not wait for the echo event. */
  emitPatch: (patch: Partial<ZoneState>) => void;
};

/**
 * Translates Loxone-side zone commands into Music Assistant `players/cmd/*`
 * RPC calls. The dispatcher is stateless aside from references to the parent
 * controller via `deps`; the controller owns the connection lifecycle and
 * latest-known state.
 */
export class MaCommandDispatcher {
  constructor(private readonly deps: CommandDispatcherDeps) {}

  /** Returns true if the command was recognised and dispatched. */
  public handle(command: string, payload?: string): boolean {
    const { log, zoneId, getApi, getPlayerId } = this.deps;
    if (!getApi() || !getPlayerId()) {
      log.warn('MA controller not ready; command dropped', { zoneId, command });
      return false;
    }
    const action = normalizeCommand(command);
    log.debug('MA command received', { zoneId, command, payload, action });
    if (action === 'volume') {
      const level = this.resolveVolumeTarget(payload);
      if (level === null) return false;
      void this.dispatchVolume(level);
      return true;
    }
    if (action === 'position') {
      const seconds = Number(payload);
      if (!Number.isFinite(seconds) || seconds < 0) return false;
      void this.dispatchSeek(Math.floor(seconds));
      return true;
    }
    if (action) {
      void this.dispatchPlayerCommand(action);
      return true;
    }
    return false;
  }

  private async dispatchPlayerCommand(
    action: 'play' | 'pause' | 'stop' | 'next' | 'previous',
  ): Promise<void> {
    const { log, zoneId, getApi, getPlayerId, getEffectivePlayerId } = this.deps;
    const api = getApi();
    const playerId = getPlayerId();
    if (!api || !playerId) return;
    const target = getEffectivePlayerId() ?? playerId;
    try {
      const ok = await api.playerCommand(target, action);
      log.debug('MA player command sent', { zoneId, playerId: target, command: action, ok });
    } catch (err) {
      log.warn('MA player command failed', {
        zoneId,
        playerId,
        command: action,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async dispatchVolume(level: number): Promise<void> {
    const { log, zoneId, getApi, getPlayerId, getEffectivePlayerId, setLastVolume, emitPatch } = this.deps;
    const api = getApi();
    const playerId = getPlayerId();
    if (!api || !playerId) return;
    const target = getEffectivePlayerId() ?? playerId;
    const value = clampVolume(level);
    try {
      await api.playerCommand(target, 'volume_set', { volume_level: value });
      setLastVolume(value);
      emitPatch({ volume: value });
    } catch (err) {
      log.warn('MA volume_set failed', {
        zoneId,
        playerId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async dispatchSeek(seconds: number): Promise<void> {
    const { log, zoneId, getApi, getPlayerId, getEffectivePlayerId } = this.deps;
    const api = getApi();
    const playerId = getPlayerId();
    if (!api || !playerId) return;
    const target = getEffectivePlayerId() ?? playerId;
    try {
      await api.playerCommand(target, 'seek', { position: seconds });
    } catch (err) {
      log.warn('MA seek failed', {
        zoneId,
        playerId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private resolveVolumeTarget(payload?: string): number | null {
    if (typeof payload !== 'string' || !payload.length) return null;
    const isRelative = /^[+-]/.test(payload);
    const parsed = Number(payload);
    if (!Number.isFinite(parsed)) return null;
    if (isRelative) {
      const base = this.deps.getLastVolume() ?? 50;
      return clampVolume(base + parsed);
    }
    return clampVolume(parsed);
  }
}
