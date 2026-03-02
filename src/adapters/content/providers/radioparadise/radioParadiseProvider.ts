import type { ContentFolder, ContentFolderItem, RadioMenuEntry } from '@/ports/ContentTypes';
import { FileType } from '@/domain/loxone/enums';
import {
  RADIO_PARADISE_ICON_BASE_URL,
  RADIO_PARADISE_STATIONS,
  buildRadioParadiseIconUrl,
} from '@/adapters/content/providers/radioparadise/radioParadiseConstants';

const PROVIDER_ID = 'radioparadise';

type RadioParadiseProviderOptions = {
  iconBaseUrl?: string;
};

export class RadioParadiseProvider {
  private readonly iconBaseUrl: string;

  constructor(options: RadioParadiseProviderOptions = {}) {
    this.iconBaseUrl = options.iconBaseUrl?.trim() || RADIO_PARADISE_ICON_BASE_URL;
  }

  public getMenuEntry(): RadioMenuEntry {
    return {
      cmd: 'radioparadise',
      name: 'Radio Paradise',
      icon: buildRadioParadiseIconUrl('radioparadise-logo-main.png', this.iconBaseUrl),
      root: 'start',
      description: 'Human-curated, listener-supported radio streams.',
    };
  }

  public async getFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    if (folderId !== 'start') {
      return null;
    }

    const items = this.mapStations(offset, limit);

    return {
      id: folderId,
      name: 'Radio Paradise',
      start: offset,
      totalitems: RADIO_PARADISE_STATIONS.length,
      items,
    };
  }

  private mapStations(offset: number, limit: number): ContentFolderItem[] {
    return RADIO_PARADISE_STATIONS.slice(offset, offset + limit).map((station) => {
      const cover = buildRadioParadiseIconUrl(station.icon, this.iconBaseUrl);
      return {
        id: station.id,
        name: station.name,
        title: station.name,
        type: FileType.File,
        audiopath: `radioparadise:${station.id}`,
        coverurl: cover,
        thumbnail: cover,
        tag: 'radio',
        provider: PROVIDER_ID,
        items: 0,
      } satisfies ContentFolderItem;
    });
  }
}
