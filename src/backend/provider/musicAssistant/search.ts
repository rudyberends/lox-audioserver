import { v4 as uuidv4 } from 'uuid';
import logger from '../../../utils/troxorlogger';
import { broadcastEvent } from '../../../http/broadcastEvent';
import {
  mapAlbumToFolderItem,
  mapArtistToFolderItem,
  mapTrackToMediaItem,
  mapPlaylistToItem,
  mapRadioToFolderItem,
} from '../musicAssistant/mappers';
import { MusicAssistantProviderClient } from './client';
import { MediaFolderItem, PlaylistItem, RadioFolderItem } from '../types';
import { FileType } from '../../zone/loxoneTypes';

/**
 * Handles global search operations for the Music Assistant integration.
 * Matches the native _audioCfgGlobalSearch structure exactly (no radio, no result object).
 */
export class SearchController {
  constructor(
    private readonly getClient: () => MusicAssistantProviderClient | undefined,
  ) { }

  async globalSearch(source: string, query: string): Promise<any> {
    const unique = uuidv4();
    const sourceType = this.getSourceType(source);

    const trimmedQuery = query.trim();

    // Initial broadcast (unique + command)
    broadcastEvent(
      JSON.stringify({
        globalsearch_result: { unique },
        command: `audio/cfg/globalsearch/${source}/${encodeURIComponent(trimmedQuery)}`,
        type: sourceType,
      }),
    );

    logger.debug(
      `[audioCfgGlobalSearch] provider=MusicAssistantProvider source=${source} query="${trimmedQuery}"`,
    );

    const client = this.getClient();
    if (!client) {
      logger.warn('[SearchController] No active Music Assistant client available.');
      return {
        globalsearch_result: { error: 1 },
        type: sourceType,
        unique,
      };
    }

    if (!trimmedQuery) {
      logger.debug('[SearchController] Empty search query provided.');
      return {
        globalsearch_result: { error: 1 },
        type: sourceType,
        unique,
      };
    }

    try {
      const { mediaTypes, limit } = this.deriveSearchOptions(source);

      const searchPayload: Record<string, unknown> = {
        search_query: trimmedQuery,
        limit,
      };
      if (mediaTypes.length > 0 && mediaTypes.every((type) => type === 'radio')) {
        searchPayload.media_types = mediaTypes;
      }

      // Perform the search
      const result = await client.rpc('music/search', searchPayload);

      const raw = result?.result ?? result ?? {};
      const mapped: Record<string, any> = {};
      const fallbackProvider = 'musicassistant';

      for (const [category, section] of Object.entries(raw)) {
        if (!section) continue;

        const items: any[] = Array.isArray(section)
          ? section
          : Array.isArray((section as any).items)
            ? (section as any).items
            : [];
        const targetCategory = this.resolveCategoryKey(sourceType, category);
        if (!targetCategory) continue;

        const includeEmptyCategory = this.shouldIncludeEmptyCategory(sourceType, targetCategory, section);
        if (!includeEmptyCategory && items.length === 0) continue;

        const caption =
          (Array.isArray(section) ? undefined : (section as any).caption) ??
          targetCategory.charAt(0).toUpperCase() + targetCategory.slice(1);
        const totalitems =
          (Array.isArray(section) ? undefined : (section as any).totalitems) ??
          items.length;
        const link = (section as any).link ?? undefined;

        let mappedItems: Array<MediaFolderItem | PlaylistItem | RadioFolderItem> = [];

        switch (targetCategory) {
          case 'albums':
            mappedItems = items.map((a) => mapAlbumToFolderItem(a, fallbackProvider));
            break;
          case 'artists':
            mappedItems = items.map((a) => mapArtistToFolderItem(a, fallbackProvider));
            break;
          case 'tracks':
            mappedItems = items.map((t) => mapTrackToMediaItem(t, fallbackProvider, fallbackProvider));
            break;
          case 'playlists':
            mappedItems = items.map((p) => mapPlaylistToItem(p, fallbackProvider));
            break;
          case 'radio':
          case 'station':
          case 'custom':
            mappedItems = items
              .map((r) => this.mapRadioSearchItem(r, fallbackProvider))
              .filter((r): r is RadioFolderItem => Boolean(r));
            break;
          default:
            continue;
        }

        mapped[targetCategory] = {
          caption,
          totalitems,
          link,
          items: mappedItems,
        };
      }

      logger.debug(
        `[SearchController] Search "${query}" complete — ${Object.keys(mapped).length} categories.`,
      );

      broadcastEvent(
        JSON.stringify({
          globalsearch_result: {
            error: 0,
            ...mapped,
          },
          type: sourceType,
          unique,
        }),
      );

      return {};
    } catch (error) {
      logger.warn(
        `[SearchController] globalSearch failed for "${query}": ${error instanceof Error ? error.message : String(error)
        }`,
      );

      return {
        globalsearch_result: { error: 1 },
        type: sourceType,
        unique,
      };
    }
  }

  /**
 * Derive the client-recognized source identifier from the incoming scope string.
 */
  private getSourceType(source: string): string {
    const firstScope = source.split('|')[0] ?? source;
    const scopeWithoutCategories = firstScope.split(':')[0] ?? firstScope;
    const providerId = scopeWithoutCategories.split('@')[0] ?? scopeWithoutCategories;
    return providerId.trim().toLowerCase() || 'local';
  }

  private deriveSearchOptions(source: string): { mediaTypes: string[]; limit: number } {
    const DEFAULT_LIMIT = 25;
    const firstScope = source.split('|')[0] ?? source;
    const [, categorySegment = ''] = firstScope.split(':', 2);
    const categories = categorySegment
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    const limits: number[] = [];
    const mediaTypeSet = new Set<string>();

    for (const categoryDef of categories) {
      const [rawCategory, rawLimit] = categoryDef.split('#', 2);
      const category = rawCategory.trim().toLowerCase();

      if (rawLimit) {
        const parsed = Number.parseInt(rawLimit, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          limits.push(parsed);
        }
      }

      switch (category.replace(/s$/, '')) {
        case 'track':
          mediaTypeSet.add('tracks');
          break;
        case 'album':
          mediaTypeSet.add('albums');
          break;
        case 'artist':
          mediaTypeSet.add('artists');
          break;
        case 'playlist':
          mediaTypeSet.add('playlists');
          break;
        case 'radio':
        case 'station':
        case 'custom':
          mediaTypeSet.add('radio');
          break;
        default:
          break;
      }
    }

    if (mediaTypeSet.size === 0) {
      const scopeType = this.getSourceType(source);
      if (scopeType === 'tunein') {
        mediaTypeSet.add('radio');
      } else {
        mediaTypeSet.add('tracks');
        mediaTypeSet.add('albums');
        mediaTypeSet.add('artists');
        mediaTypeSet.add('playlists');
      }
    }

    const limit = limits.length > 0 ? Math.max(...limits) : DEFAULT_LIMIT;
    return { mediaTypes: Array.from(mediaTypeSet), limit };
  }

  private shouldIncludeEmptyCategory(sourceType: string, category: string, section: any): boolean {
    if (sourceType !== 'tunein') return false;
    if (category === 'custom') return true;
    if (category === 'station') {
      const total =
        Array.isArray(section) || section === undefined
          ? undefined
          : Number((section as any).totalitems);
      if (Number.isFinite(total) && (total as number) > 0) {
        return true;
      }
      const link =
        Array.isArray(section) || section === undefined
          ? undefined
          : (section as any).link;
      return typeof link === 'string' && link.trim().length > 0;
    }
    return false;
  }

  private mapRadioSearchItem(raw: any, fallbackProvider: string): RadioFolderItem | undefined {
    const base = mapRadioToFolderItem(raw, fallbackProvider);
    if (!base) return undefined;

    const providerValue =
      (typeof raw?.provider === 'string' && raw.provider.trim()) ?
        raw.provider.trim() :
        base.provider ?? fallbackProvider;
    const normalizedProvider = providerValue?.toLowerCase();

    const audiopath = this.normalizeRadioAudiopath(raw, base.audiopath, normalizedProvider);
    const id = this.normalizeRadioId(raw, base.id, audiopath, normalizedProvider);
    const stationName =
      (typeof raw?.name === 'string' && raw.name.trim()) ? raw.name.trim() :
      (typeof raw?.station === 'string' && raw.station.trim()) ? raw.station.trim() :
      base.name ?? base.station;
    const finalAudiopath = audiopath ?? base.audiopath;
    const finalId = id ?? finalAudiopath ?? base.id;

    const providerFinal =
      normalizedProvider ??
      (finalAudiopath?.startsWith('tunein:') ? 'tunein' : undefined) ??
      (finalAudiopath?.startsWith('library:') ? 'library' : undefined) ??
      providerValue;

    return {
      ...base,
      id: finalId ?? base.id,
      name: stationName ?? base.name,
      station: stationName ?? base.station,
      audiopath: finalAudiopath,
      artist: '',
      album: '',
      tag: 'none',
      type: FileType.File,
      sort: base.sort ?? 'alpha',
      provider: providerFinal,
    };
  }

  private normalizeRadioAudiopath(raw: any, fallback: string | undefined, provider?: string): string | undefined {
    const candidates: Array<string | undefined> = [
      typeof raw?.audiopath === 'string' ? raw.audiopath : undefined,
      typeof raw?.audio_path === 'string' ? raw.audio_path : undefined,
      typeof raw?.uri === 'string' ? raw.uri : undefined,
      typeof raw?.url === 'string' ? raw.url : undefined,
      typeof raw?.station === 'string' ? raw.station : undefined,
      typeof raw?.id === 'string' ? raw.id : undefined,
      fallback,
    ];

    for (const candidate of candidates) {
      const formatted = this.formatRadioIdentifier(candidate, provider);
      if (formatted) {
        return formatted;
      }
    }
    return fallback;
  }

  private normalizeRadioId(raw: any, fallbackId: string | undefined, audiopath: string | undefined, provider?: string): string | undefined {
    const candidates: Array<string | undefined> = [
      typeof raw?.id === 'string' ? raw.id : undefined,
      typeof raw?.item_id === 'string' ? raw.item_id : undefined,
      typeof raw?.station === 'string' ? raw.station : undefined,
      audiopath,
      fallbackId,
    ];

    for (const candidate of candidates) {
      const formatted = this.formatRadioIdentifier(candidate, provider);
      if (formatted) {
        return formatted;
      }
    }
    return fallbackId;
  }

  private formatRadioIdentifier(candidate: string | undefined, provider?: string): string | undefined {
    if (!candidate) return undefined;
    const value = candidate.trim();
    if (!value) return undefined;

    const lowerProvider = provider?.toLowerCase();

    if (/^tunein:station:/i.test(value)) {
      return `tunein:station:${value.slice('tunein:station:'.length)}`;
    }

    if (/^tunein:\/\/radio\//i.test(value) || /^radio:tunein:/i.test(value) || lowerProvider === 'tunein') {
      const stationId = this.extractTuneInStationId(value);
      if (stationId) {
        return `tunein:station:${stationId}`;
      }
    }

    const radioKeyMatch = value.match(/^radio:([a-z0-9_]+):(.+)$/i);
    if (radioKeyMatch) {
      const [, radioProvider, idPart] = radioKeyMatch;
      const normalizedProvider = radioProvider.toLowerCase();
      if (normalizedProvider === 'tunein') {
        return `tunein:station:${idPart}`;
      }
      if (normalizedProvider === 'library') {
        return `library:radio:${idPart}`;
      }
      return `${normalizedProvider}:${idPart}`;
    }

    if (/^library:radio:/i.test(value)) {
      return value;
    }

    if (/^library:\/\/radio\//i.test(value)) {
      const idPart = value.split('/').pop();
      if (idPart) {
        return `library:radio:${idPart}`;
      }
    }

    if (value.includes('://')) {
      return value;
    }

    return value;
  }

  private extractTuneInStationId(value: string): string | undefined {
    const match = value.match(/s\d+/i);
    return match ? match[0].toLowerCase() : undefined;
  }

  private resolveCategoryKey(sourceType: string, rawCategory: string): string | undefined {
    const category = rawCategory.trim().toLowerCase();

    if (sourceType === 'tunein') {
      if (category === 'radio' || category === 'stations' || category === 'station') {
        return 'station';
      }
      if (category === 'custom' || category === 'customs') {
        return 'custom';
      }
      if (category === 'topresults') {
        return 'topresults';
      }
      return category;
    }

    if (category === 'radio' || category === 'station' || category === 'custom') {
      return undefined;
    }

    return category;
  }
}

export default SearchController;
