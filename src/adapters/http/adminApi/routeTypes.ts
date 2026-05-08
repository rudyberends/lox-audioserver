import type { IncomingMessage, ServerResponse } from 'node:http';

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpMatchArray,
  pathname: string,
) => Promise<void> | void;

export type Route = {
  method?: string;
  pattern: RegExp;
  handler: RouteHandler;
};
