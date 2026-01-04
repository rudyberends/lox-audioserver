import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createLogger } from '@/core/logging/logger';
import type { PlaybackSession } from '@/modules/audio';
import { audioManager } from '@/modules/audio';
import { audioStreamEngine } from '@/modules/audio/engine/audioStreamEngine';
import {
  audioOutputSettings,
  type AudioOutputSettings,
  type PcmBitDepth,
} from '@/modules/audio/utils/audioFormat';
import { serverNowUs } from '@/modules/http/sendspin/sendspinClock';
import { sendspinCore } from '@/modules/http/sendspin/sendspinCore';
import { sendspinClientConnector } from '@/modules/http/sendspin/sendspinClientConnector';
import type { PreferredOutput, TransportConfigDefinition, ZoneTransport } from '@/modules/audio/outputs/types';
import { zoneManager } from '@/modules/zones/zoneManager';
import type { SendspinSession } from '@/modules/http/sendspin/sendspinSession';
import { sendspinGroupController } from '@/modules/audio/outputs/sendspin/sendspinGroupController';
import { getGroupByZone, upsertGroup } from '@/modules/groups/groupTracker';
import { groupManager } from '@/modules/groups/groupManager';

type SendspinFormat = {
  codec: 'pcm' | 'opus' | 'flac';
  sampleRate: number;
  channels: number;
  bitDepth: PcmBitDepth;
};

/** Minimal Sendspin transport configuration. */
export interface SendspinTransportConfig {
  clientId: string;
}

export type SendspinMetadataProgress = {
  track_progress: number;
  track_duration: number;
  playback_speed: number;
};

export type SendspinMetadataPayload = {
  title?: string | null;
  artist?: string | null;
  album_artist?: string | null;
  album?: string | null;
  artwork_url?: string | null;
  track?: number | null;
  year?: number | null;
  shuffle?: boolean | null;
  repeat?: 'off' | 'one' | 'all' | null;
  progress?: SendspinMetadataProgress | null;
};

export interface SendspinTransportOptions {
  onMetadata?: (payload: SendspinMetadataPayload) => void;
}

const cloneMetadataPayload = (payload: SendspinMetadataPayload): SendspinMetadataPayload => ({
  ...payload,
  progress: payload.progress ? { ...payload.progress } : payload.progress ?? null,
});

export const SENDSPIN_TRANSPORT_DEFINITION: TransportConfigDefinition = {
  id: 'sendspin',
  label: 'Sendspin',
  description: 'Streams the PCM output to a Sendspin client over WebSocket.',
  fields: [
    {
      id: 'clientId',
      label: 'Sendspin client ID',
      type: 'text',
      placeholder: 'sendspin-client-1',
      required: true,
      description: 'Identifier announced by the Sendspin client (client/hello).',
    },
  ],
};

/** Sendspin ZoneTransport implementation: streams audio/state to a Sendspin client. */
/** Sendspin ZoneTransport implementation: streams audio/state to a Sendspin client. */
export class SendspinTransport implements ZoneTransport {
  public readonly type = 'sendspin';
  private readonly log = createLogger('Transport', 'Sendspin');
  private readonly clientId: string;
  private readonly options: SendspinTransportOptions;
  private currentStream: NodeJS.ReadableStream | null = null;
  private progressTimer: NodeJS.Timeout | null = null;
  private currentCoverUrl: string | null = null;
  private lastProgressPayload: SendspinMetadataProgress | null = null;
  private readonly unregisterWatch: () => void;
  private playbackState: 'playing' | 'paused' | 'stopped' = 'stopped';
  private lastSentPlaybackState: 'playing' | 'paused' | 'stopped' | null = null;
  private lastKnownVolume = 50;
  private lastClientStateSignature: string | null = null;
  private initialClientStateSkipped = false;
  private clientState: 'synchronized' | 'error' | 'external_source' | null = null;
  private externalSourceActive = false;
  private lastOutboundVolume: number | null = null;
  private lastOutboundVolumeAt: number | null = null;
  private clientConnected = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private bufferedChunks: Array<{ data: Buffer; timestampUs: number }> = [];
  private bufferedBytes = 0;
  private sentInitialBuffer = false;
  /** Rolling buffer size to retain for late join / smoothing (bytes). */
  private maxBufferedBytes = audioOutputSettings.prebufferBytes;
  private lastLeadUs: number | null = null;
  /** Anchor for the Sendspin playback timeline (play_start_time_us). */
  private playStartUs: number | null = null;
  /** When the first chunk was observed (server clock). */
  private wallClockAnchorUs: number | null = null;
  /** Timestamp to assign to the next PCM frame (server time). */
  private nextFrameTimestampUs: number | null = null;
  /** Last wall-clock observation for encoded streams to measure elapsed time. */
  private lastChunkWallUs: number | null = null;
  private lastRestartMs = 0;
  private streamStarting = false;
  private activeSession: SendspinSession | null = null;
  private negotiatedFormat: SendspinFormat = {
    codec: 'pcm',
    sampleRate: audioOutputSettings.sampleRate,
    channels: audioOutputSettings.channels,
    bitDepth: audioOutputSettings.pcmBitDepth,
  };

  /** Actual output format of the current ffmpeg pipeline. */
  private activeOutputFormat: SendspinFormat | null = null;
  private anchorLeadUs = SendspinTransport.resolveAnchorLeadUs();
  // Match aiosendspin's 5s source buffer target to keep clients well-buffered.
  private readonly targetLeadUs = Math.max(this.anchorLeadUs, 5_000_000);
  private lastMetadataSignature: string | null = null;
  private lastStreamSignature: string | null = null;
  private pcmRemainder: Buffer | null = null;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: SendspinTransportConfig,
    options: SendspinTransportOptions = {},
  ) {
    this.clientId = config.clientId;
    this.options = options;
    this.unregisterWatch = sendspinClientConnector.watchClient(this.clientId);
    sendspinGroupController.register(this.zoneId, this);
    sendspinCore.registerHooks(this.clientId, {
      onIdentified: (sendspinSession) => {
        // Avoid re-running onIdentified for the same session instance.
        if (this.activeSession === sendspinSession) {
          return;
        }
        this.initialClientStateSkipped = false;
        this.lastClientStateSignature = null;
        this.activeSession = sendspinSession;
        this.clientConnected = true;
        this.clientState = null;
        this.externalSourceActive = false;
        this.negotiatedFormat = this.normalizeFormat(sendspinSession.getStreamFormat());
        // If there is an active audio session, reflect that state immediately.
        const audioSession = audioManager.getSession(this.zoneId);
        if (audioSession?.state) {
          this.playbackState = audioSession.state;
        }
        const initialZoneVolume =
          typeof zoneManager.getZoneState(this.zoneId)?.volume === 'number'
            ? (zoneManager.getZoneState(this.zoneId)?.volume as number)
            : this.lastKnownVolume;
        this.setVolume(initialZoneVolume);
        this.sendControllerState();
        this.sendCurrentSnapshot();
        if (this.playbackState === 'playing') {
          void this.startStream({ preserveAnchor: false, formatOverride: this.negotiatedFormat });
        }
        // Push current playback state to the client right away.
        this.pushPlaybackState(this.playbackState);
      },
      onPlayerState: (_session, update) => this.handleClientState(update),
      onGroupCommand: (_session, command) => this.handleGroupCommand(command),
      onDisconnected: () => {
        this.clientConnected = false;
        this.activeSession = null;
        this.initialClientStateSkipped = false;
        this.lastClientStateSignature = null;
        this.clientState = null;
        this.externalSourceActive = false;
        this.log.info('Sendspin client disconnected', { zoneId: this.zoneId, clientId: this.clientId });
      },
      onFormatChanged: (_session, format) => {
        this.negotiatedFormat = this.normalizeFormat(format);
        // Restart stream with the newly requested format.
        void this.startStream({ preserveAnchor: false, formatOverride: this.negotiatedFormat });
      },
    });
  }

  /** Whether there is a client connected and ready to receive PCM. */
  public isReady(): boolean {
    return this.clientConnected;
  }

  public getPreferredOutput(): PreferredOutput {
    const preferredPrebuffer = this.computePrebufferBytes(this.negotiatedFormat);
    return {
      profile: this.negotiatedFormat.codec === 'opus' ? 'opus' : this.negotiatedFormat.codec === 'flac' ? 'flac' : 'pcm',
      sampleRate: this.negotiatedFormat.sampleRate,
      channels: this.negotiatedFormat.channels,
      bitDepth: this.negotiatedFormat.bitDepth,
      prebufferBytes: preferredPrebuffer,
    };
  }

  public getLatencyMs(): number {
    return Math.max(0, Math.round(this.targetLeadUs / 1000));
  }

  /** Push a volume change down to the client (used by zone manager). */
  public setVolume(level: number): void {
    const vol = Math.min(100, Math.max(0, Math.round(level)));
    if (this.activeSession) {
      this.lastKnownVolume = vol;
      this.lastOutboundVolume = vol;
      this.lastOutboundVolumeAt = Date.now();
      this.activeSession.sendServerCommand('volume', { volume: vol });
    } else {
      this.lastKnownVolume = vol;
    }
  }

  /** Start playback for this zone on the Sendspin client. */
  public async play(session: PlaybackSession): Promise<void> {
    sendspinClientConnector.requestPlaybackPriority(this.clientId);
    if (!session.playbackSource) {
      this.log.warn('Sendspin transport skipped; no playback source', { zoneId: this.zoneId });
      return;
    }
    this.log.info('Sendspin play', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      clientId: this.clientId,
      source: session.source,
    });
    this.sendMetadata(session);
    void this.fetchAndSendArtwork(session);
    this.sendControllerState();
    this.startProgressUpdates();
    await this.startStream();
    this.pushPlaybackState('playing');
  }

  /** Pause playback and tear down the current stream. */
  public async pause(_session: PlaybackSession | null): Promise<void> {
    this.log.info('Sendspin pause', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      clientId: this.clientId,
    });
    this.teardown();
    this.sendProgressUpdate();
    this.pushPlaybackState('paused');
  }

  /** Resume playback; if a session is provided, restart as play. */
  public async resume(session: PlaybackSession | null): Promise<void> {
    this.log.info('Sendspin resume', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      clientId: this.clientId,
    });
    if (session) {
      sendspinClientConnector.requestPlaybackPriority(this.clientId);
    }
    if (session) {
      await this.play(session);
    } else {
      this.sendProgressUpdate();
      this.pushPlaybackState('playing');
    }
  }

  private handleClientState(update: { state?: string; volume?: number; muted?: boolean }): void {
    const signature = JSON.stringify({
      state: update.state,
      volume: update.volume,
      muted: update.muted,
    });
    if (signature === this.lastClientStateSignature) {
      return;
    }
    this.lastClientStateSignature = signature;
    // Skip the very first client state to avoid the client overriding the zone's default volume on connect.
    if (!this.initialClientStateSkipped) {
      this.initialClientStateSkipped = true;
      return;
    }
    const nextState =
      update.state === 'synchronized' || update.state === 'error' || update.state === 'external_source'
        ? update.state
        : null;
    if (nextState && nextState !== this.clientState) {
      this.clientState = nextState;
      if (nextState === 'external_source') {
        this.log.info('Sendspin client entered external_source', {
          zoneId: this.zoneId,
          clientId: this.clientId,
        });
        this.externalSourceActive = true;
        sendspinCore.sendStreamEnd(this.clientId, ['player@v1']);
        sendspinCore.sendStreamClear(this.clientId, ['player@v1']);
      } else if (this.externalSourceActive) {
        this.externalSourceActive = false;
        this.log.info('Sendspin client returned from external_source', {
          zoneId: this.zoneId,
          clientId: this.clientId,
        });
        // If we were playing, re-announce current state/stream.
        this.sendControllerState();
        if (this.playbackState === 'playing') {
          void this.startStream({ preserveAnchor: false });
          this.pushPlaybackState('playing');
        }
      }
    }
    const stateLevel =
      update.state === 'error' ? 'warn' : update.state === 'synchronized' ? 'debug' : 'info';
    // Only log interesting changes: warn on errors, debug when synchronized, otherwise skip.
    if (stateLevel === 'warn' || stateLevel === 'debug') {
      this.log[stateLevel]('Sendspin client state update', {
        zoneId: this.zoneId,
        clientId: this.clientId,
        state: update.state,
        volume: update.volume,
        muted: update.muted,
      });
    }
    if (typeof update.volume === 'number') {
      const vol = Math.min(100, Math.max(0, Math.round(update.volume)));
      this.lastKnownVolume = vol;
      zoneManager.handleCommand(this.zoneId, 'volume_set', String(vol));
    }
    if (typeof update.muted === 'boolean') {
      // No explicit mute command path in zoneManager; treat mute as volume 0/unmute restore.
      if (update.muted) {
        zoneManager.handleCommand(this.zoneId, 'volume_set', '0');
      } else {
        zoneManager.handleCommand(this.zoneId, 'volume_set', String(this.lastKnownVolume));
      }
    }
    this.sendControllerState();
  }

  private handleGroupCommand(command: { command: string; volume?: number; mute?: boolean }): void {
    const cmd = command.command;
    this.log.info('Sendspin controller command', { zoneId: this.zoneId, command: cmd, volume: command.volume, mute: command.mute });
    switch (cmd) {
      case 'play':
        zoneManager.handleCommand(this.zoneId, 'play');
        break;
      case 'pause':
        zoneManager.handleCommand(this.zoneId, 'pause');
        break;
      case 'stop':
        zoneManager.handleCommand(this.zoneId, 'stop');
        break;
      case 'next':
        zoneManager.handleCommand(this.zoneId, 'next');
        break;
      case 'previous':
        zoneManager.handleCommand(this.zoneId, 'previous');
        break;
      case 'volume':
        if (typeof command.volume === 'number') {
          const vol = Math.min(100, Math.max(0, Math.round(command.volume)));
          this.lastKnownVolume = vol;
          // Apply group volume per Sendspin spec when in a group; otherwise set zone volume.
          groupManager.applySpecGroupVolume(this.zoneId, vol);
          zoneManager.handleCommand(this.zoneId, 'volume_set', String(vol));
        }
        break;
      case 'mute':
        if (typeof command.mute === 'boolean') {
          if (command.mute) {
            zoneManager.handleCommand(this.zoneId, 'volume_set', '0');
          } else {
            zoneManager.handleCommand(this.zoneId, 'volume_set', String(this.lastKnownVolume));
          }
        }
        break;
      case 'repeat_off':
        zoneManager.setRepeatMode(this.zoneId, 'off');
        break;
      case 'repeat_one':
        zoneManager.setRepeatMode(this.zoneId, 'one');
        break;
      case 'repeat_all':
        zoneManager.setRepeatMode(this.zoneId, 'all');
        break;
      case 'shuffle':
        zoneManager.setShuffle(this.zoneId, true);
        break;
      case 'unshuffle':
        zoneManager.setShuffle(this.zoneId, false);
        break;
      case 'switch':
        this.handleSwitchCommand();
        break;
      default:
        this.log.debug('Unsupported Sendspin controller command', { cmd });
    }
  }

  private handleSwitchCommand(): void {
    const group = getGroupByZone(this.zoneId);
    if (!group) {
      this.log.debug('Sendspin switch ignored; no active group', { zoneId: this.zoneId });
      return;
    }
    if (group.leader === this.zoneId) {
      this.log.debug('Sendspin switch ignored; zone is group leader', { zoneId: this.zoneId });
      return;
    }
    const remainingMembers = group.members.filter((id) => id !== this.zoneId);
    upsertGroup({
      leader: group.leader,
      members: remainingMembers,
      backend: group.backend,
      externalId: group.externalId,
      source: group.source,
    });
    // Clear stream on this client so it can operate solo.
    sendspinCore.sendStreamEnd(this.clientId, ['player@v1']);
    sendspinCore.sendStreamClear(this.clientId, ['player@v1']);
    this.pushPlaybackState('stopped');
  }

  /** Stop playback and fully tear down the stream. */
  public async stop(_session: PlaybackSession | null): Promise<void> {
    this.log.info('Sendspin stop', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      clientId: this.clientId,
    });
    this.teardown();
    this.sendStopMetadata();
    this.pushPlaybackState('stopped');
  }

  public async updateMetadata(session: PlaybackSession | null): Promise<void> {
    const current = session ?? audioManager.getSession(this.zoneId);
    if (!current) {
      return;
    }
    this.sendMetadata(current);
  }

  /** Dispose transport resources and unregister hooks. */
  public async dispose(): Promise<void> {
    this.teardown();
    sendspinCore.unregisterHooks(this.clientId);
    sendspinCore.clearLeadStats(this.clientId);
    this.unregisterWatch();
    sendspinGroupController.unregister(this.zoneId);
  }

  private async startStream(
    options: {
      preserveAnchor?: boolean;
      formatOverride?: Partial<SendspinFormat>;
    } = {},
  ): Promise<void> {
    if (!this.clientConnected || !this.activeSession) {
      this.log.debug('Sendspin stream start skipped; client not connected yet', {
        zoneId: this.zoneId,
        clientId: this.clientId,
      });
      return;
    }
    if (this.streamStarting) {
      this.log.debug('Sendspin stream start skipped; already starting', { zoneId: this.zoneId });
      return;
    }
    const preserveAnchor = options.preserveAnchor === true;
    this.streamStarting = true;
    try {

      // Ensure there is an active PCM session for this zone; start one if missing.
      const current = audioManager.getSession(this.zoneId);
      if (!current?.playbackSource) {
        this.log.debug('Sendspin stream start skipped; no playback source', {
          zoneId: this.zoneId,
          clientId: this.clientId,
        });
        return;
      }
      const chosenFormat = this.normalizeFormat(options.formatOverride ?? this.negotiatedFormat);
      this.negotiatedFormat = chosenFormat;
      const prebufferBytes = this.computePrebufferBytes(chosenFormat);
      const sendspinOutputSettings: AudioOutputSettings = {
        ...audioOutputSettings,
        sampleRate: chosenFormat.sampleRate,
        channels: chosenFormat.channels,
        pcmBitDepth: chosenFormat.bitDepth,
        prebufferBytes,
      };
      this.maxBufferedBytes = prebufferBytes;
      const profile: 'pcm' | 'opus' | 'flac' =
        chosenFormat.codec === 'opus' ? 'opus' : chosenFormat.codec === 'flac' ? 'flac' : 'pcm';
      const streamSignature = this.buildStreamSignature(current, profile);
      const formatMatchesActive =
        this.activeOutputFormat &&
        this.activeOutputFormat.codec === chosenFormat.codec &&
        this.activeOutputFormat.sampleRate === chosenFormat.sampleRate &&
        this.activeOutputFormat.channels === chosenFormat.channels &&
        this.activeOutputFormat.bitDepth === chosenFormat.bitDepth;
      const shouldRestartForFormat = this.activeOutputFormat !== null && !formatMatchesActive;

      // If a stream already exists and is healthy, reuse it and just re-announce to the client.
      if (
        this.currentStream &&
        !(this.currentStream as any).destroyed &&
        !(this.currentStream as any).readableEnded &&
        this.lastStreamSignature === streamSignature &&
        this.activeOutputFormat &&
        this.activeOutputFormat.codec === chosenFormat.codec &&
        this.activeOutputFormat.sampleRate === chosenFormat.sampleRate &&
        this.activeOutputFormat.channels === chosenFormat.channels &&
        this.activeOutputFormat.bitDepth === chosenFormat.bitDepth
      ) {
        this.log.debug('Sendspin stream reusing existing pipeline', {
          zoneId: this.zoneId,
          activeFormat: this.activeOutputFormat,
          requestedFormat: chosenFormat,
        });
        const { sampleRate, channels, pcmBitDepth } = sendspinOutputSettings;
        sendspinCore.sendStreamStart(this.clientId, {
          codec: chosenFormat.codec,
          sampleRate,
          channels,
          bitDepth: pcmBitDepth,
        });
        sendspinGroupController.notifyStreamStart(this.zoneId, {
          codec: chosenFormat.codec,
          sampleRate,
          channels,
          bitDepth: pcmBitDepth,
        });
        // Reaffirm playback state to the client when reusing a stream.
        this.pushPlaybackState(this.playbackState);
        this.sendCurrentSnapshot();
        this.lastStreamSignature = streamSignature;
        return;
      }

      // If a previous stream object exists but is ended/destroyed, clean it up first.
      if (this.currentStream) {
        this.teardown({ preserveAnchor });
      }

      const sessionStats = audioStreamEngine.getSessionStats(this.zoneId);
      const hasTargetProfile = sessionStats.some((s) => s.profile === profile);
      let startedEngine = false;
      if ((shouldRestartForFormat || !hasTargetProfile) && current?.playbackSource) {
        audioStreamEngine.start(this.zoneId, current.playbackSource, [profile], sendspinOutputSettings);
        startedEngine = true;
      }

      let pcmStream = audioStreamEngine.createStream(this.zoneId, profile, {
        primeWithBuffer: true,
        label: 'sendspin',
      });
      // Fallback: if we expected an existing session but couldn't attach, start a fresh one.
      if (!pcmStream && !startedEngine && current?.playbackSource) {
        audioStreamEngine.start(this.zoneId, current.playbackSource, [profile], sendspinOutputSettings);
        startedEngine = true;
        pcmStream = audioStreamEngine.createStream(this.zoneId, profile, {
          primeWithBuffer: true,
          label: 'sendspin',
        });
      }
      if (!pcmStream) {
        this.log.warn('Sendspin stream unavailable (profile missing)', { zoneId: this.zoneId, profile });
        return;
      }
      const { sampleRate, channels, pcmBitDepth } = sendspinOutputSettings;
      // Delay anchoring until the first real chunk arrives to keep the full lead even if the pipeline needs time to warm up.
      this.playStartUs = null;
      this.wallClockAnchorUs = null;
      this.nextFrameTimestampUs = null;
      this.lastChunkWallUs = null;
      this.bufferedChunks = [];
      this.bufferedBytes = 0;
      this.sentInitialBuffer = true; // streaming live; timestamps provide the lead buffer

      let chunkCount = 0;
      let modeledTimelineUs = 0; // Sum of durations we think we sent (for drift visibility).
      let codecHeaderSent = false;
      let streamStartSent = false;
      const isFlac = chosenFormat.codec === 'flac';
      const bytesPerSample = (pcmBitDepth / 8) * channels;
      const isPcm = chosenFormat.codec === 'pcm';
      const frameSamples = Math.max(1, Math.floor(sampleRate * 0.025));
      const frameBytes = frameSamples * bytesPerSample;
      let pcmFrameBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let flacBlocksizeSamples = 0;
      const parseFlacBlocksize = (headerBuf: Buffer): number => {
        // STREAMINFO: min blocksize @8-9, max blocksize @10-11 (big-endian)
        try {
          const minBs = headerBuf.readUInt16BE(8);
          const maxBs = headerBuf.readUInt16BE(10);
          const bs = maxBs || minBs || 0;
          return bs;
        } catch {
          return 0;
        }
      };
      let encodedFrameDurationUs =
        chosenFormat.codec === 'opus'
          ? Math.floor(1_000_000 / 50) // 20 ms frames
          : chosenFormat.codec === 'flac'
            ? Math.floor((4096 * 1_000_000) / sampleRate)
            : 0;
      const overbufferMarginUs = 100_000; // keep lead tight around target
      const pendingFrames: Array<{ data: Buffer; durationUs: number }> = [];
      let pendingDurationUs = 0;
      let streamingStarted = false;
      const prepareBufferMarginUs = 2_500_000; // align with MA buffer margin for stale detection
      const sendTransmissionMarginUs = 100_000; // align with MA send margin (network + client processing)
      const targetBufferUs = 5_000_000; // match MA source buffer target duration
      const backpressureCapacityBytes =
        sendspinCore.getPlayerBufferCapacity(this.clientId) || this.maxBufferedBytes || 0;
      const bufferedForCapacity: Array<{ endUs: number; byteCount: number }> = [];
      let bufferedCapacityBytes = 0;

      const pruneCapacity = (nowUs: number): void => {
        while (bufferedForCapacity.length && bufferedForCapacity[0].endUs <= nowUs) {
          const removed = bufferedForCapacity.shift();
          if (removed) {
            bufferedCapacityBytes -= removed.byteCount;
          }
        }
        if (bufferedCapacityBytes < 0) {
          bufferedCapacityBytes = 0;
        }
      };

      const timeUntilCapacityUs = (bytesNeeded: number): number => {
        if (backpressureCapacityBytes <= 0 || bytesNeeded <= 0 || bytesNeeded >= backpressureCapacityBytes) {
          return 0;
        }
        const nowUs = serverNowUs();
        pruneCapacity(nowUs);
        let virtualBytes = bufferedCapacityBytes;
        let cursorTimeUs = nowUs;
        let waitUs = 0;
        for (const chunk of bufferedForCapacity) {
          if (virtualBytes + bytesNeeded <= backpressureCapacityBytes) {
            break;
          }
          waitUs += Math.max(0, chunk.endUs - cursorTimeUs);
          cursorTimeUs = chunk.endUs;
          virtualBytes = Math.max(0, virtualBytes - chunk.byteCount);
        }
        return waitUs;
      };

      const waitForCapacity = async (bytesNeeded: number): Promise<void> => {
        if (backpressureCapacityBytes <= 0 || bytesNeeded <= 0) {
          return;
        }
        while (true) {
          const waitUs = timeUntilCapacityUs(bytesNeeded);
          if (waitUs <= 0) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.ceil(waitUs / 1000))));
        }
      };

      const registerCapacity = (endUs: number, byteCount: number): void => {
        if (backpressureCapacityBytes <= 0 || byteCount <= 0) {
          return;
        }
        bufferedForCapacity.push({ endUs, byteCount });
        bufferedCapacityBytes += byteCount;
      };

      const shiftTimeline = (deltaUs: number): void => {
        if (this.playStartUs !== null) {
          this.playStartUs += deltaUs;
        }
        if (this.nextFrameTimestampUs !== null) {
          this.nextFrameTimestampUs += deltaUs;
        }
        this.bufferedChunks = this.bufferedChunks.map((f) => ({
          data: f.data,
          timestampUs: f.timestampUs + deltaUs,
        }));
        for (let i = 0; i < bufferedForCapacity.length; i += 1) {
          bufferedForCapacity[i] = {
            endUs: bufferedForCapacity[i].endUs + deltaUs,
            byteCount: bufferedForCapacity[i].byteCount,
          };
        }
      };

      const computeAdjustForStale = (tsUs: number, durationUs: number): number => {
        const nowUs = serverNowUs();
        const headroomShortfallUs = nowUs + prepareBufferMarginUs - tsUs;
        const currentBufferEndUs = this.nextFrameTimestampUs ?? tsUs + durationUs;
        const currentBufferUs = Math.max(0, currentBufferEndUs - nowUs);
        const bufferShortfallUs = targetBufferUs - currentBufferUs;
        return bufferShortfallUs > 0
          ? Math.max(headroomShortfallUs, bufferShortfallUs)
          : headroomShortfallUs;
      };

      const waitUntilLeadInRange = async (tsUs: number): Promise<void> => {
        // Match MA behaviour: do not advance timestamps; simply backpressure the source
        // so the effective lead cannot grow beyond targetLead + margin.
        while (tsUs - serverNowUs() > this.targetLeadUs + overbufferMarginUs) {
          const deltaUs = tsUs - serverNowUs() - this.targetLeadUs;
          const waitMs = Math.max(5, Math.min(200, Math.floor(deltaUs / 1000)));
          pcmStream.pause();
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          pcmStream.resume();
        }
      };

      const emitFrame = (frameTsUs: number, frameData: Buffer, durationUs: number): void => {
        const targetLeadUs = this.targetLeadUs;
        const lead = frameTsUs - serverNowUs();
        this.lastLeadUs = lead;
        sendspinCore.setLeadStats(this.clientId, {
          leadUs: lead,
          targetLeadUs,
          bufferedBytes: this.bufferedBytes,
        });

        const frame = { data: frameData, timestampUs: frameTsUs };
        if (!this.externalSourceActive) {
          sendspinCore.sendPcmFrameToClient(this.clientId, frame);
        }
        sendspinGroupController.broadcastFrame(this.zoneId, frame);
        registerCapacity(frameTsUs + durationUs, frameData.length);

        this.bufferedChunks.push(frame);
        this.bufferedBytes += frameData.length;
        const maxBuffered = this.maxBufferedBytes;
        while (maxBuffered > 0 && this.bufferedBytes > maxBuffered && this.bufferedChunks.length > 0) {
          const removed = this.bufferedChunks.shift();
          if (removed) {
            this.bufferedBytes -= removed.data.length;
          }
        }

        chunkCount += 1;
        if (chunkCount <= 3 || chunkCount % 500 === 0) {
          const leadNow = frameTsUs - serverNowUs();
          const logPayload: Record<string, number | string | null> = {
            zoneId: this.zoneId,
            chunkCount,
            tsUs: frameTsUs,
            leadUs: leadNow,
            playStartUs: this.playStartUs,
            modeledDriftUs:
              this.playStartUs !== null ? frameTsUs - this.playStartUs - modeledTimelineUs : null,
            leadErrorUs: leadNow - this.targetLeadUs,
          };
          if (isPcm) {
            logPayload.frames = Math.floor(frameData.length / bytesPerSample);
            logPayload.durationUs = Math.floor((logPayload.frames as number * 1_000_000) / sampleRate);
            logPayload.sampleRate = sampleRate;
          }
          this.log.debug('Sendspin frame ts', logPayload);
        }
      };

      const ensureStreamStart = (codecHeader?: string): void => {
        if (streamStartSent) {
          return;
        }
        if (!this.externalSourceActive) {
          sendspinCore.sendStreamStart(this.clientId, {
            codec: chosenFormat.codec,
            sampleRate,
            channels,
            bitDepth: pcmBitDepth,
            ...(codecHeader ? { codecHeader } : {}),
          });
        }
        sendspinGroupController.notifyStreamStart(this.zoneId, {
          codec: chosenFormat.codec,
          sampleRate,
          channels,
          bitDepth: pcmBitDepth,
          ...(codecHeader ? { codecHeader } : {}),
        });
        streamStartSent = true;
      };

      const sendScheduledFrame = async (
        frameData: Buffer<ArrayBufferLike>,
        durationUs: number,
        options: { skipLeadGate?: boolean } = {},
      ): Promise<void> => {
        if (this.nextFrameTimestampUs === null) {
          this.playStartUs = serverNowUs() + this.anchorLeadUs;
          this.nextFrameTimestampUs = this.playStartUs;
          this.wallClockAnchorUs = serverNowUs();
          this.log.debug('Sendspin anchor set', {
            zoneId: this.zoneId,
            leadMs: Math.round(this.anchorLeadUs / 1000),
            sampleRate,
          });
        }
        let timestampUs = this.nextFrameTimestampUs;
        this.nextFrameTimestampUs += durationUs;
        modeledTimelineUs += durationUs;

        if (timestampUs < serverNowUs() + sendTransmissionMarginUs) {
          const adjustUs = computeAdjustForStale(timestampUs, durationUs);
          if (adjustUs > 0) {
            this.log.info('Sendspin timeline adjusted to avoid stale send', {
              zoneId: this.zoneId,
              adjustMs: Math.round(adjustUs / 1000),
            });
            shiftTimeline(adjustUs);
            timestampUs += adjustUs;
          }
        }
        if (!options.skipLeadGate) {
          await waitUntilLeadInRange(timestampUs);
        }
        await waitForCapacity(frameData.length);
        ensureStreamStart();
        emitFrame(timestampUs, frameData, durationUs);
      };

      const processFrame = async (frameData: Buffer<ArrayBufferLike>, durationUs: number): Promise<void> => {
        if (!streamingStarted) {
          pendingFrames.push({ data: frameData, durationUs });
          pendingDurationUs += durationUs;
          if (pendingDurationUs < this.targetLeadUs) {
            return;
          }
          streamingStarted = true;
          for (const frame of pendingFrames) {
            await sendScheduledFrame(frame.data, frame.durationUs, { skipLeadGate: true });
          }
          pendingFrames.length = 0;
          pendingDurationUs = 0;
          return;
        }
        await sendScheduledFrame(frameData, durationUs);
      };

      const sendPcmFrame = async (
        frameData: Buffer<ArrayBufferLike>,
        samplesInFrame: number,
      ): Promise<void> => {
        const durationUs = Math.floor((samplesInFrame * 1_000_000) / sampleRate);
        await processFrame(frameData, durationUs);
      };

      const sendLiveChunk = async (chunk: Buffer) => {
        let payload = chunk;
        const nowUs = serverNowUs();
        if (this.wallClockAnchorUs === null) {
          this.wallClockAnchorUs = nowUs;
        }

        if (isPcm) {
          if (this.pcmRemainder?.length) {
            payload = Buffer.concat([this.pcmRemainder, payload]);
            this.pcmRemainder = null;
          }
          const remainder = payload.length % bytesPerSample;
          if (remainder > 0) {
            this.pcmRemainder = payload.subarray(payload.length - remainder);
            payload = payload.subarray(0, payload.length - remainder);
          }
          if (payload.length === 0) {
            return;
          }
          pcmFrameBuffer = pcmFrameBuffer.length
            ? (Buffer.concat([pcmFrameBuffer, payload]) as Buffer<ArrayBufferLike>)
            : payload;
          while (pcmFrameBuffer.length >= frameBytes) {
            const frame = pcmFrameBuffer.subarray(0, frameBytes);
            pcmFrameBuffer = pcmFrameBuffer.subarray(frameBytes);
            await sendPcmFrame(frame, frameSamples);
          }
          return;
        } else {
          if (this.lastChunkWallUs === null) {
            this.lastChunkWallUs = nowUs;
          }
          const wallElapsedUs = Math.max(0, nowUs - this.lastChunkWallUs);
          const appliedDurationUs =
            encodedFrameDurationUs || wallElapsedUs || Math.floor(1_000_000 / 50);
          this.lastChunkWallUs = nowUs;
          const durationUs:number = appliedDurationUs;
          if (!codecHeaderSent && payload.length) {
            const codecHeader = payload.toString('base64');
            if (isFlac) {
              const bs = parseFlacBlocksize(payload);
              if (bs > 0) {
                flacBlocksizeSamples = bs;
                encodedFrameDurationUs = Math.floor((flacBlocksizeSamples * 1_000_000) / sampleRate);
              }
            }
            ensureStreamStart(codecHeader);
            codecHeaderSent = true;
            // For FLAC, treat this first packet purely as header and skip sending it as audio.
            if (isFlac) {
              return;
            }
          }
          await processFrame(payload, durationUs);
        }
      };

      // Stream PCM immediately; timestamps keep a fixed lead, so no manual prefill needed.
      let sendChain: Promise<void> = Promise.resolve();
      pcmStream.on('data', (chunk: Buffer) => {
        if (!chunk?.length) {
          return;
        }
        // Prevent a long train of queued Promises when the client is slow; drop chunk if chain is too deep.
        const pending = (sendChain as any)._pendingCount as number | undefined;
        if (typeof pending === 'number' && pending > 4) {
          return;
        }
        sendChain = sendChain.then(() => sendLiveChunk(chunk)).catch((err) => {
          this.log.warn('Sendspin send error', { zoneId: this.zoneId, message: (err as Error).message });
        });
      });

      const streamRef = pcmStream;
      pcmStream.on('error', (error) => {
        if (streamRef !== this.currentStream) {
          return;
        }
        this.log.warn('Sendspin stream error', {
          zoneId: this.zoneId,
          message: (error as Error).message,
        });
        this.teardown();
        this.scheduleRestart();
      });

      pcmStream.on('close', () => {
        if (streamRef !== this.currentStream) {
          return;
        }
        this.log.debug('Sendspin stream closed', { zoneId: this.zoneId });
        this.teardown();
        this.scheduleRestart();
      });


      this.log.info('Sendspin stream started', {
        zoneId: this.zoneId,
        clientId: this.clientId,
        sampleRate,
        channels,
        bitDepth: pcmBitDepth,
      });

      this.lastStreamSignature = streamSignature;
      this.activeOutputFormat = {
        codec: chosenFormat.codec,
        sampleRate,
        channels,
        bitDepth: pcmBitDepth,
      };

      // Reaffirm playback state to the client when (re)starting a stream.
      this.pushPlaybackState(this.playbackState);
      this.sendCurrentSnapshot();

      this.currentStream = pcmStream;
    } finally {
      this.streamStarting = false;
    }
  }

  private teardown(options: { preserveAnchor?: boolean } = {}): void {
    const preserveAnchor = options.preserveAnchor === true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.bufferedChunks = [];
    this.bufferedBytes = 0;
    this.sentInitialBuffer = false;
    this.maxBufferedBytes = audioOutputSettings.prebufferBytes;
    this.activeOutputFormat = null;
    if (!preserveAnchor) {
      this.playStartUs = null;
      this.wallClockAnchorUs = null;
      this.nextFrameTimestampUs = null;
      this.lastChunkWallUs = null;
      this.lastMetadataSignature = null;
      this.currentCoverUrl = null;
    }
    if (this.currentStream) {
      this.currentStream.removeAllListeners();
      if ('destroy' in this.currentStream && typeof (this.currentStream as any).destroy === 'function') {
        (this.currentStream as any).destroy();
      }
      this.currentStream = null;
    }
    this.stopProgressUpdates();
    // Notify client to clear/end only when we are really stopping; skip during keep-alive restarts.
    if (!preserveAnchor) {
      sendspinCore.sendStreamEnd(this.clientId, ['player@v1']);
      sendspinCore.sendStreamClear(this.clientId, ['player@v1']);
      sendspinGroupController.notifyStreamEnd(this.zoneId);
      this.lastStreamSignature = null;
    }
  }

  private async restartStreamFresh(): Promise<void> {
    this.teardown({ preserveAnchor: true });
    const session = audioManager.getSession(this.zoneId);
    if (session?.playbackSource && this.playbackState === 'playing') {
      await this.startStream({ preserveAnchor: true });
    }
  }

  public async reanchorForGroup(): Promise<void> {
    // Hard restart stream with fresh anchor so grouped members can align to leader.
    this.teardown({ preserveAnchor: false });
    const session = audioManager.getSession(this.zoneId);
    if (session?.playbackSource && this.playbackState === 'playing') {
      await this.startStream({ preserveAnchor: false });
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer) {
      return;
    }
    if (this.playbackState !== 'playing') {
      return;
    }
    const session = audioManager.getSession(this.zoneId);
    if (!session?.playbackSource) {
      return;
    }
    // Avoid rapid restart loops if the source keeps closing.
    const now = Date.now();
    if (now - this.lastRestartMs < 3000) {
      return;
    }
    this.lastRestartMs = now;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.startStream({ preserveAnchor: true });
    }, 500);
  }

  private sendMetadata(session: PlaybackSession): void {
    const payload = this.buildMetadataPayload(session);
    if (!payload) {
      return;
    }
    this.log.spam('Sendspin metadata update', {
      zoneId: this.zoneId,
      clientId: this.clientId,
      title: payload.title,
      artist: payload.artist,
      album: payload.album,
    });
    this.lastProgressPayload = payload.progress ?? null;
    sendspinCore.setClientMetadata(this.clientId, payload);
    this.options.onMetadata?.(cloneMetadataPayload(payload));
    sendspinGroupController.broadcastMetadata(this.zoneId, payload);
  }

  private sendControllerState(): void {
    const zoneState = zoneManager.getZoneState(this.zoneId);
    const vol = typeof zoneState?.volume === 'number' ? zoneState.volume : this.lastKnownVolume;
    this.lastKnownVolume = vol;
    const supportedCommands: Array<
      // eslint-disable-next-line max-len
      'play' | 'pause' | 'stop' | 'next' | 'previous' | 'volume' | 'mute' | 'repeat_off' | 'repeat_one' | 'repeat_all' | 'shuffle' | 'unshuffle' | 'switch'
    > = ['play', 'pause', 'stop', 'next', 'previous', 'volume', 'mute', 'switch'];
    // Repeat/shuffle only if zoneManager exposes those controls.
    if (typeof zoneState?.plrepeat === 'number') {
      supportedCommands.push('repeat_off', 'repeat_one', 'repeat_all');
    }
    if (typeof zoneState?.plshuffle === 'number') {
      supportedCommands.push('shuffle', 'unshuffle');
    }
    sendspinCore.setClientControllerState(this.clientId, {
      supported_commands: supportedCommands,
      volume: vol,
      muted: false,
    });
    sendspinGroupController.broadcastControllerState(this.zoneId, {
      supported_commands: supportedCommands,
      volume: vol,
      muted: false,
    });
  }

  private startProgressUpdates(): void {
    // Single-shot progress push; avoid per-second updates.
    this.sendProgressUpdate();
  }

  private stopProgressUpdates(): void {
    // No-op now that we do single-shot progress updates.
  }

  private sendProgressUpdate(): void {
    const session = audioManager.getSession(this.zoneId);
    const zoneState = zoneManager.getZoneState(this.zoneId);
    const now = Date.now();
    const baseElapsed =
      session && session.state === 'playing' && session.startedAt
        ? session.elapsed + (now - session.startedAt) / 1000
        : session?.elapsed ?? zoneState?.time ?? 0;
    const durationSec =
      session?.duration ??
      session?.metadata?.duration ??
      zoneState?.duration ??
      0;
    const coverUrl =
      session?.metadata?.coverurl ??
      session?.stream?.coverUrl ??
      zoneState?.coverurl ??
      null;

    const playbackSpeed = session?.state === 'playing' ? 1000 : 0;
    const payload = this.buildMetadataPayload(
      session,
      Math.max(0, Math.floor(baseElapsed * 1000)),
      Math.max(0, Math.floor(durationSec * 1000)),
      playbackSpeed,
    );
    const nextProgress = payload?.progress ?? null;
    const metadataSignature = payload ? this.buildMetadataSignature(payload) : null;
    const metadataChanged =
      !!metadataSignature && metadataSignature !== this.lastMetadataSignature;
    const normalizedCover = coverUrl ?? null;
    const coverChanged = normalizedCover !== this.currentCoverUrl;
    const progressChanged =
      !this.lastProgressPayload ||
      !nextProgress ||
      this.lastProgressPayload.track_progress !== nextProgress.track_progress ||
      this.lastProgressPayload.track_duration !== nextProgress.track_duration ||
      this.lastProgressPayload.playback_speed !== nextProgress.playback_speed;

    if (payload && (metadataChanged || coverChanged)) {
      this.lastProgressPayload = nextProgress;
      this.lastMetadataSignature = metadataSignature;
      this.currentCoverUrl = normalizedCover;
      sendspinCore.setClientMetadata(this.clientId, payload);
      this.options.onMetadata?.(cloneMetadataPayload(payload));
      if (coverUrl && coverChanged) {
        void this.fetchAndSendArtwork({ metadata: session?.metadata, stream: session?.stream });
      }
    } else if (nextProgress && progressChanged) {
      this.lastProgressPayload = nextProgress;
      sendspinCore.setClientMetadata(this.clientId, { progress: nextProgress });
      const progressPayload: SendspinMetadataPayload = { progress: nextProgress };
      this.options.onMetadata?.(cloneMetadataPayload(progressPayload));
    }
  }

  private sendStopMetadata(): void {
    const duration = this.lastProgressPayload?.track_duration ?? 0;
    const payload: SendspinMetadataPayload = {
      title: null,
      artist: null,
      album_artist: null,
      album: null,
      artwork_url: null,
      track: null,
      year: null,
      shuffle: null,
      repeat: null,
      progress: {
        track_progress: 0,
        track_duration: duration,
        playback_speed: 0,
      },
    };
    this.lastProgressPayload = payload.progress ?? null;
    this.lastMetadataSignature = this.buildMetadataSignature(payload);
    this.currentCoverUrl = null;
    sendspinCore.setClientMetadata(this.clientId, payload);
    this.options.onMetadata?.(cloneMetadataPayload(payload));
    sendspinGroupController.broadcastMetadata(this.zoneId, payload);
  }

  private pushPlaybackState(state: 'playing' | 'paused' | 'stopped'): void {
    this.playbackState = state;
    if (this.lastSentPlaybackState === state) {
      return;
    }
    const { groupId, groupName } = this.getGroupInfo();
    const mappedState: 'playing' | 'paused' | 'stopped' =
      state === 'playing' ? 'playing' : state === 'paused' ? 'paused' : 'stopped';
    sendspinCore.setClientPlaybackState(this.clientId, mappedState, groupId, groupName);
    sendspinGroupController.broadcastPlaybackState(this.zoneId, mappedState, groupId, groupName);
    this.lastSentPlaybackState = state;
  }

  private sendCurrentSnapshot(): void {
    // Push latest playback state + metadata to a newly connected client.
    this.pushPlaybackState(this.playbackState);
    const session = audioManager.getSession(this.zoneId);
    const payload = this.buildMetadataPayload(session);
    if (payload) {
      this.lastMetadataSignature = this.buildMetadataSignature(payload);
      this.currentCoverUrl = payload.artwork_url ?? null;
      sendspinCore.setClientMetadata(this.clientId, payload);
      this.options.onMetadata?.(cloneMetadataPayload(payload));
      if (payload.artwork_url) {
        void this.fetchAndSendArtwork(session ?? ({} as PlaybackSession));
      }
    }
    this.sendProgressUpdate();
  }

  private buildMetadataPayload(
    session: PlaybackSession | null,
    trackProgressMs?: number,
    trackDurationMs?: number,
    playbackSpeed?: number,
  ): SendspinMetadataPayload | null {
    const zoneState = zoneManager.getZoneState(this.zoneId);
    const meta = session?.metadata;
    const title = meta?.title ?? zoneState?.title ?? this.zoneName ?? 'Sendspin';
    const artist = meta?.artist ?? zoneState?.artist ?? null;
    const albumArtist = (meta as any)?.album_artist ?? null;
    const album = meta?.album ?? zoneState?.album ?? null;
    const cover = meta?.coverurl ?? session?.stream?.coverUrl ?? zoneState?.coverurl ?? null;
    const durationMs =
      typeof trackDurationMs === 'number'
        ? trackDurationMs
        : meta?.duration != null
          ? meta.duration * 1000
          : zoneState?.duration != null
            ? zoneState.duration * 1000
            : null;
    const trackNumber =
      typeof meta?.trackId === 'number'
        ? meta.trackId
        : Number.isFinite(Number(meta?.trackId))
          ? Number(meta?.trackId)
          : null;
    const repeatMode: 'off' | 'one' | 'all' | null =
      zoneState?.plrepeat === 1
        ? 'one'
        : zoneState?.plrepeat === 2
          ? 'all'
          : 'off';
    const shuffleMode: boolean | null =
      typeof zoneState?.plshuffle === 'number' ? zoneState.plshuffle === 1 : null;

    return {
      title,
      artist,
      album,
      artwork_url: cover,
      track: trackNumber,
      album_artist: albumArtist,
      year: typeof (meta as any)?.year === 'number' ? (meta as any).year : null,
      shuffle: shuffleMode,
      repeat: repeatMode,
      progress: {
        track_progress: trackProgressMs ?? 0,
        track_duration: durationMs ?? 0,
        playback_speed: playbackSpeed ?? (this.playbackState === 'playing' ? 1000 : 0),
      },
    };
  }

  private buildMetadataSignature(payload: SendspinMetadataPayload): string {
    return JSON.stringify({
      title: payload.title ?? null,
      artist: payload.artist ?? null,
      album_artist: payload.album_artist ?? null,
      album: payload.album ?? null,
      year: payload.year ?? null,
      track: payload.track ?? null,
      artwork: payload.artwork_url ?? null,
    });
  }

  private buildStreamSignature(session: PlaybackSession | null, profile: 'pcm' | 'opus' | 'flac'): string {
    if (!session) {
      return 'none';
    }
    const source = session.playbackSource;
    const base =
      source?.kind === 'pipe'
        ? `pipe:${(source as any).path ?? ''}`
        : source?.kind === 'file'
          ? `file:${(source as any).path ?? ''}`
          : source?.kind === 'url'
            ? `url:${(source as any).url ?? ''}`
            : session.source ?? 'unknown';
    const streamId = session.stream?.id ?? '';
    const pcmId = session.pcmStream?.id ?? '';
    return `${base}|${profile}|${streamId}|${pcmId}`;
  }

  // eslint-disable-next-line max-len
  private async fetchAndSendArtwork(session?: { metadata?: PlaybackSession['metadata']; stream?: PlaybackSession['stream'] }): Promise<void> {
    const preferredChannels =
      sendspinCore.getArtworkChannels(this.clientId) ??
      [
        { source: 'album', format: 'jpeg', width: 800, height: 800 },
      ];
    try {
      const coverUrl =
        session?.metadata?.coverurl ??
        session?.stream?.coverUrl ??
        null;
      if (!coverUrl) {
        sendspinCore.sendArtworkStreamStart(this.clientId, preferredChannels);
        preferredChannels.forEach((_, idx) => sendspinCore.sendArtwork(this.clientId, idx as 0 | 1 | 2 | 3, null));
        return;
      }
      // Skip invalid/non-http URLs to avoid noisy errors.
      try {
        const parsed = new URL(coverUrl);
        if (!/^https?:$/.test(parsed.protocol)) {
          sendspinCore.sendArtworkStreamStart(this.clientId, preferredChannels);
          preferredChannels.forEach((_, idx) => sendspinCore.sendArtwork(this.clientId, idx as 0 | 1 | 2 | 3, null));
          return;
        }
      } catch {
        sendspinCore.sendArtworkStreamStart(this.clientId, preferredChannels);
        preferredChannels.forEach((_, idx) => sendspinCore.sendArtwork(this.clientId, idx as 0 | 1 | 2 | 3, null));
        return;
      }
      const buf = await this.fetchBuffer(coverUrl);
      if (!buf) {
        return;
      }
      sendspinCore.sendArtworkStreamStart(this.clientId, preferredChannels);
      preferredChannels.forEach((_, idx) => {
        sendspinCore.sendArtwork(this.clientId, idx as 0 | 1 | 2 | 3, buf);
      });
    } catch (error) {
      this.log.debug('Sendspin artwork fetch failed', {
        zoneId: this.zoneId,
        message: (error as Error).message,
      });
    }
  }

  private async fetchBuffer(url: string): Promise<Buffer | null> {
    return new Promise<Buffer | null>((resolve) => {
      const handler = (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => resolve(null));
      };
      const client = url.startsWith('https') ? httpsRequest : httpRequest;
      const req = client(url, handler);
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  /** Identifier of the configured Sendspin client. */
  public getClientId(): string {
    return this.clientId;
  }

  /** Indicates whether the configured Sendspin client is currently connected. */
  public isClientConnected(): boolean {
    return this.clientConnected;
  }

  private getGroupInfo(): { groupId: string; groupName: string } {
    const group = getGroupByZone(this.zoneId);
    if (group) {
      const groupId = group.externalId ?? `group-${group.leader}`;
      const groupName =
        zoneManager.getZoneState(group.leader)?.name ??
        zoneManager.getZoneState(this.zoneId)?.name ??
        this.zoneName;
      return { groupId, groupName };
    }
    return { groupId: String(this.zoneId), groupName: this.zoneName };
  }

  /**
   * Expose the buffered frames that are still in the future so new grouped members can
   * start with a shared timeline. Frames are already timestamped in server time.
   */
  public getFutureFrames(minFutureMs = 300): Array<{ data: Buffer; timestampUs: number }> {
    const nowUs = serverNowUs();
    const guardUs = Math.max(0, Math.floor(minFutureMs * 1000));
    return this.bufferedChunks
      .filter((f) => f.timestampUs > nowUs + guardUs)
      .map((f) => ({ data: f.data, timestampUs: f.timestampUs }));
  }

  /** Compute the requested rolling prebuffer based on target lead and format. */
  private computePrebufferBytes(format: SendspinFormat): number {
    const bytesPerSample = Math.max(1, Math.floor(format.bitDepth / 8));
    const leadSeconds = this.targetLeadUs / 1_000_000;
    const targetPrebufferBytes = Math.round(
      format.sampleRate * format.channels * bytesPerSample * (leadSeconds + 0.5),
    );
    return Math.min(Math.max(audioOutputSettings.prebufferBytes, targetPrebufferBytes), 2_000_000);
  }

  private normalizeBitDepth(bitDepth: number): PcmBitDepth {
    if (bitDepth === 24 || bitDepth === 32) {
      return bitDepth;
    }
    return 16;
  }

  private normalizeFormat(format: {
    codec?: 'pcm' | 'opus' | 'flac';
    sampleRate?: number;
    channels?: number;
    bitDepth?: number;
  }): SendspinFormat {
    const sampleRate = Number.isFinite(format.sampleRate) ? format.sampleRate! : audioOutputSettings.sampleRate;
    const channels = Number.isFinite(format.channels) ? format.channels! : audioOutputSettings.channels;
    const bitDepth = this.normalizeBitDepth(
      Number.isFinite(format.bitDepth) ? (format.bitDepth as number) : audioOutputSettings.pcmBitDepth,
    );
    const codec: 'pcm' | 'opus' | 'flac' =
      format.codec === 'opus' ? 'opus' : format.codec === 'flac' ? 'flac' : 'pcm';
    return { codec, sampleRate, channels, bitDepth };
  }

  private static resolveAnchorLeadUs(): number {
    // Default to 1.0s lead (aiosendspin reference); override via SENDSPIN_LEAD_MS.
    const raw = process.env.SENDSPIN_LEAD_MS;
    const parsed = raw ? Number(raw) : NaN;
    const defaultMs = 1000;
    const leadMs = Number.isFinite(parsed) ? parsed : defaultMs;
    const clampedMs = Math.max(300, Math.min(8000, Math.round(leadMs)));
    return clampedMs * 1000;
  }
}
