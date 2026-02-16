import { createLogger } from '@/shared/logging/logger';
import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import { decodeAudiopath } from '@/domain/loxone/audiopath';
import { RADIO_PARADISE_LABELS, RADIO_PARADISE_STREAMS } from '@/domain/radioparadise/stations';

const API_PLAY_URL = 'https://api.radioparadise.com/api/play';
const COVER_BASE_URL = 'https://img.radioparadise.com/';
const DEFAULT_BITRATE = 4; // FLAC
const NOW_PLAYING_INTERVAL_MS = 10000;
const URL_PROBE_TIMEOUT_MS = 1500;

type RadioParadiseTrack = {
  startSec: number;
  durationSec: number;
  artist: string;
  title: string;
  album: string;
  year?: number;
  coverurl?: string;
  gaplessUrl?: string;
  /** Elapsed seconds into the current song (now_playing API only). */
  elapsedSec?: number;
};

type RadioParadiseBlock = {
  url: string;
  lengthSec: number;
  endEvent?: string;
  eventId?: string;
  cueSec?: number;
  expiresAtMs?: number;
  tracks: RadioParadiseTrack[];
};

type RadioParadiseSession = {
  stationId: string;
  current: RadioParadiseBlock;
  next?: RadioParadiseBlock;
  previous?: RadioParadiseBlock;
  lastSignature?: string;
  timer?: NodeJS.Timeout;
  mode: 'block' | 'nowPlaying';
  nowPlayingUrl?: string;
  nowPlayingPending?: boolean;
  lastNowPlayingAt?: number;
  blockProbePending?: boolean;
  lastBlockProbeAt?: number;
  trackMode?: boolean;
  currentTrackIndex?: number;
};

type ResolveResult = {
  url: string;
  startAtSec: number;
  blockDurationSec: number;
  track?: RadioParadiseTrack;
  stationLabel: string;
  isRadio: boolean;
};

export class RadioParadiseBlockService {
  private readonly log = createLogger('Audio', 'RadioParadiseBlock');
  private readonly sessions = new Map<number, RadioParadiseSession>();
  private readonly pollIntervalMs = 5000;
  private readonly timeoutMs = 8000;
  private readonly blockProbeIntervalMs = 30_000;

  constructor(
    private readonly deps: {
      getZone: (zoneId: number) => ZoneContext | undefined;
      updateRadioMetadata: (
        zoneId: number,
        metadata: { title: string; artist: string; coverurl?: string; duration?: number; controllable?: boolean },
      ) => void;
    },
  ) {}

  public isRadioParadiseAudiopath(audiopath: string): boolean {
    const raw = audiopath.trim();
    if (!raw) return false;
    if (/^radioparadise:(?:\/\/)?/i.test(raw)) {
      return true;
    }
    const decoded = decodeAudiopath(raw) || raw;
    return /^radioparadise:(?:\/\/)?/i.test(decoded);
  }

  public parseStationId(audiopath: string): string | null {
    const raw = audiopath.trim();
    if (!raw) return null;
    const decoded = decodeAudiopath(raw) || raw;
    const match = /^radioparadise:(?:\/\/)?(.+)$/.exec(decoded);
    if (!match || !match[1]) return null;
    const stationId = match[1].split(/[/?#]/)[0]?.trim();
    return stationId ? stationId.toLowerCase() : null;
  }

  public stationLabel(stationId: string | null | undefined): string {
    if (!stationId) return 'Radio Paradise';
    return RADIO_PARADISE_LABELS.get(stationId) || 'Radio Paradise';
  }

  public async resolveStart(zoneId: number, stationId: string): Promise<ResolveResult | null> {
    let block = await this.fetchBlock(stationId);
    if (block) {
      const cueSec =
        typeof block.cueSec === 'number' && block.cueSec >= 0
          ? block.cueSec
          : block.tracks[0]?.startSec ?? 0;

      let cueIndex = this.findTrackIndex(block.tracks, cueSec);
      let pickedIndex = await this.findPlayableTrackIndex(block, cueIndex, 1);
      if (pickedIndex === null && block.endEvent) {
        // Some blocks may resolve to DJ/promo assets that are not playable as FLAC in certain regions.
        // In that case, skip ahead to the next block.
        const next = await this.fetchBlock(stationId, block.endEvent);
        if (next) {
          block = next;
          cueIndex = 0;
          pickedIndex = await this.findPlayableTrackIndex(block, cueIndex, 1);
        }
      }

      const pickedTrack = pickedIndex !== null ? block.tracks[pickedIndex] : undefined;
      const useGapless = Boolean(pickedTrack?.gaplessUrl);
      const startAtSec = useGapless ? 0 : pickedTrack?.startSec ?? cueSec;
      const durationSec =
        useGapless && pickedTrack?.durationSec ? pickedTrack.durationSec : block.lengthSec;
      const url = useGapless && pickedTrack?.gaplessUrl ? pickedTrack.gaplessUrl : block.url;

      if (this.isRiskyAudioUrl(url) && !(await this.probeUrl(url))) {
        block = null;
      } else {
        const session: RadioParadiseSession = {
          stationId,
          current: block,
          mode: 'block',
          trackMode: useGapless,
          currentTrackIndex: pickedIndex !== null ? pickedIndex : undefined,
        };
        this.sessions.set(zoneId, session);
        this.prefetchNext(zoneId, session).catch(() => undefined);
        this.ensureTicker(zoneId);

        const firstTrack = pickedTrack ?? this.trackAtTime(block, cueSec) ?? undefined;
        return {
          url,
          startAtSec,
          blockDurationSec: durationSec || block.lengthSec,
          track: firstTrack,
          stationLabel: this.stationLabel(stationId),
          isRadio: false,
        };
      }
    }

    const fallback = this.resolveStream(stationId);
    if (!fallback) {
      return null;
    }
    const track = await this.fetchNowPlayingTrack(stationId);
    const blockFallback: RadioParadiseBlock = {
      url: this.appendSrc(fallback.streamUrl),
      lengthSec: 0,
      tracks: track ? [track] : [],
    };
    const session: RadioParadiseSession = {
      stationId,
      current: blockFallback,
      mode: 'nowPlaying',
      nowPlayingUrl: fallback.nowPlayingUrl,
    };
    this.sessions.set(zoneId, session);
    this.ensureTicker(zoneId);
    if (track) {
      // Best-effort: now_playing doesn't provide duration, but api/play often does.
      void this.tryEnrichNowPlayingDuration(zoneId, session, track);
    }
    return {
      url: blockFallback.url,
      startAtSec: 0,
      blockDurationSec: 0,
      track: track ?? undefined,
      stationLabel: this.stationLabel(stationId),
      isRadio: true,
    };
  }

  public async resolveSkip(
    zoneId: number,
    currentTimeSec: number,
    delta: 1 | -1,
  ): Promise<ResolveResult | null> {
    const session = this.sessions.get(zoneId);
    if (!session || session.mode !== 'block') return null;

    let block = session.current;
    if (session.trackMode && typeof session.currentTrackIndex === 'number') {
      const startIndex = session.currentTrackIndex + delta;
      const pickedIndex = await this.findPlayableTrackIndex(block, startIndex, delta);
      if (pickedIndex !== null) {
        session.currentTrackIndex = pickedIndex;
        const track = block.tracks[pickedIndex];
        const useGapless = Boolean(track?.gaplessUrl);
        return {
          url: useGapless && track?.gaplessUrl ? track.gaplessUrl : block.url,
          startAtSec: useGapless ? 0 : track?.startSec ?? 0,
          blockDurationSec: useGapless && track?.durationSec ? track.durationSec : block.lengthSec,
          track,
          stationLabel: this.stationLabel(session.stationId),
          isRadio: false,
        };
      }
      if (delta === 1 && block.eventId) {
        const baseTrack = block.tracks[session.currentTrackIndex];
        const elapsedBase = baseTrack?.startSec ?? 0;
        const skipElapsed = Math.max(0, Math.floor(elapsedBase + currentTimeSec));
        const skipBlock = await this.fetchBlock(session.stationId, block.eventId, skipElapsed);
        if (skipBlock) {
          const cueSec =
            typeof skipBlock.cueSec === 'number' && skipBlock.cueSec >= 0
              ? skipBlock.cueSec
              : skipBlock.tracks[0]?.startSec ?? 0;
          const cueIndex = this.findTrackIndex(skipBlock.tracks, cueSec);
          const pickedIndex = await this.findPlayableTrackIndex(skipBlock, cueIndex, 1);
          const cueTrack = pickedIndex !== null ? skipBlock.tracks[pickedIndex] : undefined;
          if (!cueTrack && this.isRiskyAudioUrl(skipBlock.url) && !(await this.probeUrl(skipBlock.url))) {
            return null;
          }
          const useGapless = Boolean(cueTrack?.gaplessUrl);
          session.previous = block;
          session.current = skipBlock;
          session.next = undefined;
          session.trackMode = useGapless;
          session.currentTrackIndex = pickedIndex !== null ? pickedIndex : undefined;
          this.prefetchNext(zoneId, session).catch(() => undefined);
          this.ensureTicker(zoneId);
          return {
            url: useGapless && cueTrack?.gaplessUrl ? cueTrack.gaplessUrl : skipBlock.url,
            startAtSec: useGapless ? 0 : cueSec,
            blockDurationSec:
              useGapless && cueTrack?.durationSec ? cueTrack.durationSec : skipBlock.lengthSec,
            track: cueTrack ?? this.trackAtTime(skipBlock, cueSec) ?? undefined,
            stationLabel: this.stationLabel(session.stationId),
            isRadio: false,
          };
        }
      }
    }
    const currentIndex = this.findTrackIndex(block.tracks, currentTimeSec);
    let nextIndex = currentIndex + delta;

    if (nextIndex < 0) {
      if (session.previous) {
        session.next = block;
        block = session.previous;
        session.current = block;
        session.previous = undefined;
        nextIndex = block.tracks.length - 1;
        if (session.trackMode) {
          session.currentTrackIndex = nextIndex;
        }
      } else {
        nextIndex = 0;
      }
    }

    if (nextIndex >= block.tracks.length) {
      const nextBlock =
        this.takeFreshPrefetchedNext(session) ?? (await this.fetchBlock(session.stationId, block.endEvent));
      if (!nextBlock) {
        return null;
      }
      const useGapless = session.trackMode && Boolean(nextBlock.tracks[0]?.gaplessUrl);
      session.previous = block;
      session.current = nextBlock;
      session.next = undefined;
      block = nextBlock;
      nextIndex = 0;
      session.trackMode = useGapless;
      session.currentTrackIndex = nextBlock.tracks.length ? 0 : undefined;
      this.prefetchNext(zoneId, session).catch(() => undefined);
    }

    const track = block.tracks[nextIndex];
    this.ensureTicker(zoneId);

    return {
      url: session.trackMode && track?.gaplessUrl ? track.gaplessUrl : block.url,
      startAtSec: session.trackMode && track?.gaplessUrl ? 0 : track?.startSec ?? 0,
      blockDurationSec:
        session.trackMode && track?.gaplessUrl && track?.durationSec
          ? track.durationSec
          : block.lengthSec,
      track,
      stationLabel: this.stationLabel(session.stationId),
      isRadio: false,
    };
  }

  public async resolveNextBlock(zoneId: number): Promise<ResolveResult | null> {
    const session = this.sessions.get(zoneId);
    if (!session || session.mode !== 'block') return null;

    if (session.trackMode && typeof session.currentTrackIndex === 'number') {
      const block = session.current;
      const nextIndex = await this.findPlayableTrackIndex(block, session.currentTrackIndex + 1, 1);
      if (nextIndex !== null) {
        session.currentTrackIndex = nextIndex;
        const track = block.tracks[nextIndex];
        const useGapless = Boolean(track?.gaplessUrl);
        this.ensureTicker(zoneId);
        return {
          url: useGapless && track?.gaplessUrl ? track.gaplessUrl : block.url,
          startAtSec: useGapless ? 0 : track?.startSec ?? 0,
          blockDurationSec: useGapless && track?.durationSec ? track.durationSec : block.lengthSec,
          track,
          stationLabel: this.stationLabel(session.stationId),
          isRadio: false,
        };
      }
    }

    const nextBlock =
      this.takeFreshPrefetchedNext(session) ?? (await this.fetchBlock(session.stationId, session.current.endEvent));
    if (!nextBlock) return null;

    session.previous = session.current;
    session.current = nextBlock;
    session.next = undefined;
    const useGapless = session.trackMode && Boolean(nextBlock.tracks[0]?.gaplessUrl);
    session.trackMode = useGapless;
    session.currentTrackIndex = nextBlock.tracks.length ? 0 : undefined;
    this.prefetchNext(zoneId, session).catch(() => undefined);
    this.ensureTicker(zoneId);

    const startAtSec =
      useGapless
        ? 0
        : typeof nextBlock.cueSec === 'number' && nextBlock.cueSec >= 0
          ? nextBlock.cueSec
          : nextBlock.tracks[0]?.startSec ?? 0;
    const cueIndex = this.findTrackIndex(nextBlock.tracks, startAtSec);
    const pickedIndex = await this.findPlayableTrackIndex(nextBlock, cueIndex, 1);
    const pickedTrack = pickedIndex !== null ? nextBlock.tracks[pickedIndex] : undefined;
    if (pickedIndex !== null) {
      session.currentTrackIndex = pickedIndex;
    }
    if (!pickedTrack && this.isRiskyAudioUrl(nextBlock.url) && !(await this.probeUrl(nextBlock.url))) {
      return null;
    }
    const track = (useGapless ? pickedTrack : this.trackAtTime(nextBlock, startAtSec)) ?? undefined;
    return {
      url: useGapless && pickedTrack?.gaplessUrl ? pickedTrack.gaplessUrl : nextBlock.url,
      startAtSec: useGapless ? 0 : startAtSec,
      blockDurationSec:
        useGapless && pickedTrack?.durationSec
          ? pickedTrack.durationSec
          : nextBlock.lengthSec,
      track,
      stationLabel: this.stationLabel(session.stationId),
      isRadio: false,
    };
  }

  public canSkip(zoneId: number): boolean {
    const session = this.sessions.get(zoneId);
    return Boolean(session && session.mode === 'block');
  }

  public stop(zoneId: number): void {
    const session = this.sessions.get(zoneId);
    if (!session) return;
    if (session.timer) {
      clearInterval(session.timer);
    }
    this.sessions.delete(zoneId);
  }

  private ensureTicker(zoneId: number): void {
    const session = this.sessions.get(zoneId);
    if (!session || session.timer) return;
    session.timer = setInterval(() => this.tick(zoneId), this.pollIntervalMs);
  }

  private tick(zoneId: number): void {
    const session = this.sessions.get(zoneId);
    if (!session) return;
    const ctx = this.deps.getZone(zoneId);
    if (!ctx) {
      this.stop(zoneId);
      return;
    }
    const audiopath = ctx.state.audiopath || '';
    if (!this.isRadioParadiseAudiopath(audiopath)) {
      this.stop(zoneId);
      return;
    }
    if (ctx.state.mode !== 'play') {
      return;
    }
    if (session.mode === 'nowPlaying') {
      void this.tickNowPlaying(zoneId, session);
      return;
    }
    if (session.trackMode) {
      return;
    }
    const timeSec = Number(ctx.player.getState().time) || 0;
    const track = this.trackAtTime(session.current, timeSec);
    if (!track) return;
    const signature = `${track.artist}|||${track.title}|||${track.coverurl ?? ''}`;
    if (signature === session.lastSignature) return;
    session.lastSignature = signature;
    this.deps.updateRadioMetadata(zoneId, {
      title: track.title,
      artist: track.artist,
      coverurl: track.coverurl,
      duration: track.durationSec,
      controllable: true,
    });
  }

  private async tickNowPlaying(zoneId: number, session: RadioParadiseSession): Promise<void> {
    if (session.nowPlayingPending) return;
    const now = Date.now();
    if (session.lastNowPlayingAt && now - session.lastNowPlayingAt < NOW_PLAYING_INTERVAL_MS) {
      return;
    }
    session.nowPlayingPending = true;
    session.lastNowPlayingAt = now;
    try {
      const track = await this.fetchNowPlayingTrack(session.stationId);
      if (!track) return;
      const signature = `${track.artist}|||${track.title}|||${track.coverurl ?? ''}`;
      if (signature === session.lastSignature) return;
      session.lastSignature = signature;
      session.current.tracks = [track];
      this.deps.updateRadioMetadata(zoneId, {
        title: track.title,
        artist: track.artist,
        coverurl: track.coverurl,
        duration: track.durationSec,
        controllable: true,
      });
      void this.tryEnrichNowPlayingDuration(zoneId, session, track);
    } finally {
      session.nowPlayingPending = false;
    }
  }

  private async tryEnrichNowPlayingDuration(
    zoneId: number,
    session: RadioParadiseSession,
    track: RadioParadiseTrack,
  ): Promise<void> {
    if (session.mode !== 'nowPlaying') return;
    if (!track?.title || !track?.artist) return;
    if (track.durationSec > 0) return;
    if (session.blockProbePending) return;
    const now = Date.now();
    if (session.lastBlockProbeAt && now - session.lastBlockProbeAt < this.blockProbeIntervalMs) {
      return;
    }
    session.blockProbePending = true;
    session.lastBlockProbeAt = now;
    try {
      const elapsedSec =
        typeof track.elapsedSec === 'number' && Number.isFinite(track.elapsedSec) && track.elapsedSec > 0
          ? track.elapsedSec
          : undefined;
      const block = await this.fetchBlock(session.stationId, undefined, elapsedSec);
      if (!block?.tracks?.length) return;
      // Prefer cue-based selection; exact metadata matching is unreliable (punctuation/featuring/encoding).
      const cueSec =
        typeof block.cueSec === 'number' && Number.isFinite(block.cueSec) && block.cueSec >= 0
          ? block.cueSec
          : block.tracks[0]?.startSec ?? 0;
      const cueTrack = this.trackAtTime(block, cueSec);
      const cueMatches =
        cueTrack &&
        this.looseEquals(cueTrack.artist, track.artist) &&
        this.looseEquals(cueTrack.title, track.title);
      const match =
        cueTrack && cueTrack.durationSec > 0 && cueMatches
          ? cueTrack
          : this.findTrackByArtistTitle(block.tracks, track.artist, track.title);
      if (!match || !(match.durationSec > 0)) return;
      // Update cached track/session and push metadata update with resolved duration.
      track.durationSec = match.durationSec;
      session.current.tracks = [track];
      this.deps.updateRadioMetadata(zoneId, {
        title: track.title,
        artist: track.artist,
        coverurl: track.coverurl,
        duration: track.durationSec,
        controllable: true,
      });
    } catch {
      // ignore enrichment errors
    } finally {
      session.blockProbePending = false;
    }
  }

  private findTrackByArtistTitle(
    tracks: RadioParadiseTrack[],
    artist: string,
    title: string,
  ): RadioParadiseTrack | null {
    const a = this.normalizeLooseText(artist);
    const t = this.normalizeLooseText(title);
    if (!a || !t) return null;
    for (const track of tracks) {
      if (!track) continue;
      if (this.normalizeLooseText(track.artist) === a && this.normalizeLooseText(track.title) === t) {
        return track;
      }
    }
    // Fuzzy fallback: substring match to tolerate "feat." / extra punctuation.
    for (const track of tracks) {
      if (!track) continue;
      const ta = this.normalizeLooseText(track.artist);
      const tt = this.normalizeLooseText(track.title);
      if (!ta || !tt) continue;
      if ((ta.includes(a) || a.includes(ta)) && (tt.includes(t) || t.includes(tt))) {
        return track;
      }
    }
    return null;
  }

  private looseEquals(a: string | undefined, b: string | undefined): boolean {
    const na = this.normalizeLooseText(a);
    const nb = this.normalizeLooseText(b);
    return Boolean(na && nb && na === nb);
  }

  private normalizeLooseText(value: string | undefined): string {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return '';
    // Normalize diacritics and common separators so now_playing and api/play can be compared.
    const deaccented = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return deaccented
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private trackAtTime(block: RadioParadiseBlock, timeSec: number): RadioParadiseTrack | null {
    if (!block.tracks.length) return null;
    let idx = 0;
    for (let i = 0; i < block.tracks.length; i += 1) {
      if (timeSec + 0.5 >= block.tracks[i].startSec) {
        idx = i;
      }
    }
    return block.tracks[idx] ?? null;
  }

  private findTrackIndex(tracks: RadioParadiseTrack[], timeSec: number): number {
    if (!tracks.length) return 0;
    let idx = 0;
    for (let i = 0; i < tracks.length; i += 1) {
      if (timeSec + 0.5 >= tracks[i].startSec) {
        idx = i;
      }
    }
    return idx;
  }

  private async findPlayableTrackIndex(
    block: RadioParadiseBlock,
    startIndex: number,
    direction: 1 | -1,
  ): Promise<number | null> {
    if (!block.tracks.length) return null;
    let idx = startIndex;
    while (idx >= 0 && idx < block.tracks.length) {
      const track = block.tracks[idx];
      const candidate = track?.gaplessUrl || block.url;
      if (!candidate) return null;
      if (!this.isRiskyAudioUrl(candidate)) {
        return idx;
      }
      // Only probe for known-risk URLs (currently /dj/). If it's actually available, we can still play it.
      const ok = await this.probeUrl(candidate);
      if (ok) {
        return idx;
      }
      idx += direction;
    }
    return null;
  }

  private isRiskyAudioUrl(url: string): boolean {
    return /\/dj\//i.test(url);
  }

  private async probeUrl(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), URL_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
      // Only treat definitive "not found" as broken; other errors may be transient and should not block playback.
      if (res.status === 404) return false;
      if (res.status >= 500) return false;
      return true;
    } catch {
      // Network/timeout errors are often transient; keep playback optimistic.
      return true;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async prefetchNext(zoneId: number, session: RadioParadiseSession): Promise<void> {
    if (session.mode !== 'block') return;
    if (!session.current.endEvent) return;
    const currentSession = this.sessions.get(zoneId);
    if (!currentSession || currentSession !== session) return;
    const next = await this.fetchBlock(session.stationId, session.current.endEvent);
    if (!next) return;
    if (this.isBlockExpired(next)) return;
    const latest = this.sessions.get(zoneId);
    if (!latest || latest !== session) return;
    session.next = next;
  }

  private async fetchBlock(
    stationId: string,
    eventId?: string,
    elapsedSec?: number,
  ): Promise<RadioParadiseBlock | null> {
    const params = new URLSearchParams();
    params.set('action', 'play');
    params.set('bitrate', String(DEFAULT_BITRATE));
    params.set('info', 'true');
    if (stationId && stationId !== '0') {
      params.set('chan', stationId);
    }
    if (eventId) {
      params.set('event', eventId);
    }
    if (typeof elapsedSec === 'number' && Number.isFinite(elapsedSec) && elapsedSec > 0) {
      params.set('elapsed', String(Math.floor(elapsedSec)));
    }
    const url = `${API_PLAY_URL}?${params.toString()}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        this.log.debug('radio paradise block fetch failed', { stationId, status: res.status });
        return null;
      }
      const raw = await res.text();
      if (!raw) {
        this.log.debug('radio paradise block fetch empty response', { stationId });
        return null;
      }
      const parsed = this.parseJsonPayload(raw);
      if (!parsed) {
        this.log.debug('radio paradise block fetch invalid json', {
          stationId,
          sample: raw.slice(0, 160),
        });
        return null;
      }
      const data = parsed as {
        url?: string;
        length?: number;
        end_event?: string;
        event?: string;
        cue?: number;
        expiration?: number;
        image_base?: string;
        song?: unknown;
      };
      const rawUrl = typeof data?.url === 'string' ? data.url : '';
      if (!rawUrl) return null;
      const lengthRaw = Number(data?.length ?? 0) || 0;
      const lengthSec = lengthRaw > 10000 ? lengthRaw / 1000 : lengthRaw;
      const endEvent = typeof data?.end_event === 'string' ? data.end_event : undefined;
      const event = typeof data?.event === 'string' ? data.event : undefined;
      const expiresAtMs = this.parseExpiration(data?.expiration);
      const imageBase = this.normalizeImageBase(data?.image_base);
      const cueRaw = Number(data?.cue ?? 0) || 0;
      const cueSec = cueRaw > 10000 ? cueRaw / 1000 : cueRaw;
      const tracks = this.parseTracks(data?.song, lengthSec, imageBase);
      return {
        url: this.appendSrc(rawUrl),
        lengthSec: lengthSec > 0 ? lengthSec : this.deriveBlockLength(tracks),
        endEvent,
        eventId: event,
        cueSec: cueSec >= 0 ? cueSec : undefined,
        expiresAtMs,
        tracks,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('radio paradise block fetch error', { stationId, message });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private appendSrc(url: string): string {
    if (!url) return url;
    return url.includes('?') ? `${url}&src=alexa` : `${url}?src=alexa`;
  }

  private resolveStream(stationId: string): { streamUrl: string; nowPlayingUrl: string } | null {
    return RADIO_PARADISE_STREAMS.get(stationId) ?? null;
  }

  private async fetchNowPlayingTrack(stationId: string): Promise<RadioParadiseTrack | null> {
    const config = this.resolveStream(stationId);
    if (!config) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(config.nowPlayingUrl, { signal: controller.signal });
      if (!res.ok) {
        this.log.debug('radio paradise now playing failed', { stationId, status: res.status });
        return null;
      }
      const data = (await res.json()) as {
        time?: number;
        artist?: string;
        title?: string;
        album?: string;
        year?: number;
        cover?: string;
        cover_med?: string;
        cover_small?: string;
      };
      const artist = typeof data?.artist === 'string' ? data.artist.trim() : '';
      const title = typeof data?.title === 'string' ? data.title.trim() : '';
      if (!artist && !title) return null;
      const album = typeof data?.album === 'string' ? data.album.trim() : '';
      const year = Number(data?.year) || undefined;
      const coverCandidate = data?.cover ?? data?.cover_med ?? data?.cover_small ?? '';
      const coverRaw = typeof coverCandidate === 'string' ? coverCandidate.trim() : '';
      const coverurl = coverRaw ? (coverRaw.startsWith('http') ? coverRaw : `${COVER_BASE_URL}${coverRaw}`) : '';
      const elapsedRaw = typeof data?.time === 'number' && Number.isFinite(data.time) ? data.time : 0;
      const elapsedSec = elapsedRaw > 0 ? Math.max(0, Math.round(elapsedRaw)) : undefined;
      return {
        startSec: 0,
        durationSec: 0,
        artist,
        title,
        album,
        year,
        coverurl: coverurl || undefined,
        elapsedSec,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('radio paradise now playing error', { stationId, message });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseJsonPayload(raw: string): unknown | null {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    try {
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return JSON.parse(trimmed);
      }
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start >= 0 && end > start) {
        return JSON.parse(trimmed.slice(start, end + 1));
      }
    } catch {
      return null;
    }
    return null;
  }

  private parseTracks(payload: unknown, fallbackLengthSec: number, coverBaseUrl?: string): RadioParadiseTrack[] {
    const list = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object'
        ? Object.values(payload as Record<string, any>)
        : [];
    const tracks = list
      .map((item) => {
        const startRaw = Number(item?.elapsed ?? 0) || 0;
        const durationRaw = Number(item?.duration ?? 0) || 0;
        const startSec = startRaw > 10000 ? startRaw / 1000 : startRaw;
        const durationSec = durationRaw > 10000 ? durationRaw / 1000 : durationRaw;
        const artist = typeof item?.artist === 'string' ? item.artist.trim() : '';
        const title = typeof item?.title === 'string' ? item.title.trim() : '';
        const album = typeof item?.album === 'string' ? item.album.trim() : '';
        const year = Number(item?.year) || undefined;
        const gaplessRaw =
          typeof item?.gapless_url === 'string'
            ? item.gapless_url
            : typeof item?.gaplessUrl === 'string'
              ? item.gaplessUrl
              : '';
        const gaplessUrl = gaplessRaw
          ? this.appendSrc(gaplessRaw.startsWith('//') ? `https:${gaplessRaw}` : gaplessRaw)
          : undefined;
        let coverurl = '';
        if (typeof item?.cover === 'string' && item.cover.trim()) {
          coverurl = this.resolveCoverUrl(item.cover, coverBaseUrl);
        }
        if (!artist && !title) {
          return null;
        }
        return {
          startSec,
          durationSec,
          artist,
          title,
          album,
          year,
          coverurl,
          gaplessUrl,
        } satisfies RadioParadiseTrack;
      })
      .filter(Boolean) as RadioParadiseTrack[];
    tracks.sort((a, b) => a.startSec - b.startSec);
    if (tracks.length) {
      for (let i = 0; i < tracks.length; i += 1) {
        const current = tracks[i];
        if (current.durationSec > 0) continue;
        const next = tracks[i + 1];
        if (next) {
          current.durationSec = Math.max(0, next.startSec - current.startSec);
        } else if (fallbackLengthSec > 0) {
          current.durationSec = Math.max(0, fallbackLengthSec - current.startSec);
        }
      }
    }
    return tracks;
  }

  private deriveBlockLength(tracks: RadioParadiseTrack[]): number {
    if (!tracks.length) return 0;
    const last = tracks[tracks.length - 1];
    return Math.max(0, last.startSec + (last.durationSec || 0));
  }

  private takeFreshPrefetchedNext(session: RadioParadiseSession): RadioParadiseBlock | undefined {
    const next = session.next;
    if (!next) return undefined;
    if (this.isBlockExpired(next)) {
      session.next = undefined;
      return undefined;
    }
    return next;
  }

  private isBlockExpired(block: RadioParadiseBlock): boolean {
    if (!block.expiresAtMs) return false;
    const skewMs = 5_000;
    return Date.now() + skewMs >= block.expiresAtMs;
  }

  private parseExpiration(value: unknown): number | undefined {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    return raw > 1_000_000_000_000 ? Math.floor(raw) : Math.floor(raw * 1000);
  }

  private normalizeImageBase(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const withScheme = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
    return withScheme.endsWith('/') ? withScheme : `${withScheme}/`;
  }

  private resolveCoverUrl(rawCover: unknown, imageBaseUrl?: string): string {
    if (typeof rawCover !== 'string') return '';
    const trimmed = rawCover.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('http')) return trimmed;
    const base = imageBaseUrl || COVER_BASE_URL;
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    const normalizedPath = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
    return `${normalizedBase}${normalizedPath}`;
  }
}
