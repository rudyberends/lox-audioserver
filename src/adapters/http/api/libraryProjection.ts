/**
 * Projects a zone's favourites and recently-played onto the public API contract.
 *
 * Both stores carry fields shaped for the Loxone clients — a favourite's `slot` and
 * `plus` describe a position in their button grid, and a recent item gets a `tag`,
 * `contentType` and numeric `type` so their strict schema accepts it. None of that says
 * anything about the favourite or the track, so none of it is reported here.
 *
 * The stored audiopath needs the same treatment and is easier to miss. Entries written while
 * a Loxone client was driving carry that client's disguise — `spotify@applemusic:…` on a
 * recent, `spotify:track:…` on a favourite that is really Apple Music — because the store
 * saves whatever form was in play. Handing that to a caller breaks the contract twice: it
 * names the wrong service, and `POST /play` cannot resolve it, so the call answers 204 and
 * the zone reports "Playback unavailable". Building our own player is what surfaced it.
 */
import type { ApiFavorite, ApiFavorites, ApiRecentItem, ApiRecents } from '@/domain/zones/apiTypes';
import type { FavoriteItem } from '@/application/zones/favorites/types';
import { toServiceNative, type BridgeRegistry } from '@/domain/zones/bridgeIdentity';
import type { RecentItem } from '@/application/zones/recents/recentsStore';

/**
 * The audiopath as this API promises it: service-native, whatever was stored.
 *
 * `toServiceNative` undoes a `spotify@bridge-…` prefix. The doubled form some entries carry
 * (`spotify@applemusic:applemusic:track:…`) is not a registered bridge id, so it needs
 * unwrapping separately — the prefix is stripped and what remains is already native.
 */
function toPublicSource(
  audiopath: string | undefined,
  registry: BridgeRegistry,
  owner?: unknown,
): string {
  const raw = (audiopath ?? '').trim();
  if (!raw) {
    return '';
  }
  // Order matters. A registered bridge prefix (`spotify@bridge-…:`) is `toServiceNative`'s
  // job and must reach it intact — stripping it first leaves a bare `track:xyz` with the
  // service gone. Only the doubled form, whose prefix is *not* a bridge id, is unwrapped
  // here, and what remains of it is already service-native.
  const native = toServiceNative(raw, registry);
  const doubled = /^spotify@(?!bridge-)[^:]+:(?=[a-z]+:)/i.exec(native);
  const unwrapped = doubled ? native.slice(doubled[0].length) : native;
  if (!/^spotify:/i.test(unwrapped)) {
    return unwrapped;
  }
  // A bare `spotify:` path with a bridge owner is the older, harder case: the disguise was
  // applied without the `@bridge-…` marker, so nothing in the path itself says otherwise and
  // `toServiceNative` has nothing to match. `owner` names the account that stored it, which
  // is the only remaining evidence — and without this the path stays unplayable, answering
  // 204 and leaving the zone on "Playback unavailable".
  const bridge = typeof owner === 'string' ? registry.byBridgeId.get(owner.trim()) : undefined;
  if (!bridge) {
    return unwrapped;
  }
  const single = (registry.accountCountByService.get(bridge.service) ?? 0) <= 1;
  const prefix = single ? bridge.service : `${bridge.service}:${bridge.slug}`;
  return `${prefix}:${unwrapped.slice('spotify:'.length)}`;
}

function toFavorite(item: FavoriteItem, registry: BridgeRegistry): ApiFavorite {
  return {
    id: item.id,
    name: item.name || item.title || '',
    source: toPublicSource(item.audiopath, registry, item.owner),
    coverUrl: item.coverurl ?? '',
  };
}

export function toApiFavorites(
  zoneId: number,
  raw: { items: FavoriteItem[]; start: number; totalitems: number },
  registry: BridgeRegistry,
): ApiFavorites {
  return {
    zoneId,
    items: raw.items.map((item) => toFavorite(item, registry)),
    start: raw.start,
    total: raw.totalitems,
  };
}

function toRecent(item: RecentItem, registry: BridgeRegistry): ApiRecentItem {
  return {
    source: toPublicSource(item.audiopath, registry),
    title: item.title || item.name || '',
    artist: item.artist ?? '',
    album: item.album ?? '',
    coverUrl: item.coverurl ?? '',
    // 'library' is how the store spells "not from a service"; say nothing instead.
    service: item.service && item.service !== 'library' ? item.service : '',
  };
}

export function toApiRecents(
  zoneId: number,
  raw: { items: RecentItem[] },
  start: number,
  limit: number,
  registry: BridgeRegistry,
): ApiRecents {
  const from = Math.max(0, start);
  return {
    zoneId,
    items: raw.items
      .slice(from, from + Math.max(0, limit))
      .map((item) => toRecent(item, registry)),
    start: from,
    total: raw.items.length,
  };
}
