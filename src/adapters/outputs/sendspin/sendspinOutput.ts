import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createLogger } from '@/shared/logging/logger';
import type { PlaybackSession } from '@/application/playback/audioManager';
import {
  audioOutputSettings,
  type AudioOutputSettings,
  type PcmBitDepth,
} from '@/ports/types/audioFormat';
import {
  AudioCodec,
  MediaCommand,
  PlaybackStateType,
  PlayerCommand,
  RepeatMode,
  sendspinCore,
  serverNowUs,
  type PlayerFormat,
  type PlayerFormatWithBitDepth,
  type SendspinGroupCommand,
  type SendspinPlayerStateUpdate,
} from '@lox-audioserver/node-sendspin';
import type { PreferredOutput, OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import type { SendspinSession } from '@lox-audioserver/node-sendspin';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';

type SendspinFormat = PlayerFormatWithBitDepth<PcmBitDepth>;

type ArtworkChannel = Parameters<SendspinSession['sendArtworkStreamStart']>[0][number];

// Multiple zones can be configured against the same Sendspin client. In that case we need
// a single "controller" zone at a time; otherwise multiple outputs race and the client can
// disconnect due to conflicting metadata/stream commands. A zone owns N clients (e.g. a 2.1
// setup with stereo + sub); the map enforces the inverse: any single client can only be
// owned by one zone at a time.
const sendspinClientOwners = new Map<string, number>(); // clientId -> zoneId
const sendspinOutputsByZoneId = new Map<number, SendspinOutput>();
const STREAM_PLAYER_ROLE = 'player';

/**
 * Sendspin output configuration. A zone may target one or several Sendspin clients
 * (`clientIds`); the same PCM frames are fanned out to each client's WebSocket session
 * so they play in sync via Sendspin's group semantics (~50 µs drift).
 *
 * Backward compat: a legacy `clientId: string` is still accepted and mapped to a
 * single-element `clientIds` array internally.
 */
export interface SendspinOutputConfig {
  /** Preferred form: one or more Sendspin client IDs targeted by this zone. */
  clientIds?: string[];
  /** Legacy single-client form; mapped to `clientIds: [clientId]` internally. */
  clientId?: string;
  endpointUrl?: string;
  /**
   * Optional client-side static playback delay (ms). Mapped to the Sendspin protocol's
   * `set_static_delay` PlayerCommand. Clamped to 0-5000 ms by the protocol.
   */
  latencyMs?: number;
}

/** Normalize `SendspinOutputConfig.clientIds` / legacy `clientId` to a non-empty list. */
function resolveConfiguredClientIds(config: SendspinOutputConfig): string[] {
  const ids: string[] = [];
  if (Array.isArray(config.clientIds)) {
    for (const id of config.clientIds) {
      if (typeof id === 'string' && id.trim()) {
        ids.push(id.trim());
      }
    }
  }
  if (ids.length === 0 && typeof config.clientId === 'string' && config.clientId.trim()) {
    ids.push(config.clientId.trim());
  }
  // De-dupe while preserving order so logs read consistently.
  return Array.from(new Set(ids));
}

const SENDSPIN_MAX_STATIC_DELAY_MS = 5000;

function normalizeSendspinLatencyMs(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(SENDSPIN_MAX_STATIC_DELAY_MS, Math.round(num)));
}

export type SendspinMetadataPayload = Parameters<SendspinSession['sendMetadata']>[0];
export type SendspinMetadataProgress = NonNullable<SendspinMetadataPayload['progress']>;

export interface SendspinOutputOptions {
  onMetadata?: (payload: SendspinMetadataPayload) => void;
  ignoreVolumeUpdates?: boolean;
}

const cloneMetadataPayload = (payload: SendspinMetadataPayload): SendspinMetadataPayload => ({
  ...payload,
  progress: payload.progress ? { ...payload.progress } : payload.progress ?? null,
});

export const SENDSPIN_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'sendspin',
  label: 'Sendspin',
  description: 'Streams the PCM output to one or more Sendspin clients over WebSocket.',
  fields: [
    {
      id: 'clientIds',
      label: 'Sendspin client IDs',
      type: 'text',
      placeholder: 'stereo-room,subwoofer',
      required: true,
      description:
        'Identifier(s) announced by Sendspin client(s) (client/hello). ' +
        'Comma-separated for multiple clients in the same zone (e.g. stereo speakers + a separate sub).',
    },
    {
      id: 'endpointUrl',
      label: 'Sendspin endpoint URL',
      type: 'text',
      placeholder: 'ws://esphome.local:8928/sendspin',
      required: false,
      description: 'Optional direct websocket endpoint from discovery; keeps clientId for identity.',
    },
    {
      id: 'latencyMs',
      label: 'Latency (ms)',
      type: 'text',
      placeholder: '0',
      description: 'Optional client-side static playback delay (0-5000 ms). Higher = sound is later. Applied to every configured client.',
    },
  ],
};

/** Sendspin ZoneOutput implementation: streams audio/state to one or more Sendspin clients. */
export class SendspinOutput implements ZoneOutput {
  public readonly type = 'sendspin';
  private readonly log = createLogger('Output', 'Sendspin');
  /** Configured client IDs this zone targets (1 = solo, >1 = multi-client fan-out). */
  private readonly clientIds: readonly string[];
  /** Configured -> resolved client ID (resolved is what we address to sendspinCore once a session identifies). */
  private readonly resolvedClientIds: Map<string, string> = new Map();
  private readonly options: SendspinOutputOptions;
  private readonly unwatchClients: Array<() => void> = [];
  private readonly unwatchResolvedClients: Array<() => void> = [];
  private currentStream: NodeJS.ReadableStream | null = null;
  private currentCoverUrl: string | null = null;
  private lastProgressPayload: SendspinMetadataProgress | null = null;
  private playbackState: 'playing' | 'paused' | 'stopped' = 'stopped';
  private lastSentPlaybackState: 'playing' | 'paused' | 'stopped' | null = null;
  private lastKnownVolume = 50;
  private lastClientStateSignature: string | null = null;
  private lastLoggedClientState: string | null = null;
  private lastLoggedMuted: boolean | null = null;
  private initialClientStateSkipped = false;
  private clientState: 'synchronized' | 'error' | 'external_source' | null = null;
  private externalSourceActive = false;
  private lastOutboundVolume: number | null = null;
  private lastOutboundVolumeAt: number | null = null;
  /** Active sessions keyed by the *configured* client ID (matches `clientIds` entries). */
  private readonly activeSessions: Map<string, SendspinSession> = new Map();
  private restartTimer: NodeJS.Timeout | null = null;
  private bufferedChunks: Array<{ data: Buffer; timestampUs: number }> = [];
  private bufferedBytes = 0;
  /** Rolling buffer size to retain for late join / smoothing (bytes). */
  private maxBufferedBytes = audioOutputSettings.prebufferBytes;
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
  private negotiatedFormat: SendspinFormat = {
    codec: AudioCodec.PCM,
    sampleRate: audioOutputSettings.sampleRate,
    channels: audioOutputSettings.channels,
    bitDepth: audioOutputSettings.pcmBitDepth,
  };

  /** Actual output format of the current ffmpeg pipeline. */
  private activeOutputFormat: SendspinFormat | null = null;
  private activeCodecHeader: string | null = null;
  private anchorLeadUs = SendspinOutput.resolveAnchorLeadUs();
  // Keep target lead aligned with the configured anchor for low-latency playback.
  private readonly targetLeadUs = this.anchorLeadUs;
  /** Configured client-side static playback delay (ms), pushed via `set_static_delay`. */
  private configuredLatencyMs: number;
  private lastMetadataSignature: string | null = null;
  private lastStreamSignature: string | null = null;
  private pcmRemainder: Buffer | null = null;
  private lastPlayRequestAtMs: number | null = null;
  private firstFrameLogged = false;
  private lastStreamStartSentAtMs: number | null = null;
  private streamToken = 0;
  /** Per-configured-clientId hook disposers (initial + resolved-id forwarders). */
  private readonly hooksStops: Map<string, () => void> = new Map();
  private readonly resolvedHooksStops: Map<string, () => void> = new Map();
  private paused = false;
  private resumeGate: Promise<void> | null = null;
  private resumeGateResolve: (() => void) | null = null;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: SendspinOutputConfig,
    options: SendspinOutputOptions = {},
    private readonly ports: OutputPorts,
  ) {
    const configuredIds = resolveConfiguredClientIds(config);
    if (configuredIds.length === 0) {
      throw new Error(
        `SendspinOutput requires at least one clientId (zone ${zoneId}); pass clientIds or legacy clientId in config.`,
      );
    }
    this.clientIds = configuredIds;
    for (const id of configuredIds) {
      this.resolvedClientIds.set(id, id);
    }
    this.configuredLatencyMs = normalizeSendspinLatencyMs(config.latencyMs);
    this.options = { ignoreVolumeUpdates: true, ...options };
    sendspinOutputsByZoneId.set(this.zoneId, this);
    this.ports.sendspinGroup.register(this.zoneId, this);

    for (const configuredId of this.clientIds) {
      this.unwatchClients.push(
        this.ports.sendspinConnector.watchClient(configuredId, config.endpointUrl),
      );
      // Per-client hook bundle: each callback captures the configured ID in closure so
      // handlers know *which* of this zone's clients fired the event.
      const hooks = this.buildClientHooks(configuredId);
      this.hooksStops.set(configuredId, this.ports.sendspinHooks.register(configuredId, hooks));
      this.unwatchResolvedClients.push(
        this.ports.sendspinConnector.onClientResolved(configuredId, (resolvedClientId) => {
          this.resolvedClientIds.set(configuredId, resolvedClientId);
          if (resolvedClientId === configuredId || this.resolvedHooksStops.has(configuredId)) {
            return;
          }
          this.resolvedHooksStops.set(
            configuredId,
            this.ports.sendspinHooks.register(resolvedClientId, hooks),
          );
        }),
      );
    }
    // Push the static-delay to any already-connected sessions right away. onIdentified
    // only fires on a fresh handshake, so without this the value would only land after
    // the client reconnects.
    this.sendStaticDelay();
  }

  /** Per-client hook handlers; `configuredId` identifies *which* of this zone's clients fired. */
  private buildClientHooks(configuredId: string) {
    return {
      onIdentified: (sendspinSession: SendspinSession) => {
        // Avoid re-running onIdentified for the same session instance.
        if (this.activeSessions.get(configuredId) === sendspinSession) {
          return;
        }
        const resolved = sendspinSession.getClientId() ?? configuredId;
        this.resolvedClientIds.set(configuredId, resolved);
        this.ports.sendspinConnector.markInboundConnected(resolved);
        this.initialClientStateSkipped = false;
        this.lastClientStateSignature = null;
        this.lastLoggedClientState = null;
        this.lastLoggedMuted = null;
        this.activeSessions.set(configuredId, sendspinSession);
        this.clientState = null;
        this.externalSourceActive = false;
        this.negotiatedFormat = this.normalizeFormat(sendspinSession.getStreamFormat());
        if (!this.isOwner()) {
          // Avoid multiple zones fighting over the same Sendspin client.
          return;
        }
        // If there is an active audio session, reflect that state immediately.
        const audioSession = this.ports.audioManager.getSession(this.zoneId);
        if (audioSession?.state) {
          this.playbackState = audioSession.state;
        }
        const zoneState = this.ports.zoneManager.getZoneState(this.zoneId);
        const initialZoneVolume =
          typeof zoneState?.volume === 'number'
            ? zoneState.volume
            : this.lastKnownVolume;
        this.setVolume(initialZoneVolume);
        this.sendStaticDelay();
        this.sendControllerState();
        this.sendCurrentSnapshot();
        if (this.playbackState === 'playing') {
          void this.startStream({ preserveAnchor: false, formatOverride: this.negotiatedFormat });
        }
        // Push current playback state to the client right away.
        this.pushPlaybackState(this.playbackState);
      },
      onPlayerState: (_session: SendspinSession, update: SendspinPlayerStateUpdate) =>
        this.handleClientState(update),
      onGroupCommand: (_session: SendspinSession, command: SendspinGroupCommand) =>
        this.handleGroupCommand(command),
      onDisconnected: (sendspinSession: SendspinSession) => {
        // A stale/superseded session can close long after a newer one took over
        // (e.g. an unclean drop the heartbeat only reaps ~30-60s later). React
        // only to the session we currently consider active for this client,
        // otherwise that late close would tear down the live state.
        if (this.activeSessions.get(configuredId) !== sendspinSession) {
          return;
        }
        this.activeSessions.delete(configuredId);
        this.ports.sendspinConnector.markInboundDisconnected(
          this.resolvedClientIds.get(configuredId) ?? configuredId,
        );
        this.log.info('Sendspin client disconnected', {
          zoneId: this.zoneId,
          clientId: configuredId,
          remainingClients: this.activeSessions.size,
        });
        // Reset only when ALL clients have dropped — a single-client disconnect
        // in a 2.1 setup shouldn't stop the still-connected speakers.
        if (this.activeSessions.size === 0) {
          this.initialClientStateSkipped = false;
          this.lastClientStateSignature = null;
          this.lastLoggedClientState = null;
          this.lastLoggedMuted = null;
          this.clientState = null;
          this.externalSourceActive = false;
          // Invalidate stream signature so the next startStream() rebuilds the
          // pipeline from scratch instead of reusing a stale consumeStream loop.
          this.lastStreamSignature = null;
        }
      },
      onFormatChanged: (_session: SendspinSession, format: PlayerFormat) => {
        this.negotiatedFormat = this.normalizeFormat(format);
        // Restart stream with the newly requested format.
        void this.startStream({ preserveAnchor: false, formatOverride: this.negotiatedFormat });
      },
    };
  }

  /** Whether at least one of this zone's clients is connected and ready to receive PCM. */
  public isReady(): boolean {
    return this.activeSessions.size > 0;
  }

  /** True if at least one configured client currently has an active session. */
  private isAnyClientConnected(): boolean {
    return this.activeSessions.size > 0;
  }

  /** Resolved IDs for clients that currently have an active session (the ones we should send to). */
  private connectedTargetClientIds(): string[] {
    const ids: string[] = [];
    for (const configuredId of this.clientIds) {
      if (!this.activeSessions.has(configuredId)) continue;
      ids.push(this.resolvedClientIds.get(configuredId) ?? configuredId);
    }
    return ids;
  }

  /** Resolved IDs for all configured clients (connected or not). Used for owner-bookkeeping and discovery. */
  private allTargetClientIds(): string[] {
    return this.clientIds.map(
      (configuredId) => this.resolvedClientIds.get(configuredId) ?? configuredId,
    );
  }

  /** Comma-joined list for log readability. */
  private clientIdsLabel(): string {
    return this.clientIds.join(',');
  }

  public getPreferredOutput(): PreferredOutput {
    const preferredPrebuffer = this.computePrebufferBytes(this.negotiatedFormat);
    return {
      profile:
        this.negotiatedFormat.codec === AudioCodec.OPUS
          ? 'opus'
          : this.negotiatedFormat.codec === AudioCodec.FLAC
            ? 'flac'
            : 'pcm',
      sampleRate: this.negotiatedFormat.sampleRate,
      channels: this.negotiatedFormat.channels,
      bitDepth: this.negotiatedFormat.bitDepth,
      prebufferBytes: preferredPrebuffer,
    };
  }

  public getLatencyMs(): number {
    const leadMs = Math.max(0, Math.round(this.targetLeadUs / 1000));
    return leadMs + this.configuredLatencyMs;
  }

  /** Hot-update the static delay; pushes the new value to the live client. */
  public setLatencyMs(ms: number): void {
    const next = normalizeSendspinLatencyMs(ms);
    if (next === this.configuredLatencyMs) {
      return;
    }
    this.configuredLatencyMs = next;
    this.sendStaticDelay();
  }

  /**
   * Push the configured client-side static delay to each connected client. Not gated by
   * ownership — the static delay is benign per-client config that should reflect the
   * latest configured value regardless of which zone currently "owns" the client.
   */
  private sendStaticDelay(): void {
    let sentTo = 0;
    for (const configuredId of this.clientIds) {
      const session =
        this.activeSessions.get(configuredId) ??
        sendspinCore.getSessionByClientId?.(this.resolvedClientIds.get(configuredId) ?? configuredId) ??
        null;
      if (!session) continue;
      session.sendServerCommand(PlayerCommand.SET_STATIC_DELAY, {
        static_delay_ms: this.configuredLatencyMs,
      });
      sentTo += 1;
    }
    if (sentTo === 0) {
      this.log.debug('Sendspin set_static_delay skipped; no live sessions', {
        zoneId: this.zoneId,
        clientIds: this.clientIdsLabel(),
      });
      return;
    }
    this.log.info('Sendspin set_static_delay sent', {
      zoneId: this.zoneId,
      clientIds: this.clientIdsLabel(),
      sessions: sentTo,
      staticDelayMs: this.configuredLatencyMs,
    });
  }

  /** Push a volume change down to every connected client (used by zone manager). */
  public setVolume(level: number): void {
    const vol = Math.min(100, Math.max(0, Math.round(level)));
    this.lastKnownVolume = vol;
    if (this.activeSessions.size === 0) {
      return;
    }
    this.lastOutboundVolume = vol;
    this.lastOutboundVolumeAt = Date.now();
    if (!this.isOwner()) {
      return;
    }
    for (const session of this.activeSessions.values()) {
      session.sendServerCommand(PlayerCommand.VOLUME, { volume: vol });
    }
  }

  /** Start playback for this zone on the Sendspin client. */
  public async play(session: PlaybackSession): Promise<void> {
    this.lastPlayRequestAtMs = Date.now();
    this.firstFrameLogged = false;
    this.lastStreamStartSentAtMs = null;
    if (!session.playbackSource) {
      this.log.warn('Sendspin output skipped; no playback source', { zoneId: this.zoneId });
      return;
    }
    this.claimOwnership();
    for (const id of this.allTargetClientIds()) {
      this.ports.sendspinConnector.requestPlaybackPriority(id);
    }
    this.log.info('Sendspin play', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      clientIds: this.clientIdsLabel(),
      source: session.source,
    });
    this.sendMetadata(session);
    void this.fetchAndSendArtwork(session);
    this.sendControllerState();
    this.startProgressUpdates();
    // A fresh play request after pause must always release the pause gate,
    // especially when startStream() reuses an existing pipeline.
    if (this.paused) {
      this.paused = false;
      if (this.resumeGateResolve) {
        this.resumeGateResolve();
      }
      this.resumeGateResolve = null;
      this.resumeGate = null;
    }
    await this.startStream();
    this.pushPlaybackState('playing');
  }

  /** Pause playback without tearing down the stream. */
  public async pause(_session: PlaybackSession | null): Promise<void> {
    this.log.info('Sendspin pause', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      clientIds: this.clientIdsLabel(),
    });
    this.paused = true;
    this.sendProgressUpdate();
    this.pushPlaybackState('paused');
  }

  /** Resume playback; if a session is provided, restart as play. */
  public async resume(session: PlaybackSession | null): Promise<void> {
    this.log.info('Sendspin resume', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      clientIds: this.clientIdsLabel(),
    });
    if (this.currentStream && this.paused) {
      this.paused = false;
      if (this.resumeGateResolve) {
        this.resumeGateResolve();
      }
      this.resumeGateResolve = null;
      this.resumeGate = null;
      this.sendProgressUpdate();
      this.pushPlaybackState('playing');
      return;
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
          clientIds: this.clientIdsLabel(),
        });
        this.externalSourceActive = true;
        for (const id of this.connectedTargetClientIds()) {
          sendspinCore.sendStreamEnd(id);
          sendspinCore.sendStreamClear(id, [STREAM_PLAYER_ROLE]);
        }
      } else if (this.externalSourceActive) {
        this.externalSourceActive = false;
        this.log.info('Sendspin client returned from external_source', {
          zoneId: this.zoneId,
          clientIds: this.clientIdsLabel(),
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
    const stateChanged = update.state != null && update.state !== this.lastLoggedClientState;
    const muteChanged = typeof update.muted === 'boolean' && update.muted !== this.lastLoggedMuted;
    // Only log interesting changes: warn on errors, debug when synchronized, otherwise skip.
    if ((stateLevel === 'warn' || stateLevel === 'debug') && (stateChanged || muteChanged)) {
      this.log[stateLevel]('Sendspin client state update', {
        zoneId: this.zoneId,
        clientIds: this.clientIdsLabel(),
        state: update.state,
        volume: update.volume,
        muted: update.muted,
      });
    }
    if (update.state != null) {
      this.lastLoggedClientState = update.state;
    }
    if (typeof update.muted === 'boolean') {
      this.lastLoggedMuted = update.muted;
    }
    if (!this.options.ignoreVolumeUpdates && typeof update.volume === 'number') {
      const vol = Math.min(100, Math.max(0, Math.round(update.volume)));
      const now = Date.now();
      const recentlySent =
        this.lastOutboundVolumeAt != null && now - this.lastOutboundVolumeAt < 1000;
      const outboundMatches =
        this.lastOutboundVolume != null && Math.abs(vol - this.lastOutboundVolume) <= 1;
      if (recentlySent && outboundMatches) {
        this.log.debug('Sendspin client volume echo ignored', {
          zoneId: this.zoneId,
          clientIds: this.clientIdsLabel(),
          volume: vol,
        });
      } else if (vol !== this.lastKnownVolume) {
        this.lastKnownVolume = vol;
        this.ports.zoneManager.handleCommand(this.zoneId, 'volume_set', String(vol));
      }
    }
    if (!this.options.ignoreVolumeUpdates && typeof update.muted === 'boolean') {
      // No explicit mute command path in zoneManager; treat mute as volume 0/unmute restore.
      if (update.muted) {
        this.ports.zoneManager.handleCommand(this.zoneId, 'volume_set', '0');
      } else {
        this.ports.zoneManager.handleCommand(
          this.zoneId,
          'volume_set',
          String(this.lastKnownVolume),
        );
      }
    }
    this.sendControllerState();
  }

  private handleGroupCommand(command: { command: string; volume?: number; mute?: boolean }): void {
    const cmd = command.command;
    this.log.info('Sendspin controller command', { zoneId: this.zoneId, command: cmd, volume: command.volume, mute: command.mute });
    switch (cmd) {
      case 'play':
        this.ports.zoneManager.handleCommand(this.zoneId, 'play');
        break;
      case 'pause':
        this.ports.zoneManager.handleCommand(this.zoneId, 'pause');
        break;
      case 'stop':
        this.ports.zoneManager.handleCommand(this.zoneId, 'stop');
        break;
      case 'next':
        this.ports.zoneManager.handleCommand(this.zoneId, 'next');
        break;
      case 'previous':
        this.ports.zoneManager.handleCommand(this.zoneId, 'previous');
        break;
      case 'volume':
        if (this.options.ignoreVolumeUpdates) {
          break;
        }
        if (typeof command.volume === 'number') {
          const vol = Math.min(100, Math.max(0, Math.round(command.volume)));
          this.lastKnownVolume = vol;
          // Apply group volume per Sendspin spec when in a group; otherwise set zone volume.
          this.ports.groupManager.applySpecGroupVolume(this.zoneId, vol);
          this.ports.zoneManager.handleCommand(this.zoneId, 'volume_set', String(vol));
        }
        break;
      case 'mute':
        if (this.options.ignoreVolumeUpdates) {
          break;
        }
        if (typeof command.mute === 'boolean') {
          if (command.mute) {
            this.ports.zoneManager.handleCommand(this.zoneId, 'volume_set', '0');
          } else {
            this.ports.zoneManager.handleCommand(
              this.zoneId,
              'volume_set',
              String(this.lastKnownVolume),
            );
          }
        }
        break;
      case 'repeat_off':
        this.ports.zoneManager.queue.setRepeatMode(this.zoneId, 'off');
        break;
      case 'repeat_one':
        this.ports.zoneManager.queue.setRepeatMode(this.zoneId, 'one');
        break;
      case 'repeat_all':
        this.ports.zoneManager.queue.setRepeatMode(this.zoneId, 'all');
        break;
      case 'shuffle':
        this.ports.zoneManager.queue.setShuffle(this.zoneId, true);
        break;
      case 'unshuffle':
        this.ports.zoneManager.queue.setShuffle(this.zoneId, false);
        break;
      case 'switch':
        this.handleSwitchCommand();
        break;
      default:
        this.log.debug('Unsupported Sendspin controller command', { cmd });
    }
  }

  private handleSwitchCommand(): void {
    const result = this.removeZoneFromGroup();
    if (result === 'no_group') {
      this.log.debug('Sendspin switch ignored; no active group', { zoneId: this.zoneId });
      return;
    }
    if (result === 'leader') {
      this.log.debug('Sendspin switch ignored; zone is group leader', { zoneId: this.zoneId });
      return;
    }
    // Clear stream on every connected client so the zone goes silent solo.
    for (const id of this.connectedTargetClientIds()) {
      sendspinCore.sendStreamEnd(id);
      sendspinCore.sendStreamClear(id, [STREAM_PLAYER_ROLE]);
    }
    this.pushPlaybackState('stopped');
  }

  /** Stop playback and fully tear down the stream. */
  public async stop(_session: PlaybackSession | null): Promise<void> {
    this.log.info('Sendspin stop', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      clientIds: this.clientIdsLabel(),
    });
    this.teardown();
    if (this.isOwner()) {
      this.sendStopMetadata();
      this.pushPlaybackState('stopped');
      this.releaseOwnership();
    }
  }

  public async updateMetadata(session: PlaybackSession | null): Promise<void> {
    const current = session ?? this.ports.audioManager.getSession(this.zoneId);
    if (!current) {
      return;
    }
    this.sendMetadata(current);
  }

  /** Dispose output resources and unregister hooks for every configured client. */
  public async dispose(): Promise<void> {
    this.teardown();
    for (const stop of this.hooksStops.values()) {
      stop();
    }
    this.hooksStops.clear();
    for (const stop of this.resolvedHooksStops.values()) {
      stop();
    }
    this.resolvedHooksStops.clear();
    for (const id of this.allTargetClientIds()) {
      sendspinCore.clearLeadStats(id);
    }
    this.ports.sendspinGroup.unregister(this.zoneId);
    for (const stop of this.unwatchClients) {
      stop();
    }
    this.unwatchClients.length = 0;
    for (const stop of this.unwatchResolvedClients) {
      stop();
    }
    this.unwatchResolvedClients.length = 0;
    if (this.isOwner()) {
      this.releaseOwnership();
    }
    sendspinOutputsByZoneId.delete(this.zoneId);
  }

  private async startStream(
    options: {
      preserveAnchor?: boolean;
      formatOverride?: Partial<SendspinFormat>;
    } = {},
  ): Promise<void> {
    if (!this.isOwner()) {
      return;
    }
    if (!this.isAnyClientConnected()) {
      this.log.debug('Sendspin stream start skipped; no client connected yet', {
        zoneId: this.zoneId,
        clientIds: this.clientIdsLabel(),
      });
      return;
    }
    if (this.streamStarting) {
      this.log.debug('Sendspin stream start skipped; already starting', { zoneId: this.zoneId });
      return;
    }
    let token = this.streamToken;
    const preserveAnchor = options.preserveAnchor === true;
    this.streamStarting = true;
    try {

      // Ensure there is an active PCM session for this zone; start one if missing.
      const current = this.ports.audioManager.getSession(this.zoneId);
      if (!current?.playbackSource) {
        this.log.debug('Sendspin stream start skipped; no playback source', {
          zoneId: this.zoneId,
          clientIds: this.clientIdsLabel(),
        });
        return;
      }
      let chosenFormat = this.normalizeFormat(options.formatOverride ?? this.negotiatedFormat);
      this.negotiatedFormat = chosenFormat;
      // A group leader streams PCM so every member can decode the shared audio
      // regardless of its own preferred codec (PCM is the universal sendspin
      // baseline; mirroring an OPUS/FLAC stream to a PCM-only member breaks it).
      // The client's real preference stays in negotiatedFormat and is restored
      // on the next stream start once the group dissolves.
      if (this.isGroupLeaderWithMembers() && chosenFormat.codec !== AudioCodec.PCM) {
        chosenFormat = { ...chosenFormat, codec: AudioCodec.PCM };
      }
      const prebufferBytes = this.computePrebufferBytes(chosenFormat);
      this.log.debug('Sendspin stream prebuffer config', {
        zoneId: this.zoneId,
        clientIds: this.clientIdsLabel(),
        codec: chosenFormat.codec,
        sampleRate: chosenFormat.sampleRate,
        channels: chosenFormat.channels,
        bitDepth: chosenFormat.bitDepth,
        targetLeadMs: Math.round(this.targetLeadUs / 1000),
        requestedPrebufferBytes: prebufferBytes,
        configuredDefaultPrebufferBytes: audioOutputSettings.prebufferBytes,
      });
      const sendspinOutputSettings: AudioOutputSettings = {
        ...audioOutputSettings,
        sampleRate: chosenFormat.sampleRate,
        channels: chosenFormat.channels,
        pcmBitDepth: chosenFormat.bitDepth,
        prebufferBytes,
      };
      this.maxBufferedBytes = prebufferBytes;
      const profile: 'pcm' | 'opus' | 'flac' =
        chosenFormat.codec === AudioCodec.OPUS
          ? 'opus'
          : chosenFormat.codec === AudioCodec.FLAC
            ? 'flac'
            : 'pcm';
      const streamSignature = this.buildStreamSignature(current, profile);
      const formatMatchesActive =
        this.activeOutputFormat &&
        this.activeOutputFormat.codec === chosenFormat.codec &&
        this.activeOutputFormat.sampleRate === chosenFormat.sampleRate &&
        this.activeOutputFormat.channels === chosenFormat.channels &&
        this.activeOutputFormat.bitDepth === chosenFormat.bitDepth;
      const sessionOutput = this.ports.audioManager.getOutputSettings(this.zoneId);
      const outputMismatch =
        this.activeOutputFormat === null &&
        sessionOutput != null &&
        (sessionOutput.sampleRate !== chosenFormat.sampleRate ||
          sessionOutput.channels !== chosenFormat.channels ||
          sessionOutput.pcmBitDepth !== chosenFormat.bitDepth);
      const shouldRestartForFormat =
        outputMismatch || (this.activeOutputFormat !== null && !formatMatchesActive);
      if (outputMismatch) {
        this.log.info('Sendspin output format mismatch; restarting engine', {
          zoneId: this.zoneId,
          clientIds: this.clientIdsLabel(),
          current: sessionOutput,
          requested: {
            sampleRate: chosenFormat.sampleRate,
            channels: chosenFormat.channels,
            pcmBitDepth: chosenFormat.bitDepth,
          },
        });
      }

      // If a stream already exists and is healthy, reuse it and just re-announce to the client.
      if (
        this.currentStream &&
        !(this.currentStream as { destroyed?: boolean }).destroyed &&
        !(this.currentStream as { readableEnded?: boolean }).readableEnded &&
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
        const codecHeader = this.activeCodecHeader ?? undefined;
        const reusedStreamParams = {
          codec: chosenFormat.codec,
          sampleRate,
          channels,
          bitDepth: pcmBitDepth,
          ...(codecHeader ? { codecHeader } : {}),
        };
        for (const id of this.connectedTargetClientIds()) {
          sendspinCore.sendStreamStart(id, reusedStreamParams);
        }
        this.ports.sendspinGroup.notifyStreamStart(this.zoneId, {
          codec: chosenFormat.codec,
          sampleRate,
          channels,
          bitDepth: pcmBitDepth,
          ...(codecHeader ? { codecHeader } : {}),
        });
        // Reaffirm playback state to the client when reusing a stream.
        this.pushPlaybackState(this.playbackState);
        this.sendCurrentSnapshot();
        this.lastStreamSignature = streamSignature;
        return;
      }

      // If a previous stream object exists but is ended/destroyed, clean it up first.
      if (this.currentStream) {
        this.teardown({ preserveAnchor, invalidateToken: false });
      }
      this.streamToken += 1;
      token = this.streamToken;

      const sessionStats = this.ports.engine.getSessionStats(this.zoneId);
      const hasTargetProfile = sessionStats.some((s) => s.profile === profile);
      let startedEngine = false;
      if ((shouldRestartForFormat || !hasTargetProfile) && current?.playbackSource) {
        this.ports.engine.start(this.zoneId, current.playbackSource, [profile], sendspinOutputSettings);
        startedEngine = true;
      }

      let pcmStream = this.ports.engine.createStream(this.zoneId, profile, {
        primeWithBuffer: true,
        label: 'sendspin',
      });
      // Fallback: if we expected an existing session but couldn't attach, start a fresh one.
      if (!pcmStream && !startedEngine && current?.playbackSource) {
        this.ports.engine.start(this.zoneId, current.playbackSource, [profile], sendspinOutputSettings);
        startedEngine = true;
        pcmStream = this.ports.engine.createStream(this.zoneId, profile, {
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
      this.activeCodecHeader = null;

      let chunkCount = 0;
      let modeledTimelineUs = 0; // Sum of durations we think we sent (for drift visibility).
      let codecHeaderSent = false;
      let streamStartSent = false;
      const isFlac = chosenFormat.codec === AudioCodec.FLAC;
      let flacHeaderBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      const bytesPerSample = (pcmBitDepth / 8) * channels;
      const isPcm = chosenFormat.codec === AudioCodec.PCM;
      const frameSamples = Math.max(1, Math.floor(sampleRate * 0.025));
      const frameBytes = frameSamples * bytesPerSample;
      let pcmFrameBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let flacBlocksizeSamples = 0;
      let lastSendWallUs: number | null = null;
      let jitterSumUs = 0;
      let jitterMaxUs = 0;
      let jitterSamples = 0;
      let waitLeadUs = 0;
      let waitCapacityUs = 0;
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
      const extractCompleteFlacHeader = (
        source: Buffer,
      ): { header: Buffer<ArrayBufferLike> | null; remainder: Buffer<ArrayBufferLike> } => {
        if (source.length < 4) {
          return { header: null, remainder: source };
        }
        if (source.subarray(0, 4).toString('ascii') !== 'fLaC') {
          return { header: null, remainder: source };
        }
        let offset = 4;
        while (true) {
          if (source.length < offset + 4) {
            return { header: null, remainder: source };
          }
          const blockHeader = source[offset]!;
          const isLast = (blockHeader & 0x80) !== 0;
          const blockLength =
            (source[offset + 1]! << 16) | (source[offset + 2]! << 8) | source[offset + 3]!;
          const nextOffset = offset + 4 + blockLength;
          if (source.length < nextOffset) {
            return { header: null, remainder: source };
          }
          offset = nextOffset;
          if (isLast) {
            return {
              header: source.subarray(0, offset),
              remainder: source.subarray(offset),
            };
          }
        }
      };
      let encodedFrameDurationUs =
        chosenFormat.codec === AudioCodec.OPUS
          ? Math.floor(1_000_000 / 50) // 20 ms frames
          : chosenFormat.codec === AudioCodec.FLAC
            ? Math.floor((4096 * 1_000_000) / sampleRate)
            : 0;
      const overbufferMarginUs = 100_000; // keep lead tight around target
      const prepareBufferMarginUs = Math.max(500_000, Math.min(2_500_000, this.targetLeadUs));
      const sendTransmissionMarginUs = 100_000; // align with MA send margin (network + client processing)
      const targetBufferUs = this.targetLeadUs;
      // With multiple clients the safe backpressure budget is the slowest one — sending
      // faster than the smallest client buffer can absorb would push that client over and
      // cause it to drop the connection. Falls back to the configured rolling buffer when
      // no client reports a capacity (e.g. before any session has been queried).
      const targetIds = this.connectedTargetClientIds();
      const reportedCapacities = targetIds
        .map((id) => sendspinCore.getPlayerBufferCapacity(id) || 0)
        .filter((n) => n > 0);
      const backpressureCapacityBytes =
        reportedCapacities.length > 0
          ? Math.min(...reportedCapacities)
          : this.maxBufferedBytes || 0;
      const bufferedForCapacity: Array<{ endUs: number; byteCount: number }> = [];
      let bufferedCapacityBytes = 0;

      const pruneCapacity = (nowUs: number): void => {
        while (bufferedForCapacity.length && bufferedForCapacity[0]!.endUs <= nowUs) {
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
          const entry = bufferedForCapacity[i]!;
          bufferedForCapacity[i] = {
            endUs: entry.endUs + deltaUs,
            byteCount: entry.byteCount,
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
          if (this.targetLeadUs > 2_000_000) {
            pcmStream.pause();
          }
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          if (this.targetLeadUs > 2_000_000) {
            pcmStream.resume();
          }
        }
      };

      const emitFrame = (frameTsUs: number, frameData: Buffer, durationUs: number): void => {
        if (token !== this.streamToken) {
          return;
        }
        const canSendToClient =
          this.isOwner() && this.isAnyClientConnected() && !this.externalSourceActive;
        if (!this.firstFrameLogged && canSendToClient) {
          this.firstFrameLogged = true;
          const now = Date.now();
          this.log.info('Sendspin first audio frame sent', {
            zoneId: this.zoneId,
            clientIds: this.clientIdsLabel(),
            sincePlayMs: this.lastPlayRequestAtMs ? now - this.lastPlayRequestAtMs : null,
            sinceStreamStartMs: this.lastStreamStartSentAtMs ? now - this.lastStreamStartSentAtMs : null,
          });
        }
        if (lastSendWallUs !== null) {
          const nowUs = serverNowUs();
          const intervalUs = nowUs - lastSendWallUs;
          const expectedUs = durationUs;
          const deltaUs = Math.abs(intervalUs - expectedUs);
          jitterSumUs += deltaUs;
          jitterMaxUs = Math.max(jitterMaxUs, deltaUs);
          jitterSamples += 1;
        }
        lastSendWallUs = serverNowUs();
        const targetLeadUs = this.targetLeadUs;
        const lead = frameTsUs - serverNowUs();
        const targets = canSendToClient ? this.connectedTargetClientIds() : [];
        if (canSendToClient) {
          for (const id of targets) {
            sendspinCore.setLeadStats(id, {
              leadUs: lead,
              targetLeadUs,
              bufferedBytes: this.bufferedBytes,
            });
          }
        }

        const frame = { data: frameData, timestampUs: frameTsUs };
        if (canSendToClient) {
          // Fan PCM out to every connected client so a multi-client zone (e.g. stereo +
          // sub) stays sample-aligned. The frame object is reused as-is; node-sendspin
          // does not mutate it.
          for (const id of targets) {
            sendspinCore.sendPcmFrameToClient(id, frame);
          }
        }
        this.ports.sendspinGroup.broadcastFrame(this.zoneId, frame);
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
        if (chunkCount <= 3 || chunkCount % 100 === 0) {
          const avgJitterUs = jitterSamples ? Math.round(jitterSumUs / jitterSamples) : 0;
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
            jitterAvgUs: avgJitterUs,
            jitterMaxUs,
            waitLeadUs,
            waitCapacityUs,
          };
          if (isPcm) {
            logPayload.frames = Math.floor(frameData.length / bytesPerSample);
            logPayload.durationUs = Math.floor((logPayload.frames as number * 1_000_000) / sampleRate);
            logPayload.sampleRate = sampleRate;
          }
          this.log.spam('Sendspin frame ts', logPayload);
        }
      };

      const ensureStreamStart = (codecHeader?: string): void => {
        if (streamStartSent) {
          return;
        }
        const params = {
          codec: chosenFormat.codec,
          sampleRate,
          channels,
          bitDepth: pcmBitDepth,
          ...(codecHeader ? { codecHeader } : {}),
        };
        if (!this.externalSourceActive) {
          for (const id of this.connectedTargetClientIds()) {
            sendspinCore.sendStreamStart(id, params);
          }
        }
        this.ports.sendspinGroup.notifyStreamStart(this.zoneId, params);
        streamStartSent = true;
        this.lastStreamStartSentAtMs = Date.now();
      };

      const sendScheduledFrame = async (
        frameData: Buffer<ArrayBufferLike>,
        durationUs: number,
        options: { skipLeadGate?: boolean } = {},
      ): Promise<void> => {
        if (token !== this.streamToken) {
          return;
        }
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
          const before = serverNowUs();
          await waitUntilLeadInRange(timestampUs);
          waitLeadUs += Math.max(0, serverNowUs() - before);
        }
        const capBefore = serverNowUs();
        await waitForCapacity(frameData.length);
        waitCapacityUs += Math.max(0, serverNowUs() - capBefore);
        ensureStreamStart();
        emitFrame(timestampUs, frameData, durationUs);
      };

      const processFrame = async (frameData: Buffer<ArrayBufferLike>, durationUs: number): Promise<void> => {
        if (token !== this.streamToken) {
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
        if (token !== this.streamToken) {
          return;
        }
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
            if (isFlac) {
              flacHeaderBuffer = flacHeaderBuffer.length
                ? (Buffer.concat([flacHeaderBuffer, payload]) as Buffer<ArrayBufferLike>)
                : payload;
              const extracted = extractCompleteFlacHeader(flacHeaderBuffer);
              if (!extracted.header) {
                if (flacHeaderBuffer.length >= 4 && flacHeaderBuffer.subarray(0, 4).toString('ascii') !== 'fLaC') {
                  // Unexpected FLAC stream framing; fallback to first packet behavior instead of stalling.
                  const codecHeader = payload.toString('base64');
                  this.activeCodecHeader = codecHeader;
                  ensureStreamStart(codecHeader);
                  codecHeaderSent = true;
                }
                return;
              }
              const codecHeader = extracted.header.toString('base64');
              this.activeCodecHeader = codecHeader;
              const bs = parseFlacBlocksize(extracted.header);
              if (bs > 0) {
                flacBlocksizeSamples = bs;
                encodedFrameDurationUs = Math.floor((flacBlocksizeSamples * 1_000_000) / sampleRate);
              }
              ensureStreamStart(codecHeader);
              codecHeaderSent = true;
              flacHeaderBuffer = Buffer.alloc(0);
              payload = extracted.remainder;
              if (!payload.length) {
                return;
              }
            } else {
              const codecHeader = payload.toString('base64');
              this.activeCodecHeader = codecHeader;
              ensureStreamStart(codecHeader);
              codecHeaderSent = true;
            }
          }
          await processFrame(payload, durationUs);
        }
      };

      // Stream PCM with pull-based backpressure: wait for each chunk to be sent before reading more.
      const streamRef = pcmStream;
      const localToken = token;
      const consumeStream = async (): Promise<void> => {
        try {
          for await (const chunk of pcmStream) {
            if (localToken !== this.streamToken || streamRef !== this.currentStream) {
              return;
            }
            while (this.paused && localToken === this.streamToken && streamRef === this.currentStream) {
              if (!this.resumeGate) {
                this.resumeGate = new Promise<void>((resolve) => {
                  this.resumeGateResolve = resolve;
                });
              }
              await this.resumeGate;
            }
            if (!chunk?.length) {
              continue;
            }
            await sendLiveChunk(chunk as Buffer);
          }
          if (localToken !== this.streamToken || streamRef !== this.currentStream) {
            return;
          }
          this.log.debug('Sendspin stream closed', { zoneId: this.zoneId });
          this.teardown();
          this.scheduleRestart();
        } catch (error) {
          if (localToken !== this.streamToken || streamRef !== this.currentStream) {
            return;
          }
          this.log.warn('Sendspin stream error', {
            zoneId: this.zoneId,
            message: (error as Error).message,
          });
          this.teardown();
          this.scheduleRestart();
        }
      };
      void consumeStream();


      this.log.info('Sendspin stream started', {
        zoneId: this.zoneId,
        clientIds: this.clientIdsLabel(),
        connectedClients: this.activeSessions.size,
        sampleRate,
        channels,
        bitDepth: pcmBitDepth,
        sincePlayMs: this.lastPlayRequestAtMs ? Date.now() - this.lastPlayRequestAtMs : null,
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

  private teardown(options: { preserveAnchor?: boolean; invalidateToken?: boolean } = {}): void {
    const preserveAnchor = options.preserveAnchor === true;
    if (options.invalidateToken !== false) {
      this.streamToken += 1;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.bufferedChunks = [];
    this.bufferedBytes = 0;
    this.maxBufferedBytes = audioOutputSettings.prebufferBytes;
    this.activeOutputFormat = null;
    this.activeCodecHeader = null;
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
      const destroyable = this.currentStream as { destroy?: () => void };
      if (typeof destroyable.destroy === 'function') {
        destroyable.destroy();
      }
      this.currentStream = null;
    }
    if (this.resumeGateResolve) {
      this.resumeGateResolve();
    }
    this.paused = false;
    this.resumeGateResolve = null;
    this.resumeGate = null;
    this.stopProgressUpdates();
    // Notify every connected client to clear/end only when we are really stopping;
    // skip during keep-alive restarts.
    if (!preserveAnchor) {
      for (const id of this.connectedTargetClientIds()) {
        sendspinCore.sendStreamEnd(id);
        sendspinCore.sendStreamClear(id, [STREAM_PLAYER_ROLE]);
      }
      this.ports.sendspinGroup.notifyStreamEnd(this.zoneId);
      this.lastStreamSignature = null;
    }
  }

  /** Switch the leader's live stream to PCM when it now drives a group, before
   *  members are fed. No-op if not the playing owner, not a group leader, or
   *  already PCM. Called by the group controller on membership changes so a
   *  solo OPUS/FLAC stream becomes decodable for every (incl. PCM-only) member. */
  public async ensureGroupCodec(): Promise<void> {
    if (!this.isOwner() || !this.isAnyClientConnected() || this.playbackState !== 'playing') {
      return;
    }
    if (!this.isGroupLeaderWithMembers()) {
      return;
    }
    if (this.activeOutputFormat?.codec === AudioCodec.PCM) {
      return;
    }
    await this.startStream({ preserveAnchor: false });
  }

  public async reanchorForGroup(): Promise<void> {
    // Hard restart stream with fresh anchor so grouped members can align to leader.
    this.teardown({ preserveAnchor: false });
    const session = this.ports.audioManager.getSession(this.zoneId);
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
    const session = this.ports.audioManager.getSession(this.zoneId);
    if (!session?.playbackSource) {
      return;
    }
    const source = session.playbackSource;
    if (source.kind !== 'pipe' && source.kind !== 'url') {
      return;
    }
    if (source.kind === 'url' && source.restartOnFailure !== true) {
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
      clientIds: this.clientIdsLabel(),
      title: payload.title,
      artist: payload.artist,
      album: payload.album,
    });
    this.lastProgressPayload = payload.progress ?? null;
    for (const id of this.connectedTargetClientIds()) {
      sendspinCore.setClientMetadata(id, payload);
    }
    this.options.onMetadata?.(cloneMetadataPayload(payload));
    this.ports.sendspinGroup.broadcastMetadata(this.zoneId, payload);
  }

  private sendControllerState(): void {
    const zoneState = this.ports.zoneManager.getZoneState(this.zoneId);
    const vol = typeof zoneState?.volume === 'number' ? zoneState.volume : this.lastKnownVolume;
    this.lastKnownVolume = vol;
    const supportedCommands: MediaCommand[] = [
      MediaCommand.PLAY,
      MediaCommand.PAUSE,
      MediaCommand.STOP,
      MediaCommand.NEXT,
      MediaCommand.PREVIOUS,
      MediaCommand.VOLUME,
      MediaCommand.MUTE,
      MediaCommand.SWITCH,
    ];
    // Repeat/shuffle only if zoneManager exposes those controls.
    if (typeof zoneState?.plrepeat === 'number') {
      supportedCommands.push(MediaCommand.REPEAT_OFF, MediaCommand.REPEAT_ONE, MediaCommand.REPEAT_ALL);
    }
    if (typeof zoneState?.plshuffle === 'number') {
      supportedCommands.push(MediaCommand.SHUFFLE, MediaCommand.UNSHUFFLE);
    }
    const controllerState = {
      supported_commands: supportedCommands,
      volume: vol,
      muted: false,
    };
    for (const id of this.connectedTargetClientIds()) {
      sendspinCore.setClientControllerState(id, controllerState);
    }
    this.ports.sendspinGroup.broadcastControllerState(this.zoneId, controllerState);
  }

  private startProgressUpdates(): void {
    // Single-shot progress push; avoid per-second updates.
    this.sendProgressUpdate();
  }

  private stopProgressUpdates(): void {
    // No-op now that we do single-shot progress updates.
  }

  private sendProgressUpdate(): void {
    const session = this.ports.audioManager.getSession(this.zoneId);
    const zoneState = this.ports.zoneManager.getZoneState(this.zoneId);
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
      for (const id of this.connectedTargetClientIds()) {
        sendspinCore.setClientMetadata(id, payload);
      }
      this.options.onMetadata?.(cloneMetadataPayload(payload));
      if (coverUrl && coverChanged) {
        void this.fetchAndSendArtwork({ metadata: session?.metadata, stream: session?.stream });
      }
    } else if (nextProgress && progressChanged) {
      this.lastProgressPayload = nextProgress;
      const progressOnly: SendspinMetadataPayload = { progress: nextProgress };
      for (const id of this.connectedTargetClientIds()) {
        sendspinCore.setClientMetadata(id, progressOnly);
      }
      this.options.onMetadata?.(cloneMetadataPayload(progressOnly));
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
    for (const id of this.connectedTargetClientIds()) {
      sendspinCore.setClientMetadata(id, payload);
    }
    this.options.onMetadata?.(cloneMetadataPayload(payload));
    this.ports.sendspinGroup.broadcastMetadata(this.zoneId, payload);
  }

  private pushPlaybackState(state: 'playing' | 'paused' | 'stopped'): void {
    this.playbackState = state;
    if (this.lastSentPlaybackState === state) {
      return;
    }
    if (!this.isOwner()) {
      this.lastSentPlaybackState = state;
      return;
    }
    const { groupId, groupName } = this.getGroupInfo();
    const mappedState =
      state === 'playing'
        ? PlaybackStateType.PLAYING
        : state === 'paused'
          ? PlaybackStateType.PAUSED
          : PlaybackStateType.STOPPED;
    for (const id of this.connectedTargetClientIds()) {
      sendspinCore.setClientPlaybackState(id, mappedState, groupId, groupName);
    }
    this.ports.sendspinGroup.broadcastPlaybackState(this.zoneId, mappedState, groupId, groupName);
    this.lastSentPlaybackState = state;
  }

  /** True only when *every* configured client for this zone is owned by us. */
  private isOwner(): boolean {
    for (const id of this.clientIds) {
      if (sendspinClientOwners.get(id) !== this.zoneId) {
        return false;
      }
    }
    return true;
  }

  /** Claim every configured client. If another zone owns one of them, evict it first
   *  (best-effort: stop its stream to prevent racing commands). */
  private claimOwnership(): void {
    const previousZones = new Set<number>();
    for (const id of this.clientIds) {
      const existing = sendspinClientOwners.get(id);
      if (existing === this.zoneId) continue;
      if (typeof existing === 'number') {
        previousZones.add(existing);
      }
      sendspinClientOwners.set(id, this.zoneId);
    }
    for (const zoneId of previousZones) {
      const prev = sendspinOutputsByZoneId.get(zoneId);
      try {
        prev?.teardown({ preserveAnchor: false });
      } catch {
        /* ignore */
      }
    }
  }

  /** Release every configured client we still own. */
  private releaseOwnership(): void {
    for (const id of this.clientIds) {
      if (sendspinClientOwners.get(id) === this.zoneId) {
        sendspinClientOwners.delete(id);
      }
    }
  }

  private sendCurrentSnapshot(): void {
    // Push latest playback state + metadata to a newly connected client.
    this.pushPlaybackState(this.playbackState);
    const session = this.ports.audioManager.getSession(this.zoneId);
    const payload = this.buildMetadataPayload(session);
    if (payload) {
      this.lastMetadataSignature = this.buildMetadataSignature(payload);
      this.currentCoverUrl = payload.artwork_url ?? null;
      for (const id of this.connectedTargetClientIds()) {
        sendspinCore.setClientMetadata(id, payload);
      }
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
    const zoneState = this.ports.zoneManager.getZoneState(this.zoneId);
    const meta = session?.metadata;
    const title = meta?.title ?? zoneState?.title ?? this.zoneName ?? 'Sendspin';
    const artist = meta?.artist ?? zoneState?.artist ?? null;
    const albumArtist = (meta as { album_artist?: string | null } | undefined)?.album_artist ?? null;
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
    const repeatMode: RepeatMode | null =
      zoneState?.plrepeat === 3
        ? RepeatMode.ONE
        : zoneState?.plrepeat === 1
          ? RepeatMode.ALL
          : RepeatMode.OFF;
    const shuffleMode: boolean | null =
      typeof zoneState?.plshuffle === 'number' ? zoneState.plshuffle === 1 : null;

    return {
      title,
      artist,
      album,
      artwork_url: cover,
      track: trackNumber,
      album_artist: albumArtist,
      year: typeof (meta as { year?: number } | undefined)?.year === 'number' ? (meta as { year?: number }).year! : null,
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
        ? `pipe:${(source as { path?: string }).path ?? ''}`
        : source?.kind === 'file'
          ? `file:${(source as { path?: string }).path ?? ''}`
          : source?.kind === 'url'
            ? `url:${(source as { url?: string }).url ?? ''}`
            : session.source ?? 'unknown';
    const streamId = session.stream?.id ?? '';
    const pcmId = session.pcmStream?.id ?? '';
    return `${base}|${profile}|${streamId}|${pcmId}`;
  }

  // eslint-disable-next-line max-len
  private async fetchAndSendArtwork(session?: { metadata?: PlaybackSession['metadata']; stream?: PlaybackSession['stream'] }): Promise<void> {
    const defaultChannels: ArtworkChannel[] = [
      { source: 'album', format: 'jpeg', width: 800, height: 800 },
    ];
    const channelsByClient = new Map<string, ArtworkChannel[]>();
    for (const id of this.connectedTargetClientIds()) {
      channelsByClient.set(id, sendspinCore.getArtworkChannels(id) ?? defaultChannels);
    }
    const sendArtworkToAll = (idx: 0 | 1 | 2 | 3, buf: Buffer | null): void => {
      for (const [id, channels] of channelsByClient) {
        if (idx < channels.length) {
          sendspinCore.sendArtwork(id, idx, buf);
        }
      }
    };
    const announceArtworkStart = (): void => {
      for (const [id, channels] of channelsByClient) {
        sendspinCore.sendArtworkStreamStart(id, channels);
      }
    };
    const sendNullArtwork = (): void => {
      announceArtworkStart();
      // Cap the loop at the widest channel set across clients; per-client
      // bounds checking is enforced inside sendArtworkToAll.
      const maxChannelCount = Math.max(
        defaultChannels.length,
        ...Array.from(channelsByClient.values(), (c) => c.length),
      );
      for (let idx = 0; idx < Math.min(4, maxChannelCount); idx += 1) {
        sendArtworkToAll(idx as 0 | 1 | 2 | 3, null);
      }
    };
    try {
      const coverUrl = session?.metadata?.coverurl ?? session?.stream?.coverUrl ?? null;
      if (!coverUrl) {
        sendNullArtwork();
        return;
      }
      // Skip invalid/non-http URLs to avoid noisy errors.
      try {
        const parsed = new URL(coverUrl);
        if (!/^https?:$/.test(parsed.protocol)) {
          sendNullArtwork();
          return;
        }
      } catch {
        sendNullArtwork();
        return;
      }
      const buf = await this.fetchBuffer(coverUrl);
      if (!buf) {
        return;
      }
      announceArtworkStart();
      const maxChannelCount = Math.max(
        defaultChannels.length,
        ...Array.from(channelsByClient.values(), (c) => c.length),
      );
      for (let idx = 0; idx < Math.min(4, maxChannelCount); idx += 1) {
        sendArtworkToAll(idx as 0 | 1 | 2 | 3, buf);
      }
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

  /** Primary identifier of the configured Sendspin client(s). For multi-client zones
   *  this is the first configured ID; use `getClientIds()` for the full list.
   *  Constructor guarantees `clientIds` is non-empty. */
  public getClientId(): string {
    // Non-null-assert is safe: constructor throws if clientIds is empty.
    const first = this.clientIds[0]!;
    return this.resolvedClientIds.get(first) ?? first;
  }

  /** Every configured (resolved) Sendspin client ID this zone targets. */
  public getClientIds(): string[] {
    return this.allTargetClientIds();
  }

  /** True if at least one of the configured Sendspin clients is currently connected. */
  public isClientConnected(): boolean {
    return this.isAnyClientConnected();
  }

  /** True when this zone leads a group that has at least one other member.
   *  (`members` always includes the leader, so length > 1 means real members.) */
  private isGroupLeaderWithMembers(): boolean {
    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    return !!group && group.leader === this.zoneId && group.members.length > 1;
  }

  private getGroupInfo(): { groupId: string; groupName: string } {
    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    if (group) {
      const groupId = group.externalId ?? `group-${group.leader}`;
      const groupName =
        this.ports.zoneManager.getZoneState(group.leader)?.name ??
        this.ports.zoneManager.getZoneState(this.zoneId)?.name ??
        this.zoneName;
      return { groupId, groupName };
    }
    return { groupId: String(this.zoneId), groupName: this.zoneName };
  }

  private removeZoneFromGroup(): 'removed' | 'no_group' | 'leader' {
    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    if (!group) {
      return 'no_group';
    }
    if (group.leader === this.zoneId) {
      return 'leader';
    }
    const remainingMembers = group.members.filter((id) => id !== this.zoneId);
    this.ports.groupTracker.upsertGroup({
      leader: group.leader,
      members: remainingMembers,
      backend: group.backend,
      externalId: group.externalId,
      source: group.source,
    });
    return 'removed';
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

  private normalizeFormat(format: Partial<PlayerFormat>): SendspinFormat {
    const sampleRate = Number.isFinite(format.sampleRate) ? format.sampleRate! : audioOutputSettings.sampleRate;
    const channels = Number.isFinite(format.channels) ? format.channels! : audioOutputSettings.channels;
    const bitDepth = this.normalizeBitDepth(
      Number.isFinite(format.bitDepth) ? (format.bitDepth as number) : audioOutputSettings.pcmBitDepth,
    );
    // Force PCM for Sendspin output stability.
    const codec: AudioCodec = AudioCodec.PCM;
    return { codec, sampleRate, channels, bitDepth };
  }

  private static resolveAnchorLeadUs(): number {
    const defaultMs = 250;
    const clampedMs = Math.max(250, Math.min(8000, Math.round(defaultMs)));
    return clampedMs * 1000;
  }
}
