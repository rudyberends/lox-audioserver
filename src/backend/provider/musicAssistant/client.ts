import logger from '../../../utils/troxorlogger';
import MusicAssistantClient from '../../zone/MusicAssistant/client';

/**
 * Thin wrapper around {@link MusicAssistantClient} that lazily connects and
 * exposes a typed `rpc` helper for provider use.
 */
export class MusicAssistantProviderClient {
  private readonly host: string;
  private readonly port: number;

  private client?: MusicAssistantClient;
  private connectPromise?: Promise<void>;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
  }

  /**
   * Ensure a websocket connection is available before issuing RPC calls.
   */
  private async ensureConnected(): Promise<MusicAssistantClient> {
    if (!this.client) {
      this.client = new MusicAssistantClient(this.host, this.port);
    }

    if (!this.connectPromise) {
      this.connectPromise = this.client
        .connect()
        .catch((error) => {
          this.client?.cleanup();
          this.client = undefined;
          throw error;
        })
        .finally(() => {
          this.connectPromise = undefined;
        });
    }

    try {
      await this.connectPromise;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistantProvider] Failed to connect to ${this.host}:${this.port} – ${message}`);
      throw error;
    }

    return this.client!;
  }

  /**
   * Issue an RPC request to Music Assistant, ensuring connectivity.
   */
  async rpc<T = any>(command: string, args?: Record<string, any>): Promise<T> {
    const client = await this.ensureConnected();
    try {
      return await client.rpc(command, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistantProvider] RPC "${command}" failed – ${message}`);
      if (message.includes('Not connected')) {
        client.cleanup();
        this.client = undefined;
      }
      throw error;
    }
  }

  /**
   * Gracefully dispose of the underlying websocket.
   */
  dispose(): void {
    if (this.client) {
      try {
        this.client.cleanup();
      } catch {
        // ignore cleanup errors
      }
      this.client = undefined;
    }
  }
}

export default MusicAssistantProviderClient;
