import type { PlaybackMetadata, PlaybackSession } from '@/application/playback/audioManager';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import type { QueueAuthority, ZoneContext } from '@/application/zones/internal/zoneTypes';
import { normalizeSpotifyAudiopath } from '@/application/zones/helpers/queueHelpers';
import {
  fallbackTitle,
  isUriLike,
  resolveDisplayAudiotype,
  sanitizeTitle,
} from '@/application/zones/helpers/stateHelpers';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import { AudioType } from '@/domain/loxone/enums';
import type { QueueItem } from '@/ports/types/queueTypes';

export type InputMetadataPatchArgs = {
  metadata: Partial<PlaybackMetadata>;
  stateTitle: string | undefined;
  zoneName: string;
  currentItem?: QueueItem | null;
  currentIndex?: number;
  didSeek: boolean;
  queueAuthority?: QueueAuthority | null;
  stateIcontype?: number;
};

export function buildInputMetadataPatch(args: InputMetadataPatchArgs): Partial<LoxoneZoneState> {
  const {
    metadata,
    stateTitle,
    zoneName,
    currentItem,
    currentIndex,
    didSeek,
    queueAuthority,
    stateIcontype,
  } = args;
  const patch: Partial<LoxoneZoneState> = {};
  const assignPatch = (
    key: keyof Pick<LoxoneZoneState, 'title' | 'artist' | 'album' | 'coverurl' | 'audiopath'>,
    value?: string,
  ): void => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) {
      return;
    }
    patch[key] = trimmed;
  };

  assignPatch(
    'title',
    metadata.title ? sanitizeTitle(metadata.title, fallbackTitle(stateTitle, zoneName)) : undefined,
  );
  assignPatch('artist', metadata.artist);
  assignPatch('album', metadata.album);
  assignPatch('coverurl', metadata.coverurl as string | undefined);
  assignPatch('audiopath', metadata.audiopath);
  if (metadata.coverurl && typeof stateIcontype === 'number') {
    patch.icontype = undefined;
  }
  if (typeof metadata.duration === 'number' && metadata.duration > 0) {
    patch.duration = Math.round(metadata.duration);
  } else if (
    metadata.audiopath &&
    currentItem &&
    normalizeSpotifyAudiopath(metadata.audiopath) === normalizeSpotifyAudiopath(currentItem.audiopath) &&
    typeof currentItem.duration === 'number' &&
    currentItem.duration > 0
  ) {
    patch.duration = Math.round(currentItem.duration);
  }
  if (didSeek && currentItem && typeof currentIndex === 'number') {
    patch.qindex = currentIndex;
    patch.qid = currentItem.unique_id;
  }
  if (queueAuthority) {
    patch.queueAuthority = queueAuthority;
  }
  return patch;
}

export function buildActiveItemPatch(
  ctx: ZoneContext,
  audioHelpers: ZoneAudioHelpers,
): Partial<LoxoneZoneState> {
  if (ctx.alert) {
    const reportedDuration =
      typeof ctx.alert.reportedDurationSec === 'number' && ctx.alert.reportedDurationSec > 0
        ? Math.round(ctx.alert.reportedDurationSec)
        : undefined;
    return {
      title: ctx.alert.title,
      artist: '',
      album: '',
      coverurl: '',
      audiopath: ctx.alert.url,
      station: '',
      qindex: ctx.alert.snapshot.queue.currentIndex,
      qid: `alert-${ctx.id}`,
      audiotype: AudioType.File,
      ...(reportedDuration ? { duration: reportedDuration } : {}),
      type: audioHelpers.resolveAlertEventType(ctx.alert.type),
      sourceName: ctx.name,
    };
  }
  const current = ctx.queueController.current();
  if (!current) {
    return {};
  }
  const audiotype = audioHelpers.getStateAudiotype(ctx, current);
  const stationForState = current.audiotype === 1 || current.audiotype === 4 ? current.station : '';
  const patch: Partial<LoxoneZoneState> = {
    title: sanitizeTitle(current.title, fallbackTitle(ctx.state.title, ctx.name)),
    artist: current.artist,
    album: current.album,
    coverurl: current.coverurl,
    audiopath: current.audiopath,
    station: stationForState,
    qindex: ctx.queueController.currentIndex(),
    qid: current.unique_id,
    duration: typeof current.duration === 'number' ? Math.max(0, Math.round(current.duration)) : 0,
    type: audioHelpers.getStateFileType(),
    queueAuthority: ctx.queue.authority,
  };
  if (audiotype !== null) {
    // Resolve sourceName with the real audiotype (e.g. Spotify user name)
    // before remapping, so the display name is still correct.
    const sourceName = audioHelpers.resolveSourceName(audiotype, ctx, current);
    // The Loxone App treats AudioType.Spotify as a "live source" and hides
    // shuffle/repeat controls for it. For Loxone-controlled playback (not
    // Spotify Connect) report as Playlist so those controls are visible.
    patch.audiotype = resolveDisplayAudiotype(audiotype, ctx.queue.authority);
    if (sourceName) {
      patch.sourceName = sourceName;
    }
  }
  return patch;
}

export function buildStartedPatch(args: {
  ctx: ZoneContext;
  session: PlaybackSession | null | undefined;
  audioHelpers: ZoneAudioHelpers;
}): Partial<LoxoneZoneState> {
  const { ctx, session, audioHelpers } = args;
  const meta = session?.metadata ?? ({} as PlaybackMetadata);
  const radioControllable = ctx.metadata.radioControllable === true;
  const startTime = typeof session?.elapsed === 'number' && session.elapsed > 0 ? session.elapsed : 0;
  const basePatch: Partial<LoxoneZoneState> = {
    mode: 'play',
    clientState: 'on',
    power: 'on',
    // Avoid carrying over stale timing when a new session starts (e.g. alerts over paused content).
    time: startTime,
    title: sanitizeTitle(meta.title, fallbackTitle(ctx.state.title, ctx.name)),
    artist: meta.artist ?? ctx.state.artist,
    album: meta.album ?? ctx.state.album,
    coverurl: meta.coverurl ?? ctx.state.coverurl,
    audiopath: meta.audiopath ?? ctx.state.audiopath,
    queueAuthority: ctx.queue.authority,
    // Don't "max" against prior state: new tracks can be shorter than the previous one.
    duration:
      typeof meta.duration === 'number' && meta.duration > 0 ? Math.round(meta.duration) : ctx.state.duration,
  };
  if (radioControllable) {
    // Ensure radio-controllable sources (e.g. Radio Paradise) do not get treated as "radio state"
    // by position listeners, which would otherwise force duration/time to zero.
    basePatch.audiotype = AudioType.File;
    basePatch.type = audioHelpers.getStateFileType();
  }
  const activePatch = buildActiveItemPatch(ctx, audioHelpers);
  if (radioControllable) {
    delete activePatch.title;
    delete activePatch.artist;
    delete activePatch.album;
    delete activePatch.coverurl;
  }
  // The session metadata is authoritative for the track that is actually starting now.
  // Queue-item metadata can be stale due to a background-fill race or a cache entry
  // that hasn't been enriched yet. When the session provides valid title/artist,
  // restore them so the stale queue-item values don't win via the spread-last rule.
  const sessionTitle = sanitizeTitle(meta.title, '');
  if (sessionTitle) {
    activePatch.title = sessionTitle;
  }
  if (typeof meta.artist === 'string' && meta.artist.trim()) {
    activePatch.artist = meta.artist;
  }
  return { ...basePatch, ...activePatch };
}

export function buildResumedPatch(args: {
  ctx: ZoneContext;
  audioHelpers: ZoneAudioHelpers;
}): Partial<LoxoneZoneState> {
  const { ctx, audioHelpers } = args;
  const radioControllable = ctx.metadata.radioControllable === true;
  const activePatch = buildActiveItemPatch(ctx, audioHelpers);
  if (radioControllable) {
    delete activePatch.title;
    delete activePatch.artist;
    delete activePatch.album;
    delete activePatch.coverurl;
  }
  return {
    mode: 'play',
    clientState: 'on',
    power: 'on',
    ...activePatch,
  };
}

export function buildStoppedPatch(): Partial<LoxoneZoneState> {
  return { mode: 'stop', clientState: 'on', power: 'on', time: 0, duration: 0 };
}

export function buildPositionPatch(args: {
  time: number;
  duration: number;
  forceDurationZero?: boolean;
}): Partial<LoxoneZoneState> {
  if (args.forceDurationZero) {
    return { time: args.time, duration: 0 };
  }
  return {
    time: args.time,
    duration: args.duration > 0 ? args.duration : undefined,
  };
}

export function buildMetadataPatch(metadata: PlaybackMetadata): Partial<LoxoneZoneState> {
  const patch: Partial<LoxoneZoneState> = {};
  if (typeof metadata.title === 'string') {
    // Never let a service-native audiopath (or other uri-like value) leak into
    // the title; leave the field untouched so a good title isn't clobbered.
    if (!isUriLike(metadata.title)) {
      patch.title = metadata.title;
    }
  }
  if (typeof metadata.artist === 'string') {
    patch.artist = metadata.artist;
  }
  if (typeof metadata.album === 'string') {
    patch.album = metadata.album;
  }
  if (typeof metadata.coverurl === 'string') {
    patch.coverurl = metadata.coverurl;
  }
  if (typeof metadata.audiopath === 'string') {
    patch.audiopath = metadata.audiopath;
  }
  if (typeof metadata.duration === 'number' && metadata.duration > 0) {
    patch.duration = Math.round(metadata.duration);
  }
  return patch;
}

export function buildVolumePatch(volume: number): Partial<LoxoneZoneState> {
  return { volume };
}

export function buildQueueItemPlaybackPatch(
  ctx: ZoneContext,
  item: QueueItem,
  index: number,
  audioHelpers: ZoneAudioHelpers,
): Partial<LoxoneZoneState> {
  const stateAudiotype = audioHelpers.getStateAudiotype(ctx, item);
  const sourceName = audioHelpers.resolveSourceName(stateAudiotype ?? item.audiotype ?? null, ctx, item);
  const patch: Partial<LoxoneZoneState> = {
    // Sanitize: on the bridge-service fast path this queue-rebuild patch is the
    // LAST writer (rebuild runs as a detached background promise after the start
    // patch), so a raw service-native audiopath in item.title would overwrite the
    // correct started title. Mirrors buildMatchedOutputUriPatch.
    title: sanitizeTitle(item.title, fallbackTitle(ctx.state.title, ctx.name)),
    artist: item.artist,
    album: item.album,
    coverurl: item.coverurl,
    audiopath: item.audiopath,
    station: item.station,
    qindex: index,
    qid: item.unique_id,
    type: audioHelpers.getStateFileType(),
    duration: typeof item.duration === 'number' ? Math.max(0, Math.round(item.duration)) : 0,
  };
  if (stateAudiotype != null) {
    patch.audiotype = resolveDisplayAudiotype(stateAudiotype, ctx.queue.authority);
  }
  if (sourceName) {
    patch.sourceName = sourceName;
  }
  return patch;
}

export function buildMatchedOutputUriPatch(
  ctx: ZoneContext,
  item: QueueItem,
  index: number,
  audioHelpers: ZoneAudioHelpers,
): Partial<LoxoneZoneState> {
  const fallback = fallbackTitle(ctx.state.title, ctx.name);
  const patch: Partial<LoxoneZoneState> = {
    title: sanitizeTitle(item.title, fallback),
    artist: item.artist,
    album: item.album,
    coverurl: item.coverurl,
    audiopath: item.audiopath,
    station: item.station,
    qindex: index,
    qid: item.unique_id,
    type: audioHelpers.getStateFileType(),
    duration: typeof item.duration === 'number' ? Math.max(0, Math.round(item.duration)) : 0,
  };
  const stateAudiotype = audioHelpers.getStateAudiotype(ctx, item);
  if (stateAudiotype != null) {
    patch.audiotype = resolveDisplayAudiotype(stateAudiotype, ctx.queue.authority);
  }
  return patch;
}
