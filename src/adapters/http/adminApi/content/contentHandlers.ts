import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ComponentLogger } from '@/shared/logging/logger';
import { bestEffort } from '@/shared/bestEffort';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { StorageConfig } from '@/adapters/content/storage/storageManager';
import { TuneInClient } from '@/adapters/content/providers/tunein/tuneinClient';
import type { Route } from '@/adapters/http/adminApi/routeTypes';
import type { WebdavServer } from '@/adapters/webdav/webdavServer';

export type ContentHandlerDeps = {
  log: ComponentLogger;
  contentManager: ContentManager;
  customRadioStore: CustomRadioStore;
  loxoneNotifier: LoxoneWsNotifier;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  /**
   * Streaming write path shared with the WebDAV share, so a file dropped in the
   * admin UI lands on disk exactly as one copied over the network drive.
   */
  webdav?: WebdavServer;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

export function buildContentRoutes(deps: ContentHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/content\/library\/status$/,
      handler: (_req, res) => handleLibraryStatus(res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/content\/library\/covers$/,
      handler: async (req, res) => handleLibraryCovers(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/content\/library\/browse$/,
      handler: async (req, res) => handleLibraryBrowse(req, res, deps),
    },
    {
      method: 'PUT',
      pattern: /^\/content\/library\/files\/(.+)$/,
      handler: async (req, res, match) => {
        const relativePath = decodeURIComponent(match[1] ?? '');
        await handleLibraryFilePut(req, res, relativePath, deps);
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/content\/library\/tracks$/,
      handler: async (req, res) => handleLibraryTrackDelete(req, res, deps),
    },
    {
      method: 'DELETE',
      pattern: /^\/content\/library\/albums$/,
      handler: async (req, res) => handleLibraryAlbumDelete(req, res, deps),
    },
    {
      method: 'DELETE',
      pattern: /^\/content\/library\/artists$/,
      handler: async (req, res) => handleLibraryArtistDelete(req, res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/content\/library\/rescan$/,
      handler: async (_req, res) => handleLibraryRescan(res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/content\/library\/storages\/([^/]+)\/status$/,
      handler: async (_req, res, match) => {
        const storageId = decodeURIComponent(match[1] ?? '');
        handleLibraryStorageStatus(storageId, res, deps);
      },
    },
    {
      method: 'GET',
      pattern: /^\/content\/library\/storages\/([^/]+)\/covers$/,
      handler: async (req, res, match) => {
        const storageId = decodeURIComponent(match[1] ?? '');
        await handleLibraryStorageCovers(storageId, req, res, deps);
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/content\/library\/storages\/([^/]+)$/,
      handler: async (_req, res, match) => {
        const storageId = decodeURIComponent(match[1] ?? '');
        await handleLibraryStorageDelete(storageId, res, deps);
      },
    },
    {
      method: 'GET',
      pattern: /^\/content\/library\/storages$/,
      handler: async (_req, res) => handleLibraryStorageList(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/content\/library\/storages$/,
      handler: async (req, res) => handleLibraryStorageAdd(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/content\/radio\/custom$/,
      handler: async (_req, res) => handleCustomRadioList(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/content\/radio\/custom$/,
      handler: async (req, res) => handleCustomRadioAdd(req, res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/content\/radio\/tunein\/validate$/,
      handler: async (req, res) => handleTuneInValidate(req, res, deps),
    },
    {
      method: 'DELETE',
      pattern: /^\/content\/radio\/custom\/([^/]+)$/,
      handler: async (_req, res, match) => {
        const stationId = decodeURIComponent(match[1] ?? '');
        if (!stationId) {
          deps.sendJson(res, 400, { error: 'invalid-station-id' });
          return;
        }
        await handleCustomRadioDelete(stationId, res, deps);
      },
    },
  ];
}

function handleLibraryStatus(res: ServerResponse, deps: ContentHandlerDeps): void {
  try {
    const status = deps.contentManager.getScanStatus();
    const stats = deps.contentManager.getLibraryStats();
    deps.sendJson(res, 200, {
      status,
      trackCount: stats?.tracks ?? null,
      albumCount: stats?.albums ?? null,
      artistCount: stats?.artists ?? null,
    });
  } catch (err) {
    deps.log.warn('library status fetch failed', { err });
    deps.sendJson(res, 500, { error: 'library-status-failed' });
  }
}

function handleLibraryStorageStatus(
  storageId: string,
  res: ServerResponse,
  deps: ContentHandlerDeps,
): void {
  if (!storageId) {
    deps.sendJson(res, 400, { error: 'missing-storage-id' });
    return;
  }
  try {
    const stats = deps.contentManager.getLibraryStorageStats(storageId);
    deps.sendJson(res, 200, {
      trackCount: stats?.tracks ?? null,
      albumCount: stats?.albums ?? null,
      artistCount: stats?.artists ?? null,
    });
  } catch (err) {
    deps.log.warn('library storage status fetch failed', { err, storageId });
    deps.sendJson(res, 500, { error: 'library-storage-status-failed' });
  }
}

async function handleLibraryCovers(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ContentHandlerDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const rawLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.round(rawLimit) : 8;
    const covers = deps.contentManager.getLibraryCoverSamples(limit);
    deps.sendJson(res, 200, { covers });
  } catch (err) {
    deps.log.warn('library covers fetch failed', { err });
    deps.sendJson(res, 500, { error: 'library-covers-failed' });
  }
}

/** Entities the admin library browser can page through, mapped to their folder id stem. */
const LIBRARY_BROWSE_KINDS = {
  albums: 'albums',
  artists: 'artists',
  tracks: 'tracks',
} as const;

type LibraryBrowseKind = keyof typeof LIBRARY_BROWSE_KINDS;

const LIBRARY_BROWSE_MAX_LIMIT = 200;

/** Per-type hit cap the local library search enforces (localLibraryProvider.search). */
const LIBRARY_SEARCH_MAX_HITS = 50;

/**
 * Folder id for a library entity listing. `local` is the built-in storage; every
 * other id is a configured network share.
 */
function libraryBrowseFolderId(kind: LibraryBrowseKind, storageId: string): string {
  const stem = LIBRARY_BROWSE_KINDS[kind];
  return storageId === 'local' ? `library-local-${stem}` : `library-nas-${storageId}-${stem}`;
}

/**
 * Paged listing behind the admin library manager. Browsing delegates to the same
 * `getMediaFolder` the players use, so the item ids it returns are exactly the ids
 * the album/artist/track DELETE endpoints accept.
 *
 * Search is a different shape: the underlying store matches with a per-type cap and
 * reports no total, so a query returns one capped page and says so via `truncated`
 * rather than pretending to paginate.
 */
async function handleLibraryBrowse(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ContentHandlerDeps,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const kindParam = (url.searchParams.get('kind') ?? 'albums') as LibraryBrowseKind;
  if (!(kindParam in LIBRARY_BROWSE_KINDS)) {
    deps.sendJson(res, 400, { error: 'invalid-library-browse-kind' });
    return;
  }
  const storageId = (url.searchParams.get('storageId') ?? 'local').trim() || 'local';
  const query = (url.searchParams.get('q') ?? '').trim();

  const rawOffset = Number(url.searchParams.get('offset'));
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  const rawLimit = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), LIBRARY_BROWSE_MAX_LIMIT)
      : 50;

  try {
    if (query) {
      // The store's search caps each type at LIBRARY_SEARCH_MAX_HITS and returns no
      // total, so a query yields a single capped page rather than a pageable set.
      const singular = kindParam.slice(0, -1);
      const hitLimit = Math.min(limit, LIBRARY_SEARCH_MAX_HITS);
      const found = await deps.contentManager.globalSearch(
        `local:${singular}#${hitLimit}`,
        query,
      );
      const items = found.result?.[kindParam] ?? [];
      deps.sendJson(res, 200, {
        kind: kindParam,
        storageId,
        query,
        items,
        offset: 0,
        limit: hitLimit,
        total: items.length,
        truncated: items.length >= hitLimit,
      });
      return;
    }

    const folder = await deps.contentManager.getMediaFolder(
      libraryBrowseFolderId(kindParam, storageId),
      offset,
      limit,
    );
    deps.sendJson(res, 200, {
      kind: kindParam,
      storageId,
      query: '',
      items: folder?.items ?? [],
      offset,
      limit,
      total: folder?.totalitems ?? 0,
      truncated: false,
    });
  } catch (err) {
    deps.log.warn('library browse failed', { err, kind: kindParam, storageId });
    deps.sendJson(res, 500, { error: 'library-browse-failed' });
  }
}

async function handleLibraryStorageCovers(
  storageId: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ContentHandlerDeps,
): Promise<void> {
  if (!storageId) {
    deps.sendJson(res, 400, { error: 'missing-storage-id' });
    return;
  }
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const rawLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.round(rawLimit) : 8;
    const covers = deps.contentManager.getLibraryStorageCoverSamples(storageId, limit);
    deps.sendJson(res, 200, { covers });
  } catch (err) {
    deps.log.warn('library storage covers fetch failed', { err, storageId });
    deps.sendJson(res, 500, { error: 'library-storage-covers-failed' });
  }
}

/**
 * Streams one uploaded file into the local library.
 *
 * Delegates to the same writer the WebDAV share uses, which is the point: the
 * admin UI's drop zone and a file copied over the network drive now produce
 * byte-identical results on disk. The previous base64-in-JSON endpoint capped a
 * file at roughly 24 MB of real audio and rewrote every non-ASCII character in
 * the path to an underscore, so the same album landed under a different name
 * depending on which route added it.
 */
async function handleLibraryFilePut(
  req: IncomingMessage,
  res: ServerResponse,
  relativePath: string,
  deps: ContentHandlerDeps,
): Promise<void> {
  if (!deps.webdav) {
    deps.sendJson(res, 503, { error: 'library-upload-unavailable' });
    return;
  }
  if (!relativePath.trim()) {
    deps.sendJson(res, 400, { error: 'invalid-library-upload' });
    return;
  }
  if (!isAudioUploadName(relativePath)) {
    deps.sendJson(res, 400, { error: 'invalid-audio-extension' });
    return;
  }
  // A file dropped on its own has no folder to keep, so it is filed under its
  // tags (Artist/Album) instead of landing loose in the library root. A whole
  // folder that was dropped already carries its structure and is left alone.
  const isLooseFile = !relativePath.replace(/^\/+/, '').includes('/');

  try {
    await deps.webdav.writeFile(
      req,
      res,
      relativePath,
      isLooseFile
        ? async (written, libraryPath) => {
          // Tags are read from the file as the indexer sees it, so the path
          // must be library-relative, not share-relative.
          const subdir = await deps.contentManager.resolveLibraryUploadSubdir(libraryPath);
          return subdir ? `${subdir}/${written.split('/').pop()}` : written;
        }
        : undefined,
    );
  } catch (err) {
    deps.log.warn('library upload failed', { err, relativePath });
    if (!res.headersSent) {
      deps.sendJson(res, 500, { error: 'library-upload-failed' });
    }
  }
}

/** Extensions the library indexes; anything else is refused rather than stored. */
function isAudioUploadName(name: string): boolean {
  return /\.(mp3|flac|m4a|aac|ogg|wav)$/i.test(name);
}

async function handleLibraryTrackDelete(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ContentHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as { audiopath?: string } | null;
  if (res.writableEnded) {
    return;
  }
  const audiopath = typeof body?.audiopath === 'string' ? body.audiopath.trim() : '';
  if (!audiopath) {
    deps.sendJson(res, 400, { error: 'invalid-library-track-delete' });
    return;
  }
  try {
    const result = await deps.contentManager.deleteLibraryTrackByAudiopath(audiopath);
    deps.sendJson(res, 200, { result });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'library-track-delete-failed';
    if (code === 'invalid-audiopath') {
      deps.sendJson(res, 400, { error: code });
      return;
    }
    if (code === 'track-not-found') {
      deps.sendJson(res, 404, { error: code });
      return;
    }
    deps.log.warn('library track delete failed', { err, audiopath });
    deps.sendJson(res, 500, { error: 'library-track-delete-failed' });
  }
}

async function handleLibraryAlbumDelete(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ContentHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as { id?: string } | null;
  if (res.writableEnded) {
    return;
  }
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) {
    deps.sendJson(res, 400, { error: 'invalid-library-album-delete' });
    return;
  }
  try {
    const result = await deps.contentManager.deleteLibraryAlbumByFolderId(id);
    deps.sendJson(res, 200, { result });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'library-album-delete-failed';
    if (code === 'invalid-album-id') {
      deps.sendJson(res, 400, { error: code });
      return;
    }
    if (code === 'album-not-found') {
      deps.sendJson(res, 404, { error: code });
      return;
    }
    deps.log.warn('library album delete failed', { err, id });
    deps.sendJson(res, 500, { error: 'library-album-delete-failed' });
  }
}

async function handleLibraryArtistDelete(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ContentHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as { id?: string } | null;
  if (res.writableEnded) {
    return;
  }
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) {
    deps.sendJson(res, 400, { error: 'invalid-library-artist-delete' });
    return;
  }
  try {
    const result = await deps.contentManager.deleteLibraryArtistByFolderId(id);
    deps.sendJson(res, 200, { result });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'library-artist-delete-failed';
    if (code === 'invalid-artist-id') {
      deps.sendJson(res, 400, { error: code });
      return;
    }
    if (code === 'artist-not-found') {
      deps.sendJson(res, 404, { error: code });
      return;
    }
    deps.log.warn('library artist delete failed', { err, id });
    deps.sendJson(res, 500, { error: 'library-artist-delete-failed' });
  }
}

async function handleLibraryStorageList(
  res: ServerResponse,
  deps: ContentHandlerDeps,
): Promise<void> {
  try {
    const storages = await deps.contentManager.listStorages();
    deps.loxoneNotifier.notifyStorageListUpdated(storages);
    deps.sendJson(res, 200, { storages });
  } catch (err) {
    deps.log.warn('library storage list failed', { err });
    deps.sendJson(res, 500, { error: 'library-storage-list-failed' });
  }
}

async function handleLibraryStorageAdd(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ContentHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as Partial<StorageConfig> | null;
  if (res.writableEnded) {
    return;
  }
  if (!body || typeof body !== 'object') {
    deps.sendJson(res, 400, { error: 'invalid-storage-payload' });
    return;
  }

  const { name, server, folder, type } = body;
  if (!name || !server || !folder || !type) {
    deps.sendJson(res, 400, { error: 'missing-storage-fields' });
    return;
  }

  try {
    const storage = await deps.contentManager.addStorage({
      id: body.id,
      name,
      server,
      folder,
      type,
      username: body.username,
      password: body.password,
      guest: body.guest,
      options: body.options,
    });
    deps.loxoneNotifier.notifyStorageAdded(storage);
    deps.loxoneNotifier.notifyStorageListUpdated(await deps.contentManager.listStorages());
    void bestEffort(() => deps.contentManager.rescanLibrary(), {
      fallback: undefined,
      onError: 'debug',
      log: deps.log,
      label: 'library rescan failed after storage add',
    });
    deps.sendJson(res, 201, { storage });
  } catch (err) {
    deps.log.warn('library storage add failed', { err });
    // The reason has to travel: a refused mount is usually about the container's own privileges,
    // and only the message says which change fixes it (see mountDiagnostics).
    const message = err instanceof Error ? err.message : String(err);
    deps.sendJson(res, 500, { error: 'library-storage-add-failed', message });
  }
}

async function handleLibraryStorageDelete(
  id: string,
  res: ServerResponse,
  deps: ContentHandlerDeps,
): Promise<void> {
  if (!id) {
    deps.sendJson(res, 400, { error: 'missing-storage-id' });
    return;
  }

  try {
    await deps.contentManager.deleteStorage(id);
    deps.loxoneNotifier.notifyStorageRemoved(id);
    deps.loxoneNotifier.notifyStorageListUpdated(await deps.contentManager.listStorages());
    void bestEffort(() => deps.contentManager.rescanLibrary(), {
      fallback: undefined,
      onError: 'debug',
      log: deps.log,
      label: 'library rescan failed after storage delete',
    });
    deps.sendJson(res, 202, { status: 'storage-deleted', id });
  } catch (err) {
    deps.log.warn('library storage delete failed', { err, id });
    deps.sendJson(res, 500, { error: 'library-storage-delete-failed' });
  }
}

async function handleLibraryRescan(res: ServerResponse, deps: ContentHandlerDeps): Promise<void> {
  try {
    await deps.contentManager.rescanLibrary();
    deps.sendJson(res, 202, { status: 'rescan-started' });
  } catch (err) {
    deps.log.warn('library rescan failed', { err });
    deps.sendJson(res, 500, { error: 'library-rescan-failed' });
  }
}

async function handleCustomRadioList(res: ServerResponse, deps: ContentHandlerDeps): Promise<void> {
  try {
    const stations = await deps.customRadioStore.list();
    deps.sendJson(res, 200, { stations });
  } catch (err) {
    deps.log.warn('custom radio list failed', { err });
    deps.sendJson(res, 500, { error: 'custom-radio-list-failed' });
  }
}

async function handleCustomRadioAdd(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ContentHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as
    | { name?: string; stream?: string; coverurl?: string }
    | null;
  if (res.writableEnded) {
    return;
  }
  if (!body || typeof body !== 'object' || !body.name || !body.stream) {
    deps.sendJson(res, 400, { error: 'invalid-radio-payload' });
    return;
  }
  try {
    const station = await deps.customRadioStore.add({
      name: body.name.trim(),
      stream: body.stream.trim(),
      coverurl: body.coverurl?.trim() || undefined,
    });
    deps.sendJson(res, 201, { station });
  } catch (err) {
    deps.log.warn('custom radio add failed', { err });
    deps.sendJson(res, 500, { error: 'custom-radio-add-failed' });
  }
}

async function handleCustomRadioDelete(
  stationId: string,
  res: ServerResponse,
  deps: ContentHandlerDeps,
): Promise<void> {
  try {
    const removed = await deps.customRadioStore.remove(stationId);
    if (!removed) {
      deps.sendJson(res, 404, { error: 'station-not-found' });
      return;
    }
    deps.sendJson(res, 204, {});
  } catch (err) {
    deps.log.warn('custom radio delete failed', { err, stationId });
    deps.sendJson(res, 500, { error: 'custom-radio-delete-failed' });
  }
}

async function handleTuneInValidate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ContentHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as { username?: string } | null;
  if (res.writableEnded) {
    return;
  }
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  if (!username) {
    deps.sendJson(res, 400, { error: 'invalid-tunein-username' });
    return;
  }
  try {
    const api = new TuneInClient();
    const outlines = await api.browsePresets(username);
    const presetCount = Array.isArray(outlines)
      ? outlines.filter((entry: any) => entry && entry.type === 'audio').length
      : 0;
    deps.sendJson(res, 200, { valid: true, presetCount });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isInvalid = /(TuneIn error|HTTP 4\d\d)/i.test(message);
    deps.log.warn('tunein validation failed', { message, username });
    deps.sendJson(res, 200, {
      valid: false,
      error: isInvalid ? 'tunein-username-invalid' : 'tunein-validate-failed',
      message: isInvalid
        ? 'TuneIn username not found.'
        : 'Unable to verify the TuneIn username right now.',
    });
  }
}
