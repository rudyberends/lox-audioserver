/**
 * zoneCommandRouter.ts
 * --------------------
 * Minimal, unified router for ZoneRuntime.
 */

import logger from '@/utils/troxorLogger';
import { fadeController } from './fadeController';
import { zoneStateStore } from '../zoneStateStore';
import { parseLoxoneCommand } from './loxoneCommandParser';
import type { ZoneEntry } from '../types/zoneEntry';
import { convertToAbsoluteVolume } from './volumeUtils';
import { ContentPlayCommand } from '@/core/types/contentPlaybackTypes';
import { buildAudiopath } from '@/core/loxone/mediaMapping';

/** Detect fade objects */
function extractFade(param: unknown) {
  if (Array.isArray(param)) {
    const last = param.at(-1);
    return last && typeof last === 'object' && 'fade' in last ? last : undefined;
  }
  return param && typeof param === 'object' && 'fade' in (param as any) ? param : undefined;
}

export class ZoneCommandRouter {
  public async handle(zone: ZoneEntry, command: string, param?: unknown): Promise<void> {
    const name = zone.name;
    const normalized = command.toLowerCase();

    logger.debug(`[ZoneRuntime][${name}] → ${command} ${JSON.stringify(param ?? '')}`);

    // Fade (non-blocking)
    const fade = extractFade(param);
    if (fade?.fade) {
      void fadeController.fadeIn(zone.id, Number(fade.fadeDurationMs ?? 60000));
    }

    // Volume with relative/absolute logic
    if (normalized === 'volume') {
      const state = zoneStateStore.get(zone.id);
      const currentVolume = state.volume ?? 25;
      const abs = convertToAbsoluteVolume(param, currentVolume);
      await zone.commandMapper?.handle('volume', abs);
      return;
    }

    // Unified content command
    if (normalized === 'contentplay') {
      await this.handleContent(zone, param);
      return;
    }

    // All other commands → delegate to commandMapper
    await zone.commandMapper?.handle(command, param);
  }

  private async handleContent(zone: ZoneEntry, param?: unknown): Promise<void> {
    const name = zone.name;

    if (!zone.contentMapper) {
      logger.warn(`[ZoneRuntime][${name}] No content mapper.`);
      return;
    }

    // 1 — Direct ANNOUNCE : { url: "..." }
    if (param && typeof param === 'object' && 'url' in (param as any)) {
      const url = String((param as any).url);

      await zone.contentMapper.handlePlayCommand({
        zoneId: zone.id,
        item: url,
        type: 'announce',
        shuffle: false,
      });

      return;
    }

    // 2 — Parse contentplay payload
    const { item, shuffle, startItem } = parseLoxoneCommand(param);

    // 3 — Queue skip detection
    if (item) {
      const state = zoneStateStore.getZoneState(zone.id);
      const target = buildAudiopath(item, 'track', 'spotify');
      const hit = state?.queue?.items?.find((i) => i.audiopath === target);

      if (hit) {
        logger.info(`[ZoneRuntime][${name}] → queue_seek (uid=${hit.unique_id})`);

        await zone.contentMapper.handlePlayCommand({
          zoneId: zone.id,
          item: hit.unique_id,
          type: 'queue_seek',
          shuffle: false,
        });
        return;
      }
    }

    // 4 — Default contentplay
    const cmd: ContentPlayCommand = {
      zoneId: zone.id,
      item,
      type: 'contentplay',
      shuffle,
    };

    if (startItem) {
      cmd.start_item = startItem;
    }

    await zone.contentMapper.handlePlayCommand(cmd);
  }
}