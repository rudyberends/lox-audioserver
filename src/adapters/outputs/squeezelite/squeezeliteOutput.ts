import { createLogger } from '@/shared/logging/logger';
import { resolveSessionCover } from '@/shared/coverArt';
import { buildBaseUrl, resolveAbsoluteUrl, resolveStreamUrl, ensureQueryParam } from '@/shared/streamUrl';
import type { PlaybackSession } from '@/application/playback/audioManager';
import type { HttpPreferences, OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import type { SlimClient, SlimEvent } from '@lox-audioserver/node-slimproto';
import { EventType, PlayerState } from '@lox-audioserver/node-slimproto';

export interface SqueezeliteOutputConfig {
  playerId?: string;
  playerName?: string;
}

export const SQUEEZELITE_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'squeezelite',
  label: 'Squeezelite / SlimProto',
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
  ],
};

export class SqueezeliteOutput implements ZoneOutput {
  public readonly type = 'squeezelite';
  private readonly log = createLogger('Output', 'Squeezelite');
  private readonly normalizedPlayerId: string;
  private readonly normalizedPlayerName: string;
  private readonly unsubscribe: () => void;
  private lastStatus: 'playing' | 'paused' | 'stopped' | null = null;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: SqueezeliteOutputConfig,
    private readonly ports: OutputPorts,
  ) {
    this.normalizedPlayerId = normalizePlayerId(config.playerId);
    this.normalizedPlayerName = normalizeName(config.playerName);
    this.unsubscribe = this.ports.squeezeliteCore.subscribe((event) => this.handleEvent(event));
    this.ports.squeezeliteGroup.register({
      zoneId: this.zoneId,
      getPlayer: () => this.resolvePlayer(),
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
    const meta = this.buildMetadata(session, streamUrl);
    await player.playUrl(
      streamUrl,
      'audio/mpeg',
      meta,
      undefined,
      0,
      false,
      !groupInfo.grouped,
    );
  }

  public async pause(_session: PlaybackSession | null): Promise<void> {
    const player = this.resolvePlayer();
    if (!player) return;
    await player.pause();
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
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

  public getPreferredOutput(): { profile: 'mp3'; sampleRate: number; channels: number; prebufferBytes: number } {
    return { profile: 'mp3', sampleRate: 44100, channels: 2, prebufferBytes: 64 * 1024 };
  }

  public getHttpPreferences(): HttpPreferences {
    return { icyEnabled: true };
  }

  public dispose(): void {
    this.unsubscribe();
    this.ports.squeezeliteGroup.unregister(this.zoneId);
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
      return players[0];
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
    if (event.type === EventType.PLAYER_DISCONNECTED) {
      this.lastStatus = 'stopped';
      this.ports.outputHandlers.onOutputState(this.zoneId, { status: 'stopped' });
      return;
    }
    if (event.type === EventType.PLAYER_UPDATED) {
      this.emitState(player);
    }
    if (event.type === EventType.PLAYER_BUFFER_READY) {
      this.ports.squeezeliteGroup.notifyBufferReady(this.zoneId);
    }
    if (event.type === EventType.PLAYER_DECODER_ERROR) {
      this.ports.outputHandlers.onOutputError(this.zoneId, 'squeezelite decode');
    }
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
      defaultExt: 'mp3',
      prime: '0',
      primeMode: 'ensure',
    });
    let result = ensureQueryParam(url, 'icy', '1');
    if (groupInfo?.grouped && groupInfo.expectedCount > 1) {
      result = ensureQueryParam(result, 'sync', String(groupInfo.leaderZoneId));
      result = ensureQueryParam(result, 'expect', String(groupInfo.expectedCount));
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
