import { v4 as uuidv4 } from 'uuid';
import logger from '@/utils/troxorLogger';
import { providerRuntime } from '@/runtime/provider';
import { CommandResult, response } from '@/http/loxoneHttp/handlers/requestHandler';
import { notifyGlobalSearchResult, notifyGlobalSearchError } from '@/http/loxoneHttp/websocketNotifier';
import { ProviderSearchResult } from '@/runtime/provider/types/providerSearchResults';

/**
 * Describe search categories available to the client.
 */
export function audioCfgGlobalSearchDescribe(url: string): CommandResult {
  return response(url, 'globalsearch', providerRuntime.describeSearchSources());
}

/**
 * -----------------------------------------------------------------------------
 * Handles:
 *   audio/cfg/globalsearch/{source}/{query}
 *
 *  Respond immediately with a unique search ID (HTTP)
 *  Perform async provider search
 *  Broadcast final result via WebSocket
 * -----------------------------------------------------------------------------
 */
export async function audioCfgGlobalSearch(url: string): Promise<CommandResult> {
  const [, , , rawSource = '', rawQuery = ''] = url.split('/');
  const unique = uuidv4();

  const query = decodeURIComponent(rawQuery.trim());
  if (!query) {
    logger.debug('[GlobalSearch] Empty query received, ignoring');
    return response(url, 'globalsearch', [{ error: 1 }]);
  }

  // Parse "spotify@nouser:track#5,album#5,artist#5,playlist#5"
  const [providerPart, filterPart = ''] = rawSource.split(':');
  const [providerId, userId = 'nouser'] = providerPart.split('@');

  logger.debug(
    `[GlobalSearch] provider=${providerId}, user=${userId}, query="${query}", filters="${filterPart}"`,
  );

  // Return immediate HTTP response (unique ID confirmation)
  const httpResponse = response(url, 'globalsearch', { unique });

  // Fire async search + WebSocket notifications
  (async () => {
    try {
      const result = (await providerRuntime.globalSearch(
        rawSource,
        query,
        unique,
      )) as ProviderSearchResult;

      if (!result) {
        logger.warn(`[GlobalSearch] Provider returned no result for "${query}"`);
        notifyGlobalSearchError(providerId, unique);
        return;
      }

      notifyGlobalSearchResult(
        { ...result.result, user: userId },
        providerId,
        unique,
      );

      logger.debug(`[GlobalSearch] Completed search (${providerId}, query="${query}")`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[GlobalSearch] Failed for "${query}": ${msg}`);
      notifyGlobalSearchError(providerId, unique);
    }
  })();

  return httpResponse;
}