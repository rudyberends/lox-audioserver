import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Identity } from '@sonn-audio/node-sendspin';
import { createLogger } from '@/shared/logging/logger';
import { resolveDataDir } from '@/shared/utils/file';

/**
 * This server's long-term Sendspin identity: an X25519 keypair whose public half
 * *is* our `server_id` on an encrypted connection.
 *
 * It has to survive restarts. A client remembers which server it paired with — and,
 * with more than one audioserver on the network, which one it is talking to — by
 * that key, so a freshly generated identity makes us a stranger to every client
 * that knew us. Hence a file rather than something derived per boot.
 *
 * Stored 0600 alongside the other per-installation secret: anyone who can read it
 * can impersonate this server to a client that trusts it.
 */

const KEY_FILE = 'sendspin-identity.key';

const log = createLogger('Sendspin', 'Identity');

let cached: Identity | null = null;

function keyPath(): string {
  return resolveDataDir(KEY_FILE);
}

/** Load the stored identity, creating one on first use. */
export function loadSendspinIdentity(): Identity {
  if (cached) {
    return cached;
  }
  const file = keyPath();
  if (existsSync(file)) {
    try {
      cached = Identity.fromPrivateB64u(readFileSync(file, 'utf8').trim());
      return cached;
    } catch (error) {
      /*
       * Replacing it changes our server_id, so say so loudly: every paired client
       * will see a server it has never met. Failing silently would look like a
       * client-side problem.
       */
      log.warn('sendspin identity file is malformed; generating a new identity', {
        file,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const identity = Identity.generate();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, identity.privateB64u, { encoding: 'utf8', mode: 0o600 });
  try {
    // writeFileSync's mode is ignored when the file already exists.
    chmodSync(file, 0o600);
  } catch {
    /* best effort: not every filesystem supports it */
  }
  log.info('created sendspin server identity', { file, serverId: identity.peerId });
  cached = identity;
  return identity;
}

/** Drop the cache, for tests. */
export function resetSendspinIdentityCache(): void {
  cached = null;
}
