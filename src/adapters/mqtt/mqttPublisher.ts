/**
 * Publishes zone state to an MQTT broker.
 *
 * Exists because integrators were rebuilding a change feed we did not offer. The
 * LoxBerry plugin's bridge polls a state snapshot once a second, keeps a full shadow
 * copy of every field it has seen, diffs each one to avoid republishing what did not
 * change, and hand-schedules "hot" fields at 1 s against "expensive" ones at 60 s — all
 * of it a client-side guess at which of our fields are volatile. Every line of that is
 * work this class does once, on the side that knows the answer.
 *
 * It subscribes to the same `ApiEventHub` the SSE endpoint uses, so an MQTT consumer and
 * an SSE consumer cannot observe different state. The payload is `ApiZoneState` verbatim;
 * see mqttTopics.ts for why the topic tree is the API's vocabulary and not Loxone's.
 */
import { connectAsync, type IClientOptions, type MqttClient } from 'mqtt';
import type { ApiEvent, ApiZoneState } from '@/domain/zones/apiTypes';
import type { ApiEventHub } from '@/adapters/http/api/apiEventHub';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { MqttConfig } from '@/domain/config/types';
import { commandTopicFilters, parseMqttCommand } from '@/domain/server/mqttCommands';
import {
  availabilityTopic,
  progressMessages,
  sanitizeTopicPrefix,
  zoneMessages,
  type MqttMessage,
} from '@/domain/server/mqttTopics';
import { createLogger } from '@/shared/logging/logger';

const DEFAULT_MQTT_PORT = 1883;
const DEFAULT_MQTTS_PORT = 8883;

/**
 * How long to wait for the broker before giving up on a connect attempt. The client
 * reconnects on its own afterwards, so this bounds the wait, not the effort.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/** How long between reconnect attempts. Generous: a broker that is down stays down a while. */
const RECONNECT_PERIOD_MS = 5_000;

export type MqttPublisherStatus = {
  enabled: boolean;
  connected: boolean;
  /** The broker this is configured for, without credentials, for the admin UI to show. */
  broker: string | null;
  topicPrefix: string;
  /** Why it is not connected, when it is not. */
  lastError: string | null;
  /** How many messages have been published since connecting, as a sign of life. */
  published: number;
  /** Whether inbound commands are accepted, i.e. this runtime was built with control. */
  control: boolean;
};

export class MqttPublisher {
  private readonly log = createLogger('Mqtt');
  private client: MqttClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastError: string | null = null;
  private published = 0;
  private starting: Promise<void> | null = null;

  constructor(
    private readonly configPort: ConfigPort,
    private readonly eventHub: ApiEventHub,
    private readonly getZones: () => ApiZoneState[],
    /**
     * Applies an inbound command. Absent when this runtime only publishes — control is
     * opt-in at construction so a deployment can be sure nothing off-broker can steer it.
     */
    private readonly control?: {
      handleCommand: (zoneId: number, command: string, payload?: string) => void;
      playContent: (zoneId: number, uri: string) => Promise<void>;
      hasZone: (zoneId: number) => boolean;
    },
  ) {}

  private config(): MqttConfig {
    return this.configPort.getConfig()?.mqtt ?? {};
  }

  public isEnabled(): boolean {
    const cfg = this.config();
    return cfg.enabled === true && Boolean(cfg.host?.trim());
  }

  public status(): MqttPublisherStatus {
    const cfg = this.config();
    return {
      enabled: this.isEnabled(),
      connected: this.client?.connected === true,
      broker: cfg.host?.trim() ? this.brokerUrl(cfg) : null,
      topicPrefix: sanitizeTopicPrefix(cfg.topicPrefix),
      lastError: this.lastError,
      published: this.published,
      control: Boolean(this.control),
    };
  }

  private brokerUrl(cfg: MqttConfig): string {
    const protocol = cfg.protocol === 'mqtts' ? 'mqtts' : 'mqtt';
    const port = cfg.port ?? (protocol === 'mqtts' ? DEFAULT_MQTTS_PORT : DEFAULT_MQTT_PORT);
    return `${protocol}://${cfg.host?.trim()}:${port}`;
  }

  /**
   * Connects and starts publishing. Idempotent, and safe to call while a previous
   * attempt is still in flight — the admin UI can toggle faster than a broker responds.
   */
  public async start(): Promise<void> {
    if (this.starting) {
      return this.starting;
    }
    if (this.client || !this.isEnabled()) {
      return;
    }
    this.starting = this.connect().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async connect(): Promise<void> {
    const cfg = this.config();
    const prefix = sanitizeTopicPrefix(cfg.topicPrefix);
    const url = this.brokerUrl(cfg);
    const online = availabilityTopic(prefix);
    try {
      // The will is registered as part of connecting, so the broker announces our death
      // even if we never get to say anything else.
      const client = await connectAsync(url, this.options(cfg, online));
      this.client = client;
      this.lastError = null;
      this.published = 0;
      client.on('error', (error) => {
        // Never throw from here: an unhandled error on the client kills the process.
        this.lastError = error instanceof Error ? error.message : String(error);
        this.log.warn('broker error', { message: this.lastError });
      });
      client.on('reconnect', () => this.log.debug('reconnecting to broker'));
      // A reconnect gets a fresh retained snapshot: the broker may have been restarted
      // and lost everything we published before.
      client.on('connect', () => {
        void this.publishSnapshot(prefix, online);
      });
      await this.publishSnapshot(prefix, online);
      this.subscribeToEvents(prefix);
      await this.subscribeToCommands(client, prefix);
      this.log.info('publishing zone state', {
        broker: url,
        topicPrefix: prefix,
        control: Boolean(this.control),
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log.warn('could not reach broker', { broker: url, message: this.lastError });
      // Leave the client null so a later start() retries rather than sitting dead.
      this.client = null;
    }
  }

  private options(cfg: MqttConfig, online: string): IClientOptions {
    const username = cfg.username?.trim();
    return {
      username: username || undefined,
      password: cfg.password || undefined,
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectPeriod: RECONNECT_PERIOD_MS,
      clientId: `sonn-${Math.random().toString(36).slice(2, 10)}`,
      will: { topic: online, payload: Buffer.from('0'), qos: 0, retain: true },
    };
  }

  /** Everything a consumer needs to render current state without waiting for a change. */
  private async publishSnapshot(prefix: string, online: string): Promise<void> {
    await this.send([{ topic: online, payload: '1', retain: true }]);
    for (const zone of this.getZones()) {
      await this.send(zoneMessages(prefix, zone));
    }
  }

  private subscribeToEvents(prefix: string): void {
    const publishProgress = this.config().publishProgress === true;
    this.unsubscribe?.();
    this.unsubscribe = this.eventHub.subscribe((event: ApiEvent) => {
      // The hub drops a subscriber that throws, silently and permanently, so nothing
      // here may propagate. Publishing is fire-and-forget for the same reason.
      void this.handleEvent(prefix, event, publishProgress).catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    });
  }

  private async handleEvent(
    prefix: string,
    event: ApiEvent,
    publishProgress: boolean,
  ): Promise<void> {
    if (event.type === 'zone.changed') {
      await this.send(zoneMessages(prefix, event.zone));
      return;
    }
    if (event.type === 'zone.progress' && publishProgress) {
      await this.send(progressMessages(prefix, event.id, event.position));
    }
    // server.ready is per-connection bookkeeping for SSE and means nothing here: this
    // publisher already sends its own snapshot on connect.
  }

  /**
   * Listens for commands, when this runtime was built with control.
   *
   * Access is the broker's business: anyone allowed to publish here can steer the audio,
   * exactly as anyone allowed to read the state topics can watch it. That is the normal
   * MQTT trust model — the broker has its own credentials and per-topic ACLs — and
   * duplicating it here would only add a second place to get it wrong.
   */
  private async subscribeToCommands(client: MqttClient, prefix: string): Promise<void> {
    if (!this.control) {
      return;
    }
    client.on('message', (topic, payload, packet) => {
      // Never throw out of a client event handler: an unhandled one takes the process.
      try {
        this.applyCommand(prefix, topic, payload.toString('utf8'), packet.retain === true);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.log.warn('command failed', { topic, message: this.lastError });
      }
    });
    for (const filter of commandTopicFilters(prefix)) {
      await client.subscribeAsync(filter, { qos: 0 });
    }
  }

  private applyCommand(prefix: string, topic: string, payload: string, retained: boolean): void {
    const control = this.control;
    if (!control) {
      return;
    }
    const result = parseMqttCommand(prefix, topic, payload, retained);
    if (result.kind === 'ignored') {
      if (result.reason === 'retained-command') {
        // Clear it, do not merely skip it: a stored command is replayed on every
        // reconnect, so ignoring it leaves a zone that lurches back after each restart
        // with nothing on the broker explaining why. An empty retained payload is how
        // MQTT deletes one.
        this.log.warn('clearing retained command; commands must be published unretained', {
          topic,
        });
        void this.client
          ?.publishAsync(topic, '', { retain: true })
          .catch(() => undefined);
      } else {
        this.log.debug('ignoring message', { topic, reason: result.reason });
      }
      return;
    }
    if (result.kind === 'error') {
      this.log.warn('rejected command', { topic, reason: result.reason });
      return;
    }
    if (!control.hasZone(result.zoneId)) {
      this.log.warn('command for unknown zone', { topic, zoneId: result.zoneId });
      return;
    }
    for (const command of result.commands) {
      control.handleCommand(command.zoneId, command.command, command.payload);
    }
    if (result.play) {
      // Fire-and-forget: resolving a uri can take a moment and there is nobody to answer.
      void control.playContent(result.play.zoneId, result.play.uri).catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.log.warn('play failed', { topic, message: this.lastError });
      });
    }
    this.log.debug('applied command', {
      topic,
      commands: result.commands.length,
      play: Boolean(result.play),
    });
  }

  private async send(messages: MqttMessage[]): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    for (const message of messages) {
      try {
        await client.publishAsync(message.topic, message.payload, { retain: message.retain });
        this.published += 1;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  /**
   * Disconnects and stops publishing.
   *
   * Says goodbye explicitly — the will only fires on an ungraceful disconnect, and a
   * consumer should see `online: 0` when the integration is switched off too.
   */
  public async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const client = this.client;
    this.client = null;
    if (!client) {
      return;
    }
    const prefix = sanitizeTopicPrefix(this.config().topicPrefix);
    await client
      .publishAsync(availabilityTopic(prefix), '0', { retain: true })
      .catch(() => undefined);
    await client.endAsync().catch(() => undefined);
    this.log.info('stopped publishing zone state');
  }

  /** Applies a config change: connect, disconnect or reconnect as the new config requires. */
  public async sync(): Promise<void> {
    if (!this.isEnabled()) {
      await this.stop();
      return;
    }
    // Reconnect unconditionally when already up: host, credentials or prefix may have
    // changed, and there is no cheap way to tell which.
    await this.stop();
    await this.start();
  }
}
