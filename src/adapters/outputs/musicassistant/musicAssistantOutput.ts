import { createLogger } from '@/shared/logging/logger';
import type { MusicAssistantApi } from '@/shared/musicassistant/musicAssistantApi';
import type {
  HttpPreferences,
  OutputConfigDefinition,
  PreferredOutput,
  ZoneOutput,
} from '@/ports/OutputsTypes';
import type { PlaybackSession } from '@/application/playback/audioManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import { buildBaseUrl, resolveStreamUrl } from '@/shared/streamUrl';
import {
  acquireMaApiForBridge,
  findMusicAssistantBridge,
} from '@/shared/musicassistant/maBridgeResolver';
import { resolveActiveMaPlayerId } from '@/shared/musicassistant/maPlayerResolver';
import {
  chooseStreamProfile,
  parseStreamFormatPreference,
  type StreamFormatPreference,
  type StreamProfileChoice,
} from '@/domain/outputs/streamProfilePolicy';

export interface MusicAssistantOutputConfig {
  bridgeId: string;
  playerId: string;
  /** `auto` (lossless here), `lossless`, or `lossy` for a link that cannot carry it. */
  streamFormat?: string;
}

export const MUSIC_ASSISTANT_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'musicassistant',
  label: 'Music Assistant player',
  description:
    'Routes the zone to an existing Music Assistant player (Sonos, Chromecast, snapcast client, …). Audio plays directly on the MA player; this server only proxies commands and mirrors state.',
  fields: [
    {
      id: 'bridgeId',
      label: 'Music Assistant bridge',
      type: 'text',
      required: true,
      description: 'ID of the MA bridge (must be configured in sink mode).',
    },
    {
      id: 'playerId',
      label: 'MA player ID',
      type: 'text',
      required: true,
      description: 'Identifier of the target Music Assistant player.',
    },
    {
      id: 'streamFormat',
      label: 'Sound quality',
      type: 'text',
      placeholder: 'auto',
      description:
        "Music Assistant plays FLAC, so this sends the music unchanged by default. Set it to 'mp3' only if the link to Music Assistant cannot carry it.",
    },
  ],
};

export class MusicAssistantOutput implements ZoneOutput {
  public readonly type = 'musicassistant';
  private readonly log = createLogger('Output', 'MAplayer');
  private readonly playerId: string;
  private readonly bridgeId: string;
  private readonly streamFormat: StreamFormatPreference;
  private api: MusicAssistantApi | null;
  private unavailableReason: string | null = null;
  private loggedReason: string | null = null;

  constructor(
    private readonly zoneId: number,
    _zoneName: string,
    config: MusicAssistantOutputConfig,
    private readonly configPort: ConfigPort,
  ) {
    this.bridgeId = config.bridgeId;
    this.playerId = config.playerId;
    this.streamFormat = parseStreamFormatPreference(config.streamFormat);
    this.api = this.acquireApi();
  }

  public isReady(): boolean {
    if (!this.api) this.api = this.acquireApi();
    return this.api !== null;
  }

  public getPreferredOutput(): PreferredOutput {
    // FLAC, because Music Assistant's fetcher is ffmpeg: it decodes FLAC natively and then re-encodes
    // for whatever it is feeding (AirPlay, Sonos, a Cast group). Handing it MP3 capped that whole chain
    // at 256 kbit and added a lossy generation MA cannot undo. Lossless costs about 970 kbit/s on a LAN.
    return { profile: this.streamProfile(), sampleRate: 44100, channels: 2 };
  }

  public getHttpPreferences(): HttpPreferences {
    // Chunked without a Content-Length: this is a continuous live stream, and FLAC's length cannot be
    // derived from a duration anyway. ICY is off because MA parses raw audio frames — ICY metadata
    // interleaved into them would corrupt the stream.
    return { httpProfile: 'chunked', icyEnabled: false };
  }

  /**
   * MA is the one endpoint whose capability we know for certain rather than by inference: it is the
   * project we compared this engine against, and its media fetcher is ffmpeg. Still honours an explicit
   * `streamFormat: "lossy"` for a link that cannot carry it.
   */
  private streamProfile(): StreamProfileChoice {
    return chooseStreamProfile({ preference: this.streamFormat, losslessSupported: true });
  }

  public async play(session: PlaybackSession): Promise<void> {
    if (!this.api) this.api = this.acquireApi();
    if (!this.api) {
      this.log.warn('MA play skipped; api unavailable', {
        zoneId: this.zoneId,
        bridgeId: this.bridgeId,
        reason: this.unavailableReason ?? 'unknown',
      });
      return;
    }
    // For MA-bridge content the streamService already issued a play_media RPC
    // and returned outputOnly:true, so audioManager doesn't open a local
    // session. When we *do* get a real session here it means the source is a
    // local one (Spotify Connect, line-in, alerts, ...). We expose the zone's
    // FLAC stream and ask MA to play that URL on the linked player.
    const streamUrl = this.buildFlacStreamUrl(session);
    if (!streamUrl) {
      this.log.warn('MA play skipped; could not build stream URL', { zoneId: this.zoneId });
      return;
    }
    const targetPlayerId = await resolveActiveMaPlayerId(this.api, this.playerId);
    if (!targetPlayerId) {
      this.log.warn('MA play skipped; could not resolve target player', { zoneId: this.zoneId });
      return;
    }
    try {
      this.log.info('MA stream play_media', {
        zoneId: this.zoneId,
        playerId: targetPlayerId,
        url: streamUrl,
      });
      await this.api.connect();
      const ok = await this.api.playMedia(targetPlayerId, streamUrl, { option: 'replace' });
      if (!ok) {
        this.log.warn('MA play_media returned false', {
          zoneId: this.zoneId,
          playerId: targetPlayerId,
        });
      }
    } catch (err) {
      this.log.warn('MA play_media failed', {
        zoneId: this.zoneId,
        playerId: targetPlayerId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  public async pause(_session: PlaybackSession | null): Promise<void> {
    await this.sendCommand('pause');
  }

  public async resume(_session: PlaybackSession | null): Promise<void> {
    await this.sendCommand('play');
  }

  public async stop(_session: PlaybackSession | null): Promise<void> {
    await this.sendCommand('stop');
  }

  public async setVolume(level: number): Promise<void> {
    if (!this.api) this.api = this.acquireApi();
    if (!this.api) return;
    const volumeLevel = Math.max(0, Math.min(100, Math.round(level)));
    try {
      await this.api.playerCommand(this.playerId, 'volume_set', { volume_level: volumeLevel });
    } catch (err) {
      this.log.warn('volume_set failed', {
        zoneId: this.zoneId,
        playerId: this.playerId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  public dispose(): void {
    if (this.api) {
      this.api.release();
      this.api = null;
    }
  }

  private buildFlacStreamUrl(session: PlaybackSession): string | null {
    const sys = this.configPort.getSystemConfig();
    const baseUrl = buildBaseUrl({
      host: sys.audioserver?.ip?.trim(),
      fallbackHost: '127.0.0.1',
    });
    const url = resolveStreamUrl({
      baseUrl,
      zoneId: this.zoneId,
      // The extension selects which profile the stream handler serves, so it has to follow the choice.
      defaultExt: this.streamProfile() === 'flac' ? 'flac' : 'mp3',
      // Cache-bust per session id so MA refetches when our session rotates.
      prime: session?.stream?.id ?? Date.now(),
    });
    return url || null;
  }

  private async sendCommand(command: string): Promise<void> {
    if (!this.api) this.api = this.acquireApi();
    if (!this.api) return;
    try {
      await this.api.playerCommand(this.playerId, command);
    } catch (err) {
      this.log.warn('player command failed', {
        zoneId: this.zoneId,
        playerId: this.playerId,
        command,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private acquireApi(): MusicAssistantApi | null {
    const bridge = findMusicAssistantBridge(this.configPort, this.bridgeId);
    if (!bridge) {
      return this.markUnavailable('no bridge with this id', 'MA output created without matching bridge', {});
    }
    if ((bridge.provider || '').toLowerCase() !== 'musicassistant') {
      return this.markUnavailable(
        `bridge provider is ${bridge.provider || 'unknown'}, expected musicassistant`,
        'referenced bridge is not a Music Assistant bridge',
        { provider: bridge.provider },
      );
    }
    if (bridge.mode !== 'sink') {
      return this.markUnavailable(
        `bridge is in ${bridge.mode} mode, expected sink`,
        'MA output requires the bridge to be in sink mode',
        { mode: bridge.mode },
      );
    }
    this.unavailableReason = null;
    this.loggedReason = null;
    return acquireMaApiForBridge(bridge);
  }

  private markUnavailable(reason: string, logMessage: string, extra: Record<string, unknown>): null {
    this.unavailableReason = reason;
    if (this.loggedReason !== reason) {
      this.loggedReason = reason;
      this.log.warn(logMessage, { zoneId: this.zoneId, bridgeId: this.bridgeId, ...extra });
    }
    return null;
  }
}
