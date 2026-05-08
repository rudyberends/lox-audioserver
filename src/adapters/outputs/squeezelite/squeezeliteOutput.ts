import { createLogger } from '@/shared/logging/logger';
import { resolveSessionCover } from '@/shared/coverArt';
import { buildBaseUrl, resolveAbsoluteUrl, resolveStreamUrl, ensureQueryParam } from '@/shared/streamUrl';
import type { PlaybackSession } from '@/application/playback/audioManager';
import { getGroupByZone, onGroupChanged, clearJoinedLeader } from '@/application/groups/groupTracker';
import type { HttpPreferences, OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import type { SlimClient, SlimEvent } from '@lox-audioserver/node-slimproto';
import { EventType, PlayerState } from '@lox-audioserver/node-slimproto';

export interface SqueezeliteOutputConfig {
  playerId?: string;
  playerName?: string;
  /** Optional fixed output latency (ms) used for sync-group alignment. */
  latencyMs?: number;
}

export const SQUEEZELITE_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'squeezelite',
  label: 'Squeezelite',
  description: 'Streams audio to Squeezelite/Squeezebox players via SlimProto.',
  fields: [
    {
      id: 'playerId',
      label: 'Player ID (MAC)',
      type: 'text',
      placeholder: 'aa:bb:cc:dd:ee:ff',
      description: 'Preferred target MAC address. Use this for a stable binding.',
    },
    {
      id: 'playerName',
      label: 'Player name',
      type: 'text',
      placeholder: 'Living Room',
      description: 'Optional player name when no MAC is configured.',
    },
    {
      id: 'latencyMs',
      label: 'Latency (ms)',
      type: 'text',
      placeholder: '0',
      description: 'Optional fixed output latency for sync-groups. Higher = sound is later.',
    },
  ],
};

export class SqueezeliteOutput implements ZoneOutput {
  public readonly type = 'squeezelite';
  private readonly log = createLogger('Output', 'Squeezelite');
  private readonly normalizedPlayerId: string;
  private readonly normalizedPlayerName: string;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeGroups: () => void;
  private lastStatus: 'playing' | 'paused' | 'stopped' | null = null;
  private pendingAutostart = false;
  private autostartTimer?: NodeJS.Timeout;
  private lastJoinAt = 0;
  private lastJoinLeaderId: number | null = null;
  private readonly baseAutostartHeadroomMs = 200;
  private readonly joinAutostartHeadroomMs = 1200;
  private joinAutostartActiveUntilMs = 0;
  private lastGroupLeaderId: number | null = null;
  private lastGrouped = false;
  private stoppingAfterDrop = false;
  private readonly latencyMs: number;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: SqueezeliteOutputConfig,
    private readonly ports: OutputPorts,
  ) {
    this.normalizedPlayerId = normalizePlayerId(config.playerId);
    this.normalizedPlayerName = normalizeName(config.playerName);
    this.latencyMs = normalizeLatencyMs((config as any).latencyMs);
    this.unsubscribe = this.ports.squeezeliteCore.subscribe((event) => this.handleEvent(event));
    this.syncGroupState();
    this.unsubscribeGroups = onGroupChanged(() => {
      void this.handleGroupChanged();
    });
    this.ports.squeezeliteGroup.register({
      zoneId: this.zoneId,
      getPlayer: () => this.resolvePlayer(),
      getLatencyMs: () => this.latencyMs,
    });
  }

  public isReady(): boolean {
    return Boolean(this.resolvePlayer());
  }

  public async play(session: PlaybackSession): Promise<void> {
    if (!session.playbackSource) {
      this.log.warn('Squeezelite output skipped; no playback source', { zoneId: this.zoneId });
      this.ports.outputHandlers.onOutputError(this.zoneId, 'squeezelite no source');
      return;
    }
    const player = await this.ensurePlayer();
    if (!player) {
      this.ports.outputHandlers.onOutputError(this.zoneId, 'squeezelite no player');
      return;
    }
    const groupInfo = this.ports.squeezeliteGroup.preparePlayback(this.zoneId);
    const streamUrl = this.buildStreamUrl(session, groupInfo);
    if (!streamUrl) {
      this.ports.outputHandlers.onOutputError(this.zoneId, 'squeezelite no stream');
      return;
    }
    this.clearPendingAutostart();

    // Only the leader zone receives new sessions on track switches.
    // Orchestrate group playback from the leader to ensure all members connect,
    // otherwise the sync stream will stall on `expect=N`.
    if (groupInfo.grouped && groupInfo.expectedCount > 1) {
      if (this.zoneId !== groupInfo.leaderZoneId) {
        return;
      }
      const meta = this.buildMetadata(session, streamUrl);
      const mime = resolveMimeType(streamUrl);
      const ok = await this.ports.squeezeliteGroup.orchestrateGroupPlayback(
        groupInfo.leaderZoneId,
        streamUrl,
        mime,
        meta,
      );
      if (!ok) {
        this.ports.outputHandlers.onOutputError(this.zoneId, 'squeezelite group orchestrate failed');
      }
      return;
    }

    const shouldAutostart = !groupInfo.grouped || groupInfo.expectedCount <= 1;
    const meta = this.buildMetadata(session, streamUrl);
    const mime = resolveMimeType(streamUrl);
    await player.playUrl(
      streamUrl,
      mime,
      meta,
      undefined,
      0,
      false,
      // For non-sync playback, allow the player to autostart as soon as it has enough buffer.
      // This avoids relying on clock/jiffies being initialized (which can be missing right after a server restart).
      shouldAutostart,
      true,
    );
  }

  public async pause(_session: PlaybackSession | null): Promise<void> {
    this.clearPendingAutostart();
    const group = getGroupByZone(this.zoneId);
    if (group && group.members.length >= 2) {
      await this.ports.squeezeliteGroup.orchestrateGroupPause(group.leader);
      return;
    }
    const player = this.resolvePlayer();
    if (!player) return;
    await player.pause();
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    const group = getGroupByZone(this.zoneId);
    if (group && group.members.length >= 2) {
      await this.ports.squeezeliteGroup.orchestrateGroupResume(group.leader);
      return;
    }
    const player = this.resolvePlayer();
    if (player) {
      await player.play();
      return;
    }
    if (session) {
      await this.play(session);
    }
  }

  public async stop(_session: PlaybackSession | null): Promise<void> {
    this.clearPendingAutostart();
    const group = getGroupByZone(this.zoneId);
    if (group && group.members.length >= 2) {
      await this.ports.squeezeliteGroup.orchestrateGroupStop(group.leader);
      return;
    }
    const player = this.resolvePlayer();
    if (!player) return;
    await player.stop();
  }

  public async setVolume(level: number): Promise<void> {
    const player = this.resolvePlayer();
    if (!player) return;
    const clamped = Math.min(100, Math.max(0, Math.round(level)));
    await player.volumeSet(clamped);
  }

  public getPreferredOutput(): { profile: 'flac' | 'mp3'; sampleRate: number; channels: number; prebufferBytes: number } {
    // Squeezelite can report sporadic underruns when the HTTP stream stalls briefly (WiFi jitter, GC, CPU spikes).
    // A larger rolling prebuffer reduces audible dropouts at the cost of a bit more startup latency/memory.
    // Prefer FLAC to avoid lossy re-encode and improve group sync stability.
    // SlimProto identifies FLAC as 'flc' in the HELO supportedCodecs list. If the connected player
    // does not advertise 'flc', fall back to MP3 which is universally supported.
    const player = this.resolvePlayer();
    const codecs = player?.supportedCodecs ?? [];
    const supportsFlac = !player || codecs.includes('flc');
    if (!supportsFlac) {
      this.log.info('squeezelite player does not support flac; using mp3', {
        zoneId: this.zoneId,
        supportedCodecs: codecs,
      });
    }
    return { profile: supportsFlac ? 'flac' : 'mp3', sampleRate: 44100, channels: 2, prebufferBytes: 256 * 1024 };
  }

  public getHttpPreferences(): HttpPreferences {
    return { icyEnabled: false };
  }

  public getLatencyMs(): number | null {
    return this.latencyMs || null;
  }

  public dispose(): void {
    this.clearPendingAutostart();
    this.unsubscribe();
    this.unsubscribeGroups();
    this.ports.squeezeliteGroup.unregister(this.zoneId);
  }

  private syncGroupState(): void {
    const group = getGroupByZone(this.zoneId);
    this.lastGrouped = Boolean(group && group.members.length >= 2);
    this.lastGroupLeaderId = group?.leader ?? null;
  }

  private async handleGroupChanged(): Promise<void> {
    const previousGrouped = this.lastGrouped;
    const previousLeader = this.lastGroupLeaderId;
    const previousWasMember = previousGrouped && previousLeader != null && previousLeader !== this.zoneId;

    const group = getGroupByZone(this.zoneId);
    const groupedNow = Boolean(group && group.members.length >= 2);
    const leaderNow = group?.leader ?? null;

    this.lastGrouped = groupedNow;
    this.lastGroupLeaderId = leaderNow;

    if (previousWasMember && !groupedNow) {
      // A member was dropped from the group: stop playback on that member to avoid it
      // continuing to pull the leader's sync stream.
      await this.stopAfterDrop(previousLeader);
      return;
    }

    if (leaderNow != null && groupedNow) {
      await this.maybeResyncGroup('group_change');
    }
  }

  private async stopAfterDrop(previousLeaderZoneId: number | null): Promise<void> {
    if (this.stoppingAfterDrop) {
      return;
    }
    this.stoppingAfterDrop = true;
    try {
      this.clearPendingAutostart();
      clearJoinedLeader(this.zoneId);
      const player = this.resolvePlayer();
      if (!player) return;
      this.log.debug('squeezelite member dropped from group; stopping', {
        zoneId: this.zoneId,
        previousLeaderZoneId,
      });
      await player.stop();
    } finally {
      this.stoppingAfterDrop = false;
    }
  }

  private async ensurePlayer(): Promise<SlimClient | null> {
    const existing = this.resolvePlayer();
    if (existing) return existing;
    return await this.ports.squeezeliteCore.waitForPlayer((player) => this.matchesPlayer(player));
  }

  private resolvePlayer(): SlimClient | null {
    const players = this.ports.squeezeliteCore.players;
    if (!players.length) return null;
    const match = players.find((player) => this.matchesPlayer(player));
    if (match) return match;
    if (!this.normalizedPlayerId && !this.normalizedPlayerName && players.length === 1) {
      return players[0] ?? null;
    }
    return null;
  }

  private matchesPlayer(player: SlimClient): boolean {
    if (this.normalizedPlayerId) {
      return normalizePlayerId(player.playerId) === this.normalizedPlayerId;
    }
    if (this.normalizedPlayerName) {
      return normalizeName(player.name) === this.normalizedPlayerName;
    }
    return false;
  }

  private handleEvent(event: SlimEvent): void {
    const player = this.ports.squeezeliteCore.getPlayer(event.playerId);
    if (!player || !this.matchesPlayer(player)) {
      return;
    }
    if (event.type === EventType.PLAYER_CONNECTED || event.type === EventType.PLAYER_NAME_RECEIVED) {
      // If this is a grouped member and the leader is already playing, start pulling the leader stream.
      // Note: this may not be perfectly in sync until the next explicit group change/resync.
      void this.maybeJoinLeader('player_connected');
    }
    if (event.type === EventType.PLAYER_DISCONNECTED) {
      this.lastStatus = 'stopped';
      this.ports.outputHandlers.onOutputState(this.zoneId, { status: 'stopped' });
      return;
    }
    if (event.type === EventType.PLAYER_UPDATED) {
      this.emitState(player);
    }
    if (event.type === EventType.PLAYER_HEARTBEAT) {
      this.ports.squeezeliteGroup.notifyPlaybackTick(this.zoneId);
    }
    if (event.type === EventType.PLAYER_BUFFER_READY) {
      this.triggerAutostart(player, 'buffer_ready');
      this.ports.squeezeliteGroup.notifyBufferReady(this.zoneId);
    }
    if (event.type === EventType.PLAYER_DECODER_ERROR) {
      this.ports.outputHandlers.onOutputError(this.zoneId, 'squeezelite decode');
    }
  }

  private async maybeResyncGroup(source: 'group_change'): Promise<void> {
    const group = getGroupByZone(this.zoneId);
    if (!group || group.members.length < 2) {
      return;
    }
    const leaderZoneId = group.leader;
    const leaderSession = this.ports.audioManager.getSession(leaderZoneId);
    if (!leaderSession || leaderSession.state !== 'playing') {
      return;
    }
    const groupInfo = this.ports.squeezeliteGroup.preparePlayback(this.zoneId);
    if (!groupInfo.grouped || groupInfo.expectedCount < 2) {
      return;
    }
    const player = await this.ensurePlayer();
    if (!player) {
      return;
    }
    const streamUrl = this.buildStreamUrl(leaderSession, groupInfo);
    if (!streamUrl) {
      return;
    }
    // Debounce group changes to avoid repeated flush/rebuffer.
    const now = Date.now();
    if (this.lastJoinLeaderId === leaderZoneId && now - this.lastJoinAt < 1500) {
      return;
    }
    this.lastJoinAt = now;
    this.lastJoinLeaderId = leaderZoneId;

    // For a resync we want the group controller to unpause everyone at the same jiffies.
    this.clearPendingAutostart();

    const meta = this.buildMetadata(leaderSession, streamUrl);
    const mime = resolveMimeType(streamUrl);
    this.log.debug('squeezelite group resync to leader stream', {
      zoneId: this.zoneId,
      leaderZoneId,
      expectedCount: groupInfo.expectedCount,
      source,
      url: streamUrl,
    });
    try {
      await player.playUrl(
        streamUrl,
        mime,
        meta,
        undefined,
        0,
        false,
        false,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('squeezelite group resync failed', {
        zoneId: this.zoneId,
        leaderZoneId,
        expectedCount: groupInfo.expectedCount,
        source,
        message,
      });
    }
  }

  private async maybeJoinLeader(source: 'group_change' | 'player_connected'): Promise<void> {
    const group = getGroupByZone(this.zoneId);
    if (!group || group.leader === this.zoneId || group.members.length < 2) {
      return;
    }
    const leaderZoneId = group.leader;
    const leaderSession = this.ports.audioManager.getSession(leaderZoneId);
    if (!leaderSession || leaderSession.state !== 'playing') {
      return;
    }
    const player = await this.ensurePlayer();
    if (!player) {
      return;
    }
    // Avoid repeated playUrl spam when we get multiple group/connection events in a short window.
    const now = Date.now();
    if (this.lastJoinLeaderId === leaderZoneId && now - this.lastJoinAt < 1500) {
      return;
    }
    if (player.state === PlayerState.PLAYING) {
      return;
    }
    const streamUrl = this.buildLeaderFollowUrl(leaderZoneId);
    if (!streamUrl) {
      return;
    }
    this.lastJoinAt = now;
    this.lastJoinLeaderId = leaderZoneId;
    // For mid-stream joins, prefer SlimProto autostart so the player can decide when it has enough buffer.
    // Forcing unpauseAt too early tends to cause immediate underruns on some clients.
    this.clearPendingAutostart();

    // For 100% sync we cannot allow "late join" mid-stream for codecs with headers (FLAC/MP3).
    // Instead, trigger a full group resync so all players start from the same byte again.
    const groupInfo = this.ports.squeezeliteGroup.preparePlayback(leaderZoneId);
    if (!groupInfo.grouped || groupInfo.expectedCount < 2) {
      return;
    }
    const url = this.buildStreamUrl(leaderSession, groupInfo);
    if (!url) {
      return;
    }
    const meta = this.buildMetadata(leaderSession, url);
    const mime = resolveMimeType(url);
    this.log.debug('squeezelite grouped member connected; resyncing full group', {
      zoneId: this.zoneId,
      leaderZoneId,
      expectedCount: groupInfo.expectedCount,
      source,
      url,
    });
    try {
      await this.ports.squeezeliteGroup.orchestrateGroupPlayback(leaderZoneId, url, mime, meta);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('squeezelite grouped member resync failed', {
        zoneId: this.zoneId,
        leaderZoneId,
        source,
        message,
      });
    }
  }

  private buildLeaderFollowUrl(leaderZoneId: number): string | null {
    const sys = this.ports.config.getSystemConfig();
    const baseUrl = buildBaseUrl({
      host: sys.audioserver.ip?.trim(),
      fallbackHost: '127.0.0.1',
    });
    // Keep this as FLAC for non-sync situations; for syncgroups we trigger a full group resync instead.
    return resolveStreamUrl({
      baseUrl,
      zoneId: leaderZoneId,
      streamPath: undefined,
      defaultExt: 'flac',
      // Disable priming when joining mid-stream; otherwise we can dump a backlog and drift far behind the leader.
      prime: '0',
      primeMode: 'ensure',
    });
  }

  private emitState(player: SlimClient): void {
    const status = mapPlayerState(player.state);
    if (!status) return;
    if (this.lastStatus === status) return;
    this.lastStatus = status;
    this.ports.outputHandlers.onOutputState(this.zoneId, {
      status,
      uri: player.currentMedia?.metadata?.item_id,
      duration: player.currentMedia?.metadata?.duration,
    });
  }

  private triggerAutostart(player: SlimClient, source: 'buffer_ready' | 'timeout' | 'immediate'): void {
    if (!this.pendingAutostart) {
      return;
    }
    this.pendingAutostart = false;
    if (this.autostartTimer) {
      clearTimeout(this.autostartTimer);
      this.autostartTimer = undefined;
    }
    const headroomMs =
      Date.now() < this.joinAutostartActiveUntilMs ? this.joinAutostartHeadroomMs : this.baseAutostartHeadroomMs;
    // If jiffies aren't initialized yet (common right after restart), schedule an immediate unpause.
    // Some players ignore "unpauseAt" timestamps that don't align with their local clock.
    const targetJiffies = player.jiffies && player.jiffies > 0 ? player.jiffies + headroomMs : 0;
    void player.unpauseAt(targetJiffies).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('squeezelite autostart failed', {
        zoneId: this.zoneId,
        source,
        message,
      });
    });
  }

  private scheduleAutostartFallback(player: SlimClient): void {
    if (this.autostartTimer) {
      clearTimeout(this.autostartTimer);
      this.autostartTimer = undefined;
    }
    this.autostartTimer = setTimeout(() => {
      this.autostartTimer = undefined;
      this.triggerAutostart(player, 'timeout');
    }, 1500);
    this.autostartTimer.unref?.();
  }

  private clearPendingAutostart(): void {
    this.pendingAutostart = false;
    if (this.autostartTimer) {
      clearTimeout(this.autostartTimer);
      this.autostartTimer = undefined;
    }
  }

  private buildStreamUrl(
    session: PlaybackSession,
    groupInfo?: { grouped: boolean; leaderZoneId: number; expectedCount: number },
  ): string | null {
    const sys = this.ports.config.getSystemConfig();
    const baseUrl = buildBaseUrl({
      host: sys.audioserver.ip?.trim(),
      fallbackHost: '127.0.0.1',
    });
    const leaderZoneId = groupInfo?.grouped ? groupInfo.leaderZoneId : this.zoneId;
    const url = resolveStreamUrl({
      baseUrl,
      zoneId: leaderZoneId,
      streamPath: groupInfo?.grouped ? undefined : session.stream?.url,
      // IMPORTANT: for sync-groups, request the same profile that the leader session already exposes.
      // If we request a profile that is not active (e.g. mp3 while the session runs flac),
      // the stream handler will restart the engine to add that profile, causing the track to restart.
      defaultExt: 'flac',
      // For sync-group playback we do NOT want a primed backlog; it can overflow client buffers
      // and trigger immediate underruns. Let SlimProto buffering thresholds handle startup.
      prime: groupInfo?.grouped ? '0' : '1',
      primeMode: 'ensure',
    });
    let result = url;
    if (groupInfo?.grouped && groupInfo.expectedCount > 1) {
      // IMPORTANT: make the sync stream URL unique per playback session.
      // Otherwise, some players may keep an existing HTTP connection open across track switches,
      // causing `expect=N` to never be satisfied and groups to start via the 10s timeout.
      const syncId = `${groupInfo.leaderZoneId}-${session.stream?.id ?? 'current'}`;
      result = ensureQueryParam(result, 'sync', syncId);
      result = ensureQueryParam(result, 'expect', String(groupInfo.expectedCount));
    }
    // Use `expect=1` for all non-grouped playback so node-slimproto uses a lower client-side input
    // buffer threshold (32KB vs 200KB). This reduces startup silence from ~2-5s to ~0.5s on track
    // changes (e.g. Spotify). The server ignores `expect` values < 2 (parseSyncParams returns null),
    // so this only affects the SlimProto client's buffering threshold, not server sync coordination.
    if (!groupInfo?.grouped) {
      const syncId = `${this.zoneId}-${session.stream?.id ?? 'current'}`;
      result = ensureQueryParam(result, 'sync', syncId);
      result = ensureQueryParam(result, 'expect', '1');
    }
    return result;
  }

  private buildMetadata(session: PlaybackSession, streamUrl: string): Record<string, string | number> {
    const meta = session.metadata;
    const itemId = meta?.audiopath || meta?.trackId || streamUrl;
    const cover = resolveSessionCover(session);
    const sys = this.ports.config.getSystemConfig();
    const baseUrl = buildBaseUrl({
      host: sys.audioserver.ip?.trim(),
      fallbackHost: '127.0.0.1',
    });
    const coverUrl = cover ? resolveAbsoluteUrl(baseUrl, cover) ?? cover : '';
    return {
      item_id: itemId,
      title: meta?.title || this.zoneName,
      artist: meta?.artist || '',
      album: meta?.album || '',
      image_url: coverUrl,
      duration: session.duration || meta?.duration || 0,
    };
  }
}

function normalizePlayerId(value?: string | null): string {
  if (!value) return '';
  return value.replace(/[^a-f0-9]/gi, '').toLowerCase();
}

function normalizeName(value?: string | null): string {
  if (!value) return '';
  return value.trim().toLowerCase();
}

function mapPlayerState(state: PlayerState): 'playing' | 'paused' | 'stopped' | null {
  switch (state) {
    case PlayerState.PLAYING:
      return 'playing';
    case PlayerState.PAUSED:
      return 'paused';
    case PlayerState.STOPPED:
      return 'stopped';
    default:
      return null;
  }
}

function normalizeLatencyMs(value: unknown): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  if (!Number.isFinite(num)) return 0;
  // Clamp to a sane range; this is a fixed compensation value, not a buffer size.
  return Math.max(-5000, Math.min(5000, Math.round(num)));
}

function resolveMimeType(url: string): string {
  const lower = (url || '').toLowerCase();
  if (lower.includes('.flac')) return 'audio/flac';
  if (lower.includes('.wav')) return 'audio/wav';
  if (lower.includes('.aac')) return 'audio/aac';
  return 'audio/mpeg';
}
