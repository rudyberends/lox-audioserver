import { createLogger } from '@/shared/logging/logger';
import type { PassThrough } from 'node:stream';
import type { PlaybackSession } from '@/application/playback/audioManager';
import type { PreferredOutput, OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import { RaopSender } from '@/adapters/outputs/airplay/raopSender';
import { AirplayStreamSession } from '@/adapters/outputs/airplay/airplayStreamSession';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import { waitForReadableStream } from '@/shared/audio/streamReadiness';

export interface AirPlayOutputConfig {
  host: string;
  port?: number;
  name?: string;
  password?: string;
  debug?: boolean;
  /** Device encryption types (mDNS TXT `et`), resolved by the AdminUI picker. */
  et?: string;
  /** Device metadata capabilities (mDNS TXT `md`), resolved by the AdminUI picker. */
  md?: string;
  /** Requested read-ahead latency (ms). Lower = snappier start/skip. Default ~500. */
  latencyMs?: number;
}

export const AIRPLAY_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'airplay',
  label: 'AirPlay',
  description: 'AirPlay output. Streams the session to a configured AirPlay (RAOP) device.',
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
      description: 'Optional RTSP port override; when omitted, discovery picks it (RAOP is typically 5000).',
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
      description: 'Enable verbose AirPlay debug logs (true/false).',
    },
  ],
};

/**
 * AirPlay (RAOP) output backed by node-libraop. libraop owns all realtime
 * streaming (RTP timing, ALAC, retransmit, device read-ahead); we just feed it a
 * continuous PCM stream and let its backpressure pace us. The stream is kept
 * alive across track switches so a track change is metadata-only (no zap).
 */
export class AirPlayOutput implements ZoneOutput {
  public readonly type = 'airplay';
  private readonly log = createLogger('Output', 'AirPlay');
  private readonly sender: RaopSender;
  private readonly streamSession: AirplayStreamSession;
  private currentVolume = 0;
  private running = false;
  private starting = false;
  private paused = false;
  private lastSession: PlaybackSession | null = null;
  private attachedLeaderId: number | null = null;

  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private readonly retryIntervalMs = 1000;
  private readonly retryMaxAttempts = 20;
  private progressTimer: NodeJS.Timeout | null = null;
  private readonly progressIntervalMs = 2000;
  private readonly pcmStartTimeoutMs = 8000;
  private readonly pcmPipeTimeoutMs = 20000;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: AirPlayOutputConfig,
    private readonly ports: OutputPorts,
    initialVolume?: number,
  ) {
    this.sender = new RaopSender(
      {
        host: config.host.trim(),
        port: typeof config.port === 'number' ? config.port : undefined,
        password: config.password?.trim() || undefined,
        et: typeof config.et === 'string' ? config.et : undefined,
        md: typeof config.md === 'string' ? config.md : undefined,
        latencyMs: typeof config.latencyMs === 'number' ? config.latencyMs : undefined,
        debug: config.debug === true,
        onUnavailable: (reason) => this.handleSenderUnavailable(reason),
      },
      { zoneId, zoneName },
    );
    this.streamSession = new AirplayStreamSession(zoneId, this.ports.engine);
    // On a track-change source swap, flush the device buffer + ring and re-bind to
    // the fresh stream so the old track's buffered tail is dropped at the seam.
    this.streamSession.setOnResubscribe((stream) => this.sender.rebind(stream));
    if (Number.isFinite(initialVolume)) {
      this.currentVolume = Math.min(100, Math.max(0, Math.round(initialVolume as number)));
    }
    this.log.info('AirPlay output config', { zoneId, zoneName, host: config.host.trim() });
    this.ports.airplayGroup.register(this.zoneId, this);
  }

  public async play(session: PlaybackSession): Promise<void> {
    this.paused = false;
    const isNewTrack = Boolean(this.lastSession && this.lastSession.stream?.id !== session.stream?.id);
    this.lastSession = session;

    if (!session.playbackSource) {
      this.log.warn('AirPlay output skipped; no playback source', { zoneId: this.zoneId });
      this.ports.outputHandlers.onOutputError(this.zoneId, 'airplay no source');
      return;
    }

    const effectiveOutput = this.ports.zoneAudioPrefs.getEffectiveOutputSettings(this.zoneId);
    this.streamSession.setPlaybackSource(session.playbackSource, effectiveOutput);

    // Track switch: keep the sender connected (no RTSP zap), but proactively swap
    // to the new engine session now — drop the old source + buffered tail and flush
    // the device buffer — instead of waiting for the old subscriber to drain. This
    // mirrors the sendspin output (re-subscribe + client-buffer reset per track).
    if (isNewTrack && this.sender.isRunning()) {
      this.running = true;
      this.clearRetry();
      this.streamSession.switchTrack();
      void this.updateMetadata(session);
      return;
    }

    // Non-leader of an active group: feed our own sender from the leader's stream.
    const joined = await this.ports.airplayGroup.tryJoinLeader(this);
    if (joined) {
      this.log.info('joined leader AirPlay session (multiroom)', { zoneId: this.zoneId });
      return;
    }

    if (this.running || this.starting) {
      // Already active; just make sure the source is bound and volume is current.
      const stream = this.streamSession.getStream();
      if (stream) {
        await this.sender.start(stream, this.currentVolume);
      }
      this.clearRetry();
      return;
    }

    const engineReady = await this.waitForEngine();
    if (!engineReady) {
      this.log.warn('AirPlay output skipped; no active audio engine session', { zoneId: this.zoneId });
      this.ports.outputHandlers.onOutputError(this.zoneId, 'airplay engine not ready');
      return;
    }

    const stream = this.streamSession.getStream();
    if (!stream) {
      this.log.warn('AirPlay output skipped; pcm stream unavailable', { zoneId: this.zoneId });
      this.ports.outputHandlers.onOutputError(this.zoneId, 'airplay pcm stream unavailable');
      return;
    }

    this.starting = true;
    try {
      const pcmTimeoutMs =
        session.playbackSource.kind === 'pipe' ? this.pcmPipeTimeoutMs : this.pcmStartTimeoutMs;
      const ready = await this.waitForPcmStream(stream, pcmTimeoutMs);
      if (!ready) {
        this.log.warn('AirPlay output skipped; PCM stream not ready', {
          zoneId: this.zoneId,
          timeoutMs: pcmTimeoutMs,
        });
        this.starting = false;
        this.scheduleRetry();
        return;
      }
      const started = await this.sender.start(stream, this.currentVolume);
      if (!started) {
        this.starting = false;
        this.scheduleRetry();
        return;
      }
      this.running = true;
      this.clearRetry();
    } finally {
      this.starting = false;
    }

    void this.updateMetadata(session);
    this.startProgressTimer();
    await this.ports.airplayGroup.syncGroupMembers(this);
  }

  public async pause(_session: PlaybackSession | null): Promise<void> {
    if (this.paused) {
      return;
    }
    this.log.info('AirPlay pause', { zoneId: this.zoneId, zoneName: this.zoneName });
    this.paused = true;
    this.stopProgressTimer();
    this.sender.pause();
    this.running = false;
    this.starting = false;
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    this.log.info('AirPlay resume', { zoneId: this.zoneId, zoneName: this.zoneName });
    if (this.running || this.starting) {
      return;
    }
    this.paused = false;
    // The sender connection is kept across pause; re-anchor the RTP clock and
    // re-bind the source explicitly (sender.resume → senderControl('play'))
    // instead of relying on libraop's implicit accept-frames unpause.
    if (this.sender.isRunning()) {
      const stream = this.streamSession.getStream();
      if (stream) {
        this.sender.resume(stream);
        this.running = true;
        this.startProgressTimer();
        void this.updateMetadata(session);
        return;
      }
    }
    if (session) {
      await this.play(session);
    }
  }

  public async stop(_session: PlaybackSession | null): Promise<void> {
    this.log.info('AirPlay stop', { zoneId: this.zoneId, zoneName: this.zoneName });
    this.clearRetry();
    this.stopProgressTimer();

    if (this.attachedLeaderId) {
      // We were a grouped member; just tear down our sender and detach.
      this.running = false;
      this.starting = false;
      await this.ports.airplayGroup.detachMember(this);
      return;
    }

    this.sender.stop();
    this.running = false;
    this.starting = false;
    this.paused = false;
    this.lastSession = null;
    this.streamSession.dispose();
    this.ports.airplayGroup.onLeaderStopped(this.zoneId);
  }

  public getPreferredOutput(): PreferredOutput {
    // AirPlay/RAOP expects 44.1kHz PCM16 stereo.
    return {
      profile: 'pcm',
      sampleRate: 44100,
      channels: 2,
      bitDepth: 16,
      prebufferBytes: 256 * 1024,
    };
  }

  public getLatencyMs(): number {
    return this.sender.getLatencyMs();
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
    await this.sender.setVolume(this.currentVolume);
  }

  public async updateMetadata(session: PlaybackSession | null): Promise<void> {
    const current = session ?? this.ports.audioManager.getSession(this.zoneId);
    if (!current) return;
    const meta = current.metadata;
    if (!meta) return;
    this.sender.updateMetadata({
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      cover: current.cover ? { data: current.cover.data, mime: current.cover.mime } : undefined,
      // session elapsed/duration are in SECONDS; libraop wants milliseconds.
      elapsedMs: Number.isFinite(current.elapsed) ? current.elapsed * 1000 : undefined,
      durationMs: Number.isFinite(current.duration) ? current.duration * 1000 : undefined,
    });
  }

  // --- multiroom group participant ----------------------------------------

  public getZoneId(): number {
    return this.zoneId;
  }

  public getCurrentVolume(): number {
    return this.currentVolume;
  }

  public isRunning(): boolean {
    return this.running;
  }

  /** PCM stream that grouped members feed their own senders from. */
  public getSharedStream(): PassThrough | null {
    return this.streamSession.getStream();
  }

  /** Start this output's sender from a leader's shared PCM stream (grouped member). */
  public async startFromLeaderStream(stream: NodeJS.ReadableStream, volume: number): Promise<void> {
    this.currentVolume = Math.min(100, Math.max(0, Math.round(volume)));
    const started = await this.sender.start(stream, this.currentVolume);
    this.running = started;
    if (started) {
      this.startProgressTimer();
    }
  }

  public async stopLocal(): Promise<void> {
    this.stopProgressTimer();
    this.sender.stop();
    this.running = false;
    this.starting = false;
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

  // --- internals -----------------------------------------------------------

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

  /** Push playback progress to the device periodically so its UI stays in sync. */
  private startProgressTimer(): void {
    this.stopProgressTimer();
    this.progressTimer = setInterval(() => {
      const session = this.ports.audioManager.getSession(this.zoneId);
      if (!session || !Number.isFinite(session.duration) || session.duration <= 0) {
        return;
      }
      // session timings are in seconds; the sender expects milliseconds.
      this.sender.setProgress((session.elapsed || 0) * 1000, session.duration * 1000);
    }, this.progressIntervalMs);
  }

  private stopProgressTimer(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private handleSenderUnavailable(reason: string): void {
    if (!this.running && !this.starting) {
      return;
    }
    this.log.info('AirPlay device unavailable; stopping zone', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      reason,
    });
    this.running = false;
    this.starting = false;
    this.ports.zoneManager.handleCommand(this.zoneId, 'stop');
  }

  private scheduleRetry(): void {
    if (this.retryAttempt >= this.retryMaxAttempts || this.retryTimer) {
      return;
    }
    const session = this.lastSession;
    if (!session) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAttempt += 1;
      if (this.running || this.starting) {
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
