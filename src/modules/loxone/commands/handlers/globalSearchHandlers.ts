import { buildResponse } from '@/modules/loxone/commands/responses';
import { splitCommand, decodeSegment } from '@/modules/loxone/commands/utils/commandUtils';
import { contentManager } from '@/modules/content/contentManager';
import { notifyGlobalSearchError, notifyGlobalSearchResult } from '@/modules/loxone/ws/notifier';

export async function audioCfgGlobalSearchDescribe(command: string) {
  const desc = contentManager.getGlobalSearchDescription();
  return buildResponse(command, 'globalsearch', desc ?? {});
}

export async function audioCfgGlobalSearch(command: string) {
  const parts = splitCommand(command);
  const source = decodeSegment(parts[3] ?? '');
  const query = decodeSegment(parts.slice(4).join('/'));
  const unique = `gs-${Date.now()}`;

  // Always return immediately with the unique token.
  const immediate = buildResponse(command, 'globalsearch', { unique });

  if (!source || !query) {
    notifyGlobalSearchError(source || 'unknown', unique);
    return immediate;
  }

  (async () => {
    try {
      const { result, user, providerId } = await contentManager.globalSearch(source, query);
      const provider = (providerId || source.split('@')[0] || 'spotify').split('@')[0];
      notifyGlobalSearchResult(
        {
          ...result,
          user,
          query,
        },
        provider,
        unique,
      );
    } catch (error) {
      notifyGlobalSearchError(source || 'unknown', unique);
    }
  })();

  return immediate;
}
