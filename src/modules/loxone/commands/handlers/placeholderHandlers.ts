import { buildNotImplemented } from '@/modules/loxone/commands/responses';
import type { HandlerFn } from '@/modules/loxone/commands/types';

/**
 * Returns a handler that explicitly reports "not implemented" for a command.
 */
export function createPlaceholderHandler(name: string): HandlerFn {
  return (command) =>
    buildNotImplemented(command.replace(/^(audio|secure)\/[^/]+/, name));
}
