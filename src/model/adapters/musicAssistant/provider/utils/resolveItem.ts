import type { MusicAssistantApi } from '../../api';
import { decodeAudiopath } from '@/core/loxone/mediaMapping';
import { extractCover } from '../../utils/imageUtils';
import logger from '@/utils/troxorLogger';

/**
 * -----------------------------------------------------------------------------
 * resolveItem
 * -----------------------------------------------------------------------------
 * The function resolves the item via the Music Assistant API and
 * returns a normalized object with an extracted cover URL.
 * -----------------------------------------------------------------------------
 */
export async function resolveItem(api: MusicAssistantApi, audiopath: string): Promise<any | undefined> {
  if (!audiopath) {
    return undefined;
  }

  try {
    // Step 1 – Decode Loxone wrapper to original MA URI
    const decoded = decodeAudiopath(audiopath).trim();

    // Step 2 – Extract provider, type, id from "<provider>://<type>/<id>"
    const match = decoded.match(/^([\w-]+):\/\/([\w-]+)\/(.+)$/i);
    if (!match) {
      logger.debug(`[resolveItem] Invalid URI format: "${decoded}"`);
      return undefined;
    }

    const [, provider, type, id] = match;

    // Step 3 – Choose resolver based on media type
    const resolverMap: Record<string, (p: string, id: string) => Promise<any>> = {
      radio: api.getRadio.bind(api),
      station: api.getRadio.bind(api),
      album: api.getAlbum.bind(api),
      artist: api.getArtist.bind(api),
      playlist: api.getPlaylist.bind(api),
    };

    const resolver = resolverMap[type] ?? api.getTrack.bind(api);

    // Step 4 – Fetch item and attach cover
    const item = await resolver(provider, id);
    if (!item) {
      return undefined;
    }

    return { ...item, coverurl: extractCover(item) };
  } catch (err) {
    logger.warn(`[resolveItem] Failed for "${audiopath}": ${String(err)}`);
    return undefined;
  }
}