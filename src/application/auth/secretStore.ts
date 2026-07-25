import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createLogger } from '@/shared/logging/logger';
import { resolveDataDir } from '@/shared/utils/file';

/**
 * At-rest protection for the credentials in {@link SystemConfig.users}.
 *
 * These cannot be hashed. A stored password has to be recoverable because
 * Subsonic's salted-token login sends `md5(password + salt)` with a per-request
 * salt, and verifying that means computing the same digest. So they are
 * encrypted, with a key generated per installation and kept in its own file.
 *
 * Two properties matter, and both are deliberate:
 *
 *   - **The key is not in the source.** It is 32 random bytes made on first use,
 *     so knowing how this works buys an attacker nothing.
 *   - **The key is not derivable from the config.** Not from `audioserver.uuid`,
 *     `macId` or `miniserver.serial` — those live inside the very file this
 *     protects, and deriving from them would make the encryption decorative.
 *
 * Be clear-eyed about the threat it addresses: a leaked `config.json`. Someone
 * pasting their config into a bug report, a partial backup, a synced folder. It
 * is *not* a defence against anyone who can read files as this user — they can
 * read the key too. Copying the whole `data/` directory takes both.
 *
 * Values are stored as `enc:v1:<iv>:<tag>:<ciphertext>`, base64 segments,
 * AES-256-GCM. A value without that prefix is treated as a literal password, so
 * a hand-edited config keeps working and existing installs need no migration
 * step — entries are encrypted the next time they are written.
 */

const KEY_FILE = 'secret.key';
const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

const log = createLogger('Auth', 'Secrets');

let cachedKey: Buffer | null = null;

function keyPath(): string {
  return resolveDataDir(KEY_FILE);
}

/**
 * Load the per-installation key, creating it on first use.
 *
 * Written 0600: the point is that this file does not travel with the config, so
 * it should also not be readable by other local accounts.
 */
function loadKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }
  const file = keyPath();
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length === KEY_BYTES) {
      cachedKey = key;
      return key;
    }
    // Replacing it makes existing ciphertexts undecryptable, which is why this
    // is loud: the alternative is failing every login with no explanation.
    log.warn('secret key file is malformed; generating a new one (stored secrets become unreadable)', {
      file,
    });
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(file, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  try {
    // writeFileSync's mode is ignored when the file already exists.
    chmodSync(file, 0o600);
  } catch {
    /* best effort: not every filesystem supports it */
  }
  log.info('created installation secret key', { file });
  cachedKey = key;
  return key;
}

/** True when a stored value is in encrypted form. */
export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) {
    return '';
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Recover a stored secret. A value without the prefix is returned unchanged, so
 * a password typed straight into the config still works.
 *
 * Returns null when an encrypted value cannot be opened — a replaced key, or
 * tampering, since GCM authenticates the ciphertext. Callers must treat that as
 * "no credential" and never as a match.
 */
export function decryptSecret(stored: string): string | null {
  if (!stored) {
    return null;
  }
  if (!isEncrypted(stored)) {
    return stored;
  }
  const [ivRaw, tagRaw, dataRaw] = stored.slice(PREFIX.length).split(':');
  if (!ivRaw || !tagRaw || !dataRaw) {
    log.warn('malformed encrypted secret');
    return null;
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, loadKey(), Buffer.from(ivRaw, 'base64'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataRaw, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    log.warn('could not decrypt stored secret', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Test seam: forget the cached key so the next call reloads it. */
export function resetKeyCache(): void {
  cachedKey = null;
}
