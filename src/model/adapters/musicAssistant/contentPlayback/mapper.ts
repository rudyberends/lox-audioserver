import logger from '@/utils/troxorLogger';
import { MusicAssistantApi } from '../api';
import { ContentPlayCommand } from '@/core/types/contentPlaybackTypes';

export class MusicAssistantContentPlaybackMapper {
  private readonly zoneName: string;
  private readonly playerId?: string;
  private readonly api?: MusicAssistantApi;

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

  async initialize(): Promise<void> {
    try {
      await this.api?.connect();
      logger.debug(`[MA-Playback][${this.zoneName}] Initialized`);
    } catch (err) {
      logger.warn(`[MA-Playback][${this.zoneName}] Failed to connect: ${String(err)}`);
    }
  }

  async handlePlayCommand(cmd: ContentPlayCommand): Promise<void> {
    const p = `[MA-Playback][${this.zoneName}]`;

    if (!this.api || !this.playerId) {
      logger.warn(`${p} No API or playerId`);
      return;
    }

    try {
      switch (cmd.type) {
        case 'announce':
          logger.debug(`${p} Announce → ${cmd.item}`);
          await this.api.playAnnouncement(this.playerId, { url: cmd.item });
          logger.info(`${p} Announced ${cmd.item}`);
          return;

        case 'queue_seek':
          logger.debug(`${p} Queue seek → uid=${cmd.item}`);
          await this.api.playQueueIndex(this.playerId, { index: cmd.item });
          logger.info(`${p} Queue-seek ok → ${cmd.item}`);
          return;

        case 'alert':
          logger.debug(`${p} Alert → ${cmd.item}`);
          await this.api.playMedia(this.playerId, cmd.item, {
            option: 'replace',
            shuffle: false,
            radio_mode: false,
          });
          logger.info(`${p} Alert played`);
          return;

        default:
          logger.debug(`${p} Playback → ${cmd.type}, uri=${cmd.item}, start=${cmd.start_item ?? '-'}, shuffle=${!!cmd.shuffle}`);

          await this.api.playMedia(this.playerId, cmd.item, {
            option: 'replace',
            radio_mode: false,
            shuffle: !!cmd.shuffle,
            start_item: cmd.start_item,
          });

          logger.info(`${p} Started ${cmd.type} → ${cmd.item}${cmd.start_item ? ` (start=${cmd.start_item})` : ''}`);
          return;
      }
    } catch (err) {
      logger.warn(`${p} Command ${cmd.type} failed: ${String(err)}`);
    }
  }

  async dispose(): Promise<void> {
    this.api?.release();
    logger.debug(`[MA-Playback][${this.zoneName}] Disposed`);
  }
}