import type { ContentFolderItem } from '@/ports/ContentTypes';
import { encodeContainerId, encodeItemId } from '@/adapters/mediaserver/objectId';
import { audioOutputSettings, mp3BitrateToBps } from '@/ports/types/audioFormat';

/**
 * DIDL-Lite serialisation for the MediaServer ContentDirectory.
 *
 * A control point sends Browse and expects a `Result` string containing an
 * escaped `<DIDL-Lite>` document. We build that document from the same
 * `ContentFolderItem` shapes the content layer already produces for the Loxone
 * UI, mapping folders to `<container>` and tracks to `<item>` with a single
 * `http-get` `<res>` pointing at our stateless `/dlna/track/<id>` endpoint.
 *
 * The DLNA flags mirror the audio *output* path (OP=00, no seek; sender-paced
 * streaming) so a renderer treats a MediaServer pull exactly like the pushed
 * streams it already handles.
 */

const DIDL_OPEN =
  '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">';
const DIDL_CLOSE = '</DIDL-Lite>';

// protocolInfo for our MP3 stream. The DLNA.ORG_PN=MP3 profile name is
// load-bearing: strict sinks (B&O) validate the 4th field and refuse to adopt an
// item's DIDL as now-playing metadata when no recognized profile is present —
// which is why the browse queue showed metadata but the now-playing screen was
// empty. OP=00 (no byte-range seek) stays consistent with our `Accept-Ranges:
// none` chunked stream. This exact string must also appear on the track
// response's `contentFeatures.dlna.org` header and in ConnectionManager
// GetProtocolInfo, or a strict sink still rejects the resource.
// The DLNA feature string (4th field of protocolInfo). Shared with the track
// response's `contentFeatures.dlna.org` header and ConnectionManager
// GetProtocolInfo so all three advertise an identical, PN-tagged MP3 profile.
export const AUDIO_DLNA_FEATURES =
  'DLNA.ORG_PN=MP3;DLNA.ORG_OP=00;DLNA.ORG_CI=0;' +
  'DLNA.ORG_FLAGS=8D500000000000000000000000000000';
export const AUDIO_PROTOCOL_INFO = `http-get:*:audio/mpeg:${AUDIO_DLNA_FEATURES}`;

/** Loxone content type for a directly-playable file/track. Everything else browses. */
const CONTENT_TYPE_TRACK = 2;

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function isTrackItem(item: ContentFolderItem): boolean {
  // A track carries a playable audiopath and the "file" content type. Folders
  // (type 1/7/11/12…) browse further even when they expose a container audiopath.
  return item.type === CONTENT_TYPE_TRACK && !!item.audiopath;
}

function coverFor(item: ContentFolderItem, baseUrl: string): string | null {
  const raw = item.coverurl || item.thumbnail;
  if (!raw) {
    return null;
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  if (raw.startsWith('/')) {
    return `${baseUrl}${raw}`;
  }
  return null;
}

function formatDuration(seconds?: number): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  // DLNA res@duration wants H:MM:SS.mmm with an un-padded hour.
  return `${h}:${pad(m)}:${pad(s)}.000`;
}

// The engine transcodes MP3 at the configured output settings, so we advertise
// honest res descriptors. A strict renderer keys on size + audio attributes to
// accept the item as now-playing metadata.
const MP3_BITRATE_BPS = mp3BitrateToBps(audioOutputSettings.mp3Bitrate);
const MP3_SAMPLE_RATE = audioOutputSettings.sampleRate;
const MP3_CHANNELS = audioOutputSettings.channels;

/** Estimated byte size for a live transcode (bitrate × duration). */
function estimateSize(durationSeconds?: number): number | null {
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }
  return Math.round((MP3_BITRATE_BPS / 8) * durationSeconds);
}

export type DidlContainer = {
  id: string;
  parentId: string;
  title: string;
  /** Optional child count for controllers that show it. */
  childCount?: number;
  /** Optional absolute icon URL shown as the folder tile (upnp:albumArtURI). */
  iconUrl?: string;
};

export function buildContainerElement(container: DidlContainer): string {
  const childCountAttr =
    typeof container.childCount === 'number' ? ` childCount="${container.childCount}"` : '';
  const art = container.iconUrl
    ? `<upnp:albumArtURI>${escapeXml(container.iconUrl)}</upnp:albumArtURI>`
    : '';
  return (
    `<container id="${escapeXml(container.id)}" parentID="${escapeXml(container.parentId)}" ` +
    `restricted="1"${childCountAttr}>` +
    `<dc:title>${escapeXml(container.title)}</dc:title>` +
    art +
    '<upnp:class>object.container.storageFolder</upnp:class>' +
    '</container>'
  );
}

/**
 * Build a `<container>` for a browsable ContentFolderItem (a folder/playlist/album)
 * belonging to `service`. The item's native id becomes the child container id so a
 * follow-up Browse resolves straight back to the content layer.
 */
export function buildFolderContainer(
  item: ContentFolderItem,
  serviceKey: string,
  parentId: string,
): string {
  // The child container id must be the value the content layer accepts back as a
  // folderId on the next Browse. That is the listing item's `id` (e.g.
  // `library-local`, `library-nas-<n>-albums`), NOT its audiopath (`library:local`)
  // — the audiopath is a play target, not a browse key. Fall back to audiopath only
  // when an item has no id.
  const folderId = item.id || item.audiopath || 'root';
  return buildContainerElement({
    id: encodeContainerId(serviceKey, folderId),
    parentId,
    title: item.name || item.title || 'Folder',
    childCount: typeof item.items === 'number' ? item.items : undefined,
  });
}

/**
 * Build an `<item>` for a playable track. `baseUrl` is the absolute
 * `http://ip:7090` origin the renderer can reach; the res URL is the stateless
 * track endpoint keyed by the encoded audiopath.
 */
export function buildTrackItem(
  item: ContentFolderItem,
  parentId: string,
  baseUrl: string,
): string {
  const audiopath = item.audiopath ?? '';
  const objectId = encodeItemId(audiopath);
  const title = item.name || item.title || 'Track';
  const artist = item.artist || '';
  const album = item.album || '';
  const cover = coverFor(item, baseUrl);
  const duration = formatDuration(item.duration);
  const durationAttr = duration ? ` duration="${duration}"` : '';
  const resUrl = `${baseUrl}/dlna/track/${encodeURIComponent(objectId)}.mp3`;

  // res descriptors a strict renderer keys on. DLNA res@bitrate is BYTES/sec
  // (not bits). size is estimated from bitrate × duration for the live transcode.
  const size = estimateSize(item.duration);
  const sizeAttr = size ? ` size="${size}"` : '';
  const resAttrs =
    ` bitrate="${Math.round(MP3_BITRATE_BPS / 8)}"` +
    ` sampleFrequency="${MP3_SAMPLE_RATE}"` +
    ` nrAudioChannels="${MP3_CHANNELS}"`;

  const parts: string[] = [
    `<item id="${escapeXml(objectId)}" parentID="${escapeXml(parentId)}" restricted="1">`,
    `<dc:title>${escapeXml(title)}</dc:title>`,
  ];
  if (artist) {
    parts.push(`<dc:creator>${escapeXml(artist)}</dc:creator>`);
    parts.push(`<upnp:artist>${escapeXml(artist)}</upnp:artist>`);
  }
  if (album) {
    parts.push(`<upnp:album>${escapeXml(album)}</upnp:album>`);
  }
  if (cover) {
    parts.push(`<upnp:albumArtURI>${escapeXml(cover)}</upnp:albumArtURI>`);
  }
  parts.push('<upnp:class>object.item.audioItem.musicTrack</upnp:class>');
  parts.push(
    `<res${durationAttr}${sizeAttr}${resAttrs} ` +
      `protocolInfo="${AUDIO_PROTOCOL_INFO}">${escapeXml(resUrl)}</res>`,
  );
  parts.push('</item>');
  return parts.join('');
}

/** Wrap already-built container/item element strings in a DIDL-Lite document. */
export function wrapDidl(elements: string[]): string {
  return `${DIDL_OPEN}${elements.join('')}${DIDL_CLOSE}`;
}
