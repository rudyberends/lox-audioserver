import logger from '@/utils/troxorLogger';
import { LoxoneRouter } from '../router/loxoneRouter';
import { registerLoxoneRoutes } from '../router/loxoneRoutes';
import { formatLoxoneCommandForLog } from '../utils/loxoneCommandLogFormatter';

/**
 * Represents a normalized Loxone command response payload.
 */
export interface CommandResult {
  command: string;
  name: string;
  payload: Record<string, unknown> | unknown[] | string | number | boolean | null;
  raw?: boolean;
}

/**
 * Creates a standardized Loxone-style command response.
 */
export function response(url: string, name: string, result: unknown): CommandResult {
  return {
    command: url.trim(),
    name: name.trim(),
    payload: result as CommandResult['payload'],
  };
}

/**
 * Builds a default response for unhandled commands.
 */
export function emptyCommand(url: string, rsp: unknown): CommandResult {
  logger.debug(`[RequestHandler] Returning empty reply: [${url}]`);
  const name = url
    .split('/')
    .reverse()
    .find((part) => /^[a-z]/i.test(part)) ?? 'response';

  return response(url, name, rsp);
}

/**
 * Singleton router instance reused across all requests.
 */
let router: LoxoneRouter | null = null;

/**
 * Lazily creates and returns the Loxone router.
 */
function ensureRouter(): LoxoneRouter {
  if (!router) {
    router = new LoxoneRouter();
    registerLoxoneRoutes(router);
  }
  return router;
}

/**
 * Dispatches an incoming Loxone command URL to the correct handler.
 *
 * @param url - Raw Loxone command (e.g. "audio/cfg/getconfig").
 * @returns Serialized JSON string for the Loxone client.
 */
export async function handleLoxoneCommand(url: string): Promise<string> {
  const normalized = url.trim();
  if (!normalized) {
    return serializeResult(emptyCommand('', []));
  }

  const activeRouter = ensureRouter();
  logger.debug(`[RequestHandler] Received command: ${formatLoxoneCommandForLog(normalized)}`);

  try {
    const result: CommandResult = await activeRouter.dispatch(normalized);
    return serializeResult(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[RequestHandler] Error handling command '${normalized}': ${message}`);

    if (error instanceof Error && process.env.NODE_ENV === 'development') {
      logger.debug(error.stack);
    }

    // Return safe empty response so Loxone client doesn't break
    return serializeResult(emptyCommand(normalized, []));
  }
}

/**
 * Serializes a CommandResult into the Loxone-compatible JSON format.
 *
 * The output matches typical Loxone AudioServer replies, e.g.:
 * {
 *   "getconfig_result": {...},
 *   "command": "audio/cfg/getconfig"
 * }
 */
function serializeResult(result: CommandResult): string {
  try {
    if (result.raw) {
      // Raw passthrough (used for already formatted responses)
      return typeof result.payload === 'string'
        ? result.payload
        : JSON.stringify(result.payload);
    }

    // Normal Loxone API format
    return JSON.stringify(
      {
        [`${result.name}_result`]: result.payload,
        command: result.command,
      },
      null,
      2,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[RequestHandler] Failed to serialize result for ${result.command}: ${message}`);
    return JSON.stringify({ error: 'Serialization failed' });
  }
}