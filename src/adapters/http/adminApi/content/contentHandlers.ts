import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ComponentLogger } from '@/shared/logging/logger';
import { bestEffort } from '@/shared/bestEffort';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { StorageConfig } from '@/adapters/content/storage/storageManager';
import { TuneInClient } from '@/adapters/content/providers/tunein/tuneinClient';
import type { Route } from '@/adapters/http/adminApi/routeTypes';

const MAX_LIBRARY_UPLOAD_JSON_BODY_BYTES = 32 * 1024 * 1024;

export type ContentHandlerDeps = {
  log: ComponentLogger;
  contentManager: ContentManager;
  customRadioStore: CustomRadioStore;
  loxoneNotifier: LoxoneWsNotifier;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
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
      method: 'POST',
      pattern: /^\/content\/library\/upload$/,
      handler: async (req, res) => handleLibraryUpload(req, res, deps),
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

async function handleLibraryUpload(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ContentHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res, MAX_LIBRARY_UPLOAD_JSON_BODY_BYTES)) as
    | { filename?: string; relativePath?: string; data?: string }
    | null;
  if (res.writableEnded) {
    return;
  }
  const filename = typeof body?.filename === 'string' ? body.filename.trim() : '';
  const relativePath = typeof body?.relativePath === 'string' ? body.relativePath.trim() : '';
  const data = typeof body?.data === 'string' ? body.data : '';
  if ((!filename && !relativePath) || !data) {
    deps.sendJson(res, 400, { error: 'invalid-library-upload' });
    return;
  }
  try {
    const upload = await deps.contentManager.uploadLibraryAudio(relativePath || filename, data);
    void bestEffort(() => deps.contentManager.rescanLibrary(), {
      fallback: undefined,
      onError: 'debug',
      log: deps.log,
      label: 'library rescan failed after upload',
    });
    deps.sendJson(res, 201, { upload });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'library-upload-failed';
    if (['invalid-filename', 'invalid-audio-data', 'invalid-audio-extension'].includes(code)) {
      deps.sendJson(res, 400, { error: code });
      return;
    }
    deps.log.warn('library upload failed', { err });
    deps.sendJson(res, 500, { error: 'library-upload-failed' });
  }
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
    deps.sendJson(res, 500, { error: 'library-storage-add-failed' });
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
