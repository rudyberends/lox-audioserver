import { buildResponse } from '@/adapters/loxone/commands/responses';
import { splitCommand, decodeSegment } from '@/adapters/loxone/commands/utils/commandUtils';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';

export function createGlobalSearchHandlers(contentManager: ContentManager, notifier: LoxoneWsNotifier) {
  return {
    audioCfgGlobalSearchDescribe: async (command: string) => {
      const desc = contentManager.getGlobalSearchDescription();
      return buildResponse(command, 'globalsearch', desc ?? {});
    },
    audioCfgGlobalSearch: async (command: string) => {
      const parts = splitCommand(command);
      const source = decodeSegment(parts[3] ?? '');
      const query = decodeSegment(parts.slice(4).join('/'));
      const unique = `gs-${Date.now()}`;

      // Always return immediately with the unique token.
      const immediate = buildResponse(command, 'globalsearch', { unique });

      if (!source || !query) {
        notifier.notifyGlobalSearchError(source || 'unknown', unique);
        return immediate;
      }

      (async () => {
        try {
          const { result, user, providerId } = await contentManager.globalSearch(source, query);
          const provider = (providerId || source.split('@')[0] || 'spotify').split('@')[0];
          notifier.notifyGlobalSearchResult(
            {
              ...result,
              user,
              query,
            },
            provider,
            unique,
          );
        } catch (error) {
          notifier.notifyGlobalSearchError(source || 'unknown', unique);
        }
      })();

      return immediate;
    },
  };
}
