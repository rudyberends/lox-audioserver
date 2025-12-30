import type { LoxoneHttpConfig } from '@/config/loxone';
import { createLogger } from '@/core/logging/logger';
import { LoxoneRouter } from '@/modules/loxone/commands/router/loxoneRouter';
import { registerRoutes } from '@/modules/loxone/commands/router/routeRegistry';
import { serializeResult } from '@/modules/loxone/commands/responses';
import { formatCommand } from '@/modules/loxone/commands/utils/commandFormatter';

export interface LoxoneCommandProcessorOptions {
  onRestart?: () => Promise<boolean>;
}

/**
 * Bridges the HTTP transport with the command router/handlers.
 */
export class LoxoneCommandProcessor {
  private readonly log = createLogger('LoxoneHttp', 'Processor');
  private readonly router = new LoxoneRouter();

  constructor(config: LoxoneHttpConfig, options: LoxoneCommandProcessorOptions = {}) {
    registerRoutes(this.router, { config, onRestart: options.onRestart });
  }

  public async execute(command: string, payload?: Buffer): Promise<string> {
    this.log.debug('command received', { command: formatCommand(command) });
    const result = await this.router.dispatch(command, payload);
    return serializeResult(result);
  }
}
