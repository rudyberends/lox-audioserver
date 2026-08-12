import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Jimp } from 'jimp';
import { createLogger } from '@/shared/logging/logger';
import { COVER_ART_MAX_BYTES, isHttpUrl } from '@/shared/coverArt';
import { derivePalette, type ArtworkPalette } from '@/application/artwork/artworkPalette';

export type DecodedArtwork = Awaited<ReturnType<typeof Jimp.read>>;

/** How many cover URLs keep a derived palette. Six RGB triples each — the map is bytes, not images. */
const PALETTE_CACHE_LIMIT = 128;

/**
 * The one place a cover image is fetched and decoded.
 *
 * Two consumers want the same bytes at the same moment: the Sendspin adapter re-encodes the image
 * per artwork channel, and the zone state wants a palette off it. They used to be one code path
 * inside the Sendspin output, which meant a zone with no Sendspin client had no palette at all —
 * `artworkColors` was, in effect, a Sendspin feature that the API happened to project. Pulling the
 * fetch here makes the palette a property of the *zone*, and collapses what would otherwise be two
 * downloads of the same JPEG into one.
 *
 * Downloads are deduplicated while in flight and palettes are cached by URL, so a track that comes
 * round again — a repeat, a queue loop, the same album on two zones — costs nothing. Decoded images
 * are deliberately *not* cached: an 800x800 RGBA bitmap is 2.5 MB, and the only caller that needs
 * one needs it once, right after the track changes.
 */
export class ArtworkService {
  private readonly log = createLogger('Artwork');
  private readonly palettes = new Map<string, ArtworkPalette>();
  private readonly inFlight = new Map<string, Promise<DecodedArtwork | null>>();

  /**
   * Palette for a cover URL, from cache when possible.
   *
   * Returns null for a missing or non-HTTP URL and for anything that fails to download or decode —
   * a zone with unreadable artwork simply has no palette, which every consumer already handles.
   */
  public async getPalette(coverUrl: string | null | undefined): Promise<ArtworkPalette | null> {
    const url = this.normalizeUrl(coverUrl);
    if (!url) {
      return null;
    }
    const cached = this.palettes.get(url);
    if (cached) {
      return cached;
    }
    const image = await this.decode(url);
    return image ? this.paletteFor(url, image) : null;
  }

  /**
   * The decoded image *and* its palette, for a caller that needs the pixels anyway.
   *
   * Deriving the palette here rather than leaving it to the caller is what keeps the two consumers
   * on one download: whoever gets there first fills the cache for the other.
   */
  public async getImage(
    coverUrl: string | null | undefined,
  ): Promise<{ image: DecodedArtwork; palette: ArtworkPalette } | null> {
    const url = this.normalizeUrl(coverUrl);
    if (!url) {
      return null;
    }
    const image = await this.decode(url);
    if (!image) {
      return null;
    }
    return { image, palette: this.paletteFor(url, image) };
  }

  private normalizeUrl(coverUrl: string | null | undefined): string | null {
    if (!coverUrl) {
      return null;
    }
    return isHttpUrl(coverUrl) ? coverUrl : null;
  }

  private paletteFor(url: string, image: DecodedArtwork): ArtworkPalette {
    const cached = this.palettes.get(url);
    if (cached) {
      return cached;
    }
    const palette = derivePalette(image);
    // Insertion-ordered eviction: the oldest URL goes when the map is full.
    if (this.palettes.size >= PALETTE_CACHE_LIMIT) {
      const oldest = this.palettes.keys().next().value;
      if (oldest !== undefined) {
        this.palettes.delete(oldest);
      }
    }
    this.palettes.set(url, palette);
    return palette;
  }

  /** Download + decode, with concurrent callers for the same URL sharing one request. */
  private async decode(url: string): Promise<DecodedArtwork | null> {
    const existing = this.inFlight.get(url);
    if (existing) {
      return existing;
    }
    const pending = this.fetchAndDecode(url).finally(() => {
      this.inFlight.delete(url);
    });
    this.inFlight.set(url, pending);
    return pending;
  }

  private async fetchAndDecode(url: string): Promise<DecodedArtwork | null> {
    const buffer = await this.fetchBuffer(url);
    if (!buffer || buffer.length === 0) {
      return null;
    }
    try {
      return await Jimp.read(buffer);
    } catch (error) {
      this.log.debug('artwork decode failed', {
        url,
        bytes: buffer.length,
        message: (error as Error).message,
      });
      return null;
    }
  }

  private async fetchBuffer(url: string, redirectsLeft = 5): Promise<Buffer | null> {
    return new Promise<Buffer | null>((resolve) => {
      const handler = (res: any) => {
        const status = res.statusCode ?? 0;
        // Follow redirects: cover CDNs routinely 30x, and the redirect body is not
        // an image. Without this the receiver would get HTML/empty bytes.
        if (status >= 300 && status < 400 && res.headers?.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            resolve(null);
            return;
          }
          let next: string;
          try {
            next = new URL(res.headers.location, url).toString();
          } catch {
            resolve(null);
            return;
          }
          this.fetchBuffer(next, redirectsLeft - 1).then(resolve, () => resolve(null));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          // A cover that runs past the cap is a wrong URL, not a big picture. Stop reading rather
          // than decoding whatever a mislabelled endpoint is streaming at us.
          if (received > COVER_ART_MAX_BYTES) {
            res.destroy();
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => resolve(null));
      };
      const client = url.startsWith('https') ? httpsRequest : httpRequest;
      const req = client(url, handler);
      req.on('error', () => resolve(null));
      req.end();
    });
  }
}

/**
 * Process-wide instance. The cache only pays off when every zone and every adapter shares it, and
 * there is nothing per-zone to configure.
 */
export const artworkService = new ArtworkService();
