import { createLogger } from '@/shared/logging/logger';
import { PassThrough } from 'node:stream';
import type { PlaybackSession } from '@/application/playback/audioManager';
import type { PreferredOutput, OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import { AirplaySender } from '@/adapters/outputs/airplay/airplaySender';
import { AirplayStreamSession } from '@/adapters/outputs/airplay/airplayStreamSession';
import { AirplayFlowSession } from '@/adapters/outputs/airplay/airplayFlowSession';
import type { AirplaySenderOverrides } from '@/adapters/outputs/airplay/airplaySender';
import type { AirplaySenderLike } from '@/application/outputs/airplayGroupController';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import { buildBaseUrl, resolveStreamUrl } from '@/shared/streamUrl';
import { waitForReadableStream } from '@/shared/audio/streamReadiness';

export interface AirPlayOutputConfig {
  host: string;
  port?: number;
  name?: string;
  password?: string;
  debug?: boolean;
  /** Force AirPlay2 even if RAOP is available. */
  forceAp2?: boolean;
}

export const AIRPLAY_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'airplay',
  label: 'AirPlay',
  description:
    'AirPlay output. Streams the session to a configured AirPlay device.',
  fields: [
    {
      id: 'host',
      label: 'AirPlay host',
      type: 'text',
      placeholder: '192.168.1.120',
      required: true,
      description: 'IP or hostname of the AirPlay/RAOP renderer.',
    },
    {
      id: 'port',
      label: 'AirPlay port',
      type: 'text',
      placeholder: '5000',
      description:
        'Optional override; when omitted, discovery picks the correct port (AirPlay 2 uses the discovered port, RAOP typically 5000).',
    },
    {
      id: 'name',
      label: 'Display name',
      type: 'text',
      placeholder: 'Living Room',
      description: 'Optional name shown in logs.',
    },
    {
      id: 'password',
      label: 'Password',
      type: 'text',
      placeholder: 'Optional password',
      description: 'Only needed for protected AirPlay devices.',
    },
    {
      id: 'debug',
      label: 'Debug logging',
      type: 'text',
      placeholder: 'true',
      description: 'Enable verbose AirPlay sender debug logs (true/false).',
    },
  ],
};

/**
 * AirPlay sender that pushes the session stream to a configured device.
 */
export class AirPlayOutput implements ZoneOutput {
  public readonly type = 'airplay';
  private readonly log = createLogger('Output', 'AirPlay');
  private readonly sender: AirplaySender;
  private currentVolume = 0;
  private lastInputUrl: string | null = null;
  private running = false;
  private starting = false;
  private clientStarted = false;
  private lastSession: PlaybackSession | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private readonly retryIntervalMs = 1000;
  private readonly retryMaxAttempts = 20;
  private readonly streamSession: AirplayStreamSession;
  private readonly flowSession: AirplayFlowSession;
  private readonly clientId: string;
  private readonly startDelayMs = 50; // simple barrier; later can use NTP
  private attachedLeaderId: number | null = null;
  private readonly pcmStartTimeoutMs = 8000;
  private readonly pcmPipeTimeoutMs = 20000;
  private paused = false;
  private lastStopAt = 0;
  private resumeInFlight = false;
  private fastStartNext = false;
  private noBacklogNext = false;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: AirPlayOutputConfig,
    private readonly ports: OutputPorts,
    initialVolume?: number,
  ) {
    const configOverrides: AirplaySenderOverrides = {
      packets_in_buffer: 520,
      stream_latency: 350,
      // TODO: tune sync_period; temporarily higher to reduce sync noise.
      sync_period: 70000,
      jump_forward_threshold_ms: 240,
      jump_forward_lead_ms: 180,
      control_sync_base_delay_ms: 2,
      control_sync_jitter_ms: 3,
    };
    const port = typeof config.port === 'number' ? config.port : undefined;
    const forceAp2 = typeof config.forceAp2 === 'boolean' ? config.forceAp2 : port === 7000 ? true : undefined;
    this.sender = new AirplaySender(
      {
        host: config.host.trim(),
        port,
        password: config.password?.trim() || undefined,
        name: (config.name || zoneName).trim(),
        forceAp2,
        debug: config.debug === true,
        config: configOverrides,
      },
      { zoneId, zoneName },
    );
    this.log.info('AirPlay output config', {
      zoneId,
      zoneName,
      host: config.host.trim(),
      port,
      forceAp2,
    });
    this.streamSession = new AirplayStreamSession(zoneId, this.ports.engine);
    this.flowSession = new AirplayFlowSession(zoneId);
    this.clientId = port ? `${config.host.trim()}:${port}` : config.host.trim();
    if (Number.isFinite(initialVolume)) {
      this.currentVolume = Math.min(100, Math.max(0, Math.round(initialVolume as number)));
    }
    this.ports.airplayGroup.register(this.zoneId, this);
  }

  public async play(session: PlaybackSession): Promise<void> {
    this.paused = false;
    const isNewTrack = Boolean(
      this.lastSession && this.lastSession.stream?.id !== session.stream?.id,
    );
    this.lastSession = session;
    if (!session.playbackSource) {
      this.log.warn('AirPlay output skipped; no playback source', { zoneId: this.zoneId });
      this.ports.outputHandlers.onOutputError(this.zoneId, 'airplay no source');
      return;
    }
    const outputSettings = this.ports.audioManager.getOutputSettings(this.zoneId);
    const effectiveOutput = this.ports.audioManager.getEffectiveOutputSettings(this.zoneId);
    const resolvedOutput = outputSettings ?? effectiveOutput;
    this.flowSession.setOutputFormat(
      resolvedOutput.sampleRate,
      resolvedOutput.channels,
      resolvedOutput.pcmBitDepth,
    );
    this.streamSession.setPlaybackSource(session.playbackSource, effectiveOutput);
    this.log.info('AirPlay output format', {
      zoneId: this.zoneId,
      sampleRate: resolvedOutput.sampleRate,
      channels: resolvedOutput.channels,
      pcmBitDepth: resolvedOutput.pcmBitDepth,
    });
    this.log.info('AirPlay play requested', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      clientId: this.clientId,
    });
    const directStream = this.streamSession.getStream();
    const existing = this.flowSession.getClient(this.clientId);
    if (existing) {
      this.clientStarted = true;
    }
    if (this.sender.isRunning()) {
      this.clientStarted = true;
    }
    const effectiveStream = directStream ?? existing?.stream ?? null;
    this.lastInputUrl = effectiveStream ? 'shared' : null;
    if (isNewTrack) {
      this.flowSession.resetBuffers('new_track');
      this.sender.clearBuffers();
      this.fastStartNext = true;
      this.noBacklogNext = true;
      if (this.sender.isRunning()) {
        this.log.info('AirPlay track change; restarting sender to drop buffered audio', {
          zoneId: this.zoneId,
          zoneName: this.zoneName,
        });
        await this.flowSession.stopAll();
        this.lastInputUrl = null;
        this.running = false;
        this.starting = false;
        this.clientStarted = false;
      }
    }
    if (this.clientStarted || this.starting || this.running) {
      // Sender already active (or starting); keep the session and just refresh stream + volume.
      if (effectiveStream) {
        await this.flowSession.setSharedStream(effectiveStream);
      }
      if (isNewTrack) {
        this.sender.clearBuffers();
      }
      await this.flowSession.setVolume(this.clientId, this.currentVolume);
      this.running = true;
      this.clearRetry();
      return;
    }
    const engineReady = await this.waitForEngine();
    if (!engineReady) {
      this.log.warn('AirPlay output skipped; no active audio engine session', {
        zoneId: this.zoneId,
      });
      this.ports.outputHandlers.onOutputError(this.zoneId, 'airplay engine not ready');
      return;
    }
    if (!effectiveStream) {
      this.log.warn('AirPlay output skipped; pcm stream unavailable', { zoneId: this.zoneId });
      this.ports.outputHandlers.onOutputError(this.zoneId, 'airplay pcm stream unavailable');
      return;
    }
    const inputUrl = null;
    // If this zone should join an active leader session, skip local playback.
    const joined = await this.ports.airplayGroup.tryJoinLeader(this);
    if (joined) {
      this.log.info('joined leader AirPlay session (multiroom)', { zoneId: this.zoneId });
      return;
    }

    // For pipe inputs (e.g. embedded librespot) avoid ntpstart to reduce cliap2 timing errors.
    const ntpStart = undefined;

    this.log.info('AirPlay starting stream', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      inputUrl,
      source: session.source,
    });
    this.starting = true;
    const skipPcmWait = this.fastStartNext;
    this.fastStartNext = false;
    if (!skipPcmWait) {
      const pcmTimeoutMs =
        session.playbackSource?.kind === 'pipe' ? this.pcmPipeTimeoutMs : this.pcmStartTimeoutMs;
      const streamReady = await this.waitForPcmStream(effectiveStream, pcmTimeoutMs);
      if (!streamReady) {
        this.log.warn('AirPlay output skipped; PCM stream not ready', {
          zoneId: this.zoneId,
          timeoutMs: pcmTimeoutMs,
        });
        this.starting = false;
        this.scheduleRetry();
        return;
      }
    }
    const primeBacklog = !isNewTrack && !this.noBacklogNext;
    this.noBacklogNext = false;
    try {
      await this.flowSession.startClient(
        this.clientId,
        this.sender,
        inputUrl,
        effectiveStream,
        this.currentVolume,
        ntpStart,
        primeBacklog,
      );
      setTimeout(() => this.flowSession.markReady(this.clientId), this.startDelayMs);
      this.running = true;
      this.clientStarted = true;
      this.clearRetry();
    } finally {
      this.starting = false;
    }
    await this.ports.airplayGroup.syncGroupMembers(this, inputUrl, directStream, ntpStart);
  }

  public async pause(_session: PlaybackSession | null): Promise<void> {
    this.log.info('AirPlay pause (flush)', { zoneId: this.zoneId, zoneName: this.zoneName });
    if (this.paused) {
      return;
    }
    this.paused = true;
    this.fastStartNext = true;
    await this.flowSession.pauseClients();
    this.lastStopAt = Date.now();
    this.running = false;
    this.starting = false;
    this.clientStarted = false;
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    this.log.info('AirPlay resume', { zoneId: this.zoneId, zoneName: this.zoneName });
    if (this.resumeInFlight) {
      return;
    }
    if (this.running || this.starting) {
      return;
    }
    this.resumeInFlight = true;
    try {
      if (this.paused) {
        const waitMs = 150 - (Date.now() - this.lastStopAt);
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        this.paused = false;
      }
      if (session) {
        await this.play(session);
      }
    } finally {
      this.resumeInFlight = false;
    }
  }

  public async stop(_session: PlaybackSession | null): Promise<void> {
    this.log.info('AirPlay stop', { zoneId: this.zoneId, zoneName: this.zoneName });
    this.clearRetry();
    // If we are attached to another leader's session, detach from it and skip local teardown.
    if (this.attachedLeaderId) {
      this.log.debug('AirPlay stop detaching from leader', {
        zoneId: this.zoneId,
        leaderId: this.attachedLeaderId,
      });
      this.running = false;
      this.starting = false;
      this.clientStarted = false;
      await this.ports.airplayGroup.detachMember(this);
      return;
    }

    this.log.debug('AirPlay stop tearing down local session', {
      zoneId: this.zoneId,
      clientId: this.clientId,
      running: this.running,
    });
    await this.flowSession.stopAll();
    this.lastInputUrl = null;
    this.running = false;
    this.starting = false;
    this.clientStarted = false;
    this.lastSession = null;
    this.streamSession.dispose();
      this.ports.airplayGroup.onLeaderStopped(this.zoneId);
  }

  public getPreferredOutput(): PreferredOutput {
    // AirPlay devices typically expect 44.1kHz PCM16 stereo.
    return {
      profile: 'pcm',
      sampleRate: 44100,
      channels: 2,
      bitDepth: 16,
      // Add a small rolling prebuffer to smooth bursty PCM delivery.
      prebufferBytes: 256 * 1024,
    };
  }

  public getLatencyMs(): number {
    const base = this.ports.airplayGroup.getBaseStartOffsetMs();
    const preloadMs = Math.round(this.flowSession.getPreloadSeconds() * 1000);
    return Math.max(0, base + preloadMs);
  }

  public async dispose(): Promise<void> {
    await this.stop(null);
    this.ports.airplayGroup.unregister(this.zoneId);
  }

  public async setVolume(level: number): Promise<void> {
    if (!Number.isFinite(level)) return;

    const clamped = Math.min(100, Math.max(0, Math.round(level)));
    if (clamped === this.currentVolume) {
      return;
    }
    this.currentVolume = clamped;

    // Try to update the volume live for AirPlay 2. If not possible (RAOP or pipe missing),
    // fall back to restarting the sender for the current session.
    await this.flowSession.setVolume(this.clientId, this.currentVolume);
  }

  public async updateMetadata(session: PlaybackSession | null): Promise<void> {
    const current = session ?? this.ports.audioManager.getSession(this.zoneId);
    if (!current) return;
    const meta = current.metadata;
    if (!meta) return;
    await this.sender.updateMetadata({
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      cover: current.cover ? { data: current.cover.data, mime: current.cover.mime } : undefined,
      coverUrl: meta.coverurl,
      elapsedMs: current.elapsed,
      durationMs: current.duration,
    });
  }

  private async waitForPcmStream(stream: PassThrough, timeoutMs: number): Promise<boolean> {
    return waitForReadableStream(stream, { timeoutMs });
  }

  private async waitForEngine(retries = 5, delayMs = 150): Promise<boolean> {
    let attempts = 0;
    while (attempts <= retries) {
      if (this.ports.engine.hasSession(this.zoneId)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempts++;
    }
    return this.ports.engine.hasSession(this.zoneId);
  }

  /** Expose current volume for multiroom orchestration. */
  public getCurrentVolume(): number {
    return this.currentVolume;
  }

  public getSender(): AirplaySender {
    return this.sender;
  }

  public getClientId(): string {
    return this.clientId;
  }

  public getZoneId(): number {
    return this.zoneId;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getLastInputUrl(): string | null {
    return this.lastInputUrl;
  }

  public getStreamForClients(): ReturnType<AirplayStreamSession['getStream']> {
    return this.streamSession.getStream();
  }

  public getSecondsStreamed(): number {
    return this.flowSession.getSecondsStreamed();
  }

  public async addMultiroomClient(
    clientId: string,
    sender: AirplaySenderLike,
    volume: number,
    inputUrl?: string | null,
    stream?: NodeJS.ReadableStream | null,
    ntpStart?: bigint,
    primeBacklog = true,
  ): Promise<void> {
    this.log.debug('airplay add multiroom client', {
      zoneId: this.zoneId,
      clientId,
      inputUrl,
      hasStream: Boolean(stream),
      senderRunning: sender.isRunning(),
      primeBacklog,
    });
    const source = (stream as ReturnType<AirplayStreamSession['getStream']> | null) ??
      this.streamSession.getStream() ??
      null;
    const sys = this.ports.config.getSystemConfig();
    const baseUrl = buildBaseUrl({
      host: sys.audioserver.ip?.trim(),
      fallbackHost: '127.0.0.1',
    });
    const fallbackUrl = resolveStreamUrl({
      baseUrl,
      zoneId: this.zoneId,
      streamPath: this.lastInputUrl,
      defaultExt: 'wav',
    });
    await this.flowSession.startClient(
      clientId,
      sender as AirplaySender,
      inputUrl ?? fallbackUrl,
      source,
      volume,
      ntpStart,
      primeBacklog,
    );
    setTimeout(() => this.flowSession.markReady(clientId), this.startDelayMs);
  }

  public markAttachedToLeader(leaderId: number): void {
    this.attachedLeaderId = leaderId;
  }

  public clearLeaderAttachment(): void {
    this.attachedLeaderId = null;
  }

  public isAttachedToLeader(leaderId: number): boolean {
    return this.attachedLeaderId === leaderId;
  }

  public getAttachedLeaderId(): number | null {
    return this.attachedLeaderId;
  }

  public async stopClient(clientId: string): Promise<void> {
    await this.flowSession.stopClientSafe(clientId);
  }

  private scheduleRetry(): void {
    if (this.retryAttempt >= this.retryMaxAttempts) {
      return;
    }
    if (this.retryTimer) {
      return;
    }
    const session = this.lastSession;
    if (!session) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAttempt += 1;
      if (this.running || this.starting || this.clientStarted) {
        this.clearRetry();
        return;
      }
      void this.play(session);
    }, this.retryIntervalMs);
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryAttempt = 0;
  }
}
