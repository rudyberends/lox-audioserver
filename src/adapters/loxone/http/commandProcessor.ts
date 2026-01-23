import type { LoxoneHttpConfig } from '@/config/loxone';
import { createLogger } from '@/shared/logging/logger';
import { LoxoneRouter } from '@/adapters/loxone/commands/router/loxoneRouter';
import { registerRoutes } from '@/adapters/loxone/commands/router/routeRegistry';
import { serializeResult } from '@/adapters/loxone/commands/responses';
import { formatCommand } from '@/adapters/loxone/commands/utils/commandFormatter';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { GroupManager } from '@/application/groups/groupManager';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { LoxoneConfigService } from '@/adapters/loxone/services/loxoneConfigService';

export interface LoxoneCommandProcessorOptions {
  onRestart?: () => Promise<boolean>;
  notifier: NotifierPort;
  loxoneNotifier: LoxoneWsNotifier;
  configService: LoxoneConfigService;
  zoneManager: ZoneManagerFacade;
  configPort: ConfigPort;
  lineInRegistry: LineInIngestRegistry;
  sendspinLineInService: SendspinLineInService;
  spotifyInputService: SpotifyInputService;
  recentsManager: RecentsManager;
  favoritesManager: FavoritesManager;
  groupManager: GroupManager;
  contentManager: ContentManager;
}

/**
 * Bridges the HTTP transport with the command router/handlers.
 */
export class LoxoneCommandProcessor {
  private readonly log = createLogger('LoxoneHttp', 'Processor');
  private readonly router = new LoxoneRouter();

  constructor(config: LoxoneHttpConfig, options: LoxoneCommandProcessorOptions) {
    registerRoutes(this.router, {
      config,
      onRestart: options.onRestart,
      notifier: options.notifier,
      loxoneNotifier: options.loxoneNotifier,
      configService: options.configService,
      zoneManager: options.zoneManager,
      configPort: options.configPort,
      lineInRegistry: options.lineInRegistry,
      sendspinLineInService: options.sendspinLineInService,
      spotifyInputService: options.spotifyInputService,
      recentsManager: options.recentsManager,
      favoritesManager: options.favoritesManager,
      groupManager: options.groupManager,
      contentManager: options.contentManager,
    });
  }

  public async execute(command: string, payload?: Buffer): Promise<string> {
    this.log.debug('command received', { command: formatCommand(command) });
    const result = await this.router.dispatch(command, payload);
    return serializeResult(result);
  }
}
