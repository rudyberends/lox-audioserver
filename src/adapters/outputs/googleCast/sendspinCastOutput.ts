import { createLogger } from '@/shared/logging/logger';
import { bestEffort } from '@/shared/bestEffort';
import type { PlaybackSession } from '@/application/playback/audioManager';
import type { OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import { buildBaseUrl } from '@/shared/streamUrl';
import {
  SendspinOutput,
  type SendspinMetadataPayload,
} from '@/adapters/outputs/sendspin/sendspinOutput';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import type { CastDevice, DiscoveredDevice } from '@lox-audioserver/node-googlecast';
import { loadGoogleCastModule } from '@/adapters/outputs/googleCast/googlecastLoader';
import {
  createJsonNamespaceControllerFactory,
  type JsonNamespaceController,
} from '@/adapters/outputs/googleCast/googlecastNamespace';

const DEFAULT_SENDSPIN_APP_ID = '938CBF87';
const DEFAULT_SENDSPIN_NAMESPACE = 'urn:x-cast:sendspin';

export interface SendspinCastOutputConfig {
  host: string;
  name?: string;
  namespace?: string;
  playerId?: string;
  syncDelayMs?: number;
}

export const SENDSPIN_CAST_OUTPUT_DEFINITION: OutputConfigDefinition = {
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

export class SendspinCastOutput implements ZoneOutput {
  public readonly type = 'sendspin-cast';
  private readonly log = createLogger('Output', 'SendspinCast');
  private readonly clientId: string;
  private readonly base: SendspinOutput;
  private latestMetadata: SendspinMetadataPayload | null = null;

  private castDevice: CastDevice | null = null;
  private namespaceController: JsonNamespaceController | null = null;
  private connected = false;
  private castMessageHandler: ((message: Record<string, unknown>) => void) | null = null;
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
    private readonly config: SendspinCastOutputConfig,
    private readonly ports: OutputPorts,
  ) {
    this.clientId = config.playerId || `cast-${zoneId}`;
    this.base = new SendspinOutput(
      zoneId,
      zoneName,
      { clientId: this.clientId },
      {
        onMetadata: (payload) => this.handleMetadataUpdate(payload),
        ignoreVolumeUpdates: true,
      },
      this.ports,
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
      if (this.base.isClientConnected() && this.namespaceController) {
        return;
      }
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
    if (this.connected && this.castDevice) return;
    const { connect } = await loadGoogleCastModule();
    const device = this.buildDeviceDescriptor();
    const castDevice = await connect(device);
    this.castDevice = castDevice;
    this.connected = true;
    this.log.info('Sendspin Cast connected', { host: this.config.host });
    castDevice.on('disconnected', (err?: Error) => {
      this.log.warn('Sendspin Cast disconnected', {
        host: this.config.host,
        message: err?.message,
      });
      this.disconnect();
    });
    castDevice.on('error', (err: Error) => {
      this.log.warn('Sendspin Cast error', { host: this.config.host, message: err.message });
      this.disconnect();
    });
  }

  private async startSendspinApp(): Promise<void> {
    if (!this.castDevice) return;
    const namespace = this.config.namespace || DEFAULT_SENDSPIN_NAMESPACE;
    const playerId = this.getClientId();
    const syncDelay = Number.isFinite(Number(this.config.syncDelayMs)) ? Number(this.config.syncDelayMs) : 0;
    const session = this.castDevice.getSession();
    if (!session || session.appId !== DEFAULT_SENDSPIN_APP_ID) {
      await this.castDevice.launchApp(DEFAULT_SENDSPIN_APP_ID);
    }
    if (!this.namespaceController) {
      const factory = await createJsonNamespaceControllerFactory(namespace);
      const controller = this.castDevice.addAppController(namespace, factory);
      this.namespaceController = controller;
      this.attachCastChannel(controller);
    }
    const controller = this.namespaceController;
    if (!controller) {
      throw new Error('sendspin namespace controller missing');
    }
    const payload = {
      type: 'setup',
      serverUrl: this.buildSendspinServerUrl(),
      playerId,
      playerName: this.zoneName,
      syncDelay,
      codecs: ['pcm', 'opus', 'flac'],
      metadata: this.latestMetadata || undefined,
    };
    try {
      await controller.sendMessage(payload);
      this.log.info('Sendspin Cast payload sent', { zoneId: this.zoneId, payload });
      void this.sendMetadataToReceiver();
    } catch (sendErr: any) {
      this.log.warn('Sendspin Cast payload failed', { zoneId: this.zoneId, message: sendErr?.message });
    }
  }

  private attachCastChannel(controller: JsonNamespaceController): void {
    this.detachCastChannel();
    const handler = (message: Record<string, unknown>) => this.handleCastMessage(message);
    try {
      controller.on('message', handler);
      this.castMessageHandler = handler;
      if (this.metadataSendPending && this.latestMetadata) {
        void this.sendMetadataToReceiver();
      }
    } catch (err) {
      this.log.debug('Sendspin Cast channel attach failed', {
        zoneId: this.zoneId,
        message: (err as Error)?.message ?? String(err),
      });
    }
  }

  private detachCastChannel(): void {
    if (this.namespaceController && this.castMessageHandler) {
      this.namespaceController.off('message', this.castMessageHandler);
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
    if (this.castDevice) {
      // Best-effort; device may already be closing.
      void bestEffort(() => this.castDevice!.disconnect(), {
        fallback: undefined,
        onError: 'debug',
        log: this.log,
        label: 'Sendspin Cast client close failed',
        context: { zoneId: this.zoneId },
      });
      this.castDevice = null;
    }
    this.namespaceController = null;
  }

  private buildSendspinServerUrl(): string {
    const host = this.resolvePublicHost();
    if (!host) {
      throw new Error('audioserver ip missing');
    }
    return buildBaseUrl({ host });
  }

  private buildDeviceDescriptor(): DiscoveredDevice {
    const name = this.config.name?.trim() || this.zoneName;
    return {
      id: `sendspin-cast-${this.zoneId}-${this.config.host}`,
      name,
      host: this.config.host,
      port: 8009,
      lastSeen: Date.now(),
    };
  }

  private resolvePublicHost(): string {
    return this.ports.config.getSystemConfig()?.audioserver?.ip;
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
    void this.sendMetadataToReceiver();
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

  private async sendMetadataToReceiver(): Promise<void> {
    if (!this.namespaceController || !this.latestMetadata) {
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
        metadata: this.latestMetadata,
      };
      // Send as plain object to the JSON namespace; CAF will deliver parsed data to the receiver.
      await this.namespaceController.sendMessage(message);
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
            void this.sendMetadataToReceiver();
          }
        }, 1000);
      }
    }
  }
}
