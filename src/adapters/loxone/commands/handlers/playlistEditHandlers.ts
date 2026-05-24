import type { ContentManager } from '@/adapters/content/contentManager';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import { splitCommand, decodeSegment } from '@/adapters/loxone/commands/utils/commandUtils';
import { buildEmptyResponse, buildResponse } from '@/adapters/loxone/commands/responses';
import {
  BASE_PLAYLIST,
  decodeLoxoneId,
  encodeLoxoneId,
} from '@/adapters/loxone/commands/utils/loxoneIdCodec';
import { buildPlaylistTrackItem } from '@/adapters/loxone/commands/handlers/providerHandlers';
import { createLogger } from '@/shared/logging/logger';

const log = createLogger('Loxone', 'PlaylistEdit');

interface ParsedPlaylistCommand {
  service: string;
  user: string;
  rest: string[];
}

function parsePrefix(command: string): ParsedPlaylistCommand {
  const parts = splitCommand(command);
  // audio/cfg/playlist/<action>/<service>/<user>/...
  // The LocalPlaylistRepository on the client uses lowercase `nouser` in its
  // service config; the URL also sends `nouser` lowercase. Match it verbatim.
  const rawUser = parts[5] ?? '';
  return {
    service: parts[4] ?? '',
    user: rawUser || 'nouser',
    rest: parts.slice(6),
  };
}

/**
 * Library audiopaths use standard base64 which may contain `/`. The Loxone
 * client embeds these unencoded in URLs (`.../additem:library:local:track:b64_x/y`)
 * which `splitCommand` would shred. Reassemble everything after `rest[0]`
 * (the playlist id) back into a single action+arg string.
 */
function reassembleAction(rest: string[]): string {
  return rest.slice(1).join('/');
}

/**
 * Resolves a playlist-item argument (sent by the client in remove/move URLs) to a
 * 0-based position within the playlist. The modern Loxone client sends the raw
 * track audiopath (e.g. `library:local:track:b64_…`); older paths may send the
 * Loxone-encoded id where the offset carries the slot.
 */
async function resolveTrackPosition(
  contentManager: ContentManager,
  playlistId: number,
  rawItemId: string,
): Promise<number | null> {
  const decoded = decodeLoxoneId(rawItemId);
  if (decoded && typeof decoded.offset === 'number') {
    const slot = decoded.offset - BASE_PLAYLIST;
    if (Number.isFinite(slot) && slot >= 0) {
      return slot;
    }
  }
  const folder = await contentManager.getLocalPlaylistItems(playlistId, 0, 1_000);
  const items = folder?.items ?? [];
  const idx = items.findIndex((item) => (item.audiopath ?? item.id) === rawItemId);
  return idx >= 0 ? idx : null;
}

/**
 * Splits the update action portion (everything after the playlist id).
 * Modern client forms:
 *   start | finish | finishnochanges                  (no args)
 *   additem:<audiopath> | addbrowsable:<containerId>  (colon-joined arg)
 *   removeById/<itemId>                                (slash-separated arg)
 *   moveById/<itemId>/before/<targetItemId|"end">     (slash-separated args)
 */
function parseUpdateAction(rest: string[]): { cmd: string; args: string[] } | null {
  const raw = reassembleAction(rest);
  if (!raw) return null;

  const colonIdx = raw.indexOf(':');
  if (colonIdx > 0) {
    const cmd = raw.slice(0, colonIdx);
    if (cmd === 'additem' || cmd === 'addbrowsable') {
      return { cmd, args: [raw.slice(colonIdx + 1)] };
    }
  }

  const segments = raw.split('/');
  const [cmd = '', ...args] = segments;
  return { cmd, args };
}

function isLocal(service: string): boolean {
  return service === 'lms';
}

/**
 * Accepts either a Loxone-encoded id (base64url JSON tuple) or a plain numeric id.
 */
function resolvePlaylistId(raw: string): number | null {
  if (!raw) return null;
  const decoded = decodeLoxoneId(raw);
  if (decoded) {
    const value = Number(decoded.data);
    return Number.isFinite(value) ? value : null;
  }
  const numeric = Number.parseInt(raw, 10);
  return Number.isFinite(numeric) ? numeric : null;
}

export function createPlaylistEditHandlers(
  contentManager: ContentManager,
  notifier: LoxoneWsNotifier,
) {
  return {
    create: (command: string) => {
      const { service, user, rest } = parsePrefix(command);
      if (!isLocal(service)) {
        return buildEmptyResponse(command);
      }
      const name = decodeSegment(rest[0]);
      const playlist = contentManager.createLocalPlaylist(name);
      const encodedId = encodeLoxoneId(Number(playlist.id), BASE_PLAYLIST);
      notifier.notifyPlaylistChanged({
        action: 'create',
        playlistid: encodedId,
        audiopath: encodedId,
        cmd: service,
        user,
        name: playlist.name,
      }, command);
      return buildResponse(command, 'playlist', [
        { audiopath: encodedId, name: playlist.name, playlistid: encodedId },
      ]);
    },

    rename: (command: string) => {
      const { service, user, rest } = parsePrefix(command);
      if (!isLocal(service)) {
        return buildEmptyResponse(command);
      }
      const idStr = decodeSegment(rest[0]);
      const newName = decodeSegment(reassembleAction(rest));
      const playlistId = resolvePlaylistId(idStr);
      if (playlistId === null) {
        return buildResponse(command, 'playlist',[{ action: 'failed' }]);
      }
      const playlist = contentManager.renameLocalPlaylist(playlistId, newName);
      if (!playlist) {
        return buildResponse(command, 'playlist', [{ action: 'failed' }]);
      }
      const encodedId = encodeLoxoneId(playlistId, BASE_PLAYLIST);
      notifier.notifyPlaylistChanged({
        action: 'rename',
        playlistid: encodedId,
        audiopath: encodedId,
        cmd: service,
        user,
        name: playlist.name,
      }, command);
      return buildResponse(command, 'playlist', [{ action: 'rename', name: playlist.name }]);
    },

    deleteList: (command: string) => {
      const { service, user, rest } = parsePrefix(command);
      if (!isLocal(service)) {
        return buildEmptyResponse(command);
      }
      const idStr = decodeSegment(rest[0]);
      const playlistId = resolvePlaylistId(idStr);
      if (playlistId === null) {
        return buildResponse(command, 'playlist',[{ items: [] }]);
      }
      const removed = contentManager.deleteLocalPlaylist(playlistId);
      if (removed) {
        const encodedId = encodeLoxoneId(playlistId, BASE_PLAYLIST);
        // Omit `command` for fire-and-forget actions (DeletePlaylistSchema has
        // `shouldWaitForResponse: false`). Including it makes the client treat
        // the broadcast as a stale response (the URL stays in sentMessages until
        // a 20s timeout), so event listeners never fire and the UI doesn't
        // refresh.
        notifier.notifyPlaylistChanged({
          action: 'delete',
          playlistid: encodedId,
          audiopath: encodedId,
          cmd: service,
          user,
        });
      }
      return buildResponse(command, 'playlist', [{ action: 'delete' }]);
    },

    update: async (command: string) => {
      const { service, user, rest } = parsePrefix(command);
      if (!isLocal(service)) {
        return buildEmptyResponse(command);
      }
      const idStr = decodeSegment(rest[0]);
      const playlistId = resolvePlaylistId(idStr);
      const parsed = parseUpdateAction(rest);
      if (playlistId === null || !parsed) {
        return buildResponse(command, 'playlist',[{ action: 'failed' }]);
      }
      const encodedId = encodeLoxoneId(playlistId, BASE_PLAYLIST);
      const { cmd, args } = parsed;
      const arg = args[0] ?? '';

      switch (cmd) {
        case 'start':
        case 'finish':
        case 'finishnochanges': {
          const playlist = contentManager.getLocalPlaylist(playlistId);
          // The Loxone client only honours START/UPDATE/CREATE/RENAME/DELETE in
          // its playlistchanged_event handler. Send `start` for start (used as a
          // conflict check), but send `update` for finish/finishnochanges so the
          // client invalidates its cached playlist contents after edit mode ends.
          // Omit `command` for finishnochanges (shouldWaitForResponse: false) so
          // the client doesn't treat the broadcast as a stale response.
          const includeCommand = cmd !== 'finishnochanges';
          notifier.notifyPlaylistChanged({
            action: cmd === 'start' ? 'start' : 'update',
            playlistid: encodedId,
            audiopath: encodedId,
            cmd: service,
            user,
            name: playlist?.name,
          }, includeCommand ? command : undefined);
          return buildResponse(command, 'playlist',[{ action: 'ok' }]);
        }
        case 'additem':
        case 'addbrowsable': {
          const added = await contentManager.addItemsToLocalPlaylist(playlistId, arg);
          const folder = await contentManager.getLocalPlaylistItems(playlistId, 0, 500);
          const items = (folder?.items ?? []).map((track, idx) =>
            buildPlaylistTrackItem(track, idx, playlistId),
          );
          log.debug('playlist update add', {
            playlistId,
            cmd,
            arg,
            added,
            total: folder?.totalitems,
          });
          notifier.notifyPlaylistChanged({
            action: 'update',
            playlistid: encodedId,
            audiopath: encodedId,
            cmd: service,
            user,
          }, command);
          return buildResponse(command, 'playlist',[{ action: 'ok', items }]);
        }
        case 'removeById': {
          const position = await resolveTrackPosition(contentManager, playlistId, arg);
          if (position === null) {
            log.debug('removeById: could not resolve position', { arg });
            return buildResponse(command, 'playlist', [{ action: 'failed' }]);
          }
          contentManager.removeLocalPlaylistItem(playlistId, position);
          notifier.notifyPlaylistChanged({
            action: 'update',
            playlistid: encodedId,
            audiopath: encodedId,
            cmd: service,
            user,
          }, command);
          return buildResponse(command, 'playlist', [{ action: 'ok' }]);
        }
        case 'moveById': {
          // args: [<srcItemId>, 'before', <targetItemId>|'end']
          const fromPos = await resolveTrackPosition(contentManager, playlistId, args[0] ?? '');
          const target = args[2] ?? 'end';
          if (fromPos === null) {
            return buildResponse(command, 'playlist', [{ action: 'failed' }]);
          }
          let toPos: number;
          if (target === 'end') {
            const folder = await contentManager.getLocalPlaylistItems(playlistId, 0, 1);
            toPos = Math.max(0, (folder?.totalitems ?? 1) - 1);
          } else {
            const targetPos = await resolveTrackPosition(contentManager, playlistId, target);
            if (targetPos === null) {
              return buildResponse(command, 'playlist', [{ action: 'failed' }]);
            }
            // Move "before" target → if moving forward, target slot becomes (targetPos - 1)
            // after the source is removed; if moving backward, target stays at targetPos.
            toPos = targetPos > fromPos ? targetPos - 1 : targetPos;
          }
          contentManager.moveLocalPlaylistItem(playlistId, fromPos, toPos);
          notifier.notifyPlaylistChanged({
            action: 'update',
            playlistid: encodedId,
            audiopath: encodedId,
            cmd: service,
            user,
          }, command);
          return buildResponse(command, 'playlist', [{ action: 'ok' }]);
        }
        default:
          log.debug('unknown playlist update command', { cmd, arg });
          return buildResponse(command, 'playlist',[{ action: 'ok' }]);
      }
    },
  };
}
