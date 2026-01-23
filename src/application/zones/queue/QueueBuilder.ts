import type { PlaybackMetadata } from '@/application/playback/audioManager';
import { createQueueItem, normalizeSpotifyAudiopath, sanitizeStation } from '@/application/zones/helpers/queueHelpers';
import { clamp } from '@/application/zones/helpers/stateHelpers';
import type { QueueItem } from '@/ports/types/queueTypes';
import type { ContentPort } from '@/ports/ContentPort';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import type { ParentContext } from '@/application/zones/policies/ParentContextPolicy';
import type { QueueController as ZoneQueueController } from '@/application/zones/QueueController';

export type QueueBuildRequest = {
  zoneId: number;
  zoneName: string;
  uri: string;
  resolvedTarget: string;
  stationUri?: string;
  stationValue?: string;
  queueSourcePath: string;
  queueAudiopath: string;
  parentContext: ParentContext | null;
  isRadio: boolean;
  isAppleMusic: boolean;
  isDeezer?: boolean;
  isTidal?: boolean;
  isMusicAssistant: boolean;
  isLineIn?: boolean;
  queueBuildLimit?: number;
  startIndexHint?: number;
  startItemHint?: string;
  metadata?: PlaybackMetadata;
};

export type QueueBuildResult = {
  items: QueueItem[];
  startIndex: number;
  shouldFillInBackground: boolean;
  fillToken?: string;
  fillArgs?: { resolvedTarget: string; stationUri?: string; queueSourcePath: string; maxItems?: number };
  expandedCount: number;
  metadata?: PlaybackMetadata;
};

export async function buildQueueForRequest(args: {
  request: QueueBuildRequest;
  queueController: ZoneQueueController;
  content: ContentPort;
  audioHelpers: ZoneAudioHelpers;
  resolveMetadata?: () => Promise<PlaybackMetadata | undefined>;
}): Promise<QueueBuildResult> {
  const { request, queueController, content, audioHelpers, resolveMetadata } = args;
  const expandedQueue = await queueController.buildQueueForUri(
    request.resolvedTarget,
    request.zoneName,
    request.stationUri || undefined,
    request.queueSourcePath,
    request.queueBuildLimit ? { maxItems: request.queueBuildLimit } : undefined,
  );
  const enrichedMetadata = resolveMetadata ? await resolveMetadata() : request.metadata;
  const fallbackAudiopath = request.parentContext?.startItem ?? request.queueAudiopath;
  const queueAudioType = request.isLineIn
    ? 3
    : request.isMusicAssistant || request.isAppleMusic || request.isDeezer || request.isTidal
      ? 5
      : request.isRadio
        ? 1
        : 0;
  let queueItems = expandedQueue.length
    ? expandedQueue.map((item) => ({
      ...item,
      audiopath: request.isRadio ? audioHelpers.toRadioAudiopath(item.audiopath) : item.audiopath,
      audiotype: request.isRadio ? 1 : item.audiotype,
      station: request.parentContext?.parent
        ? request.isMusicAssistant
          ? request.parentContext.parent
          : sanitizeStation(request.parentContext.parent, item.audiopath)
        : item.station,
    }))
    : [
      createQueueItem(
        request.isRadio
          ? audioHelpers.toRadioAudiopath(fallbackAudiopath)
          : normalizeSpotifyAudiopath(fallbackAudiopath),
        request.zoneName,
        enrichedMetadata,
        queueAudioType,
        content.getDefaultSpotifyAccountId(),
      ),
    ];
  if (request.isRadio) {
    queueItems = queueItems.map((item) => ({
      ...item,
      title: '',
      artist: '',
      album: '',
      duration: 0,
      station: request.stationValue ?? item.station ?? '',
    }));
  }

  let startIndex = request.startIndexHint ?? 0;
  const startHint = request.startItemHint ?? normalizeSpotifyAudiopath(request.resolvedTarget);
  const normalizedStartHint = normalizeSpotifyAudiopath(startHint);
  const hintedIndex = queueItems.findIndex(
    (item) =>
      normalizeSpotifyAudiopath(item.audiopath) === normalizedStartHint ||
      normalizeSpotifyAudiopath(item.unique_id) === normalizedStartHint,
  );
  if (hintedIndex >= 0) {
    startIndex = hintedIndex;
  }
  const clampedIndex = clamp(startIndex, 0, queueItems.length - 1);
  const shouldFillInBackground =
    Boolean(request.queueBuildLimit && expandedQueue.length >= request.queueBuildLimit);
  const fillArgs = shouldFillInBackground
    ? {
      resolvedTarget: request.resolvedTarget,
      stationUri: request.stationUri || undefined,
      queueSourcePath: request.queueSourcePath,
      maxItems: request.queueBuildLimit,
    }
    : undefined;

  return {
    items: queueItems,
    startIndex: clampedIndex,
    shouldFillInBackground,
    fillArgs,
    expandedCount: expandedQueue.length,
    metadata: enrichedMetadata,
  };
}
