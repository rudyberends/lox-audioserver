import { createLogger } from '@/core/logging/logger';
import type { PlaybackSession } from '@/modules/audio';
import { audioStreamEngine } from '@/modules/audio/engine/audioStreamEngine';
import { pcmCodecFromBitDepth, audioOutputSettings } from '@/modules/audio/utils/audioFormat';
import type { PreferredOutput, TransportConfigDefinition, ZoneTransport } from '@/modules/audio/outputs/types';
import { snapcastCore } from '@/modules/http/snapcast/snapcastCore';
import { snapcastGroupController } from '@/modules/audio/outputs/snapcast/snapcastGroupController';

export interface SnapcastTransportConfig {
  /** Optional list of client IDs that should be mapped to this stream. */
  clientIds?: string | string[];
}

export const SNAPCAST_TRANSPORT_DEFINITION: TransportConfigDefinition = {
  id: 'snapcast',
  label: 'Snapcast',
  description: 'Built-in Snapcast-compatible WebSocket stream at /snapcast (same HTTP port).',
  fields: [
    {
      id: 'clientIds',
      label: 'Client ID',
      type: 'text',
      required: true,
      description: 'Snapclient Hello ID/MAC to map to this zone (comma-separated allowed for multiroom).',
    },
  ],
};

export class SnapcastTransport implements ZoneTransport {
  public readonly type = 'snapcast';
  private readonly log = createLogger('Transport', 'Snapcast');
  private currentStream: NodeJS.ReadableStream | null = null;
  private activeOutputSettings = audioOutputSettings;
  private readonly baseStreamId: string;
  private readonly baseClientIds: string[];
  private effectiveStreamId: string;
  private effectiveClientIds: string[];

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: SnapcastTransportConfig,
  ) {
    this.baseStreamId = String(zoneId);
    this.baseClientIds = Array.isArray(config.clientIds)
      ? config.clientIds.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim())
      : typeof config.clientIds === 'string'
        ? config.clientIds
            .split(',')
            .map((c: string) => c.trim())
            .filter(Boolean)
        : [];
    this.effectiveStreamId = this.baseStreamId;
    this.effectiveClientIds = [...this.baseClientIds];

    snapcastGroupController.register({
      zoneId,
      baseStreamId: this.baseStreamId,
      baseClientIds: this.baseClientIds,
      refresh: () => this.refreshGrouping(),
    });
  }

  public async play(session: PlaybackSession): Promise<void> {
    if (!session.playbackSource) {
      this.log.warn('Snapcast transport skipped; no playback source', { zoneId: this.zoneId });
      return;
    }
    await this.startStream(session);
  }

  public async pause(_session: PlaybackSession | null): Promise<void> {
    this.stopStream();
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    if (session) {
      await this.play(session);
    }
  }

  public async stop(_session: PlaybackSession | null): Promise<void> {
    this.stopStream();
  }

  public setVolume(level: number): void {
    const clamped = Math.min(100, Math.max(0, Math.round(level)));
    const targetClientIds = this.baseClientIds.length > 0 ? this.baseClientIds : this.effectiveClientIds;
    if (targetClientIds.length === 0) {
      return;
    }
    snapcastCore.setClientVolumes(targetClientIds, clamped);
  }

  public getPreferredOutput(): PreferredOutput {
    // Snapclient defaults: PCM, 48kHz/16-bit stereo.
    return { profile: 'pcm', sampleRate: 48000, channels: 2, bitDepth: 16 };
  }

  public getLatencyMs(): number | null {
    return null;
  }

  public async dispose(): Promise<void> {
    this.stopStream();
    snapcastGroupController.unregister(this.zoneId);
  }

  private async startStream(session: PlaybackSession | null): Promise<void> {
    this.stopStream();
    const plan = snapcastGroupController.buildPlan(
      this.zoneId,
      this.baseStreamId,
      this.baseClientIds,
    );
    this.effectiveStreamId = plan.streamId;
    this.effectiveClientIds = plan.clientIds;
    if (!plan.shouldPlay) {
      this.log.info('snapcast grouped member, skipping local stream', {
        zoneId: this.zoneId,
        leaderZoneId: plan.leaderZoneId,
      });
      return;
    }

    const pcmStream = audioStreamEngine.createStream(this.zoneId, 'pcm', {
      label: 'snapcast',
      primeWithBuffer: false,
    });
    if (!pcmStream) {
      this.log.warn('Snapcast stream unavailable (pcm profile missing)', { zoneId: this.zoneId });
      return;
    }
    const outputSettings = session?.outputSettings
      ? { ...audioOutputSettings, ...session.outputSettings }
      : audioOutputSettings;
    this.activeOutputSettings = outputSettings;
    const codec = pcmCodecFromBitDepth(outputSettings.pcmBitDepth);
    this.log.debug('serving PCM to Snapclients (ws)', {
      zoneId: this.zoneId,
      codec,
      sampleRate: outputSettings.sampleRate,
      channels: outputSettings.channels,
      streamId: this.effectiveStreamId,
      clientIds: this.effectiveClientIds,
    });

    snapcastCore.setStream(
      this.effectiveStreamId,
      this.zoneId,
      outputSettings,
      pcmStream,
      this.effectiveClientIds,
    );
    this.currentStream = pcmStream;
  }

  private stopStream(): void {
    snapcastCore.clearStream(this.zoneId);
    if (this.currentStream) {
      if (typeof (this.currentStream as any).destroy === 'function') {
        (this.currentStream as any).destroy();
      }
      this.currentStream = null;
    }
  }

  private refreshGrouping(): void {
    const plan = snapcastGroupController.buildPlan(
      this.zoneId,
      this.baseStreamId,
      this.baseClientIds,
    );
    this.effectiveStreamId = plan.streamId;
    this.effectiveClientIds = plan.clientIds;
    // Keep client mappings in sync even when this transport is not actively streaming.
    for (const clientId of this.baseClientIds) {
      snapcastCore.setClientStream(clientId, this.effectiveStreamId);
    }
    if (!this.currentStream) {
      return;
    }
    if (!plan.shouldPlay) {
      this.stopStream();
      return;
    }
    // Re-register stream with updated client mapping.
    if (this.currentStream) {
      snapcastCore.setStream(
        this.effectiveStreamId,
        this.zoneId,
        this.activeOutputSettings,
        this.currentStream,
        this.effectiveClientIds,
      );
    }
  }
}
