import type { IncomingMessage } from 'node:http';
import type net from 'node:net';
import {
  SnapcastCore as NodeSnapcastCore,
  type SnapcastCommandResult,
  type SnapcastHooks,
  type SnapcastStreamContext,
  type SnapcastStreamProperties,
} from '@lox-audioserver/node-snapcast';
import { createLogger } from '@/shared/logging/logger';
import { audioOutputSettings, type AudioOutputSettings } from '@/ports/types/audioFormat';
import type { AudioManager } from '@/application/playback/audioManager';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';

export class SnapcastCore {
  private readonly log = createLogger('Http', 'Snapcast');
  private readonly core: NodeSnapcastCore;
  private readonly audioManager: AudioManager;
  private zoneManager: ZoneManagerFacade | null = null;
  private readonly muteSnapshots = new Map<string, number>();

  constructor(audioManager: AudioManager) {
    this.audioManager = audioManager;
    const hooks: SnapcastHooks = {
      getStreamProperties: (stream) => this.buildStreamProperties(stream),
      onStreamControl: (stream, command, params) =>
        this.handleStreamControl(stream, command, params),
      onStreamProperty: (stream, property, value, params) =>
        this.handleStreamProperty(stream, property, value, params),
    };
    this.core = new NodeSnapcastCore({
      hooks,
      logger: {
        debug: (message, meta) => this.log.debug(message, meta),
        info: (message, meta) => this.log.info(message, meta),
        warn: (message, meta) => this.log.warn(message, meta),
      },
      defaultOutput: audioOutputSettings,
      serverName: 'Lox Audio Server',
      serverVersion: '0.0.0',
      streamUri: {
        scheme: 'ws',
        port: 7090,
        basePath: '/snapcast',
      },
    });
  }

  public initOnce(deps: { zoneManager: ZoneManagerFacade }): void {
    if (this.zoneManager) {
      throw new Error('snapcast core already initialized');
    }
    if (!deps.zoneManager) {
      throw new Error('snapcast core missing zone manager');
    }
    this.zoneManager = deps.zoneManager;
  }

  private get zones(): ZoneManagerFacade {
    if (!this.zoneManager) {
      throw new Error('zone manager not configured');
    }
    return this.zoneManager;
  }

  public handleUpgrade(request: IncomingMessage, socket: any, head: Buffer): boolean {
    return this.core.handleUpgrade(request, socket as any, head);
  }

  public handleTcpConnection(socket: net.Socket): void {
    this.core.handleTcpConnection(socket);
  }

  public close(): void {
    this.core.close();
  }

  public listClients(): Array<{
    clientId: string;
    streamId: string;
    connected: boolean;
    connectedAt: number;
    lastHelloId: number | null;
    latency: number;
  }> {
    return this.core.listClients();
  }

  public setClientLatency(clientId: string, latency: number): {
    updated: boolean;
    connected: boolean;
    latency: number;
  } {
    return this.core.setClientLatency(clientId, latency);
  }

  public setClientStream(clientId: string, streamId: string): { updated: boolean; connected: boolean } {
    return this.core.setClientStream(clientId, streamId);
  }

  public setClientVolumes(clientIds: string[], volume: number): void {
    this.core.setClientVolumes(clientIds, volume);
  }

  public setStream(
    streamId: string,
    zoneId: number,
    output: AudioOutputSettings,
    stream: NodeJS.ReadableStream,
    clientIds: string[],
  ): void {
    this.core.setStream(streamId, zoneId, output, stream, clientIds);
  }

  public clearStream(zoneId: number): void {
    this.core.clearStream(zoneId);
  }

  private buildStreamProperties(stream: SnapcastStreamContext): SnapcastStreamProperties {
    const session = this.audioManager.getSession(stream.zoneId);
    const meta = session?.metadata;
    const zoneState = this.zones.getZoneState(stream.zoneId);
    const hasSession = Boolean(session);
    const title = meta?.title ?? zoneState?.title ?? undefined;
    const artist = meta?.artist ?? zoneState?.artist ?? undefined;
    const album = meta?.album ?? zoneState?.album ?? undefined;
    const artUrl = meta?.coverurl ?? zoneState?.coverurl ?? session?.stream?.coverUrl;
    const duration = meta?.duration ?? session?.duration ?? zoneState?.duration ?? undefined;
    const metadata =
      title || artist || album || artUrl || typeof duration === 'number'
        ? {
            title,
            artist: artist ? [artist] : undefined,
            album,
            artUrl,
            duration,
          }
        : undefined;
    const playbackStatus =
      session?.state === 'playing' ? 'playing' : session?.state === 'paused' ? 'paused' : 'stopped';
    const position = session?.elapsed ?? undefined;
    const loopStatus =
      zoneState?.plrepeat === 3 ? 'track' : zoneState?.plrepeat === 1 ? 'playlist' : 'none';
    return {
      canControl: hasSession,
      canGoNext: hasSession,
      canGoPrevious: hasSession,
      canPause: hasSession,
      canPlay: hasSession,
      canSeek: hasSession && typeof duration === 'number' && duration > 0,
      loopStatus,
      shuffle: zoneState?.plshuffle === 1,
      volume: zoneState?.volume ?? 100,
      playbackStatus,
      position,
      metadata,
    };
  }

  private handleStreamControl(
    stream: SnapcastStreamContext,
    command: string,
    params: any,
  ): SnapcastCommandResult {
    const zoneId = stream.zoneId;
    const commandParams = params && typeof params.params === 'object' ? params.params : {};
    switch (command) {
      case 'play':
        this.zones.handleCommand(zoneId, 'play');
        return { ok: true };
      case 'pause':
        this.zones.handleCommand(zoneId, 'pause');
        return { ok: true };
      case 'playPause': {
        const session = this.audioManager.getSession(zoneId);
        if (session?.state === 'playing') {
          this.zones.handleCommand(zoneId, 'pause');
        } else {
          this.zones.handleCommand(zoneId, 'play');
        }
        return { ok: true };
      }
      case 'stop':
        this.zones.handleCommand(zoneId, 'stop');
        return { ok: true };
      case 'next':
        this.zones.handleCommand(zoneId, 'queueplus');
        return { ok: true };
      case 'previous':
        this.zones.handleCommand(zoneId, 'queueminus');
        return { ok: true };
      case 'setPosition': {
        const position = Number(commandParams.position ?? params.position ?? params.param);
        if (!Number.isFinite(position)) {
          return { ok: false, error: { code: -32602, message: "setPosition requires parameter 'position'" } };
        }
        this.zones.handleCommand(zoneId, 'position', String(position));
        return { ok: true };
      }
      case 'seek': {
        const offset = Number(commandParams.offset ?? params.offset ?? params.param);
        if (!Number.isFinite(offset)) {
          return { ok: false, error: { code: -32602, message: "seek requires parameter 'offset'" } };
        }
        const session = this.audioManager.getSession(zoneId);
        const target = (session?.elapsed ?? 0) + offset;
        this.zones.handleCommand(zoneId, 'position', String(target));
        return { ok: true };
      }
      default:
        return { ok: false, error: { code: -32602, message: `Command '${command}' not supported` } };
    }
  }

  private handleStreamProperty(
    stream: SnapcastStreamContext,
    property: string,
    value: any,
    params: any,
  ): SnapcastCommandResult {
    const zoneId = stream.zoneId;
    if (property === 'volume') {
      const volume = Number(value);
      if (!Number.isFinite(volume)) {
        return { ok: false, error: { code: -32602, message: 'Value for volume must be an int' } };
      }
      this.zones.handleCommand(zoneId, 'volume_set', String(volume));
      return { ok: true };
    }
    if (property === 'mute') {
      if (typeof value !== 'boolean') {
        return { ok: false, error: { code: -32602, message: 'Value for mute must be bool' } };
      }
      if (value) {
        const snapshot = this.zones.getZoneState(zoneId)?.volume ?? 0;
        this.muteSnapshots.set(stream.streamId, snapshot);
        this.zones.handleCommand(zoneId, 'volume_set', '0');
      } else {
        const restore = this.muteSnapshots.get(stream.streamId);
        if (typeof restore === 'number') {
          this.zones.handleCommand(zoneId, 'volume_set', String(restore));
          this.muteSnapshots.delete(stream.streamId);
        }
      }
      return { ok: true };
    }
    if (property === 'shuffle') {
      if (typeof value !== 'boolean') {
        return { ok: false, error: { code: -32602, message: 'Value for shuffle must be bool' } };
      }
      this.zones.setShuffle(zoneId, value);
      return { ok: true };
    }
    if (property === 'loopStatus') {
      if (typeof value !== 'string') {
        return {
          ok: false,
          error: { code: -32602, message: "Value for loopStatus must be one of 'none', 'track', 'playlist'" },
        };
      }
      if (value === 'none') {
        this.zones.setRepeatMode(zoneId, 'off');
        return { ok: true };
      }
      if (value === 'track') {
        this.zones.setRepeatMode(zoneId, 'one');
        return { ok: true };
      }
      if (value === 'playlist') {
        this.zones.setRepeatMode(zoneId, 'all');
        return { ok: true };
      }
      return {
        ok: false,
        error: { code: -32602, message: "Value for loopStatus must be one of 'none', 'track', 'playlist'" },
      };
    }
    if (property === 'rate') {
      if (!Number.isFinite(Number(params?.value))) {
        return { ok: false, error: { code: -32602, message: 'Value for rate must be float' } };
      }
      return { ok: false, error: { code: -32603, message: 'Stream property rate not supported' } };
    }
    return { ok: false, error: { code: -32602, message: `Property '${property}' not supported` } };
  }
}
