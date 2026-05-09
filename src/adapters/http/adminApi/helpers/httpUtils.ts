import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

export async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };

    const done = (value: unknown | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const closeSocket = () => {
      const socket = req.socket;
      if (socket && !socket.destroyed) {
        socket.destroy();
      }
    };

    const rejectTooLarge = () => {
      if (!res.writableEnded) {
        sendJson(res, 413, { error: 'payload-too-large' });
      }
      req.pause();
      res.once('finish', closeSocket);
      res.once('close', closeSocket);
      done(null);
    };

    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        rejectTooLarge();
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      if (settled) return;
      if (totalBytes === 0) {
        done(null);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        done(JSON.parse(raw));
      } catch {
        if (!res.writableEnded) {
          sendJson(res, 400, { error: 'invalid-json' });
        }
        done(null);
      }
    };

    const onError = () => {
      if (!res.writableEnded) {
        sendJson(res, 400, { error: 'invalid-json' });
      }
      done(null);
    };

    const onAborted = () => {
      done(null);
    };

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

export async function readBinaryBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };

    const done = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const closeSocket = () => {
      const socket = req.socket;
      if (socket && !socket.destroyed) {
        socket.destroy();
      }
    };

    const rejectTooLarge = () => {
      if (!res.writableEnded) {
        sendJson(res, 413, { error: 'payload-too-large' });
      }
      req.pause();
      res.once('finish', closeSocket);
      res.once('close', closeSocket);
      done(null);
    };

    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        rejectTooLarge();
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      if (settled) return;
      if (totalBytes === 0) {
        done(null);
        return;
      }
      done(Buffer.concat(chunks));
    };

    const onError = () => {
      if (!res.writableEnded) {
        sendJson(res, 400, { error: 'invalid-body' });
      }
      done(null);
    };

    const onAborted = () => {
      done(null);
    };

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}
