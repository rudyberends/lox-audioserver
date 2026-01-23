/**
 * Strongly typed representation of a Loxone command result prior to serialization.
 */
export interface CommandResult {
  command: string;
  name: string;
  payload:
    | Record<string, unknown>
    | unknown[]
    | string
    | number
    | boolean
    | null
    | object;
  raw?: boolean;
}

/**
 * Handler signature shared by all command modules.
 */
export type HandlerFn = (
  command: string,
  payload?: Buffer,
) => CommandResult | Promise<CommandResult> | undefined;

export type HandlerFactory = () => HandlerFn;
