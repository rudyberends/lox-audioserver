import { v4 as uuidv4 } from 'uuid';
import logger from '../../../utils/troxorlogger';
import { broadcastEvent } from '../../../http/broadcastEvent';
import {
  mapAlbumToFolderItem,
  mapArtistToFolderItem,
  mapTrackToMediaItem,
  mapPlaylistToItem,
} from '../musicAssistant/mappers';
import { MusicAssistantProviderClient } from './client';
import { MediaFolderItem, PlaylistItem } from '../types';

/**
 * Handles global search operations for the Music Assistant integration.
 * Matches the native _audioCfgGlobalSearch structure exactly (no radio, no result object).
 */
export class SearchController {
  constructor(
    private readonly getClient: () => MusicAssistantProviderClient | undefined,
  ) {}

  async globalSearch(source: string, query: string): Promise<any> {
    const unique = uuidv4();

    // Initial broadcast (unique + command)
    broadcastEvent(
      JSON.stringify({
        globalsearch_result: { unique },
        command: `audio/cfg/globalsearch/${source}/${query}`,
      }),
    );

    logger.debug(
      `[audioCfgGlobalSearch] provider=MusicAssistantProvider source=${source} query="${query}"`,
    );

    const client = this.getClient();
    if (!client) {
      logger.warn('[SearchController] No active Music Assistant client available.');
      return {
        globalsearch_result: { error: 1 },
        type: source,
        unique,
      };
    }

    if (!query?.trim()) {
      logger.debug('[SearchController] Empty search query provided.');
      return {
        globalsearch_result: { error: 1 },
        type: source,
        unique,
      };
    }

    try {
      // Perform the search
      const result = await client.rpc('music/search', {
        search_query: query,
        limit: 25,
      });

      const raw = result?.result ?? result ?? {};
      const mapped: Record<string, any> = {};
      const fallbackProvider = 'music_assistant';

      for (const [category, section] of Object.entries(raw)) {
        if (!section) continue;

        const items: any[] = Array.isArray(section)
          ? section
          : Array.isArray((section as any).items)
            ? (section as any).items
            : [];
        if (items.length === 0) continue;

        const caption =
          (Array.isArray(section) ? undefined : (section as any).caption) ??
          category.charAt(0).toUpperCase() + category.slice(1);
        const totalitems =
          (Array.isArray(section) ? undefined : (section as any).totalitems) ??
          items.length;
        const link = (section as any).link ?? undefined;

        let mappedItems: Array<MediaFolderItem | PlaylistItem> = [];

        switch (category) {
          case 'albums':
            mappedItems = items.map((a) => mapAlbumToFolderItem(a, fallbackProvider));
            break;
          case 'artists':
            mappedItems = items.map((a) => mapArtistToFolderItem(a, fallbackProvider));
            break;
          case 'tracks':
            mappedItems = items.map((t) => mapTrackToMediaItem(t, fallbackProvider));
            break;
          case 'playlists':
            mappedItems = items.map((p) => mapPlaylistToItem(p, fallbackProvider));
            break;
          default:
            // Ignore any non-standard categories (like "radio")
            continue;
        }

        mapped[category] = {
          caption,
          totalitems,
          link,
          items: mappedItems,
        };
      }

      logger.debug(
        `[SearchController] Search "${query}" complete — ${Object.keys(mapped).length} categories.`,
      );

      // Final broadcast — matches original local _audioCfgGlobalSearch
      broadcastEvent(
        JSON.stringify({
          globalsearch_result: {
            error: 0,
            ...mapped,
          },
          type: source,
          unique,
        }),
      );

      return {};
    } catch (error) {
      logger.warn(
        `[SearchController] globalSearch failed for "${query}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return {
        globalsearch_result: { error: 1 },
        type: source,
        unique,
      };
    }
  }
}

export default SearchController;