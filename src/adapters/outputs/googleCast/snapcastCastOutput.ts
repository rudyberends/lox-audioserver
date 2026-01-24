import { URL } from 'node:url';
import { createLogger } from '@/shared/logging/logger';
import { bestEffort } from '@/shared/bestEffort';
import type { ZoneConfig, ZoneTransportConfig } from '@/domain/config/types';
import type { PlaybackSession } from '@/application/playback/audioManager';
import { audioOutputSettings } from '@/ports/types/audioFormat';
import type { OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import type { CastDevice, DiscoveredDevice } from '@lox-audioserver/node-googlecast';
import { loadGoogleCastModule } from '@/adapters/outputs/googleCast/googlecastLoader';
import {
  createJsonNamespaceControllerFactory,
  type JsonNamespaceController,
} from '@/adapters/outputs/googleCast/googlecastNamespace';

const DEFAULT_SNAPCAST_APP_ID = '16BF7E39';
const DEFAULT_SNAPCAST_NAMESPACE = 'urn:x-cast:snapcast';

export interface SnapcastCastOutputConfig {
  host: string; // Cast device host
  name?: string;
  streamId?: string;
  clientId?: string;
  serverHost?: string;
}

export const SNAPCAST_CAST_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'snapcast-cast',
  label: 'Snapcast Cast',
  description: 'Send a Snapcast stream to a Cast device running the Snapcast Cast receiver.',
  fields: [
    { id: 'host', label: 'Google Cast host/IP', type: 'text', required: true },
    { id: 'name', label: 'Friendly name', type: 'text', required: false },
  ],
};

export class SnapcastCastOutput implements ZoneOutput {
  public readonly type = 'snapcast-cast';
  private readonly log = createLogger('Output', 'SnapcastCast');
  private currentStream: NodeJS.ReadableStream | null = null;
  private readonly streamId: string;
  private readonly baseClientId: string;
  private effectiveStreamId: string;
  private effectiveClientIds: string[];
  private lastSession: PlaybackSession | null = null;

  private castDevice: CastDevice | null = null;
  private namespaceController: JsonNamespaceController | null = null;
  private connected = false;
  private sendPending = false;
  private lastPayload: Record<string, unknown> | null = null;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    private readonly config: SnapcastCastOutputConfig,
    private readonly ports: OutputPorts,
  ) {
    this.streamId = config.streamId || String(zoneId);
    this.baseClientId = config.clientId || `snap-cast-${zoneId}`;
    this.effectiveStreamId = this.streamId;
    this.effectiveClientIds = [this.baseClientId];

    this.ports.snapcastGroup.register({
      zoneId,
      baseStreamId: this.streamId,
      baseClientIds: [this.baseClientId],
      refresh: () => this.refreshGrouping(),
    });
  }

  public isReady(): boolean {
    return this.connected;
  }

  public async play(session: PlaybackSession): Promise<void> {
    this.lastSession = session;
    const plan = this.recomputePlan();
    if (!plan.shouldPlay) {
      this.stopStream();
      return;
    }
    await this.ensurePcmStream(session, plan);
    await this.ensureReady();
    await this.pushPayload(session);
  }

  public async pause(_session: PlaybackSession | null): Promise<void> {
    // No pause control; sender would stop pushing audio.
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    if (session) {
      await this.play(session);
    }
  }

  public async stop(_session: PlaybackSession | null): Promise<void> {
    this.stopStream();
    this.disconnect();
  }

  public async dispose(): Promise<void> {
    this.stopStream();
    this.disconnect();
    this.ports.snapcastGroup.unregister(this.zoneId);
  }

  public async updateMetadata(session: PlaybackSession | null): Promise<void> {
    if (!session) return;
    this.lastSession = session;
    const plan = this.recomputePlan();
    if (!plan.shouldPlay) return;
    await this.pushPayload(session, true);
  }

  public setVolume(_level: number): void {
    // Volume is handled by the Cast device system volume; skipping here.
  }

  public getPreferredOutput() {
    return {
      profile: 'pcm' as const,
      sampleRate: audioOutputSettings.sampleRate,
      channels: audioOutputSettings.channels,
      bitDepth: audioOutputSettings.pcmBitDepth,
    };
  }

  private async ensureReady(): Promise<void> {
    if (this.connected && this.namespaceController) return;
    await this.connectCast();
    await this.startApp();
  }

  private recomputePlan() {
    const plan = this.ports.snapcastGroup.buildPlan(
      this.zoneId,
      this.streamId,
      [this.baseClientId],
    );
    this.effectiveStreamId = plan.streamId;
    this.effectiveClientIds = plan.clientIds;
    return plan;
  }

  private refreshGrouping(): void {
    const plan = this.recomputePlan();
    if (this.baseClientId) {
      this.ports.snapcastCore.setClientStream(this.baseClientId, this.effectiveStreamId);
    }
    if (!this.lastSession) return;
    void this.play(this.lastSession);
  }

  private async ensurePcmStream(session: PlaybackSession | null, plan = this.recomputePlan()): Promise<void> {
    if (!session?.playbackSource) {
      this.log.warn('Snapcast Cast skipped; no playback source', { zoneId: this.zoneId });
      return;
    }
    if (!plan.shouldPlay) {
      this.log.info('Snapcast Cast grouped member, skipping local stream', {
        zoneId: this.zoneId,
        leaderZoneId: plan.leaderZoneId,
      });
      return;
    }
    this.stopStream();
    const pcmStream = this.ports.engine.createStream(this.zoneId, 'pcm', {
      label: 'snapcast-cast',
      primeWithBuffer: false,
    });
    if (!pcmStream) {
      // Try to reconfigure the session to expose a PCM profile.
      try {
        this.ports.audioManager.startExternalPlayback(
          this.zoneId,
          session.source ?? this.zoneName,
          session.playbackSource,
          session.metadata,
          true,
        );
      } catch {
        // ignore
      }
      const retry = this.ports.engine.createStream(this.zoneId, 'pcm', {
        label: 'snapcast-cast',
        primeWithBuffer: false,
      });
      if (!retry) {
        this.log.warn('Snapcast Cast stream unavailable (pcm profile missing)', { zoneId: this.zoneId });
        return;
      }
      this.currentStream = retry;
      this.ports.snapcastCore.setStream(
        this.effectiveStreamId,
        this.zoneId,
        audioOutputSettings,
        retry,
        this.effectiveClientIds,
      );
      return;
    }
    this.currentStream = pcmStream;
    this.ports.snapcastCore.setStream(
      this.effectiveStreamId,
      this.zoneId,
      audioOutputSettings,
      pcmStream,
      this.effectiveClientIds,
    );
  }

  private async connectCast(): Promise<void> {
    if (this.connected && this.castDevice) return;
    const { connect } = await loadGoogleCastModule();
    const device = this.buildDeviceDescriptor();
    const castDevice = await connect(device);
    this.castDevice = castDevice;
    this.connected = true;
    this.log.info('Snapcast Cast connected', { host: this.config.host });
    castDevice.on('disconnected', (err?: Error) => {
      this.log.warn('Snapcast Cast disconnected', { host: this.config.host, message: err?.message });
      this.disconnect();
    });
    castDevice.on('error', (err: Error) => {
      this.log.warn('Snapcast Cast error', { host: this.config.host, message: err.message });
      this.disconnect();
    });
  }

  private async startApp(): Promise<void> {
    if (!this.castDevice) return;
    const namespace = DEFAULT_SNAPCAST_NAMESPACE;
    try {
      await this.castDevice.launchApp(DEFAULT_SNAPCAST_APP_ID);
      this.log.info('Snapcast Cast launched', {
        host: this.config.host,
        appId: DEFAULT_SNAPCAST_APP_ID,
        namespace,
      });
    } catch (err: any) {
      this.log.warn('Snapcast Cast launch failed', {
        host: this.config.host,
        appId: DEFAULT_SNAPCAST_APP_ID,
        namespace,
        message: err?.message ?? String(err),
      });
      throw err;
    }
    if (!this.namespaceController) {
      const factory = await createJsonNamespaceControllerFactory(namespace);
      this.namespaceController = this.castDevice.addAppController(namespace, factory);
    }
  }

  private disconnect(): void {
    this.connected = false;
    if (this.castDevice) {
      void bestEffort(() => this.castDevice!.disconnect(), {
        fallback: undefined,
        onError: 'debug',
        log: this.log,
        label: 'Snapcast Cast client close failed',
        context: { zoneId: this.zoneId },
      });
    }
    this.castDevice = null;
    this.namespaceController = null;
  }

  private stopStream(): void {
    this.ports.snapcastCore.clearStream(this.zoneId);
    if (this.currentStream) {
      try {
        (this.currentStream as any).destroy?.();
      } catch {
        /* ignore */
      }
      this.currentStream = null;
    }
  }

  private async pushPayload(session: PlaybackSession, metadataOnly = false): Promise<void> {
    if (!this.namespaceController) return;
    if (this.sendPending) return;
    this.sendPending = true;
    try {
      const payload = this.buildPayload(session, metadataOnly);
      const signature = JSON.stringify(payload);
      if (this.lastPayload && JSON.stringify(this.lastPayload) === signature) {
        return;
      }
      await this.namespaceController.sendMessage(payload);
      this.lastPayload = payload;
      this.log.info('Snapcast Cast payload sent', {
        zoneId: this.zoneId,
        streamId: payload.streamId,
        metadataOnly,
        serverUrl: payload.serverUrl,
      });
    } catch (err) {
      this.log.warn('Snapcast Cast send failed', {
        zoneId: this.zoneId,
        message: (err as Error)?.message ?? String(err),
      });
    } finally {
      this.sendPending = false;
    }
  }

  private buildPayload(session: PlaybackSession, metadataOnly: boolean): Record<string, unknown> {
    const serverUrl = this.buildStreamUrl();
    const streamId = this.effectiveStreamId;
    const clientId = this.baseClientId;
    const meta = session.metadata;
    const zoneState = this.ports.zoneManager.getZoneState(this.zoneId);
    const title = meta?.title ?? zoneState?.title ?? this.zoneName;
    const artist = meta?.artist ?? zoneState?.artist ?? '';
    const album = meta?.album ?? zoneState?.album ?? '';
    const artUrl = meta?.coverurl ?? zoneState?.coverurl ?? session.stream.coverUrl;
    const duration = meta?.duration ?? session.duration ?? zoneState?.duration ?? 0;
    const payload: Record<string, unknown> = {
      type: 'setup',
      serverUrl,
      streamId,
      clientId,
      metadata: {
        title,
        artist,
        album,
        artUrl,
        duration,
      },
    };
    if (metadataOnly) {
      payload.type = 'metadata';
    }
    return payload;
  }

  private buildDeviceDescriptor(): DiscoveredDevice {
    const name = this.config.name?.trim() || this.zoneName;
    return {
      id: `snapcast-cast-${this.zoneId}-${this.config.host}`,
      name,
      host: this.config.host,
      port: 8009,
      lastSeen: Date.now(),
    };
  }

  private buildStreamUrl(): string {
    const sysHost = this.ports.config.getSystemConfig()?.audioserver?.ip;
    const host = sysHost || this.config.serverHost || this.config.host;
    const url = new URL(`ws://${host}:7090/snapcast`);
    url.searchParams.set('stream', this.effectiveStreamId);
    return url.toString();
  }
}

export function createSnapcastCastOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): SnapcastCastOutput | null {
  const host = typeof (config as any).host === 'string' ? (config as any).host.trim() : '';
  if (!host) {
    return null;
  }
  const name = typeof (config as any).name === 'string' ? (config as any).name : zone.name;
  const streamId =
    typeof (config as any).streamId === 'string' ? (config as any).streamId : undefined;
  const clientId =
    typeof (config as any).clientId === 'string' ? (config as any).clientId : undefined;
  const snapcastConfig: SnapcastCastOutputConfig = {
    host,
    name,
    streamId,
    clientId,
  };
  return new SnapcastCastOutput(zone.id, zone.name, snapcastConfig, ports);
}
