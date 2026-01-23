import type { ContentManager } from '@/adapters/content/contentManager';
import {
  splitCommand,
  parseNumberPart,
  decodeSegment,
} from '@/adapters/loxone/commands/utils/commandUtils';
import { buildEmptyResponse, buildResponse } from '@/adapters/loxone/commands/responses';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import { decodeBase64Segment, safeJsonParse } from '@/adapters/loxone/commands/utils/payload';
import { decryptWithAudioCfgKey } from '@/adapters/loxone/commands/handlers/configHandlers';
import { createLogger } from '@/shared/logging/logger';

const log = createLogger('Loxone', 'ProviderHandlers');

function normalizeItemId(raw: string | undefined): string {
  const decoded = decodeSegment(raw ?? '').trim();
  return decoded.replace(/\]+$/, '');
}

export function createProviderHandlers(contentManager: ContentManager, notifier: LoxoneWsNotifier) {
  return {
    audioCfgGetAvailableServices: (command: string) => {
      const services = contentManager.getAvailableServices();
      return buildResponse(command, 'getavailableservices', services);
    },
    audioCfgGetServices: (command: string) => {
      const services = contentManager.getServices();
      return buildResponse(command, 'getservices', services);
    },
    audioCfgGetMediaFolder: async (command: string) => {
      const parts = splitCommand(command);
      const folderId = parts[3] || 'root';
      const start = parseNumberPart(parts[4], 0);
      const limit = parseNumberPart(parts[5], 50);
      const folder = await contentManager.getMediaFolder(folderId, start, limit);
      return buildResponse(command, 'getmediafolder', folder ? [folder] : []);
    },
    audioCfgGetRadios: async (command: string) => {
      const radios = await contentManager.getRadios();
      return buildResponse(command, 'getradios', radios);
    },
    audioCfgGetPlaylists: async (command: string) => {
      const parts = splitCommand(command);
      const service = parts[3];
      const user = parts[4] ?? 'nouser';
      const start = parseNumberPart(parts[5], 0);
      const limit = parseNumberPart(parts[6], 50);
      const playlists = await contentManager.getPlaylists(service, user, start, limit);
      return buildResponse(command, 'getplaylists2', playlists);
    },
    audioCfgGetServiceFolder: async (command: string) => {
      const parts = splitCommand(command);
      const service = parts[3];
      const user = parts[4] ?? 'nouser';
      const folderId = decodeSegment(parts.slice(5, -2).join('/') || 'root');
      const start = parseNumberPart(parts[parts.length - 2], 0);
      const limit = parseNumberPart(parts[parts.length - 1], 50);
      const folder = await contentManager.getServiceFolder(service, user, folderId, start, limit);
      return buildResponse(command, 'getservicefolder', folder ? [folder] : []);
    },
    audioCfgRescan: (command: string) => {
      void contentManager.rescanLibrary();
      return buildEmptyResponse(command);
    },
    audioCfgScanStatus: (command: string) => {
      const status = contentManager.getScanStatus();
      return buildResponse(command, 'scanstatus', [status]);
    },
    audioCfgStorageList: async (command: string) => {
      const storages = await contentManager.listStorages();
      notifier.notifyStorageListUpdated(storages);
      const result = storages.map((storage) => ({
        id: storage.id,
        name: storage.name,
        server: storage.server,
        folder: storage.folder,
        guest: storage.guest,
        username: storage.username ?? undefined,
        type: storage.type,
      }));
      return buildResponse(command, 'storage', result);
    },
    audioCfgStorageAdd: async (command: string) => {
      const parts = splitCommand(command);
      const encoded = decodeSegment(parts[4]);
      if (!encoded) {
        return buildResponse(command, 'storage', { configerror: 1 });
      }

      const jsonStr = decodeBase64Segment(decodeURIComponent(encoded));
      const payload = safeJsonParse<any>(jsonStr);
      if (!payload || !payload.server || !payload.folder || !payload.name) {
        return buildResponse(command, 'storage', { configerror: 1 });
      }

      const plaintextPassword = decryptWithAudioCfgKey(payload.password) ?? payload.password;

      log.debug('storage add payload (plaintext)', {
        name: payload.name,
        server: payload.server,
        folder: payload.folder,
        guest: !!payload.guest,
        username: payload.username,
        password: plaintextPassword,
        options: payload.options,
      });

      try {
        const storage = await contentManager.addStorage({
          id: payload.id,
          name: payload.name,
          server: payload.server,
          folder: payload.folder,
          guest: !!payload.guest,
          username: payload.username,
          password: plaintextPassword,
          type: payload.type ?? 'cifs',
          options: payload.options,
        });
        notifier.notifyStorageAdded(storage);
        notifier.notifyStorageListUpdated(await contentManager.listStorages());
        void contentManager.rescanLibrary();
        return buildResponse(command, 'storage', {
          configerror: 0,
          id: storage.id,
          name: storage.name,
          server: storage.server,
          folder: storage.folder,
          guest: storage.guest,
          username: storage.username ?? undefined,
        });
      } catch (err) {
        const cfgErr = mapMountErrorToConfigError(err);
        return buildResponse(command, 'storage', {
          configerror: cfgErr,
          id: undefined,
          name: payload?.name,
          server: payload?.server,
          folder: payload?.folder,
          guest: payload?.guest,
          username: payload?.username ?? undefined,
        });
      }
    },
    audioCfgStorageDel: async (command: string) => {
      const parts = splitCommand(command);
      const id = parts[4];
      if (id) {
        try {
          await contentManager.deleteStorage(id);
          notifier.notifyStorageRemoved(id);
          notifier.notifyStorageListUpdated(await contentManager.listStorages());
          void contentManager.rescanLibrary();
          return buildResponse(command, 'storage', { configerror: 0 });
        } catch (err) {
          const cfgErr = mapMountErrorToConfigError(err);
          return buildResponse(command, 'storage', { configerror: cfgErr || 1 });
        }
      }
      return buildResponse(command, 'storage', { configerror: 1 });
    },
    audioCfgIsFollowed: (command: string) => {
      const parts = splitCommand(command);
      const service = parts[3] ?? 'spotify';
      const user = parts[4] ?? 'nouser';
      const itemId = normalizeItemId(parts[5]);
      return (async () => {
        const provider = contentManager.resolveServiceProvider(service, user);
        if (!provider) {
          return buildResponse(command, 'isfollowed', {
            action: 'isfollowed',
            id: itemId,
            isfollowed: false,
            isowner: false,
          });
        }
        const state =
          (await provider?.getFollowState?.(service, user, itemId)) ?? {
            isfollowed: false,
            isowner: false,
          };
        return buildResponse(command, 'isfollowed', {
          action: 'isfollowed',
          id: itemId,
          isfollowed: state.isfollowed ?? false,
          isowner: state.isowner ?? false,
        });
      })();
    },
    audioCfgFollow: (command: string) => {
      const parts = splitCommand(command);
      const service = parts[3] ?? 'spotify';
      const user = parts[4] ?? 'nouser';
      const itemId = normalizeItemId(parts[5]);
      const provider = contentManager.resolveServiceProvider(service, user);
      void provider?.setFollowState?.(service, user, itemId, true);
      return buildResponse(command, 'follow', { action: 'follow', id: itemId });
    },
    audioCfgUnfollow: (command: string) => {
      const parts = splitCommand(command);
      const service = parts[3] ?? 'spotify';
      const user = parts[4] ?? 'nouser';
      const itemId = normalizeItemId(parts[5]);
      const provider = contentManager.resolveServiceProvider(service, user);
      void provider?.setFollowState?.(service, user, itemId, false);
      return buildResponse(command, 'unfollow', { action: 'unfollow', id: itemId });
    },
  };
}

function mapMountErrorToConfigError(err: unknown): number {
  const msg = String(err || '').toLowerCase();
  if (msg.includes('status_logon_failure') || msg.includes('permission denied')) {
    return 12;
  }
  if (msg.includes('no such file or directory')) {
    return 1;
  }
  if (
    msg.includes('host is down') ||
    msg.includes('no route to host') ||
    msg.includes('connection timed out') ||
    msg.includes('connection refused')
  ) {
    return 2;
  }
  return 2;
}
