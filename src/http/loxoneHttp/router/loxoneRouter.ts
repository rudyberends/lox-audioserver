import logger from '@/utils/troxorLogger';
import { CommandResult, emptyCommand } from '../handlers/requestHandler';
import { formatLoxoneCommandForLog } from '../utils/loxoneCommandLogFormatter';

/**
 * Contract for any Loxone command handler.
 */
export type HandlerFn = (url: string, body?: Buffer) => CommandResult | Promise<CommandResult> | undefined;

/**
 * Route definition linking a matcher to a handler.
 */
export interface Route {
  test: (url: string) => boolean;
  handler: HandlerFn;
}

/**
 * Central router that maps incoming Loxone HTTP/WebSocket commands to handler functions.
 */
export class LoxoneRouter {
  private readonly routesBySegment = new Map<string, Route[]>();
  private readonly allRoutes: Route[] = [];

  registerPrefix(segment: string, prefix: string, handler: HandlerFn): void {
    this.register(segment, { test: (url) => url.startsWith(prefix), handler });
  }

  registerRegex(segment: string, regex: RegExp, handler: HandlerFn): void {
    this.register(segment, { test: (url) => regex.test(url), handler });
  }

  private register(segment: string, route: Route): void {
    const bucket = this.routesBySegment.get(segment) ?? [];
    bucket.push(route);
    this.routesBySegment.set(segment, bucket);
    this.allRoutes.push(route);
  }

  /**
   * Dispatch an incoming command to the correct handler.
   */
  async dispatch(url: string, body?: Buffer): Promise<CommandResult> {
    if (!url?.trim()) {
      return this.unknownCommand('');
    }

    const normalizedUrl = url.trim();
    const [segment] = normalizedUrl.split('/');
    const bucket = this.routesBySegment.get(segment);

    const match = bucket
      ? await this.dispatchBucket(bucket, normalizedUrl, body)
      : await this.dispatchBucket(this.allRoutes, normalizedUrl, body);

    return match ?? this.unknownCommand(normalizedUrl);
  }

  /**
   * Try all routes in the given bucket until one matches and returns a result.
   */
  private async dispatchBucket(
    routes: Route[],
    url: string,
    body?: Buffer,
  ): Promise<CommandResult | undefined> {
    for (const route of routes) {
      if (!route.test(url)) {
        continue;
      }
      try {
        const result = await route.handler(url, body);
        if (result !== undefined) {
          return result;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(
          `[LoxoneRouter] Handler for ${formatLoxoneCommandForLog(url)} failed: ${msg}`,
        );
      }
    }
    return undefined;
  }

  /**
   * Fallback for unknown or unregistered commands.
   */
  private unknownCommand(url: string): CommandResult {
    logger.warn(`[LoxoneApiRouter] Unhandled Loxone command: ${formatLoxoneCommandForLog(url)}`);
    return emptyCommand(url, []);
  }
}

/**
 * Serializes a CommandResult into the JSON wire format expected by Loxone clients.
 * (Kept here for backward compatibility, but should ideally come from requestHandler)
 */
export function serializeResult(result: CommandResult): string {
  if (result.raw) {
    return typeof result.payload === 'string'
      ? result.payload
      : JSON.stringify(result.payload);
  }

  return JSON.stringify(
    {
      [`${result.name}_result`]: result.payload,
      command: result.command,
    },
    null,
    2,
  );
}