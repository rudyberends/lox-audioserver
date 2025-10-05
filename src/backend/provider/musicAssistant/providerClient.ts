import MusicAssistantClient from '../../zone/MusicAssistant/client';
import logger from '../../../utils/troxorlogger';

const DEFAULT_RETRY_ATTEMPTS = 3;

/**
 * Thin wrapper around the Music Assistant zone client providing retrying RPC access for providers.
 */
export class MusicAssistantProviderClient {
  private readonly client: MusicAssistantClient;
  private connectPromise?: Promise<void>;
  private started = false;

  /** Create a client bound to a Music Assistant host/port. */
  constructor(host: string, port: number) {
    this.client = new MusicAssistantClient(host, port);
  }

  /** Issue an RPC call with lightweight retry logic for not-yet-connected sockets. */
  async rpc(command: string, args?: Record<string, any>): Promise<any> {
    await this.ensureStarted();

    let attempt = 0;
    let lastError: unknown;

    while (attempt < DEFAULT_RETRY_ATTEMPTS) {
      try {
        return await this.client.rpc(command, args);
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.message === 'Not connected') {
          attempt += 1;
          logger.debug(
            `[MusicAssistantProviderClient] RPC ${command} failed because connection is not ready. Retry ${attempt}/${DEFAULT_RETRY_ATTEMPTS}.`,
          );
          await this.delay(Math.min(300 * attempt, 1000));
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Disconnects and resets the lazily started Music Assistant client. */
  cleanup(): void {
    this.client.cleanup();
    this.started = false;
    this.connectPromise = undefined;
  }

  /** Establishes the underlying socket connection once and memoizes the promise. */
  private async ensureStarted(): Promise<void> {
    if (this.started) return;

    if (!this.connectPromise) {
      this.connectPromise = this.client.connect().then(() => {
        this.started = true;
      });
      this.connectPromise.catch((error) => {
        logger.warn(`[MusicAssistantProviderClient] Failed to connect: ${error instanceof Error ? error.message : error}`);
        this.connectPromise = undefined;
        this.started = false;
      });
    }

    await this.connectPromise;
  }

  /** Small helper to back off between retry attempts. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Factory that reads env vars to construct a ready-to-use provider client. */
export function createProviderClient(): MusicAssistantProviderClient {
  const host = process.env.MEDIA_PROVIDER_IP || '127.0.0.1';
  const port = Number(process.env.MEDIA_PROVIDER_PORT || 8095);
  logger.info(`[MusicAssistantProviderClient] Connecting to ${host}:${port}`);
  return new MusicAssistantProviderClient(host, port);
}
