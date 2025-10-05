import axios from 'axios';
import * as ndjson from 'ndjson';
import { Readable } from 'stream';
import logger from '../../../utils/troxorlogger';
import { NotificationMessage } from './types';

export type NotificationHandler = (msg: NotificationMessage) => Promise<void> | void;

/**
 * Thin wrapper around the BeoNotify streaming endpoint.
 * Handles lifecycle for the NDJSON stream and forwards parsed notifications to a handler.
 */
export default class BeolinkNotifyClient {
  private stream: Readable | null = null;
  private source: Readable | null = null;
  private reconnectTimer?: NodeJS.Timeout;
  private handler: NotificationHandler | null = null;

  constructor(private readonly notifyUrl: string, private readonly reconnectDelayMs = 5000) {}

  /** Starts listening to the BeoNotify endpoint and delivers events to {@link NotificationHandler}. */
  async subscribe(handler: NotificationHandler): Promise<void> {
    this.handler = handler;
    await this.openStream();
  }

  /** Stops streaming notifications and clears any pending reconnect attempts. */
  async close(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (!this.stream && !this.source) return;

    try {
      if (this.source) {
        this.source.removeAllListeners();
        this.source.destroy();
      }
      if (this.stream) {
        this.stream.removeAllListeners();
        this.stream.destroy();
      }
      logger.info(`[BeoNotify] Notification listener closed for ${this.notifyUrl}`);
    } catch (error) {
      logger.error(`[BeoNotify] Error closing notification listener for ${this.notifyUrl}: ${error}`);
    } finally {
      this.stream = null;
      this.source = null;
    }
  }

  /** Tears down existing streams and establishes a fresh NDJSON subscription. */
  private async openStream(): Promise<void> {
    await this.close();

    if (!this.handler) return;

    try {
      const response = await axios.get(this.notifyUrl, {
        responseType: 'stream',
      });

      const source = response.data as Readable;
      const stream = source.pipe(ndjson.parse());
      this.stream = stream;
      this.source = source;
      logger.info(`[BeoNotify] Notification listener active for ${this.notifyUrl}`);

      stream.on('data', async (msg: NotificationMessage) => {
        try {
          await this.handler?.(msg);
        } catch (error) {
          logger.error(`[BeoNotify] Handler threw an error: ${error}`);
        }
      });

      const scheduleReconnect = (reason: string, error?: any) => {
        if (error) {
          logger.error(`[BeoNotify] ${reason} for ${this.notifyUrl}: ${error}`);
        } else {
          logger.warn(`[BeoNotify] ${reason} for ${this.notifyUrl}`);
        }
        this.scheduleReconnect();
      };

      const registerLifecycle = (emitter: Readable, label: string) => {
        emitter.on('error', (error: any) => scheduleReconnect(`${label} error`, error));
        emitter.on('close', () => scheduleReconnect(`${label} closed`));
        emitter.on('end', () => scheduleReconnect(`${label} ended`));
      };

      registerLifecycle(source, 'Source stream');
      registerLifecycle(stream, 'Parser stream');
    } catch (error) {
      logger.error(`[BeoNotify] Failed to initialize notification stream for ${this.notifyUrl}: ${error}`);
      this.scheduleReconnect();
    }
  }

  /** Schedules a reconnect attempt after the configured backoff. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.handler) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openStream().catch((error) => {
        logger.error(`[BeoNotify] Reconnect attempt failed for ${this.notifyUrl}: ${error}`);
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
  }
}
