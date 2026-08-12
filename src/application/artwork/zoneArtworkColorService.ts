import type { ZoneState } from '@/domain/zones/zoneState';
import type { ArtworkPalette } from '@/application/artwork/artworkPalette';

export interface ZoneArtworkColorDeps {
  getPalette: (coverUrl: string) => Promise<ArtworkPalette | null>;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>) => void;
}

/**
 * Keeps `artworkColors` on the zone state in step with `coverurl`.
 *
 * The palette used to be computed inside the Sendspin output, as a side effect of pushing artwork
 * to a connected client — so a zone playing to a Sonos or a DLNA renderer never got one, and the
 * `colors` the API projects were silently a Sendspin-only field. Derived here instead, from the
 * cover the zone already reports, it is a property of what is playing rather than of who is
 * listening.
 *
 * Resolution is asynchronous (the cover has to be fetched and decoded), so each zone remembers the
 * URL its outstanding request was for and a result that no longer matches is dropped. Skipping
 * tracks fast enough to overlap requests otherwise leaves the previous track's colours on screen.
 */
export class ZoneArtworkColorService {
  /** Cover URL each zone's palette currently reflects — '' means "no artwork". */
  private readonly resolved = new Map<number, string>();

  constructor(private readonly deps: ZoneArtworkColorDeps) {}

  /**
   * Call for every state patch. Patches that do not touch `coverurl` are ignored, which is also
   * what keeps the `artworkColors` patch this issues from re-entering.
   */
  public onStatePatch(zoneId: number, patch: Partial<ZoneState>): void {
    if (!('coverurl' in patch)) {
      return;
    }
    const coverUrl = patch.coverurl ?? '';
    if (this.resolved.get(zoneId) === coverUrl) {
      return;
    }
    this.resolved.set(zoneId, coverUrl);
    if (!coverUrl) {
      this.deps.applyPatch(zoneId, { artworkColors: null });
      return;
    }
    void this.resolve(zoneId, coverUrl);
  }

  public forget(zoneId: number): void {
    this.resolved.delete(zoneId);
  }

  private async resolve(zoneId: number, coverUrl: string): Promise<void> {
    const palette = await this.deps.getPalette(coverUrl);
    if (this.resolved.get(zoneId) !== coverUrl) {
      // The zone moved on while we were fetching; the newer request owns the field.
      return;
    }
    this.deps.applyPatch(zoneId, { artworkColors: palette });
  }
}
