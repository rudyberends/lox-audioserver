import logger from '@/utils/troxorLogger';
import { MusicAssistantApi } from '../api';
import { cleanLoxoneUri } from '../utils/loxoneUriParser';
import { ContentPlayCommand } from '@/core/types/contentPlaybackTypes';

/**
 * -----------------------------------------------------------------------------
 * MusicAssistantContentPlaybackMapper
 * -----------------------------------------------------------------------------
 * Handles playback commands for Music Assistant–backed zones.
 * This mapper is responsible for translating generic content-play commands
 * (tracks, albums, playlists, or alerts) into concrete API calls toward
 * the Music Assistant backend.
 *
 * Responsibilities:
 *  - Establish and maintain an API connection to the Music Assistant server.
 *  - Execute playback of provided items with proper shuffle/start parameters.
 *  - Handle special alert playback requests immediately (type = 'alert').
 *
 * This class is entirely type-safe and designed for production use.
 * -----------------------------------------------------------------------------
 */
export class MusicAssistantContentPlaybackMapper {
  /** Human-friendly zone name, used for logging. */
  private readonly zoneName: string;

  /** Unique player identifier provided by Music Assistant. */
  private readonly playerId?: string;

  /** Music Assistant API instance bound to this zone. */
  private readonly api?: MusicAssistantApi;

  /**
   * Creates a new playback mapper instance for a specific zone.
   * @param init - Zone initialization parameters.
   */
  constructor(init: {
    providerId: string;
    zoneId: number;
    zoneName?: string;
    ip?: string;
    port?: number;
    playerId?: string;
  }) {
    this.zoneName = init.zoneName ?? `Zone ${init.zoneId}`;
    this.playerId = init.playerId;
    this.api = init.ip ? MusicAssistantApi.acquire(init.ip, init.port ?? 8095) : undefined;
  }

  /**
   * Establishes a connection to the Music Assistant backend.
   * Must be called before issuing playback commands.
   */
  async initialize(): Promise<void> {
    try {
      await this.api?.connect();
      logger.debug(`[MusicAssistantContentPlayback][${this.zoneName}] Initialized`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistantContentPlayback][${this.zoneName}] Failed to connect: ${msg}`);
    }
  }

  /**
   * Executes a playback command for this zone.
   *
   * @param cmd - The normalized content-play command containing:
   *  - `item`: Cleaned playback URI or media path.
   *  - `start_item`: Optional item index or track ID to start from.
   *  - `shuffle`: Whether shuffle mode is enabled.
   *  - `type`: The command type ('serviceplay', 'playlistplay', 'alert', etc.).
   *
   * This method handles two execution paths:
   *  1. **Alert playback** (`type === 'alert'`) — played directly without parsing.
   *  2. **Standard playback** — normal track/album/playlist playback via API.
   */
  async handlePlayCommand(cmd: ContentPlayCommand): Promise<void> {
    const prefix = `[MusicAssistantContentPlayback][${this.zoneName}]`;

    // --- Safety guards ---
    if (!this.api || !this.playerId) {
      logger.warn(`${prefix} Missing backend API or playerId`);
      return;
    }

    // --- Handle alert playback (direct path) ---
    if (cmd.type === 'alert') {
      logger.debug(`${prefix} Direct alert playback → ${cmd.item}`);
      try {
        await this.api.playMedia(this.playerId, cmd.item, {
          option: 'replace',
          shuffle: false,
          radio_mode: false,
        });
        logger.info(`${prefix} Played alert ${cmd.item}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`${prefix} Alert playback failed: ${msg}`);
      }
      return;
    }

    // --- Standard playback ---
    const mainUri: string = cleanLoxoneUri(cmd.item);
    const startItem: string | undefined = cmd.start_item
      ? cleanLoxoneUri(cmd.start_item)
      : undefined;
    const shuffle: boolean = !!cmd.shuffle;

    logger.debug(
      `${prefix} Playback → main=${mainUri}, start=${startItem ?? '-'}, shuffle=${shuffle}, type=${cmd.type}`,
    );

    try {
      await this.api.playMedia(this.playerId, mainUri, {
        option: 'replace',
        radio_mode: false,
        start_item: startItem,
        shuffle,
      });

      logger.info(
        `${prefix} Started ${cmd.type} playback of ${mainUri}${
          startItem ? ` (start=${startItem})` : ''
        }`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`${prefix} Playback failed for ${mainUri}: ${msg}`);
    }
  }

  /**
   * Releases any API resources and detaches from the Music Assistant backend.
   * Should be called during system shutdown or zone removal.
   */
  async dispose(): Promise<void> {
    this.api?.release();
    logger.debug(`[MusicAssistantContentPlayback][${this.zoneName}] Disposed`);
  }
}