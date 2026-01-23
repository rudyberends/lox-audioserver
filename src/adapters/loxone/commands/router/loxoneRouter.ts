import { createLogger } from '@/shared/logging/logger';
import type { CommandResult, HandlerFn } from '@/adapters/loxone/commands/types';
import { buildEmptyResponse } from '@/adapters/loxone/commands/responses';
import { formatCommand } from '@/adapters/loxone/commands/utils/commandFormatter';

const log = createLogger('LoxoneHttp', 'Router');

type Route =
  | { type: 'prefix'; prefix: string; handler: HandlerFn }
  | { type: 'regex'; expression: RegExp; handler: HandlerFn };

/**
 * Bucket-based router that mirrors the legacy Loxone HTTP command dispatching.
 */
export class LoxoneRouter {
  private readonly buckets = new Map<string, Route[]>();
  private readonly fallbackRoutes: Route[] = [];

  public registerPrefix(segment: string, prefix: string, handler: HandlerFn): void {
    const route: Route = { type: 'prefix', prefix, handler };
    this.add(segment, route);
  }

  public registerRegex(segment: string, expression: RegExp, handler: HandlerFn): void {
    const route: Route = { type: 'regex', expression, handler };
    this.add(segment, route);
  }

  public async dispatch(command: string, payload?: Buffer): Promise<CommandResult> {
    const normalized = (command ?? '').trim().replace(/^\/+/, '');
    if (!normalized) {
      return buildEmptyResponse('');
    }

    const [segment] = normalized.split('/');
    const bucket = this.buckets.get(segment);

    if (bucket?.length) {
      const matched = await this.tryRoutes(bucket, normalized, payload);
      if (matched) {
        return matched;
      }
    }

    const fallback = await this.tryRoutes(this.fallbackRoutes, normalized, payload);
    if (fallback) {
      return fallback;
    }

    log.warn('unhandled loxone command', { command: formatCommand(command) });
    return buildEmptyResponse(command);
  }

  private add(segment: string, route: Route): void {
    const bucket = this.buckets.get(segment) ?? [];
    bucket.push(route);
    this.buckets.set(segment, bucket);
    this.fallbackRoutes.push(route);
  }

  private async tryRoutes(
    routes: Route[],
    command: string,
    payload?: Buffer,
  ): Promise<CommandResult | undefined> {
    for (const route of routes) {
      if (!this.matches(route, command)) {
        continue;
      }

      try {
        const result = await route.handler(command, payload);
        if (result) {
          return result;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('route handler failed', {
          command: formatCommand(command),
          message,
        });
      }
    }

    return undefined;
  }

  private matches(route: Route, command: string): boolean {
    if (route.type === 'prefix') {
      return command.startsWith(route.prefix);
    }
    return route.expression.test(command);
  }
}
