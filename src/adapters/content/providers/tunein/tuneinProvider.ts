import { createLogger } from '@/shared/logging/logger';
import type { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';
import type {
  ContentFolder,
  ContentFolderItem,
  RadioMenuEntry,
  RadioStation,
} from '@/ports/ContentTypes';
import { TuneInClient } from '@/adapters/content/providers/tunein/tuneinClient';

const DEFAULT_ICON =
  'https://extended-app-content.s3.eu-central-1.amazonaws.com/audioZone/services/Icon-TuneIn.svg';

const DEMO_STATIONS: RadioStation[] = [
  {
    id: 'tunein_s6707',
    name: 'BBC Radio 1',
    stream: 'http://stream.live.vc.bbcmedia.co.uk/bbc_radio_one',
    coverurl: DEFAULT_ICON,
  },
  {
    id: 'tunein_s2475',
    name: 'NPO Radio 2',
    stream: 'http://icecast.omroep.nl/radio2-bb-mp3',
    coverurl: DEFAULT_ICON,
  },
  {
    id: 'tunein_s129237',
    name: 'KEXP 90.3 FM',
    stream: 'http://live-mp3-128.kexp.org/kexp128.mp3',
    coverurl: DEFAULT_ICON,
  },
];

const log = createLogger('Content', 'TuneIn');

export interface TuneInProviderOptions {
  username?: string;
}

/**
 * Unified provider that exposes TuneIn favourites under the `local` entry
 * and keeps the legacy `custom` list for manually defined streams.
 */
export class TuneInProvider {
  private readonly username?: string;
  private readonly api = new TuneInClient();
  private readonly searchCache = new Map<string, { station: RadioStation; seenAt: number }>();
  private readonly searchCacheTtlMs = 30 * 60 * 1000;
  private readonly searchCacheMaxSize = 200;
  private readonly customRadioStore: CustomRadioStore;

  constructor(customRadioStore: CustomRadioStore, options: TuneInProviderOptions = {}) {
    this.customRadioStore = customRadioStore;
    this.username = options.username?.trim();
  }

  /**
   * Resolve a station by its stream URL (checks custom + local presets).
   */
  public async resolveStationByStream(streamUrl: string): Promise<RadioStation | null> {
    const normalized = this.normalizeStreamUrl(streamUrl);
    if (!normalized) return null;
    const cached = this.searchCache.get(normalized);
    if (cached) {
      if (Date.now() - cached.seenAt <= this.searchCacheTtlMs) {
        return cached.station;
      }
      this.searchCache.delete(normalized);
    }
    const stations = [
      ...(await this.getCustomStations()),
      ...(await this.getLocalStations()),
    ];
    const match = stations.find(
      (s) => this.normalizeStreamUrl(s.stream) === normalized,
    );
    return match ?? null;
  }

  public async getMenuEntries(): Promise<RadioMenuEntry[]> {
    return [
      {
        cmd: 'local',
        icon: DEFAULT_ICON,
        name: 'TuneIn Presets',
        root: 'start',
      },
      {
        cmd: 'custom',
        icon: DEFAULT_ICON,
        name: 'Custom Streams',
        root: 'start',
        editable: true,
      },
    ];
  }

  public async getFolder(
    service: string,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    if (folderId !== 'start') {
      return null;
    }

    const stations =
      service === 'custom' ? await this.getCustomStations() : await this.getLocalStations();
    const items = this.mapStationsToItems(stations, offset, limit);

    return {
      id: folderId,
      name: service === 'custom' ? 'Custom Radio' : 'TuneIn Presets',
      start: offset,
      totalitems: stations.length,
      items,
    };
  }

  public async search(
    query: string,
    limits: { station?: number; custom?: number } = {},
  ): Promise<{ station: ContentFolderItem[]; custom: ContentFolderItem[] }> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return { station: [], custom: [] };
    }
    const stationLimit = limits.station ?? 50;
    const customLimit = limits.custom ?? 50;

    let outlines: unknown[] = [];
    try {
      outlines = await this.api.search(normalizedQuery, this.username);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('tunein search failed', { message, query: normalizedQuery });
    }

    const stations = await this.mapTuneInItems(outlines);
    this.cacheStations(stations);
    const stationItems = stations
      .slice(0, stationLimit)
      .map<ContentFolderItem>((station) => this.toSearchItem(station));

    const customStations = await this.getCustomStations();
    this.cacheStations(customStations);
    const filteredCustom = customStations.filter((s) =>
      s.name.toLowerCase().includes(normalizedQuery.toLowerCase()),
    );
    const customItems = filteredCustom
      .slice(0, customLimit)
      .map<ContentFolderItem>((station) => this.toSearchItem(station));

    return { station: stationItems, custom: customItems };
  }

  private async getLocalStations(): Promise<RadioStation[]> {
    if (!this.username) {
      return DEMO_STATIONS;
    }

    try {
      const outlines = await this.api.browsePresets(this.username);
      const stations = await this.mapTuneInItems(outlines);
      return stations.length ? stations : DEMO_STATIONS;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('failed to load TuneIn presets', { message });
      return DEMO_STATIONS;
    }
  }

  private async getCustomStations(): Promise<RadioStation[]> {
    const entries = await this.customRadioStore.list();
    return entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      stream: entry.stream,
      coverurl: entry.coverurl ?? DEFAULT_ICON,
    }));
  }

  private async mapTuneInItems(outlines: unknown[]): Promise<RadioStation[]> {
    const tasks = outlines.map(async (raw): Promise<RadioStation | null> => {
      const item = raw as {
        type?: string;
        preset_id?: string;
        guide_id?: string;
        URL?: string;
        text?: string;
        image?: string;
        playing_image?: string;
        key?: string;
      };

      if (!item || item.type !== 'audio' || item.key === 'unavailable') {
        return null;
      }

      const id = item.preset_id ?? item.guide_id;
      if (!id) {
        return null;
      }

      const stream = await this.resolveStreamUrl(id, item.URL);
      if (!stream) {
        return null;
      }

      let coverurl = item.image ?? item.playing_image;
      if (coverurl) {
        coverurl = coverurl.replace(/q(?=\.[^.]*$)/, 'd'); // replaces `q` char before file extension to `d` to get 300x300 pixel squared cover
      } else {
        coverurl = DEFAULT_ICON;
      }

      let name = item.text;
      if (name) {
        name = name.replace(/^(?:\d+\.\d+ \| )?(.+?)(?: \([^)]+\))?$/, '$1'); // removes frequency and genre if present in name
      } else {
        name = 'Unknown station';
      }

      return {
        id,
        name,
        stream,
        coverurl,
      } satisfies RadioStation;
    });

    const resolved = await Promise.all(tasks);
    return resolved.filter((station): station is RadioStation => Boolean(station));
  }

  private async resolveStreamUrl(id: string, fallback?: string): Promise<string | null> {
    try {
      const outlines = await this.api.tune(id);
      const match = outlines.find((entry) => entry && typeof (entry as any).url === 'string') as
        | { url?: string }
        | undefined;
      return match?.url ?? fallback ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.debug('tunein tune failed', { id, message });
      return fallback ?? null;
    }
  }

  private normalizeStreamUrl(streamUrl: string | undefined): string {
    const raw = streamUrl?.trim().toLowerCase();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      url.hash = '';
      url.search = '';
      const normalized = url.toString().replace(/\/$/, '');
      return normalized;
    } catch {
      return raw.replace(/\/$/, '');
    }
  }

  private cacheStations(stations: RadioStation[]): void {
    if (!stations.length) return;
    const now = Date.now();
    for (const station of stations) {
      const key = this.normalizeStreamUrl(station.stream);
      if (!key) continue;
      this.searchCache.set(key, { station, seenAt: now });
    }
    if (this.searchCache.size <= this.searchCacheMaxSize) {
      return;
    }
    let oldestKey: string | null = null;
    let oldestSeenAt = Number.POSITIVE_INFINITY;
    for (const [key, value] of this.searchCache.entries()) {
      if (value.seenAt < oldestSeenAt) {
        oldestSeenAt = value.seenAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.searchCache.delete(oldestKey);
    }
  }

  private mapStationsToItems(
    stations: RadioStation[],
    offset: number,
    limit: number,
  ): ContentFolderItem[] {
    return stations.slice(offset, offset + limit).map<ContentFolderItem>((station) => ({
      id: station.id,
      name: station.name,
      title: station.name,
      type: 2,
      audiopath: station.stream,
      coverurl: station.coverurl ?? DEFAULT_ICON,
      items: 0,
    }));
  }

  private toSearchItem(station: RadioStation): ContentFolderItem {
    const cover = station.coverurl ?? DEFAULT_ICON;
    return {
      id: station.id,
      name: station.name,
      title: station.name,
      audiopath: station.stream,
      coverurl: cover,
      thumbnail: cover,
      type: 2,
      tag: 'radio',
      provider: 'tunein',
      items: 0,
      // Keep a "station" field similar to legacy payloads so clients can show the stream URL.
      ...(station.stream ? { station: station.stream } : {}),
      contentType: 'audio/mpeg',
    } as ContentFolderItem;
  }
}
