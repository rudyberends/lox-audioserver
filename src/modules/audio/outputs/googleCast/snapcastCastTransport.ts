import util from 'node:util';
import { URL } from 'node:url';
import { createLogger } from '@/core/logging/logger';
import type { ZoneConfig, ZoneTransportConfig } from '@/domain/config/types';
import type { PlaybackSession } from '@/modules/audio';
import { audioStreamEngine } from '@/modules/audio/engine/audioStreamEngine';
import { audioOutputSettings } from '@/modules/audio/utils/audioFormat';
import { audioManager } from '@/modules/audio/audioManager';
import { snapcastCore } from '@/modules/http/snapcast/snapcastCore';
import { getSystemConfig } from '@/domain/config/configStore';
import type { TransportConfigDefinition, ZoneTransport } from '@/modules/audio/outputs/types';
import { snapcastGroupController } from '@/modules/audio/outputs/snapcast/snapcastGroupController';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const castv2: any = require('castv2-client');
const { Client: CastClient } = castv2;
const JsonController =
  castv2.controllers?.Json || castv2.JsonController || require('castv2-client/lib/controllers/json');
const ApplicationBase = require('castv2-client/lib/senders/application');

const DEFAULT_SNAPCAST_APP_ID = '16BF7E39';
const DEFAULT_SNAPCAST_NAMESPACE = 'urn:x-cast:snapcast';

export interface SnapcastCastTransportConfig {
  host: string; // Cast device host
  name?: string;
  streamId?: string;
  clientId?: string;
  serverHost?: string;
}

export const SNAPCAST_CAST_TRANSPORT_DEFINITION: TransportConfigDefinition = {
  id: 'snapcast-cast',
  label: 'Snapcast Cast',
  description: 'Send a Snapcast stream to a Cast device running the Snapcast Cast receiver.',
  fields: [
    { id: 'host', label: 'Google Cast host/IP', type: 'text', required: true },
    { id: 'name', label: 'Friendly name', type: 'text', required: false },
  ],
};

function createSnapcastApp(appId: string, namespace: string) {
  function SnapcastApp(this: any, client: any, session: any) {
    ApplicationBase.call(this, client, session);
    this.channel = this.createController(JsonController, namespace);
  }
  util.inherits(SnapcastApp, ApplicationBase);
  (SnapcastApp as any).APP_ID = appId;
  return SnapcastApp as any;
}

export class SnapcastCastTransport implements ZoneTransport {
  public readonly type = 'snapcast-cast';
  private readonly log = createLogger('Transport', 'SnapcastCast');
  private currentStream: NodeJS.ReadableStream | null = null;
  private readonly streamId: string;
  private readonly baseClientId: string;
  private effectiveStreamId: string;
  private effectiveClientIds: string[];
  private lastSession: PlaybackSession | null = null;

  private client: any | null = null;
  private receiver: any | null = null;
  private connected = false;
  private sendPending = false;
  private lastPayload: Record<string, unknown> | null = null;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    private readonly config: SnapcastCastTransportConfig,
  ) {
    this.streamId = config.streamId || String(zoneId);
    this.baseClientId = config.clientId || `snap-cast-${zoneId}`;
    this.effectiveStreamId = this.streamId;
    this.effectiveClientIds = [this.baseClientId];

    snapcastGroupController.register({
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
    snapcastGroupController.unregister(this.zoneId);
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
    if (this.connected && this.receiver) return;
    await this.connectCast();
    await this.startApp();
  }

  private recomputePlan() {
    const plan = snapcastGroupController.buildPlan(
      this.zoneId,
      this.streamId,
      [this.baseClientId],
    );
    this.effectiveStreamId = plan.streamId;
    this.effectiveClientIds = plan.clientIds;
    return plan;
  }

  private refreshGrouping(): void {
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
    const pcmStream = audioStreamEngine.createStream(this.zoneId, 'pcm', {
      label: 'snapcast-cast',
      primeWithBuffer: false,
    });
    if (!pcmStream) {
      // Try to reconfigure the session to expose a PCM profile.
      try {
        audioManager.startExternalPlayback(
          this.zoneId,
          session.source ?? this.zoneName,
          session.playbackSource,
          session.metadata,
          true,
        );
      } catch {
        // ignore
      }
      const retry = audioStreamEngine.createStream(this.zoneId, 'pcm', {
        label: 'snapcast-cast',
        primeWithBuffer: false,
      });
      if (!retry) {
        this.log.warn('Snapcast Cast stream unavailable (pcm profile missing)', { zoneId: this.zoneId });
        return;
      }
      this.currentStream = retry;
      snapcastCore.setStream(
        this.effectiveStreamId,
        this.zoneId,
        audioOutputSettings,
        retry,
        this.effectiveClientIds,
      );
      return;
    }
    this.currentStream = pcmStream;
    snapcastCore.setStream(
      this.effectiveStreamId,
      this.zoneId,
      audioOutputSettings,
      pcmStream,
      this.effectiveClientIds,
    );
  }

  private async connectCast(): Promise<void> {
    if (this.connected && this.client) return;
    await new Promise<void>((resolve, reject) => {
      const client = new CastClient();
      client.connect(this.config.host, () => {
        this.client = client;
        this.connected = true;
        this.log.info('Snapcast Cast connected', { host: this.config.host });
        client.on('close', () => this.disconnect());
        client.on('error', (err: Error) => {
          this.log.warn('Snapcast Cast error', { host: this.config.host, message: err.message });
          this.disconnect();
        });
        resolve();
      });
      client.on('error', (err: Error) => reject(err));
    });
  }

  private async startApp(): Promise<void> {
    if (!this.client) return;
    const namespace = DEFAULT_SNAPCAST_NAMESPACE;
    const SnapcastApp = createSnapcastApp(DEFAULT_SNAPCAST_APP_ID, namespace);
    await new Promise<void>((resolve, reject) => {
      this.client!.launch(SnapcastApp, (err: Error, app: any) => {
        if (err) {
          this.log.warn('Snapcast Cast launch failed', {
            host: this.config.host,
            appId: DEFAULT_SNAPCAST_APP_ID,
            namespace,
            message: err.message,
          });
          return reject(err);
        }
        this.log.info('Snapcast Cast launched', {
          host: this.config.host,
          appId: DEFAULT_SNAPCAST_APP_ID,
          namespace,
        });
        this.receiver = app;
        resolve();
      });
    });
  }

  private disconnect(): void {
    this.connected = false;
    try {
      this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.receiver = null;
  }

  private stopStream(): void {
    snapcastCore.clearStream(this.zoneId);
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
    if (!this.receiver) return;
    if (this.sendPending) return;
    this.sendPending = true;
    try {
      const payload = this.buildPayload(session, metadataOnly);
      const signature = JSON.stringify(payload);
      if (this.lastPayload && JSON.stringify(this.lastPayload) === signature) {
        return;
      }
      await util.promisify((cb: any) => this.receiver.channel.send(payload, cb))();
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
    const payload: Record<string, unknown> = {
      type: 'setup',
      serverUrl,
      streamId,
      clientId,
      metadata: {
        title: meta?.title ?? this.zoneName,
        artist: meta?.artist ?? '',
        album: meta?.album ?? '',
        artUrl: meta?.coverurl ?? session.stream.coverUrl,
        duration: meta?.duration ?? session.duration ?? 0,
      },
    };
    if (metadataOnly) {
      payload.type = 'metadata';
    }
    return payload;
  }

  private buildStreamUrl(): string {
    const sysHost = getSystemConfig()?.audioserver?.ip;
    const host = sysHost || this.config.serverHost || this.config.host;
    const url = new URL(`ws://${host}:7090/snapcast`);
    url.searchParams.set('stream', this.effectiveStreamId);
    return url.toString();
  }
}

export function createSnapcastCastTransport(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
): SnapcastCastTransport | null {
  const host = typeof (config as any).host === 'string' ? (config as any).host.trim() : '';
  if (!host) {
    return null;
  }
  const name = typeof (config as any).name === 'string' ? (config as any).name : zone.name;
  const streamId =
    typeof (config as any).streamId === 'string' ? (config as any).streamId : undefined;
  const clientId =
    typeof (config as any).clientId === 'string' ? (config as any).clientId : undefined;
  const snapcastConfig: SnapcastCastTransportConfig = {
    host,
    name,
    streamId,
    clientId,
  };
  return new SnapcastCastTransport(zone.id, zone.name, snapcastConfig);
}
