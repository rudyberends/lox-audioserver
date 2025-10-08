import {
  logError,
} from './utils';
import {
  mapRadioToFolderItem,
} from './mappers';
import { RadioEntry, RadioFolderItem, RadioFolderResponse } from '../types';
import MusicAssistantProviderClient from './client';

const DEFAULT_RADIO_LIMIT = 200;
const LOCAL_SERVICE_CMD = 'local';
const CUSTOM_SERVICE_CMD = 'custom';

export class RadioController {
  private cache: RadioFolderItem[] = [];
  private cacheTimestamp = 0;

  constructor(
    private readonly getClient: () => MusicAssistantProviderClient | undefined,
    private readonly fallbackProvider: string,
    private readonly cacheTtlMs: number,
    private readonly providerLabel: string,
  ) {}

  async getRadios(): Promise<RadioEntry[]> {
    const items = await this.loadRadioItems();
    const fallbackIcon =
      items.find((item) => item.coverurl)?.coverurl ?? '';

    const radios: RadioEntry[] = [
      {
        cmd: LOCAL_SERVICE_CMD,
        name: `${this.providerLabel} Radio`,
        icon: fallbackIcon,
        root: 'start',
      },
    ];

    radios.push({
      cmd: CUSTOM_SERVICE_CMD,
      name: `${this.providerLabel} Custom Radios`,
      icon: fallbackIcon,
      root: 'start',
    });

    return radios;
  }

  async getServiceFolder(
    service: string,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<RadioFolderResponse> {
    const normalizedService = this.normalizeService(service);
    const items =
      normalizedService === CUSTOM_SERVICE_CMD
        ? []
        : await this.loadRadioItems();
    const sliced =
      normalizedService === CUSTOM_SERVICE_CMD
        ? []
        : items.slice(offset, offset + limit);

    return {
      id: folderId,
      name: '/',
      service,
      totalitems: items.length,
      start: offset,
      items: sliced,
    };
  }

  async resolveStation(stationId: string): Promise<RadioFolderItem | undefined> {
    const items = await this.loadRadioItems();
    return items.find(
      (item) =>
        item.id === stationId ||
        item.station === stationId ||
        item.audiopath === stationId,
    );
  }

  private normalizeService(service: string): string {
    if (!service) {
      return this.fallbackProvider;
    }
    if (service === this.fallbackProvider) {
      return LOCAL_SERVICE_CMD;
    }
    return service;
  }

  private async loadRadioItems(): Promise<RadioFolderItem[]> {
    const client = this.getClient();
    if (!client) {
      return [];
    }

    const now = Date.now();
    if (this.cache.length && now - this.cacheTimestamp < this.cacheTtlMs) {
      return this.cache;
    }

    try {
      const radios = await client.rpc<any[]>('music/radios/library_items', {
        offset: 0,
        limit: DEFAULT_RADIO_LIMIT,
      });

      const mapped = Array.isArray(radios)
        ? radios
            .map((radio) => mapRadioToFolderItem(radio, this.fallbackProvider))
            .filter((item): item is RadioFolderItem => Boolean(item?.audiopath))
        : [];

      this.cache = mapped;
      this.cacheTimestamp = now;
      return mapped;
    } catch (error) {
      logError('music/radios/library_items', error);
      return this.cache;
    }
  }
}

export default RadioController;
