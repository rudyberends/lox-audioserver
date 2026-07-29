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
import { detectServiceFromAudiopath } from '@/domain/zones/audiopath';
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

/**
 * Which service a normalised source belongs to.
 *
 * `library` is how the store spells "not from a service", and this API says nothing rather
 * than inventing a name for local files. The stored value is a fallback only: it is right for
 * entries this server wrote itself and wrong for anything a Loxone client touched.
 */
/** A title that is really the zone's name is not a title; see toRecent. */
function titleWithoutZoneName(title: string, zoneName: string): string {
  const trimmed = title.trim();
  return trimmed && trimmed === zoneName.trim() ? '' : title;
}

function serviceFromSource(source: string, stored: string | undefined): string {
  const detected = detectServiceFromAudiopath(source);
  if (detected !== 'library') {
    return detected;
  }
  // `detectServiceFromAudiopath` never returns nothing: an unrecognised path falls through to
  // `library`, its catch-all. So `library` means "recognised as local" *or* "no idea", and the
  // two are worth telling apart. For something genuinely local this API says nothing rather
  // than inventing a name; only in the no-idea case is the stored value worth consulting.
  if (/(^|:)library(:|\/|$)/i.test(source.trim())) {
    return '';
  }
  const fallback = (stored ?? '').trim().toLowerCase();
  return fallback && fallback !== 'library' ? fallback : '';
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

function toRecent(
  item: RecentItem,
  registry: BridgeRegistry,
  zoneName: string,
): ApiRecentItem {
  const source = toPublicSource(item.audiopath, registry);
  return {
    source,
    // Entries written before the zone-name guard existed have the zone's own name stored as
    // the title: playback fills that field with it when a track has no metadata, and recents
    // copied it out of the live state. Suppress it rather than migrate the store — a blank
    // title is honest, and the artist and album beside it usually still identify the track.
    title: titleWithoutZoneName(item.title || item.name || '', zoneName),
    artist: item.artist ?? '',
    album: item.album ?? '',
    coverUrl: item.coverurl ?? '',
    // Derived from the normalised source rather than read from the store. The stored
    // `service` carries whatever the writer believed at the time, which for an entry written
    // while a Loxone client was driving is the Spotify disguise — so an Apple Music track came
    // back as `service: "spotify"` next to an `applemusic:` source that contradicted it.
    // The audiopath is the one field that knows.
    service: serviceFromSource(source, item.service),
  };
}

export function toApiRecents(
  zoneId: number,
  raw: { items: RecentItem[] },
  start: number,
  limit: number,
  registry: BridgeRegistry,
  /** The zone's own name, so a title that is really it can be recognised. */
  zoneName: string,
): ApiRecents {
  const from = Math.max(0, start);
  return {
    zoneId,
    items: raw.items
      .slice(from, from + Math.max(0, limit))
      .map((item) => toRecent(item, registry, zoneName)),
    start: from,
    total: raw.items.length,
  };
}
