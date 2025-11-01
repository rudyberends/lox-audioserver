/**
 * -----------------------------------------------------------------------------
 * ProviderRuntime
 * -----------------------------------------------------------------------------
 * Central runtime responsible for initializing and delegating to the active
 * content provider (e.g. Music Assistant, BeoLink, etc.).
 *
 * Responsibilities:
 * - Load provider based on configuration
 * - Keep track of the currently active provider type
 * - Expose a unified API for the rest of the system
 * -----------------------------------------------------------------------------
 */

import logger from '@/utils/troxorLogger';
import { configManager } from '../config';
import {
  getContentProvider,
  listContentProviders,
} from '@/model/registry/contentProviderRegistry';
import type { ContentProviderConstructor } from '@/model/registry/contentProviderRegistry';
import { ProviderSearchResult } from './types/providerSearchResults';
import { ContentProvider, RadioEntry, RadioFolderResponse, RadioFolderItem, RecentResponse } from '@/core/types/content';

export class ProviderRuntime {
  private active?: ContentProvider;
  private activeType?: string;

  /* -------------------------------------------------------------------------- */
  /*  Registration & lifecycle                                                  */
  /* -------------------------------------------------------------------------- */

  public listRegisteredProviderTypes(): string[] {
    return listContentProviders();
  }

  public getActiveType(): string | undefined {
    return this.activeType;
  }

  public isActive(): boolean {
    return !!this.active;
  }

  public async initialize(): Promise<void> {
    const providerCfg = configManager.current.mediaProvider;

    if (!providerCfg?.type) {
      logger.info('[ProviderRuntime] No media provider configured.');
      return;
    }

    const type = String(providerCfg.type).toLowerCase();
    const Ctor = getContentProvider(type) as ContentProviderConstructor | undefined;

    if (!Ctor) {
      logger.warn(
        `[ProviderRuntime] No provider registered for type "${type}".)}`,
      );
      return;
    }

    await this.dispose();

    try {
      const options = providerCfg.options ?? {};
      const instance = new Ctor({ providerId: type, zoneName: 'provider', ...options });
      this.active = instance as ContentProvider;
      this.activeType = type;
      if ('initialize' in this.active && typeof this.active.initialize === 'function') {
        await this.active.initialize();
      }
      logger.info(`[ProviderRuntime] Activated provider "${type}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[ProviderRuntime] Failed to initialize provider "${type}": ${msg}`);
      this.active = undefined;
      this.activeType = undefined;
    }
  }

  public async dispose(): Promise<void> {
    if (this.active) {
      await this.active.dispose?.();
      logger.info(`[ProviderRuntime] Disposed provider "${this.activeType}"`);
      this.active = undefined;
      this.activeType = undefined;
    }
  }

  /* -------------------------------------------------------------------------- */
  /*  Global search                                                             */
  /* -------------------------------------------------------------------------- */

  /* -------------------------------------------------------------------------- */
  /*  Global search (Loxone-compatible)                                         */
  /* -------------------------------------------------------------------------- */

  /**
   * Executes a global search via the active content provider.
   *
   * @param source  Full search scope string, e.g. "spotify@nouser:track#5,album#5"
   * @param query   Search query string (already decoded)
   * @returns       Structured result ready for Loxone broadcast
   */
  async globalSearch(source: string, query: string, unique: string): Promise<ProviderSearchResult> {
    if (!this.active) {
      throw new Error('No active provider');
    }

    if (typeof this.active.globalSearch !== 'function') {
      throw new Error('Active provider does not implement globalSearch');
    }

    logger.debug(`[ProviderRuntime] globalSearch → ${source}, query="${query}", unique=${unique}`);

    const result = await this.active.globalSearch(source, query, unique);
    return result as ProviderSearchResult;
  }

  /* -------------------------------------------------------------------------- */
  /*  Delegated API (generic content operations)                                */
  /* -------------------------------------------------------------------------- */
  /*
  public async browse(options?: BrowseOptions): Promise<ContentItem[]> {
    if (!this.active) {
      return [];
    }
    return this.active.browse(options);
  }

  public async getItem(id: string): Promise<ContentItem | null> {
    if (!this.active) {
      return null;
    }
    return this.active.getItem(id);
  }*/

  /* -------------------------------------------------------------------------- */
  /*  Provider-specific façade (Loxone-compatible endpoints)                    */
  /* -------------------------------------------------------------------------- */

  public async getAvailableServices(): Promise<unknown[]> {
    if (!this.active || typeof this.active.getAvailableServices !== 'function') {
      return [];
    }
    return this.active.getAvailableServices();
  }

  public async getServices(): Promise<unknown[]> {
    if (!this.active || typeof this.active.getServices !== 'function') {
      logger.warn('[ProviderRuntime] Active provider missing getServices()');
      return [];
    }
    try {
      return await this.active.getServices();
    } catch (err) {
      logger.error(`[ProviderRuntime] getServices() failed: ${err}`);
      return [];
    }
  }

  public async getServiceFolder(
    service: string,
    user: string,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<any | undefined> {
    if (!this.active || typeof this.active.getServiceFolder !== 'function') {
      return undefined;
    }
    return this.active.getServiceFolder(service, user, folderId, offset, limit);
  }

  /**
 * -----------------------------------------------------------------------------
 * getRadios()
 * -----------------------------------------------------------------------------
 * Returns the minimal static radio root list required by the Loxone client.
 *
 * This ensures the radio section in the client does not crash even if
 * no providers are active. The list is constant and provider-independent.
 *
 * Corresponds to command: "audio/cfg/getradios"
 * -----------------------------------------------------------------------------
 */
  public async getRadios(): Promise<RadioEntry[]> {
    return [
      {
        cmd: 'local',
        icon: 'http://a.b/c',
        name: 'Radio',
        root: 'start',
      },
      {
        cmd: 'custom',
        icon: 'http://a.b/c',
        name: 'Custom Radio',
        root: 'start',
      },
    ];
  }

  public async getRadioFolder(
    service: string,
    folderId: string,
    user: string,
    offset: number,
    limit: number,
  ): Promise<RadioFolderResponse | undefined> {
    if (!this.active || typeof this.active.getRadioFolder !== 'function') {
      logger.warn('[ProviderRuntime] Active provider missing getRadioFolder()');
      return undefined;
    }
    try {
      return await this.active.getRadioFolder(service, folderId, user, offset, limit);
    } catch (err) {
      logger.error(`[ProviderRuntime] getRadioFolder() failed: ${err}`);
      return undefined;
    }
  }

  public async resolveRadioStation(
    service: string,
    stationId: string,
  ): Promise<RadioFolderItem | undefined> {
    if (!this.active || typeof this.active.resolveRadioStation !== 'function') {
      logger.warn('[ProviderRuntime] Active provider missing resolveRadioStation()');
      return undefined;
    }
    try {
      return await this.active.resolveRadioStation(service, stationId);
    } catch (err) {
      logger.error(`[ProviderRuntime] resolveRadioStation() failed: ${err}`);
      return undefined;
    }
  }

  public async getRecentlyPlayed(zoneId: number, limit: number): Promise<RecentResponse | undefined> {
    if (!this.active || typeof this.active.getRecentlyPlayed !== 'function') {
      logger.warn('[ProviderRuntime] Active provider missing getRecentlyPlayed()');
      return undefined;
    }
    try {
      return await this.active.getRecentlyPlayed(zoneId, limit);
    } catch (err) {
      logger.error(`[ProviderRuntime] getRecentlyPlayed() failed: ${err}`);
      return undefined;
    }
  }

  public async clearRecentlyPlayed(zoneId: number): Promise<void> {
    if (!this.active || typeof this.active.clearRecentlyPlayed !== 'function') {
      logger.warn('[ProviderRuntime] Active provider missing clearRecentlyPlayed()');
      return;
    }
    try {
      await this.active.clearRecentlyPlayed(zoneId);
    } catch (err) {
      logger.error(`[ProviderRuntime] clearRecentlyPlayed() failed: ${err}`);
    }
  }

  public async getPlaylists(
    service: string,
    user: string,
    offset: number,
    limit: number,
  ): Promise<unknown> {
    if (!this.active || typeof this.active.getPlaylists !== 'function') {
      return [];
    }
    return this.active.getPlaylists(offset, limit);
  }

  public async getMediaFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<unknown> {
    if (!this.active || typeof this.active.browse !== 'function') {
      return [];
    }
    return this.active.browse({ path: folderId, offset, limit });
  }

  public async search(source: string, query: string): Promise<unknown[] | undefined> {
    if (!this.active || typeof this.active.search !== 'function') {
      return [];
    }
    return this.active.search({ query });
  }

  public describeSearchSources(): Record<string, string[]> {
    return {
      spotify: ['track', 'album', 'artist', 'playlist', 'episode', 'show'],
      tunein: ['station', 'custom'],
    };
  }

  public async resolveItem(audiopath: string): Promise<any | undefined> {
    if (!this.active || typeof (this.active as any).resolveItem !== 'function') {
      logger.warn('[ProviderRuntime] Active provider missing resolveItem()');
      return undefined;
    }
    try {
      return await this.active.resolveItem(audiopath);
    } catch (err) {
      logger.error(`[ProviderRuntime] resolveItem() failed for ${audiopath}: ${err}`);
      return undefined;
    }
  }
}

/** Singleton instance */
export const providerRuntime = new ProviderRuntime();