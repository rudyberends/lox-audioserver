import { createLogger } from '@/shared/logging/logger';
import { buildProxyUrl } from '@/shared/urlProxy';
import type { AirplayController } from '@/ports/InputsPort';
import type { PlaybackMetadata } from '@/ports/types/playback';
import type { PlaybackSource } from '@/ports/EngineTypes';
import type { RendererHandler, ParsedDidlObject } from '@sonn-audio/node-upnp';

/**
 * The app-glue for one zone's DLNA MediaRenderer: it turns the module's neutral
 * renderer callbacks (a control point cast SetAVTransportURI + Play) into the
 * zone's playback via the shared input controller — the same `AirplayController`
 * AirPlay uses. The module owns the UPnP protocol; this owns only "what the zone
 * does when a URI is cast at it".
 *
 * The engine plays URLs natively, so no audio is decoded here: we hand it a
 * `{ kind: 'url' }` source. Metadata comes from the parsed DIDL the control point
 * pushed (title/artist/album/cover/duration).
 */
export class DlnaRendererHandler implements RendererHandler {
  private readonly log = createLogger('Input', 'DlnaRenderer');
  private parsed: ParsedDidlObject | null = null;
  private durationSec = 0;

  constructor(
    private readonly zoneId: number,
    private readonly controller: AirplayController,
    /**
     * The zone's own position, or null when it is not known. Without it the module
     * answers GetPositionInfo from wall-clock since its last Play, which is only
     * right while this control point is the sole thing driving the zone — a seek
     * from our app, a queue advance or a pause from a Loxone panel all leave that
     * estimate drifting.
     */
    private readonly position: () => { elapsed: number; duration: number } | null = () => null,
  ) {}

  public getPosition(): { elapsed: number; duration: number } | null {
    return this.position();
  }

  public onSetUri(_uri: string, metadata: ParsedDidlObject | null): void {
    this.parsed = metadata;
    this.durationSec = parseClock(metadata?.duration ?? '') ?? 0;
    this.log.info('renderer SetAVTransportURI', { zoneId: this.zoneId, uri: _uri });
  }

  public onPlay(uri: string, startAtSec?: number): void {
    // Fresh start (or a seek, which the module signals as onPlay with an offset): hand the
    // pushed URL to the engine as the zone's source. onSeek stays a no-op so the seek doesn't
    // double-start — the module calls onPlay(uri, seconds) right after onSeek.
    //
    // Through the local proxy, like every other http(s) source: `resolvePlaybackSource` does
    // this for anything played by audiopath, and a cast URI was the one URL that reached ffmpeg
    // raw. That is a difference nobody chose — and it bites, because ffmpeg's own name
    // resolution is the fragile part of the chain (issue #336: a Plex URL, a hostname it could
    // not resolve, and a SIGSEGV before any output). The server fetches, ffmpeg talks to
    // 127.0.0.1, and Range/redirects are handled on the way. A URI the proxy cannot front
    // (anything not http/https) is passed through untouched.
    const source: PlaybackSource = {
      kind: 'url',
      url: buildProxyUrl(uri) ?? uri,
      ...(startAtSec != null ? { startAtSec } : {}),
      realTime: true,
      restartOnFailure: false,
    };
    const metadata = this.buildMetadata();
    this.controller.startPlayback(this.zoneId, 'dlna', source, metadata);
    if (metadata.coverurl) {
      // Cover is already a URL in the DIDL; nothing to upload — updateMetadata carries it.
      this.controller.updateMetadata(this.zoneId, metadata);
    }
    if (this.durationSec > 0) {
      this.controller.updateTiming(this.zoneId, startAtSec ?? 0, this.durationSec);
    }
    this.log.info('renderer Play', { zoneId: this.zoneId, uri, startAtSec });
  }

  public onResume(): void {
    this.controller.resumePlayback(this.zoneId);
  }

  public onPause(): void {
    this.controller.pausePlayback(this.zoneId);
  }

  public onStop(): void {
    this.controller.stopPlayback(this.zoneId);
  }

  public onSeek(): void {
    // No-op: the module also calls onPlay(uri, seconds) right after, which restarts the URL
    // source at the offset (a single engine start, matching the previous adapter's behavior).
  }

  public onVolume(percent: number): void {
    this.controller.updateVolume(this.zoneId, percent);
  }

  // onMute intentionally omitted — there was no app mapping for mute (local-only in the
  // renderer's own state, which the module tracks).

  private buildMetadata(): PlaybackMetadata {
    const p = this.parsed;
    return {
      title: p?.title || 'DLNA',
      artist: p?.artist || '',
      album: p?.album || '',
      coverurl: p?.albumArtUri || undefined,
      duration: this.durationSec || undefined,
      audiopath: `dlna-renderer://${this.zoneId}`,
    };
  }
}

/** Parse an H:MM:SS[.mmm] clock (DIDL res@duration) into whole seconds. */
function parseClock(value: string): number | null {
  const t = value.trim();
  if (!t) {
    return null;
  }
  const parts = t.split(':').map((p) => parseFloat(p));
  if (parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  let sec = 0;
  for (const p of parts) {
    sec = sec * 60 + p;
  }
  return Math.round(sec);
}
