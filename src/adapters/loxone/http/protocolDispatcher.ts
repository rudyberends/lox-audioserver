import net from 'node:net';
import type http from 'node:http';
import type https from 'node:https';
import { createLogger } from '@/shared/logging/logger';

const log = createLogger('LoxoneHttp', 'Dispatcher');

const TLS_HANDSHAKE_BYTE = 0x16;

/**
 * Build a TCP listener that demultiplexes plain HTTP and TLS to two
 * backing servers on the same port.
 *
 * The first byte of every TLS record is 0x16 (handshake content type);
 * any HTTP request starts with an ASCII verb. Peeking that single byte
 * is enough to route deterministically.
 *
 * The unshift + nextTick(resume) sequence is the well-known
 * "httpolyglot" pattern: bytes go back into the readable buffer, the
 * target server attaches its listeners during the synchronous emit,
 * and resume fires on the next tick so the buffered bytes flow into
 * the right pipeline.
 */
export function createDualProtocolServer(
  httpServer: http.Server,
  httpsServer: https.Server | null,
): net.Server {
  return net.createServer((socket) => {
    socket.once('error', (err) => {
      log.debug('dispatcher socket error', { msg: (err as Error).message });
    });

    socket.once('data', (chunk) => {
      if (chunk.length === 0) {
        socket.destroy();
        return;
      }
      socket.pause();
      socket.unshift(chunk);

      const isTls = chunk[0] === TLS_HANDSHAKE_BYTE;
      const target = isTls && httpsServer ? httpsServer : httpServer;
      target.emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
}
