import { LoxoneRouter, serializeResult } from './loxoneRouter';
import { registerLoxoneRoutes } from './loxoneRoutes';

/**
 * Creates and initializes a LoxoneRouter instance with all routes registered.
 */
export function createLoxoneRouter(): LoxoneRouter {
  const router = new LoxoneRouter();
  registerLoxoneRoutes(router);
  return router;
}

/**
 * Facade used by LoxoneHttp and WebSocket handlers.
 * Accepts a raw command URL and returns the serialized JSON response.
 */
export async function handleLoxoneCommand(url: string): Promise<string> {
  const router = createLoxoneRouter();
  const result = await router.dispatch(url);
  return serializeResult(result);
}