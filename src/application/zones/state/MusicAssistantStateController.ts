import { createLogger } from '@/shared/logging/logger';
import type { ZoneConfig } from '@/domain/config/types';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { ZoneStateController } from '@/application/zones/state/StateController';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { QueueItem } from '@/ports/types/queueTypes';
import { MusicAssistantApi } from '@/shared/musicassistant/musicAssistantApi';
import {
  containsMember,
  findMusicAssistantBridge,
  idSuffix,
  mergeRecord,
  pickNumber,
  pickRecord,
  pickString,
  resolvePrimaryOutput,
} from './musicassistant/maHelpers';
import { mapMaItemsToLoxoneQueue } from './musicassistant/maQueueMirror';
import { buildSnapshotPatch } from './musicassistant/maSnapshotBuilder';
import { MaCommandDispatcher } from './musicassistant/maCommandDispatcher';

type MusicAssistantStateControllerOptions = {
  zone: ZoneConfig;
  configPort: ConfigPort;
  onStatePatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void;
  onQueueMirror?: (zoneId: number, items: QueueItem[], currentIndex: number) => void;
};

const HEARTBEAT_MS = 3_000; // periodic full re-emit so Loxone keeps in sync
const TIME_TICK_MS = 1_000; // local extrapolated time progress

/**
 * Music Assistant external state controller.
 *
 * Subscribes to PLAYER_UPDATED, QUEUE_UPDATED and QUEUE_TIME_UPDATED for the
 * player linked to this zone. On every event we update an in-memory snapshot of
 * the player + queue and re-emit a *full* state patch (mirrors the BeoLink/Sonos
 * approach where each notification produces a full snapshot patch). A heartbeat
 * timer also re-emits the snapshot every few seconds so Loxone stays in sync
 * even if MA goes quiet, and a 1 s ticker extrapolates the playback position.
 */
export class MusicAssistantStateController implements ZoneStateController {
  private readonly log = createLogger('Zones', 'StateController:MA');
  private readonly zone: ZoneConfig;
  private readonly configPort: ConfigPort;
  private readonly onStatePatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void;
  private readonly onQueueMirror?: (zoneId: number, items: QueueItem[], currentIndex: number) => void;
  private readonly commandDispatcher: MaCommandDispatcher;

  private lastQueueSignature = '';
  private queueRefreshPending = false;
  private providerPrefix = 'spotify@nouser';

  private api: MusicAssistantApi | null = null;
  private playerId: string | null = null;
  // When MA wraps our base player in a universal group (e.g. on play_media), it
  // routes all subsequent player/queue events to the group id. We track that
  // here and treat the group as the effective source of state + command target.
  private effectivePlayerId: string | null = null;
  private queueId: string | null = null;

  private unsubscribers: Array<() => void> = [];
  private timeTicker: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // Latest payloads received from MA.
  private playerData: Record<string, unknown> | null = null;
  private queueData: Record<string, unknown> | null = null;

  // Cached projection used by the time ticker.
  private lastMode: LoxoneZoneState['mode'] = 'stop';
  private lastTime = 0;
  private lastTimeAtMs = 0;
  private lastDuration = 0;
  private lastVolume: number | null = null;

  constructor(options: MusicAssistantStateControllerOptions) {
    this.zone = options.zone;
    this.configPort = options.configPort;
    this.onStatePatch = options.onStatePatch;
    this.onQueueMirror = options.onQueueMirror;
    this.commandDispatcher = new MaCommandDispatcher({
      zoneId: this.zone.id,
      log: this.log,
      getApi: () => this.api,
      getPlayerId: () => this.playerId,
      getEffectivePlayerId: () => this.effectivePlayerId,
      getLastVolume: () => this.lastVolume,
      setLastVolume: (v) => {
        this.lastVolume = v;
      },
      emitPatch: (patch) => this.onStatePatch(this.zone.id, patch),
    });
  }

  // ----- lifecycle -----

  public async start(): Promise<void> {
    const resolved = this.resolvePlayer();
    if (!resolved) {
      this.log.warn('MA state controller has no usable player; passive mode', {
        zoneId: this.zone.id,
      });
      return;
    }
    this.api = resolved.api;
    this.playerId = resolved.playerId;
    this.effectivePlayerId = resolved.playerId;

    try {
      await this.api.connect();
    } catch (err) {
      this.log.warn('MA state controller bridge connect failed', {
        zoneId: this.zone.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // Subscribe with wildcard object id and filter inside the handler. This is
    // robust against MA emitting events whose `object_id` doesn't equal the
    // exact `player_id` (e.g. namespaced ids).
    this.unsubscribers.push(
      this.api.subscribe('PLAYER_UPDATED', (evt) => this.handlePlayerEvent(evt), '*'),
    );
    this.unsubscribers.push(
      this.api.subscribe('QUEUE_UPDATED', (evt) => this.handleQueueEvent(evt), '*'),
    );
    this.unsubscribers.push(
      this.api.subscribe('QUEUE_TIME_UPDATED', (evt) => this.handleQueueTimeEvent(evt), '*'),
    );
    this.unsubscribers.push(
      this.api.subscribe('QUEUE_ITEMS_UPDATED', (evt) => this.handleQueueEvent(evt), '*'),
    );

    await this.fetchInitialSnapshot();
    this.startTicker();
    this.startHeartbeat();
    this.emitFullSnapshot();
    void this.refreshQueueItems();

    this.log.info('MA state controller started', { zoneId: this.zone.id, playerId: this.playerId });
  }

  public stop(): void {
    this.stopTicker();
    this.stopHeartbeat();
    for (const fn of this.unsubscribers) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this.unsubscribers = [];
    if (this.api) {
      this.api.release();
      this.api = null;
    }
    this.playerId = null;
    this.queueId = null;
    this.playerData = null;
    this.queueData = null;
    this.log.info('MA state controller stopped', { zoneId: this.zone.id });
  }

  public handleCommand(command: string, payload?: string): boolean {
    return this.commandDispatcher.handle(command, payload);
  }

  // ----- events -----

  private async fetchInitialSnapshot(): Promise<void> {
    if (!this.api || !this.playerId) return;
    try {
      const players = await this.api.getAllPlayers();
      const list = Array.isArray(players) ? players : [];
      const me = list.find((p) => {
        const r = p as Record<string, unknown>;
        const id = String(r.player_id ?? r.id ?? '').toLowerCase();
        return id === this.playerId!.toLowerCase();
      });
      if (me) {
        this.playerData = me as Record<string, unknown>;
        const r = me as Record<string, unknown>;
        const candidate =
          pickString(r.active_source) ?? pickString(r.active_queue) ?? this.playerId;
        this.queueId = candidate;
        this.log.info('MA initial snapshot loaded', {
          zoneId: this.zone.id,
          playerId: this.playerId,
          state: pickString(r.state) ?? pickString(r.playback_state),
          volume: pickNumber(r.volume_level),
          hasMedia: Boolean(r.current_media ?? r.media ?? r.item),
          queueId: this.queueId,
        });
        if (this.queueId) {
          try {
            const items = await this.api.getQueueItems(this.queueId, 0, 1);
            if (items.length > 0) {
              this.queueData = mergeRecord(this.queueData, {
                queue_id: this.queueId,
                current_item: items[0],
              });
            }
          } catch {
            /* ignore */
          }
        }
      } else {
        this.log.warn('MA initial snapshot: player not found in getAllPlayers()', {
          zoneId: this.zone.id,
          playerId: this.playerId,
          known: list.map((p) =>
            String((p as Record<string, unknown>).player_id ?? (p as Record<string, unknown>).id ?? ''),
          ),
        });
      }
    } catch (err) {
      this.log.debug('MA initial snapshot failed', {
        zoneId: this.zone.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handlePlayerEvent(evt: Record<string, unknown>): void {
    const data = pickRecord(evt.data) ?? evt;
    if (!data) return;
    const incomingId = pickString(data.player_id) ?? pickString(evt.object_id);
    if (!this.matchesPlayer(incomingId, data)) return;
    if (incomingId && incomingId !== this.effectivePlayerId) {
      this.log.info('MA effective player switched (followed group)', {
        zoneId: this.zone.id,
        from: this.effectivePlayerId,
        to: incomingId,
      });
      this.effectivePlayerId = incomingId;
      this.playerData = null;
    }
    this.playerData = mergeRecord(this.playerData, data);
    this.emitFullSnapshot();
  }

  /**
   * An event matches our zone if the event's player_id either equals our base
   * or current-effective player id, OR if the event's payload describes a
   * (universal) group that contains our base player as a member.
   *
   * MA exposes the same physical device under multiple ids — `ap…` (provider
   * specific, e.g. AirPlay) and `up…` (universal wrapper) — that share the
   * same MAC suffix. We compare by suffix so a saved `ap…` id still matches
   * when MA only emits `up…` events.
   */
  private matchesPlayer(incomingId: string | null, data: Record<string, unknown>): boolean {
    if (!this.playerId) return false;
    const base = this.playerId.toLowerCase();
    const eff = this.effectivePlayerId?.toLowerCase() ?? base;
    const inc = (incomingId ?? '').toLowerCase();
    if (inc === base || inc === eff) return true;
    if (idSuffix(inc) && idSuffix(inc) === idSuffix(base)) return true;
    if (containsMember(data.group_members, base)) return true;
    if (containsMember(data.static_group_members, base)) return true;
    if (containsMember(data.group_childs, base)) return true;
    const synced = pickString(data.synced_to);
    if (synced && synced.toLowerCase() === base) return true;
    return false;
  }

  private handleQueueEvent(evt: Record<string, unknown>): void {
    const data = pickRecord(evt.data) ?? evt;
    if (!data) return;
    const queueId = pickString(data.queue_id) ?? pickString(evt.object_id);
    if (!this.queueIdMatches(queueId)) return;
    if (queueId && !this.queueId) this.queueId = queueId;
    this.queueData = mergeRecord(this.queueData, data);
    this.emitFullSnapshot();
    void this.refreshQueueItems();
  }

  /**
   * Pull the queue's items list from MA and mirror it into the Loxone zone
   * queue. Called on QUEUE_UPDATED / QUEUE_ITEMS_UPDATED. Throttled with a
   * `queueRefreshPending` flag so a flurry of MA events causes one fetch.
   */
  private async refreshQueueItems(): Promise<void> {
    if (!this.api) {
      this.log.debug('queue mirror skipped: no api', { zoneId: this.zone.id });
      return;
    }
    const onQueueMirror = this.onQueueMirror;
    if (!onQueueMirror) {
      this.log.debug('queue mirror skipped: no callback', { zoneId: this.zone.id });
      return;
    }
    if (this.queueRefreshPending) return;
    const queueId = this.queueId;
    if (!queueId) {
      this.log.debug('queue mirror skipped: no queue_id known yet', { zoneId: this.zone.id });
      return;
    }
    this.queueRefreshPending = true;
    try {
      const items = await this.api.getQueueItems(queueId, 0, 200);
      const currentIndex = pickNumber(this.queueData?.current_index) ?? 0;
      const mapped = mapMaItemsToLoxoneQueue(items, this.providerPrefix, this.zone.name);
      if (mapped.length === 0) {
        onQueueMirror(this.zone.id, [], 0);
        return;
      }
      const signature = `${queueId}|${mapped.length}|${currentIndex}|${mapped[0]?.audiopath ?? ''}|${mapped[mapped.length - 1]?.audiopath ?? ''}`;
      if (signature === this.lastQueueSignature) return;
      this.lastQueueSignature = signature;
      this.log.info('MA queue mirror push', {
        zoneId: this.zone.id,
        queueId,
        items: mapped.length,
        currentIndex,
      });
      onQueueMirror(this.zone.id, mapped, Math.max(0, Math.floor(currentIndex)));
    } catch (err) {
      this.log.warn('MA queue items fetch failed', {
        zoneId: this.zone.id,
        queueId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.queueRefreshPending = false;
    }
  }

  private handleQueueTimeEvent(evt: Record<string, unknown>): void {
    const data = pickRecord(evt.data) ?? evt;
    if (!data) return;
    const queueId = pickString(data.queue_id) ?? pickString(evt.object_id);
    if (!this.queueIdMatches(queueId)) return;
    // QUEUE_TIME_UPDATED payload sometimes has only the elapsed-seconds value
    // directly (e.g. `data: 12.5`). Cover all known shapes.
    const elapsed =
      pickNumber(data.elapsed_time) ??
      pickNumber(data.position) ??
      pickNumber(data.time) ??
      pickNumber(evt.data) ??
      null;
    if (elapsed === null) return;
    this.queueData = mergeRecord(this.queueData, { elapsed_time: elapsed });
    this.lastTime = Math.max(0, Math.floor(elapsed));
    this.lastTimeAtMs = Date.now();
    this.onStatePatch(this.zone.id, { time: this.lastTime });
  }

  private queueIdMatches(queueId: string | null): boolean {
    if (!queueId) return true;
    if (this.queueId && queueId === this.queueId) return true;
    const eff = this.effectivePlayerId?.toLowerCase();
    const base = this.playerId?.toLowerCase();
    const q = queueId.toLowerCase();
    if (q === eff || q === base) {
      this.queueId = queueId;
      return true;
    }
    // Suffix match: MA may emit queue events under the universal-wrapper id
    // (e.g. `up…`) before our PLAYER_UPDATED handler switches `effectivePlayerId`.
    const baseSuffix = base ? idSuffix(base) : '';
    if (baseSuffix && idSuffix(q) === baseSuffix) {
      this.queueId = queueId;
      return true;
    }
    return false;
  }

  // ----- snapshot projection -----

  private emitFullSnapshot(): void {
    const result = buildSnapshotPatch({
      player: this.playerData,
      queue: this.queueData,
      lastTime: this.lastTime,
    });
    if (!result) return;
    this.lastMode = result.derived.mode;
    if (result.derived.volume !== null) this.lastVolume = result.derived.volume;
    if (result.derived.duration !== null) this.lastDuration = result.derived.duration;
    if (result.derived.freezeTicker) this.lastTimeAtMs = 0;
    this.onStatePatch(this.zone.id, result.patch);
  }

  // ----- timers -----

  private startTicker(): void {
    this.stopTicker();
    this.timeTicker = setInterval(() => this.emitTimeTick(), TIME_TICK_MS);
  }

  private stopTicker(): void {
    if (this.timeTicker) {
      clearInterval(this.timeTicker);
      this.timeTicker = null;
    }
  }

  private emitTimeTick(): void {
    if (this.lastMode !== 'play' || !this.lastTimeAtMs) return;
    const elapsed = Math.floor((Date.now() - this.lastTimeAtMs) / 1000);
    const time = Math.max(0, this.lastTime + elapsed);
    if (this.lastDuration > 0 && time > this.lastDuration) return;
    this.onStatePatch(this.zone.id, { time });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    let beat = 0;
    this.heartbeatTimer = setInterval(() => {
      beat += 1;
      void this.pollPlayerState();
      if (beat % 10 === 0) {
        this.log.debug('MA heartbeat', {
          zoneId: this.zone.id,
          hasPlayer: Boolean(this.playerData),
          hasQueue: Boolean(this.queueData),
          mode: this.lastMode,
          time: this.lastTime,
          duration: this.lastDuration,
          volume: this.lastVolume,
        });
      }
      this.emitFullSnapshot();
    }, HEARTBEAT_MS);
  }

  private async pollPlayerState(): Promise<void> {
    if (!this.api || !this.playerId) return;
    try {
      const players = await this.api.getAllPlayers();
      if (!Array.isArray(players)) {
        this.log.debug('MA pollPlayerState: no players array', { zoneId: this.zone.id });
        return;
      }
      const base = this.playerId.toLowerCase();
      const baseSuffix = idSuffix(base);
      const exact = (players.find((p) => {
        const r = p as Record<string, unknown>;
        return String(r.player_id ?? r.id ?? '').toLowerCase() === base;
      }) ?? players.find((p) => {
        const r = p as Record<string, unknown>;
        const id = String(r.player_id ?? r.id ?? '').toLowerCase();
        return baseSuffix && idSuffix(id) === baseSuffix;
      })) as Record<string, unknown> | undefined;

      let effective = exact;
      let groupId: string | null = null;
      if (exact) {
        groupId = pickString(exact.active_group) ?? pickString(exact.synced_to) ?? null;
      }
      if (groupId) {
        const groupPlayer = players.find((p) => {
          const r = p as Record<string, unknown>;
          return String(r.player_id ?? r.id ?? '').toLowerCase() === groupId!.toLowerCase();
        }) as Record<string, unknown> | undefined;
        if (groupPlayer) effective = groupPlayer;
      } else {
        const groupPlayer = players.find((p) => {
          const r = p as Record<string, unknown>;
          return (
            containsMember(r.group_members, base) ||
            containsMember(r.static_group_members, base) ||
            containsMember(r.group_childs, base)
          );
        }) as Record<string, unknown> | undefined;
        if (groupPlayer) effective = groupPlayer;
      }

      if (!effective) {
        this.log.debug('MA pollPlayerState: base player not in players list', {
          zoneId: this.zone.id,
          base: this.playerId,
          known: players.slice(0, 25).map(
            (p) => String((p as Record<string, unknown>).player_id ?? (p as Record<string, unknown>).id ?? ''),
          ),
        });
        return;
      }

      const incomingId = pickString(effective.player_id) ?? pickString(effective.id);
      if (incomingId && incomingId !== this.effectivePlayerId) {
        this.log.info('MA effective player resolved (poll)', {
          zoneId: this.zone.id,
          from: this.effectivePlayerId,
          to: incomingId,
          via: groupId ? 'active_group' : 'group_members',
        });
        this.effectivePlayerId = incomingId;
        this.playerData = null;
      }
      this.playerData = mergeRecord(this.playerData, effective);
      const queueId =
        pickString(effective.active_source) ?? pickString(effective.active_queue) ?? this.queueId;
      if (queueId && queueId !== this.queueId) {
        this.queueId = queueId;
      }
    } catch (err) {
      this.log.debug('MA pollPlayerState failed', {
        zoneId: this.zone.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ----- resolver -----

  private resolvePlayer(): { api: MusicAssistantApi; playerId: string } | null {
    const output = resolvePrimaryOutput(this.zone);
    if (!output || (output.id ?? '').toString().toLowerCase() !== 'musicassistant') {
      return null;
    }
    const playerId = pickString(output.playerId);
    if (!playerId) return null;
    const bridgeId = pickString(output.bridgeId) ?? '';
    const bridge = findMusicAssistantBridge(this.configPort, bridgeId);
    if (!bridge) return null;
    const host = (bridge.host || '').trim() || '127.0.0.1';
    const port = typeof bridge.port === 'number' && bridge.port > 0 ? bridge.port : 8095;
    const apiKey = typeof bridge.apiKey === 'string' && bridge.apiKey.trim() ? bridge.apiKey.trim() : undefined;
    const api = MusicAssistantApi.acquire(host, port, apiKey);
    // Format queue audiopaths as `spotify@<bridgeId>:<type>:b64_<uri>` so the
    // Loxone app accepts them — same scheme used by the Loxone-initiated
    // playContent flow for MA-bridge content.
    const resolvedBridgeId = bridge.id?.trim() ?? '';
    if (resolvedBridgeId) {
      this.providerPrefix = `spotify@${resolvedBridgeId}`;
    }
    return { api, playerId };
  }
}
