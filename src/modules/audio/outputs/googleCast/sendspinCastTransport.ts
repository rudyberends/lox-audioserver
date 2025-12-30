import util from 'node:util';
import { URL } from 'node:url';
import { createLogger } from '@/core/logging/logger';
import type { PlaybackSession } from '@/modules/audio';
import { getSystemConfig } from '@/domain/config/configStore';
import { zoneManager } from '@/modules/zones/zoneManager';
import type { TransportConfigDefinition, ZoneTransport } from '@/modules/audio/outputs/types';
import {
  SendspinTransport,
  type SendspinMetadataPayload,
} from '@/modules/audio/outputs/sendspin/sendspinTransport';

// castv2-client has no bundled types; import via require to avoid TS resolution issues.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const castv2: any = require('castv2-client');
const { Client: CastClient } = castv2;
const JsonController =
  castv2.controllers?.Json || castv2.JsonController || require('castv2-client/lib/controllers/json');
const ApplicationBase = require('castv2-client/lib/senders/application');

const DEFAULT_SENDSPIN_APP_ID = '7268B1DD';
const DEFAULT_SENDSPIN_NAMESPACE = 'urn:x-cast:sendspin';

export interface SendspinCastTransportConfig {
  host: string;
  name?: string;
  namespace?: string;
  playerId?: string;
  syncDelayMs?: number;
}

export const SENDSPIN_CAST_TRANSPORT_DEFINITION: TransportConfigDefinition = {
  id: 'sendspin-cast',
  label: 'Sendspin Cast',
  description: 'Stream to the Sendspin Cast receiver app.',
  fields: [
    { id: 'host', label: 'Google Cast host/IP', type: 'text', required: true },
    { id: 'name', label: 'Friendly name', type: 'text', required: false },
    { id: 'namespace', label: 'Sendspin namespace', type: 'text', required: false },
    { id: 'playerId', label: 'Sendspin player ID', type: 'text', required: false },
    { id: 'syncDelayMs', label: 'Sendspin sync delay ms', type: 'text', required: false },
  ],
};

function createSendspinApp(appId: string, namespace: string) {
  function SendspinApp(this: any, client: any, session: any) {
    ApplicationBase.call(this, client, session);
    this.channel = this.createController(JsonController, namespace);
  }
  util.inherits(SendspinApp, ApplicationBase);
  (SendspinApp as any).APP_ID = appId;
  return SendspinApp as any;
}

export class SendspinCastTransport implements ZoneTransport {
  public readonly type = 'sendspin-cast';
  private readonly log = createLogger('Transport', 'SendspinCast');
  private readonly clientId: string;
  private readonly base: SendspinTransport;
  private latestMetadata: SendspinMetadataPayload | null = null;

  private client: any | null = null;
  private receiver: any | null = null;
  private connected = false;
  private castMessageHandler: ((message: any) => void) | null = null;
  private lastKnownVolume = 50;
  private lastCastVolumeLogged: number | null = null;
  private lastCastMuteLogged: boolean | null = null;
  private lastCastLogMs = 0;
  private sendspinEnsuring = false;
  private sendspinLastEnsureMs = 0;
  private metadataSendPending = false;
  private metadataRetryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    private readonly config: SendspinCastTransportConfig,
  ) {
    this.clientId = config.playerId || `cast-${zoneId}`;
    this.base = new SendspinTransport(
      zoneId,
      zoneName,
      { clientId: this.clientId },
      {
        onMetadata: (payload) => this.handleMetadataUpdate(payload),
      },
    );
  }

  public isReady(): boolean {
    return this.base.isReady();
  }

  public async play(session: PlaybackSession): Promise<void> {
    await this.ensureClientReady();
    await this.base.play(session);
  }

  public async pause(session: PlaybackSession | null): Promise<void> {
    await this.base.pause(session);
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    await this.ensureClientReady();
    await this.base.resume(session);
  }

  public async stop(session: PlaybackSession | null): Promise<void> {
    await this.base.stop(session);
  }

  public async updateMetadata(session: PlaybackSession | null): Promise<void> {
    await this.base.updateMetadata?.(session);
  }

  public async dispose(): Promise<void> {
    await this.base.dispose();
    this.disconnect();
  }

  public getClientId(): string {
    return this.clientId;
  }

  public setVolume(level: number): void {
    // Ensure receiver connection exists before forwarding volume.
    void this.ensureClientReady();
    this.base.setVolume(level);
  }

  public isClientConnected(): boolean {
    return this.base.isClientConnected();
  }

  public async ensureClientReady(): Promise<void> {
    const now = Date.now();
    if (this.sendspinEnsuring) return;
    if (now - this.sendspinLastEnsureMs < 5000) return;
    this.sendspinEnsuring = true;
    this.sendspinLastEnsureMs = now;
    try {
      await this.ensureConnected();
      await this.startSendspinApp();
    } catch (err) {
      this.log.debug('Sendspin Cast ensure ready failed', {
        zoneId: this.zoneId,
        message: (err as Error)?.message ?? String(err),
      });
    } finally {
      this.sendspinEnsuring = false;
    }
  }

  public getFutureFrames(minFutureMs = 300): Array<{ data: Buffer; timestampUs: number }> {
    return this.base.getFutureFrames(minFutureMs);
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.client) return;
    await new Promise<void>((resolve, reject) => {
      const client = new CastClient();
      try {
        client.setMaxListeners?.(20);
      } catch {}
      client.connect(this.config.host, () => {
        this.client = client;
        this.connected = true;
        this.log.info('Sendspin Cast connected', { host: this.config.host });
        client.on('close', () => this.disconnect());
        client.on('error', (err: Error) => {
          this.log.warn('Sendspin Cast error', { host: this.config.host, message: err.message });
          this.disconnect();
        });
        resolve();
      });
      client.on('error', (err: Error) => reject(err));
    });
  }

  private async startSendspinApp(): Promise<void> {
    if (!this.client) return;
    const appId = this.config.namespace ? undefined : DEFAULT_SENDSPIN_APP_ID;
    const namespace = this.config.namespace || DEFAULT_SENDSPIN_NAMESPACE;
    const playerId = this.getClientId();
    const syncDelay = Number.isFinite(Number(this.config.syncDelayMs)) ? Number(this.config.syncDelayMs) : 0;
    const SendspinApp = createSendspinApp(appId || DEFAULT_SENDSPIN_APP_ID, namespace);

    await new Promise<void>((resolve, reject) => {
      if (!this.client) return reject(new Error('cast client missing'));
      this.client.launch(SendspinApp, (err: Error, app: any) => {
        if (err) return reject(err);
        this.receiver = app;
        this.attachCastChannel(app);
        const payload = {
          type: 'setup',
          serverUrl: this.buildSendspinWsUrl(),
          playerId,
          playerName: this.zoneName,
          syncDelay,
          codecs: ['pcm', 'opus', 'flac'],
          metadata: this.latestMetadata || undefined,
        };
        try {
          app.channel.send(payload);
          this.log.info('Sendspin Cast payload sent', { zoneId: this.zoneId, payload });
          this.sendMetadataToReceiver();
        } catch (sendErr: any) {
          this.log.warn('Sendspin Cast payload failed', { zoneId: this.zoneId, message: sendErr?.message });
        }
        resolve();
      });
    });
  }

  private attachCastChannel(app: any): void {
    if (!app?.channel) return;
    this.detachCastChannel();
    const handler = (message: any) => this.handleCastMessage(message);
    try {
      app.channel.on('message', handler);
      this.castMessageHandler = handler;
      if (this.metadataSendPending && this.latestMetadata) {
        this.sendMetadataToReceiver();
      }
    } catch (err) {
      this.log.debug('Sendspin Cast channel attach failed', {
        zoneId: this.zoneId,
        message: (err as Error)?.message ?? String(err),
      });
    }
  }

  private detachCastChannel(): void {
    if (this.receiver?.channel && this.castMessageHandler) {
      try {
        this.receiver.channel.removeListener('message', this.castMessageHandler);
      } catch {}
    }
    this.castMessageHandler = null;
    if (this.metadataRetryTimer) {
      clearTimeout(this.metadataRetryTimer);
      this.metadataRetryTimer = null;
    }
  }

  private handleCastMessage(raw: any): void {
    let payload = raw;
    if (!payload) return;
    if (Buffer.isBuffer(payload)) {
      try {
        payload = JSON.parse(payload.toString());
      } catch {
        return;
      }
    } else if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    if (typeof payload !== 'object' || !payload) return;
    switch (payload.type) {
      case 'player_status':
        this.handleCastPlayerStatus(payload);
        break;
      default:
        break;
    }
  }

  private handleCastPlayerStatus(status: { volume?: number; muted?: boolean }): void {
    const now = Date.now();
    const shouldLog = (change: boolean): boolean => {
      if (change) return true;
      return now - this.lastCastLogMs > 10000;
    };

    const volFraction =
      typeof status.volume === 'number' && Number.isFinite(status.volume)
        ? Math.min(1, Math.max(0, status.volume))
        : null;
    if (volFraction !== null) {
      const vol = Math.round(volFraction * 100);
      this.lastKnownVolume = vol;
      const changed = this.lastCastVolumeLogged === null || vol !== this.lastCastVolumeLogged;
      if (shouldLog(changed)) {
        this.lastCastVolumeLogged = vol;
        this.lastCastLogMs = now;
        // We keep the last known volume for display/metadata, but we do not let the Cast
        // receiver drive the zone volume to avoid fighting defaults and server-side limits.
        this.log.spam('cast volume status ignored (server drives volume)', {
          zoneId: this.zoneId,
          volume: vol,
        });
      }
    }
    if (typeof status.muted === 'boolean') {
      const changed = this.lastCastMuteLogged === null || status.muted !== this.lastCastMuteLogged;
      if (shouldLog(changed)) {
        this.lastCastMuteLogged = status.muted;
        this.lastCastLogMs = now;
        this.log.spam('cast mute status ignored (server drives volume)', {
          zoneId: this.zoneId,
          muted: status.muted,
        });
      }
    }
  }

  private disconnect(): void {
    this.connected = false;
    this.detachCastChannel();
    if (this.receiver) {
      try {
        this.receiver.close?.();
      } catch {}
      this.receiver = null;
    }
    if (this.client) {
      try {
        this.client.close();
      } catch {}
      this.client = null;
    }
  }

  private buildSendspinWsUrl(): string {
    const host = this.resolvePublicHost() || '127.0.0.1';
    const url = new URL(`ws://${host}:7090/sendspin`);
    url.searchParams.set('tunnel', 'cast');
    url.searchParams.set('zone', String(this.zoneId));
    url.searchParams.set('player', this.clientId);
    return url.toString();
  }

  private resolvePublicHost(): string {
    return getSystemConfig()?.audioserver?.ip;
  }

  private handleMetadataUpdate(payload: SendspinMetadataPayload | null): void {
    if (!payload) return;
    this.latestMetadata = this.mergeMetadataPayload(payload);
    this.log.spam('Sendspin Cast metadata update received', {
      zoneId: this.zoneId,
      title: this.latestMetadata.title,
      artist: this.latestMetadata.artist,
      album: this.latestMetadata.album,
    });
    this.sendMetadataToReceiver();
  }

  private mergeMetadataPayload(update: SendspinMetadataPayload): SendspinMetadataPayload {
    const base: SendspinMetadataPayload = { ...(this.latestMetadata || {}) };
    const assign = <K extends keyof SendspinMetadataPayload>(key: K) => {
      if (Object.prototype.hasOwnProperty.call(update, key)) {
        base[key] = update[key];
      }
    };
    assign('title');
    assign('artist');
    assign('album');
    assign('artwork_url');
    assign('track');
    assign('shuffle');
    assign('repeat');
    if (Object.prototype.hasOwnProperty.call(update, 'progress')) {
      base.progress = update.progress ? { ...update.progress } : null;
    }
    return base;
  }

  private sendMetadataToReceiver(): void {
    if (!this.receiver?.channel || !this.latestMetadata) {
      if (this.latestMetadata) {
        this.metadataSendPending = true;
      }
      return;
    }
    try {
      this.log.spam('Sendspin Cast sending metadata', {
        zoneId: this.zoneId,
        title: this.latestMetadata.title,
        artist: this.latestMetadata.artist,
        album: this.latestMetadata.album,
      });
      const message = {
        type: 'metadata',
        payload: this.latestMetadata,
      };
      // Send as plain object to the JSON namespace; CAF will deliver parsed data to the receiver.
      this.receiver.channel.send(message);
      this.metadataSendPending = false;
      if (this.metadataRetryTimer) {
        clearTimeout(this.metadataRetryTimer);
        this.metadataRetryTimer = null;
      }
    } catch (err) {
      this.metadataSendPending = true;
      this.log.debug('Sendspin Cast metadata send failed', {
        zoneId: this.zoneId,
        message: (err as Error)?.message ?? String(err),
      });
      if (!this.metadataRetryTimer) {
        this.metadataRetryTimer = setTimeout(() => {
          this.metadataRetryTimer = null;
          if (this.metadataSendPending) {
            this.sendMetadataToReceiver();
          }
        }, 1000);
      }
    }
  }
}
