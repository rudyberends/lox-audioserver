import util from 'node:util';
import { createLogger } from '@/core/logging/logger';
import type { PlaybackSession } from '@/modules/audio';
import { getSystemConfig } from '@/domain/config/configStore';
import type { HttpPreferences, PreferredOutput, TransportConfigDefinition, ZoneTransport } from '@/modules/audio/outputs/types';
import { notifyTransportState } from '@/modules/audio/outputs/queueUpdater';

// castv2-client has no bundled types; import via require to avoid TS resolution issues.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const castv2: any = require('castv2-client');
const { Client: CastClient, DefaultMediaReceiver } = castv2;
export interface GoogleCastTransportConfig {
  host: string;
  name?: string;
  useSendspin?: boolean;
  sendspinNamespace?: string;
  sendspinPlayerId?: string;
  sendspinSyncDelayMs?: number;
}

export const GOOGLE_CAST_TRANSPORT_DEFINITION: TransportConfigDefinition = {
  id: 'googleCast',
  label: 'Google Cast',
  description: 'Stream to a Google Cast device using the default media receiver.',
  fields: [],
};

export class GoogleCastTransport implements ZoneTransport {
  public readonly type = 'googleCast';
  private readonly log = createLogger('Transport', 'GoogleCast');
  private client: any | null = null;
  private receiver: any | null = null;
  private connected = false;
  private lastLoadAt = 0;
  private lastLoadSignature: string | null = null;
  private lastMediaSessionId: number | null = null;
  private lastMetadataSignature: string | null = null;
  private lastMetadataUpdateAt = 0;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    private readonly config: GoogleCastTransportConfig,
  ) {}

  public isReady(): boolean {
    return this.connected;
  }

  public async play(session: PlaybackSession): Promise<void> {
    if (!session.playbackSource) {
      this.log.warn('Google Cast transport skipped; no playback source', { zoneId: this.zoneId });
      return;
    }
    await this.connect();
    await this.loadStream(session);
  }

  public async pause(_session: PlaybackSession | null): Promise<void> {
    if (this.receiver) {
      await util.promisify((cb: any) => this.receiver.pause(cb))().catch(() => {});
      return;
    }
    await this.stopStream();
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    if (!session) return;
    if (this.receiver) {
      await util.promisify((cb: any) => this.receiver.play(cb))().catch(() => {});
      return;
    }
    await this.play(session);
  }

  public async stop(_session: PlaybackSession | null): Promise<void> {
    await this.stopStream();
  }

  public async setPosition(positionMs: number): Promise<void> {
    if (!this.receiver || !this.lastMediaSessionId) {
      this.log.debug('Google Cast seek skipped; no receiver or session', { zoneId: this.zoneId });
      return;
    }
    const seconds = Math.max(0, positionMs / 1000);
    this.log.debug('Google Cast seek', { zoneId: this.zoneId, seconds });
    await util
      .promisify((cb: any) => this.receiver.seek(seconds, cb))()
      .catch((err: any) => {
        this.log.debug('Google Cast seek failed', { zoneId: this.zoneId, message: err?.message });
      });
  }

  public async dispose(): Promise<void> {
    await this.stopStream();
    this.disconnect();
  }

  public async setVolume(level: number): Promise<void> {
    if (!this.client) return;
    const volume = Math.max(0, Math.min(1, level / 100));
    await util.promisify((cb: any) => this.client.setVolume({ level: volume }, cb))().catch(
      (err: any) => {
        this.log.debug('Google Cast setVolume failed', {
          zoneId: this.zoneId,
          message: err?.message,
        });
      },
    );
  }

  public async updateMetadata(session: PlaybackSession | null): Promise<void> {
    if (!session) return;
    if (!this.receiver) {
      this.log.debug('Google Cast metadata skipped; no receiver yet', { zoneId: this.zoneId });
      return;
    }

    const signature = this.buildMediaSignature(session);
    if (signature === this.lastMetadataSignature) {
      return;
    }
    if (Date.now() - this.lastMetadataUpdateAt < 1500) {
      return;
    }

    this.log.info('Google Cast metadata update', {
      zoneId: this.zoneId,
      title: session.metadata?.title,
      artist: session.metadata?.artist,
      elapsedMs: session.elapsed,
      durationMs: session.duration,
    });

    const media = this.buildMedia(session);
    const status: any = await util.promisify((cb: any) => this.receiver.getStatus(cb))().catch(() => null);
    const isLiveStream = !media.duration || media.streamType === 'LIVE';
    const controller = (this.receiver as any)?.media;
    if (controller && status) {
      controller.currentSession = status;
    }
    const canPushMetadata =
      isLiveStream && status?.playerState === 'PLAYING' && status?.mediaSessionId && !!controller?.sessionRequest;

    let updated = false;
    if (canPushMetadata) {
      updated = await this.pushMetadataUpdate(media.metadata, media.customData ?? {});
    }
    if (!updated) {
      const shouldAutoplay = status?.playerState !== 'PAUSED';
      const opts = {
        autoplay: shouldAutoplay,
        currentTime: status?.currentTime ?? 0,
      };
      await util.promisify((cb: any) => this.receiver.load(media, opts, cb))().catch(() => {});
    }
    this.lastMetadataSignature = signature;
    this.lastMetadataUpdateAt = Date.now();
  }

  public getPreferredOutput(): PreferredOutput {
    // Cast typically prefers MP3/AAC streams; stick with MP3 profile at 44.1kHz.
    return { profile: 'mp3', sampleRate: 44100, channels: 2 };
  }

  public getHttpPreferences(): HttpPreferences {
    // Chunked works well for Cast; disable ICY metadata.
    return { httpProfile: 'chunked', icyEnabled: false };
  }

  private async connect(): Promise<void> {
    if (this.connected) return;
    return new Promise((resolve, reject) => {
      const client = new CastClient();
      client.connect(this.config.host, () => {
        this.connected = true;
        this.client = client;
        this.log.info('Google Cast connected', { zoneId: this.zoneId, host: this.config.host });
        client.on('close', () => this.disconnect());
        client.on('error', (err: any) => {
          this.log.warn('Google Cast client error', { zoneId: this.zoneId, message: err?.message });
          this.disconnect();
        });
        resolve();
      });
      client.on('error', (err: any) => {
        this.log.warn('Google Cast connect error', { zoneId: this.zoneId, message: err?.message });
        reject(err);
      });
    });
  }

  private disconnect(): void {
    this.connected = false;
    try {
      this.client?.close();
    } catch {}
    this.client = null;
    this.receiver = null;
  }

  private async loadStream(session: PlaybackSession): Promise<void> {
    if (!this.client) return;
    const media = this.buildMedia(session);
    const signature = this.buildMediaSignature(session);
    if (this.lastLoadSignature === signature && Date.now() - this.lastLoadAt < 1000) {
      return;
    }
    this.lastLoadSignature = signature;
    this.lastMetadataSignature = signature;
    this.lastLoadAt = Date.now();

    const receiver = await this.ensureReceiver();
    await new Promise<void>((resolve, reject) => {
      receiver.load(
        media,
        {
          autoplay: true,
          currentTime: session.elapsed ? session.elapsed / 1000 : 0,
        },
        (loadErr: any) => {
          if (loadErr) {
            this.log.warn('Google Cast load error', { zoneId: this.zoneId, message: loadErr?.message });
            reject(loadErr);
            return;
          }
          this.log.info('Google Cast stream loaded', { zoneId: this.zoneId });
          resolve();
        },
      );
    });
    // Ensure playback starts; some devices remain paused after load.
    try {
      const status: any = await util.promisify((cb: any) => receiver.getStatus(cb))();
      if (status?.mediaSessionId) {
        this.lastMediaSessionId = status.mediaSessionId;
      }
      const shouldPlay =
        status?.mediaSessionId && status?.playerState && status.playerState !== 'PLAYING';
      if (shouldPlay) {
        await util.promisify((cb: any) => receiver.play(cb))();
      }
    } catch (err: any) {
      this.log.debug('Google Cast play after load failed', {
        zoneId: this.zoneId,
        message: err?.message,
      });
    }
  }

  private async stopStream(): Promise<void> {
    try {
      await this.stopReceiver();
    } catch {}
  }

  private async stopReceiver(): Promise<void> {
    if (!this.receiver) return;
    await util.promisify((cb: any) => this.receiver.stop(cb))();
  }

  private async ensureReceiver(): Promise<any> {
    if (this.receiver) {
      return this.receiver;
    }
    return await new Promise<any>((resolve, reject) => {
      this.client.launch(DefaultMediaReceiver, (err: any, receiver: any) => {
        if (err) {
          this.log.warn('Google Cast launch error', { zoneId: this.zoneId, message: err?.message });
          reject(err);
          return;
        }
        const previous = this.receiver;
        if (previous) {
          try {
            previous.removeAllListeners?.('status');
          } catch {}
        }
        this.receiver = receiver;
        receiver.on('status', (status: any) => this.handleStatus(status));
        resolve(receiver);
      });
    });
  }

  private handleStatus(status: any): void {
    if (!status) return;
    const state = status.playerState;
    if (status.mediaSessionId) {
      this.lastMediaSessionId = status.mediaSessionId;
    }
    this.log.debug('Google Cast status', { zoneId: this.zoneId, state });
    const mappedStatus =
      state === 'PLAYING' ? 'playing' : state === 'PAUSED' ? 'paused' : state === 'IDLE' ? 'stopped' : undefined;
    if (!mappedStatus) {
      return;
    }
    const duration =
      typeof status.media?.duration === 'number'
        ? status.media.duration
        : typeof status.media?.metadata?.duration === 'number'
          ? status.media.metadata.duration
          : undefined;
    const position = typeof status.currentTime === 'number' ? status.currentTime : undefined;
    const uri =
      status.media?.customData?.uri ??
      status.media?.customData?.queue_item_id ??
      status.media?.contentId ??
      undefined;
    notifyTransportState(this.zoneId, {
      status: mappedStatus,
      position,
      duration,
      uri,
    });
  }

  private buildMedia(session: PlaybackSession): any {
    const { baseUrl, streamUrl, coverUrl } = this.resolveStreamUrls(session);
    const meta = (session.metadata ?? {}) as {
      title?: string;
      artist?: string;
      subtitle?: string;
      album?: string;
      station?: string;
      duration?: number;
    };
    const durationMs = session.duration || meta.duration || 0;
    const durationSec = durationMs > 0 ? durationMs / 1000 : undefined;
    const streamType = durationSec && durationSec > 0 ? 'BUFFERED' : 'LIVE';
    const currentTimeSec = session.elapsed ? session.elapsed / 1000 : 0;
    return {
      contentId: streamUrl,
      contentType: 'audio/mpeg',
      streamType,
      duration: durationSec,
      currentTime: currentTimeSec,
      metadata: {
        metadataType: 3, // MUSIC_TRACK
        title: meta.title ?? this.zoneName,
        artist: meta.artist ?? meta.subtitle ?? '',
        albumName: meta.album ?? '',
        images: coverUrl ? [{ url: coverUrl }] : [],
        customData: {
          zoneId: this.zoneId,
          source: session.source,
          duration: durationMs || null,
          station: meta.station ?? null,
        },
      },
      customData: {
        baseUrl,
      },
    };
  }

  private buildMediaSignature(session: PlaybackSession): string {
    const { streamUrl, coverUrl } = this.resolveStreamUrls(session);
    const meta = (session.metadata ?? {}) as {
      title?: string;
      artist?: string;
      subtitle?: string;
      album?: string;
    };
    const durationMs = session.duration || (meta as any).duration || 0;
    return JSON.stringify({
      streamUrl,
      title: meta?.title,
      artist: meta?.artist ?? (meta as any)?.subtitle,
      album: (meta as any)?.album,
      coverUrl,
      durationMs,
    });
  }

  private resolveStreamUrls(session: PlaybackSession): { baseUrl: string; streamUrl: string; coverUrl?: string } {
    const cfg = getSystemConfig() as any;
    const ip = cfg?.audioserver?.ip;
    const baseUrl = ip ? `http://${ip}:7090` : '';
    const streamPath = session.stream?.url || `/streams/${this.zoneId}/current.mp3`;
    const coverPath = session.stream?.coverUrl;
    const streamUrl = `${baseUrl}${streamPath}`;
    const coverUrl = coverPath ? `${baseUrl}${coverPath}` : undefined;
    return { baseUrl, streamUrl, coverUrl };
  }

  private async pushMetadataUpdate(metadata: any, customData: Record<string, any>): Promise<boolean> {
    const controller = (this.receiver as any)?.media;
    if (!controller?.sessionRequest || !controller?.currentSession?.mediaSessionId) {
      return false;
    }
    const payload = {
      type: 'PLAY',
      customData: {
        metadata,
        customData,
      },
    };
    try {
      await util.promisify((cb: any) => controller.sessionRequest(payload, cb))();
      return true;
    } catch (error: any) {
      this.log.debug('Google Cast metadata session update failed', {
        zoneId: this.zoneId,
        message: error?.message,
      });
      return false;
    }
  }
}
