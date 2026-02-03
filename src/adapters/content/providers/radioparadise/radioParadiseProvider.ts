import type { ContentFolder, ContentFolderItem, RadioMenuEntry } from '@/ports/ContentTypes';
import { FileType } from '@/domain/loxone/enums';
import {
  RADIO_PARADISE_MENU_ENTRY,
  RADIO_PARADISE_STATIONS,
  buildRadioParadiseIconUrl,
} from '@/adapters/content/providers/radioparadise/radioParadiseConstants';

const PROVIDER_ID = 'radioparadise';

export class RadioParadiseProvider {
  public getMenuEntry(): RadioMenuEntry {
    return RADIO_PARADISE_MENU_ENTRY;
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
      const cover = buildRadioParadiseIconUrl(station.icon);
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
