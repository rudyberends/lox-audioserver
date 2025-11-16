/**
 * zoneCommandRouter.ts
 * --------------------
 * A small, testable command router for ZoneRuntime.
 *
 * Responsibilities
 * - Centralize command logging and normalization (fade, volume payloads)
 * - Detect and handle "content" commands
 * - Keep ZoneRuntime slim and focused on lifecycle/config concerns
 */

import logger from '@/utils/troxorLogger';
import { fadeController } from './fadeController';
import { zoneStateStore } from '../zoneStateStore';
import { parseLoxoneCommand, CONTENT_COMMANDS, type ContentCommandType } from './loxoneCommandParser';
import type { ZoneEntry } from '../types/zoneEntry';
import { ContentPlayCommand } from '@/core/types/contentPlaybackTypes';
import { convertToAbsoluteVolume } from './volumeUtils';

function isContentCommand(command: string): command is ContentCommandType {
  const normalized = command.toLowerCase();
  return CONTENT_COMMANDS.some((c) => normalized.includes(c));
}

interface FadeInfo {
  readonly fade: boolean;
  readonly fadeDurationMs?: number;
}

/** Narrow possible fade payloads from arbitrary param objects. */
function extractFadeInfo(param: unknown): FadeInfo | undefined {
  if (Array.isArray(param)) {
    const last = param.at(-1);
    if (last && typeof last === 'object' && last !== null && 'fade' in last) {
      const f = (last as Record<string, unknown>);
      return { fade: Boolean(f.fade), fadeDurationMs: Number(f.fadeDurationMs ?? 0) || undefined };
    }
    return undefined;
  }
  if (param && typeof param === 'object' && 'fade' in (param as Record<string, unknown>)) {
    const f = param as Record<string, unknown>;
    return { fade: Boolean(f.fade), fadeDurationMs: Number(f.fadeDurationMs ?? 0) || undefined };
  }
  return undefined;
}

export class ZoneCommandRouter {
  /**
   * Route a zone command to either the content mapper or the regular command mapper.
   * Keeps ZoneRuntime lightweight and testable.
   */
  public async handle(zone: ZoneEntry, command: string, param?: unknown): Promise<void> {
    const zoneName = zone.name;
    const normalized = command.toLowerCase();

    logger.info(`[ZoneRuntime][${zoneName}] → ${command} ${JSON.stringify(param ?? '')}`);

    // Optional fade (does not block playback)
    const fade = extractFadeInfo(param);
    if (fade?.fade) {
      void fadeController.fadeIn(zone.id, fade.fadeDurationMs ?? 60_000);
    }

    if (normalized === 'volume') {
      const state = zoneStateStore.get(zone.id);
      const currentVolume = state.volume ?? 25;
      const absolute = convertToAbsoluteVolume(param, currentVolume);

      const handled = await zone.commandMapper?.handle('volume', absolute);
      if (!handled) {
        logger.debug(`[ZoneRuntime][${zoneName}] Command not handled by mapper.`);
      }
      return;
    }

    // Content commands → content mapper
    if (isContentCommand(normalized)) {
      await this.handleContent(zone, normalized, param);
      return;
    }

    // Regular mapper command
    const handled = await zone.commandMapper?.handle(command, param);
    if (!handled) {
      logger.debug(`[ZoneRuntime][${zoneName}] Command not handled by mapper.`);
    }
  }

  private async handleContent(
    zone: ZoneEntry,
    type: ContentCommandType,
    param?: unknown,
  ): Promise<void> {
    const zoneName = zone.name;

    if (!zone.contentMapper) {
      logger.warn(`[ZoneRuntime][${zoneName}] No content mapper for content command.`);
      return;
    }

    // Direct payloads (alerts or static serviceplay)
    if (param && typeof param === 'object') {
      const obj = param as Record<string, unknown>;

      // Announce case
      if ('url' in obj) {
        const url = String(obj.url);
        logger.info(`[ZoneRuntime][${zoneName}] ▶ direct url="${url}", type=${type}`);
        const cmd: ContentPlayCommand = {
          zoneId: zone.id,
          item: url,
          shuffle: false,
          type: 'announce',
        };
        await zone.contentMapper.handlePlayCommand(cmd);
        return;
      }

      // Serviceplay or playlistplay case (from alerts or direct)
      if ('audiopath' in obj) {
        const url = String(obj.audiopath);
        logger.info(`[ZoneRuntime][${zoneName}] ▶ direct audiopath="${url}", type=${type}`);
        const mappedType =
      type === 'serviceplay'
        ? 'service'
        : type === 'playlistplay'
          ? 'playlist'
          : (type as ContentPlayCommand['type']);
        const cmd: ContentPlayCommand = {
          zoneId: zone.id,
          item: url,
          shuffle: false,
          type: mappedType,
        };
        await zone.contentMapper.handlePlayCommand(cmd);
        return;
      }
    }

    // default behaviour
    const { item, startItem, shuffle } = parseLoxoneCommand(param);
    logger.info(
      `[ZoneRuntime][${zoneName}] ▶ item="${item}"${startItem ? `, start_item="${startItem}"` : ''}, shuffle=${shuffle}, type=${type}`,
    );

    const cmd: ContentPlayCommand = {
      zoneId: zone.id,
      item,
      start_item: startItem,
      shuffle,
      type: type as Exclude<ContentPlayCommand['type'], 'alert'>,
    };

    await zone.contentMapper.handlePlayCommand(cmd);

    logger.info(
      `[ZoneRuntime][${zoneName}] Content command "${type}" handled (item=${item}, shuffle=${shuffle}, type=${type})`,
    );
  }
}