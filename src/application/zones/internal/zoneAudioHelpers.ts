import type { QueueItem, ZoneContext } from '@/application/zones/internal/zoneTypes';
import { normalizeSpotifyAudiopath, parseSpotifyUser } from '@/application/zones/helpers/queueHelpers';
import { AudioEventType, AudioType, FileType } from '@/domain/loxone/enums';
import { decodeAudiopath, detectServiceFromAudiopath, encodeAudiopath } from '@/domain/loxone/audiopath';
import { getMusicAssistantProviderId, getMusicAssistantUserId } from '@/application/zones/internal/musicAssistantProvider';
import type { ContentPort } from '@/ports/ContentPort';
import type { ConfigPort } from '@/ports/ConfigPort';

export type ZoneAudioHelpers = {
  isSpotifyAudiopath: (audiopath: string | null | undefined) => boolean;
  isAppleMusicAudiopath: (audiopath: string | null | undefined) => boolean;
  isDeezerAudiopath: (audiopath: string | null | undefined) => boolean;
  isTidalAudiopath: (audiopath: string | null | undefined) => boolean;
  isMusicAssistantAudiopath: (audiopath: string | null | undefined) => boolean;
  resolveBridgeProvider: (rawAudiopath: string | undefined | null) => string | null;
  getInputAudioType: (ctx: ZoneContext, audiopathOverride?: string) => number | null;
  getStateAudiotype: (ctx: ZoneContext, item?: QueueItem | null) => number | null;
  getStateFileType: () => number;
  isRadioAudiopath: (audiopath: string | undefined, audiotype?: number | null) => boolean;
  isLineInAudiopath: (audiopath: string | undefined) => boolean;
  parseLineInInputId: (audiopath: string | undefined) => string | null;
  toRadioAudiopath: (audiopath: string | undefined) => string;
  resolveAlertEventType: (type: string) => AudioEventType;
  deriveRadioStationLabel: (audiopath: string | undefined) => string | undefined;
  isLikelyHostLabel: (value: string) => boolean;
  resolveSourceName: (
    audiotype: number | null | undefined,
    ctx: ZoneContext,
    current?: QueueItem | null,
  ) => string | undefined;
};

export function createZoneAudioHelpers(
  contentPort: ContentPort,
  configPort: ConfigPort,
): ZoneAudioHelpers {
  return {
    isSpotifyAudiopath: (audiopath) => isSpotifyAudiopath(audiopath, contentPort),
    isAppleMusicAudiopath: (audiopath) => isAppleMusicAudiopath(audiopath, contentPort),
    isDeezerAudiopath: (audiopath) => isDeezerAudiopath(audiopath, contentPort),
    isTidalAudiopath: (audiopath) => isTidalAudiopath(audiopath, contentPort),
    isMusicAssistantAudiopath,
    resolveBridgeProvider: (rawAudiopath) => resolveBridgeProvider(rawAudiopath, configPort),
    getInputAudioType,
    getStateAudiotype,
    getStateFileType,
    isRadioAudiopath,
    isLineInAudiopath,
    parseLineInInputId,
    toRadioAudiopath,
    resolveAlertEventType,
    deriveRadioStationLabel,
    isLikelyHostLabel,
    resolveSourceName,
  };
}

export function isSpotifyAudiopath(
  audiopath: string | null | undefined,
  contentPort: ContentPort,
): boolean {
  if (!audiopath) {
    return false;
  }
  const decoded = decodeAudiopath(audiopath) || audiopath;
  const lower = decoded.toLowerCase();
  if (lower.includes('musicassistant')) {
    return false;
  }
  if (isAppleMusicAudiopath(decoded, contentPort)) {
    return false;
  }
  if (isDeezerAudiopath(decoded, contentPort)) {
    return false;
  }
  if (isTidalAudiopath(decoded, contentPort)) {
    return false;
  }
  return lower.includes('spotify:') || lower.startsWith('spotify@');
}

export function isAppleMusicAudiopath(
  audiopath: string | null | undefined,
  contentPort: ContentPort,
): boolean {
  if (!audiopath) {
    return false;
  }
  const raw = String(audiopath);
  const rawProvider = raw.split(':')[0] ?? '';
  if (rawProvider && contentPort.isAppleMusicProvider(rawProvider)) {
    return true;
  }
  if (raw.toLowerCase().includes('applemusic')) {
    return true;
  }
  const decoded = decodeAudiopath(raw) || raw;
  const providerSegment = decoded.split(':')[0] ?? '';
  if (providerSegment && contentPort.isAppleMusicProvider(providerSegment)) {
    return true;
  }
  return decoded.toLowerCase().includes('applemusic');
}

export function isDeezerAudiopath(
  audiopath: string | null | undefined,
  contentPort: ContentPort,
): boolean {
  if (!audiopath) {
    return false;
  }
  const raw = String(audiopath);
  const rawProvider = raw.split(':')[0] ?? '';
  if (rawProvider && contentPort.isDeezerProvider(rawProvider)) {
    return true;
  }
  if (raw.toLowerCase().includes('deezer')) {
    return true;
  }
  const decoded = decodeAudiopath(raw) || raw;
  const providerSegment = decoded.split(':')[0] ?? '';
  if (providerSegment && contentPort.isDeezerProvider(providerSegment)) {
    return true;
  }
  return decoded.toLowerCase().includes('deezer');
}

export function isTidalAudiopath(
  audiopath: string | null | undefined,
  contentPort: ContentPort,
): boolean {
  if (!audiopath) {
    return false;
  }
  const raw = String(audiopath);
  const rawProvider = raw.split(':')[0] ?? '';
  if (rawProvider && contentPort.isTidalProvider(rawProvider)) {
    return true;
  }
  if (raw.toLowerCase().includes('tidal')) {
    return true;
  }
  const decoded = decodeAudiopath(raw) || raw;
  const providerSegment = decoded.split(':')[0] ?? '';
  if (providerSegment && contentPort.isTidalProvider(providerSegment)) {
    return true;
  }
  return decoded.toLowerCase().includes('tidal');
}

export function isMusicAssistantAudiopath(audiopath: string | null | undefined): boolean {
  const providerLower = getMusicAssistantProviderId().toLowerCase();
  const userLower = getMusicAssistantUserId().toLowerCase();
  const matches = (value: string | null | undefined): boolean => {
    if (!value) {
      return false;
    }
    const lower = value.toLowerCase();
    if (lower.startsWith('musicassistant://') || lower.startsWith('musicassistant:') || lower.startsWith('musicassistant@')) {
      return true;
    }
    if (providerLower && (lower.startsWith(providerLower) || lower.startsWith(`${providerLower}:`))) {
      return true;
    }
    if (userLower && (lower.startsWith(`spotify@${userLower}`) || lower.startsWith(`musicassistant@${userLower}`))) {
      return true;
    }
    return lower.includes('musicassistant');
  };
  if (matches(audiopath)) {
    return true;
  }
  const decoded = decodeAudiopath(audiopath ?? '');
  return matches(decoded || audiopath || '');
}

/** Resolve a bridge provider from an audiopath like spotify@bridge-<provider>-xyz:... */
export function resolveBridgeProvider(
  rawAudiopath: string | undefined | null,
  configPort: ConfigPort,
): string | null {
  const raw = (rawAudiopath || '').toLowerCase();
  const match = /^spotify@([^:]+):/.exec(raw);
  const bridgeId = match?.[1] ?? null;
  if (!bridgeId) {
    return null;
  }
  // First, try exact bridge lookup from config.
  try {
    const cfg = configPort.getConfig();
    const bridges = cfg?.content?.spotify?.bridges ?? [];
    const bridge = bridges.find((b: any) => String(b?.id ?? '').toLowerCase() === bridgeId);
    const provider = String(bridge?.provider ?? '').trim().toLowerCase();
    if (provider) {
      return provider;
    }
  } catch {
    /* ignore */
  }
  // Fallback: derive provider from id pattern bridge-<provider>-...
  const inferred = /^bridge-([a-z0-9]+)-/.exec(bridgeId)?.[1];
  return inferred || null;
}

export function getInputAudioType(ctx: ZoneContext, audiopathOverride?: string): number | null {
  const current = ctx.queueController.current();
  const audiopath = audiopathOverride ?? current?.audiopath ?? ctx.state.audiopath ?? '';
  const lowerAudiopath = audiopath.toLowerCase();
  const maProvider = getMusicAssistantProviderId().toLowerCase();
  const maUser = getMusicAssistantUserId().toLowerCase();
  const isBridgeProvider = /^spotify@bridge-[^:]+:/i.test(lowerAudiopath);
  const isBridgeApple = isBridgeProvider && /bridge-applemusic/i.test(lowerAudiopath);
  const isBridgeDeezer = isBridgeProvider && /bridge-deezer/i.test(lowerAudiopath);
  const isBridgeTidal = isBridgeProvider && /bridge-tidal/i.test(lowerAudiopath);
  // Prefer the active input mode when available, otherwise fall back to URI heuristics.
  if (ctx.inputMode === 'airplay' || audiopath.startsWith('airplay://')) {
    return 4;
  }
  if (ctx.inputMode === 'linein' || audiopath.startsWith('linein://')) {
    return 3;
  }
  if (isBridgeProvider) {
    return AudioType.Spotify;
  }
  if (lowerAudiopath.includes('applemusic') || isBridgeApple) {
    return AudioType.Playlist;
  }
  if (lowerAudiopath.includes('deezer') || isBridgeDeezer) {
    return AudioType.Playlist;
  }
  if (lowerAudiopath.includes('tidal') || isBridgeTidal) {
    return AudioType.Playlist;
  }
  if (
    ctx.inputMode === 'musicassistant' ||
    lowerAudiopath.startsWith('musicassistant://') ||
    lowerAudiopath.startsWith('musicassistant:') ||
    (maProvider && lowerAudiopath.startsWith(maProvider)) ||
    (maUser && lowerAudiopath.startsWith(`spotify@${maUser}`)) ||
    (maUser && lowerAudiopath.startsWith(`musicassistant@${maUser}`)) ||
    lowerAudiopath.includes('musicassistant')
  ) {
    return AudioType.Playlist;
  }
  if (ctx.inputMode === 'spotify' || audiopath.startsWith('spotify://') || audiopath.startsWith('spotify:')) {
    return AudioType.Spotify;
  }
  if (detectServiceFromAudiopath(audiopath) === 'radio') {
    return AudioType.Radio;
  }
  return null;
}

export function getStateAudiotype(ctx: ZoneContext, item?: QueueItem | null): number | null {
  const audiopath = item?.audiopath ?? ctx.queueController.current()?.audiopath ?? ctx.state.audiopath ?? '';
  if (/^spotify@bridge-[^:]+:track:/i.test(audiopath)) {
    return AudioType.Spotify;
  }
  const resolved = getInputAudioType(ctx, audiopath);
  if (resolved != null) {
    return resolved;
  }
  return item?.audiotype ?? ctx.state.audiotype ?? null;
}

export function getStateFileType(): number {
  return FileType.File;
}

export function isRadioAudiopath(audiopath: string | undefined, audiotype?: number | null): boolean {
  const raw = (audiopath ?? '').trim();
  const lower = raw.toLowerCase();
  if (lower.startsWith('airplay://')) {
    return false;
  }
  if (audiotype === 1 || audiotype === 4) {
    return true;
  }
  if (!raw) {
    return false;
  }
  if (detectServiceFromAudiopath(raw) === 'radio') {
    return true;
  }
  const decoded = decodeAudiopath(raw);
  if (!decoded) {
    return false;
  }
  return detectServiceFromAudiopath(decoded) === 'radio';
}

export function isLineInAudiopath(audiopath: string | undefined): boolean {
  const raw = (audiopath ?? '').trim().toLowerCase();
  return raw.startsWith('linein:') || raw.startsWith('linein://');
}

export function parseLineInInputId(audiopath: string | undefined): string | null {
  if (!audiopath) {
    return null;
  }
  const decoded = decodeAudiopath(audiopath) || audiopath;
  const match = decoded.trim().match(/^linein:(?:\/\/)?(.+)$/i);
  if (!match || !match[1]) {
    return null;
  }
  const inputId = match[1].trim();
  return inputId.length ? inputId : null;
}

export function toRadioAudiopath(audiopath: string | undefined): string {
  const raw = (audiopath ?? '').trim();
  if (!raw) {
    return '';
  }
  const lower = raw.toLowerCase();
  if (lower.startsWith('tunein:') || lower.startsWith('radio:')) {
    return raw;
  }
  return encodeAudiopath(raw, 'station', 'tunein', true);
}

export function resolveAlertEventType(type: string): AudioEventType {
  switch (type.toLowerCase()) {
    case 'bell':
      return AudioEventType.Bell;
    case 'buzzer':
      return AudioEventType.Buzzer;
    case 'tts':
      return AudioEventType.TTS;
    case 'error_tts':
    case 'error-tts':
      return AudioEventType.ErrorTTS;
    case 'uploaded':
      return AudioEventType.UploadedFile;
    case 'alarm':
      return AudioEventType.Alarm;
    case 'fire':
    case 'firealarm':
      return AudioEventType.Fire;
    case 'identify':
      return AudioEventType.Identify;
    default:
      return AudioEventType.Unknown;
  }
}

export function deriveRadioStationLabel(audiopath: string | undefined): string | undefined {
  const raw = (audiopath ?? '').trim();
  if (!raw) {
    return undefined;
  }
  const decoded = decodeAudiopath(raw) ?? raw;
  if (!/^https?:\/\//i.test(decoded)) {
    return undefined;
  }
  try {
    const url = new URL(decoded);
    const host = url.hostname.replace(/^www\./i, '').trim();
    return host || undefined;
  } catch {
    return undefined;
  }
}

export function isLikelyHostLabel(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/\s/.test(trimmed)) {
    return false;
  }
  return /^[a-z0-9.-]+$/i.test(trimmed) && trimmed.includes('.');
}

export function resolveSourceName(
  audiotype: number | null | undefined,
  ctx: ZoneContext,
  current?: QueueItem | null,
): string | undefined {
  if (audiotype === null) {
    return undefined;
  }
  if (audiotype === 4) {
    return ctx.name;
  }
  if (audiotype === 5) {
    const raw =
      current?.audiopath ??
      ctx.queueController.current()?.audiopath ??
      ctx.state.audiopath ??
      '';
    if (ctx.inputMode === 'musicassistant') {
      return stripSpotifyPrefix(getMusicAssistantProviderId()) || 'musicassistant';
    }
    const user =
      (current?.user && current.user !== 'nouser' ? current.user : undefined) ??
      (() => {
        const parsed = parseSpotifyUser(normalizeSpotifyAudiopath(raw));
        return parsed && parsed !== 'nouser' ? parsed : undefined;
      })();
    return user ?? 'nouser';
  }
  return ctx.sourceMac;
}

export function stripSpotifyPrefix(value: string): string {
  if (!value) {
    return value;
  }
  return value.toLowerCase().startsWith('spotify@') ? value.slice('spotify@'.length) : value;
}
