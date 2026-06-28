import {
  constants as cryptoConstants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  randomUUID,
  X509Certificate,
} from 'node:crypto';
import {
  MINISERVER_ADMIN_PERMISSION,
  MiniserverAuthError,
  type HashAlgorithm,
} from '@/adapters/http/adminApi/auth/types';
import type { AudioServerConfig } from '@/domain/config/types';

type Salts = { oneTimeSalt: string; salt: string; hashAlg: HashAlgorithm };

export function readMiniserverBaseUrlFromConfig(cfg: AudioServerConfig): string {
  const host = cfg.system?.miniserver?.ip?.trim() ?? '';
  if (!host) {
    return '';
  }
  const port = cfg.system?.miniserver?.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return '';
  }
  const protocol = cfg.system?.miniserver?.protocol === 'https' ? 'https' : 'http';
  const includePort = (protocol === 'https' && port !== 443) || (protocol === 'http' && port !== 80);
  return includePort ? `${protocol}://${host}:${port}` : `${protocol}://${host}`;
}

export class MiniserverAuthClient {
  public async verifyAdminCredentials(
    baseUrl: string,
    username: string,
    password: string,
  ): Promise<{ tokenRights: number | null }> {
    let salts: Salts;
    let authHash: string;
    let tokenRights: number | null;

    try {
      const publicKey = await this.fetchPublicKey(baseUrl);
      salts = await this.fetchTokenSalts(baseUrl, publicKey, username);
      authHash = this.buildAuthHash(username, password, salts);
      tokenRights = await this.requestAdminToken(baseUrl, publicKey, username, authHash);
    } catch (err) {
      if (!(err instanceof MiniserverAuthError) || err.code !== 'miniserver-protocol') {
        throw err;
      }
      salts = await this.fetchTokenSaltsPlain(baseUrl, username);
      authHash = this.buildAuthHash(username, password, salts);
      tokenRights = await this.requestAdminTokenPlain(baseUrl, username, authHash);
    }

    if (tokenRights !== null && (tokenRights & MINISERVER_ADMIN_PERMISSION) === 0) {
      throw new MiniserverAuthError('insufficient-permissions', 'miniserver user is not admin');
    }
    return { tokenRights };
  }

  private async fetchPublicKey(baseUrl: string): Promise<string> {
    const payload = await this.requestJson(baseUrl, 'jdev/sys/getPublicKey');
    const value = this.extractValue(payload);
    if (typeof value !== 'string' || !value.trim()) {
      throw new MiniserverAuthError('miniserver-protocol', 'missing miniserver public key');
    }
    return this.normalizePublicKey(value);
  }

  private async fetchTokenSalts(baseUrl: string, publicKey: string, username: string): Promise<Salts> {
    const payload = await this.requestEncryptedJson(baseUrl, `jdev/sys/getkey2/${encodeURIComponent(username)}`, publicKey);
    return this.parseSaltsPayload(payload);
  }

  private async fetchTokenSaltsPlain(baseUrl: string, username: string): Promise<Salts> {
    const payload = await this.requestJson(baseUrl, `jdev/sys/getkey2/${encodeURIComponent(username)}`);
    return this.parseSaltsPayload(payload);
  }

  private parseSaltsPayload(payload: unknown): Salts {
    const value = this.extractValue(payload);
    const obj = this.asObject(value);
    const oneTimeSalt = this.readString(obj.key);
    const salt = this.readString(obj.salt);
    const hashAlg = this.normalizeHashAlgorithm(this.readString(obj.hashAlg) || 'SHA1');
    if (!oneTimeSalt || !salt) {
      throw new MiniserverAuthError('miniserver-protocol', 'missing miniserver salt data');
    }
    return { oneTimeSalt, salt, hashAlg };
  }

  private buildAuthHash(username: string, password: string, salts: Salts): string {
    const hashName = salts.hashAlg === 'SHA256' ? 'sha256' : 'sha1';
    const pwHash = createHash(hashName).update(`${password}:${salts.salt}`, 'utf8').digest('hex').toUpperCase();
    return createHmac(hashName, Buffer.from(salts.oneTimeSalt, 'hex'))
      .update(`${username}:${pwHash}`, 'utf8')
      .digest('hex');
  }

  private async requestAdminToken(
    baseUrl: string,
    publicKey: string,
    username: string,
    authHash: string,
  ): Promise<number | null> {
    const { jwtCmd, tokenCmd } = this.buildTokenCommands(username, authHash);
    let payload: unknown;
    try {
      payload = await this.requestEncryptedJson(baseUrl, jwtCmd, publicKey);
    } catch (err) {
      if (err instanceof MiniserverAuthError && err.code === 'invalid-credentials') {
        throw err;
      }
      payload = await this.requestEncryptedJson(baseUrl, tokenCmd, publicKey);
    }
    return this.parseTokenRights(payload);
  }

  private async requestAdminTokenPlain(
    baseUrl: string,
    username: string,
    authHash: string,
  ): Promise<number | null> {
    const { jwtCmd, tokenCmd } = this.buildTokenCommands(username, authHash);
    let payload: unknown;
    try {
      payload = await this.requestJson(baseUrl, jwtCmd);
    } catch (err) {
      if (err instanceof MiniserverAuthError && err.code === 'invalid-credentials') {
        throw err;
      }
      payload = await this.requestJson(baseUrl, tokenCmd);
    }
    return this.parseTokenRights(payload);
  }

  private buildTokenCommands(username: string, authHash: string): { jwtCmd: string; tokenCmd: string } {
    const deviceUuid = randomUUID();
    const deviceInfo = encodeURIComponent('Sonn Core Admin UI').replace(/\//g, ' ');
    const suffix = `${authHash}/${encodeURIComponent(username)}/${MINISERVER_ADMIN_PERMISSION}/${deviceUuid}/${deviceInfo}`;
    return {
      jwtCmd: `jdev/sys/getjwt/${suffix}`,
      tokenCmd: `jdev/sys/gettoken/${suffix}`,
    };
  }

  private parseTokenRights(payload: unknown): number | null {
    const value = this.extractValue(payload);
    const obj = this.asObject(value);
    const rights = this.readNumber(obj.tokenRights);
    if (rights !== null) return rights;
    return this.readNumber(obj.msPermission);
  }

  private async requestJson(baseUrl: string, command: string): Promise<unknown> {
    const raw = await this.fetchText(baseUrl, command);
    const parsed = this.tryParseJson(raw) ?? this.tryParseLooseJson(raw);
    if (parsed === null) {
      const lower = raw.toLowerCase();
      if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('forbidden')) {
        throw new MiniserverAuthError('invalid-credentials', 'invalid miniserver credentials');
      }
      throw new MiniserverAuthError('miniserver-protocol', 'invalid miniserver response');
    }
    this.ensureSuccess(parsed);
    return parsed;
  }

  private async requestEncryptedJson(baseUrl: string, command: string, publicKey: string): Promise<unknown> {
    const aesKey = randomBytes(32);
    const aesIv = randomBytes(16);
    const salt = randomBytes(2).toString('hex');
    const encryptedCmd = this.encryptCommand(command, salt, aesKey, aesIv, publicKey);
    const raw = await this.fetchText(baseUrl, encryptedCmd);

    // Some Miniserver builds can return LL-wrapped JSON even for encrypted HTTP commands.
    const directPayload = this.tryParseJson(raw);
    if (directPayload !== null) {
      this.ensureSuccess(directPayload);
      const llValue = this.asObject(this.asObject(directPayload).LL).value;
      if (typeof llValue === 'string' && llValue.trim()) {
        const maybeDecrypted = this.tryDecryptResponse(llValue, aesKey, aesIv);
        if (maybeDecrypted !== null) {
          this.ensureSuccess(maybeDecrypted);
          return maybeDecrypted;
        }
      }
      return directPayload;
    }

    let decrypted: string;
    try {
      decrypted = this.decryptResponse(raw, aesKey, aesIv);
    } catch {
      throw new MiniserverAuthError('miniserver-protocol', 'failed to decrypt miniserver response');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decrypted);
    } catch {
      throw new MiniserverAuthError('miniserver-protocol', 'invalid decrypted miniserver response');
    }
    this.ensureSuccess(parsed);
    return parsed;
  }

  private encryptCommand(
    command: string,
    salt: string,
    aesKey: Buffer,
    aesIv: Buffer,
    publicKey: string,
  ): string {
    const payload = `salt/${salt}/${command}`;
    const blockSize = 16;
    const payloadBuf = Buffer.from(payload, 'utf8');
    const remainder = payloadBuf.length % blockSize;
    const padded = remainder === 0 ? payloadBuf : Buffer.concat([payloadBuf, Buffer.alloc(blockSize - remainder)]);
    const cipher = createCipheriv('aes-256-cbc', aesKey, aesIv);
    cipher.setAutoPadding(false);
    const cipherText = Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
    const sessionPayload = `${aesKey.toString('hex')}:${aesIv.toString('hex')}`;
    let sk: string;
    try {
      sk = publicEncrypt(
        { key: publicKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
        Buffer.from(sessionPayload, 'utf8'),
      ).toString('base64');
    } catch {
      throw new MiniserverAuthError('miniserver-protocol', 'invalid miniserver public key');
    }
    return `jdev/sys/fenc/${encodeURIComponent(cipherText)}?sk=${encodeURIComponent(sk)}`;
  }

  private normalizePublicKey(rawValue: string): string {
    const addCandidate = (bucket: string[], value: string): void => {
      const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      if (!normalized) return;
      if (!bucket.includes(normalized)) bucket.push(normalized);
    };

    const formatPem = (label: 'CERTIFICATE' | 'PUBLIC KEY', base64Body: string): string => {
      const chunks = base64Body.match(/.{1,64}/g) ?? [base64Body];
      return `-----BEGIN ${label}-----\n${chunks.join('\n')}\n-----END ${label}-----`;
    };

    const maybeCanonicalPem = (value: string): string | null => {
      const match = value.match(/^-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----$/);
      if (!match) return null;
      const label = (match[1] ?? '').trim();
      if (label !== 'CERTIFICATE' && label !== 'PUBLIC KEY') return null;
      const body = (match[2] ?? '').replace(/[^A-Za-z0-9+/=]/g, '');
      if (!body) return null;
      return formatPem(label as 'CERTIFICATE' | 'PUBLIC KEY', body);
    };

    const maybeBase64Body = (value: string): string | null => {
      const compact = value.replace(/\s+/g, '');
      if (compact.length < 64) return null;
      if (!/^[A-Za-z0-9+/=]+$/.test(compact)) return null;
      return compact;
    };

    const maybeBase64UrlBody = (value: string): string | null => {
      const compact = value.replace(/\s+/g, '');
      if (compact.length < 64) return null;
      if (!/^[A-Za-z0-9\-_]+={0,2}$/.test(compact)) return null;
      return compact.replace(/-/g, '+').replace(/_/g, '/');
    };

    const maybeHexBody = (value: string): string | null => {
      const compact = value.replace(/\s+/g, '');
      if (compact.length < 128 || compact.length % 2 !== 0) return null;
      if (!/^[0-9a-fA-F]+$/.test(compact)) return null;
      return compact;
    };

    const canEncryptWithKey = (key: string | Buffer): boolean => {
      try {
        publicEncrypt(
          { key, padding: cryptoConstants.RSA_PKCS1_PADDING },
          Buffer.from('00:00', 'utf8'),
        );
        return true;
      } catch {
        return false;
      }
    };

    const extractPemPublicKeyFromCertificate = (value: string | Buffer): string | null => {
      try {
        const cert = new X509Certificate(value);
        const exported = cert.publicKey.export({ type: 'spki', format: 'pem' });
        return String(exported);
      } catch {
        return null;
      }
    };

    const extractPemPublicKeyFromSpkiDer = (der: Buffer): string | null => {
      try {
        const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
        const exported = key.export({ type: 'spki', format: 'pem' });
        return String(exported);
      } catch {
        return null;
      }
    };

    const candidates: string[] = [];
    addCandidate(candidates, rawValue);
    try {
      addCandidate(candidates, decodeURIComponent(rawValue));
    } catch {
      // keep raw value if it is not URL-encoded
    }

    const expandedCandidates = [...candidates];
    for (const candidate of candidates) {
      addCandidate(expandedCandidates, candidate.replace(/\\n/g, '\n'));
      addCandidate(expandedCandidates, candidate.replace(/\s+/g, '+'));
      const canonicalPem = maybeCanonicalPem(candidate);
      if (canonicalPem) {
        addCandidate(expandedCandidates, canonicalPem);
      }
      const body = maybeBase64Body(candidate) ?? maybeBase64UrlBody(candidate);
      if (body !== null) {
        addCandidate(expandedCandidates, formatPem('CERTIFICATE', body));
        addCandidate(expandedCandidates, formatPem('PUBLIC KEY', body));
      }
    }

    for (const candidate of expandedCandidates) {
      if (canEncryptWithKey(candidate)) {
        return candidate;
      }

      const certPem = extractPemPublicKeyFromCertificate(candidate);
      if (certPem !== null && canEncryptWithKey(certPem)) {
        return certPem;
      }

      const base64Body = maybeBase64Body(candidate) ?? maybeBase64UrlBody(candidate);
      if (base64Body !== null) {
        const der = Buffer.from(base64Body, 'base64');
        const spkiPem = extractPemPublicKeyFromSpkiDer(der);
        if (spkiPem !== null && canEncryptWithKey(spkiPem)) {
          return spkiPem;
        }
        const certPemFromDer = extractPemPublicKeyFromCertificate(der);
        if (certPemFromDer !== null && canEncryptWithKey(certPemFromDer)) {
          return certPemFromDer;
        }
      }

      const hexBody = maybeHexBody(candidate);
      if (hexBody !== null) {
        const der = Buffer.from(hexBody, 'hex');
        const spkiPem = extractPemPublicKeyFromSpkiDer(der);
        if (spkiPem !== null && canEncryptWithKey(spkiPem)) {
          return spkiPem;
        }
        const certPemFromDer = extractPemPublicKeyFromCertificate(der);
        if (certPemFromDer !== null && canEncryptWithKey(certPemFromDer)) {
          return certPemFromDer;
        }
      }
    }

    throw new MiniserverAuthError('miniserver-protocol', 'unsupported miniserver public key format');
  }

  private decryptResponse(raw: string, aesKey: Buffer, aesIv: Buffer): string {
    const sanitized = raw.trim().replace(/\s+/g, '');
    let cipherBuf = Buffer.from(sanitized, 'base64');
    const blockSize = 16;
    const remainder = cipherBuf.length % blockSize;
    if (remainder !== 0) {
      cipherBuf = Buffer.concat([cipherBuf, Buffer.alloc(blockSize - remainder)]);
    }
    const decipher = createDecipheriv('aes-256-cbc', aesKey, aesIv);
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
    return plain.toString('utf8').replace(/\u0000+$/g, '');
  }

  private tryDecryptResponse(raw: string, aesKey: Buffer, aesIv: Buffer): unknown | null {
    try {
      const decrypted = this.decryptResponse(raw, aesKey, aesIv);
      return this.tryParseJson(decrypted);
    } catch {
      return null;
    }
  }

  private async fetchText(baseUrl: string, command: string): Promise<string> {
    const url = `${baseUrl.replace(/\/+$/, '')}/${command.replace(/^\/+/, '')}`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET' });
    } catch {
      throw new MiniserverAuthError('miniserver-unreachable', 'miniserver request failed');
    }
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new MiniserverAuthError('invalid-credentials', 'invalid miniserver credentials');
    }
    if (!res.ok && !text) {
      throw new MiniserverAuthError('miniserver-unreachable', `miniserver http ${res.status}`);
    }
    return text;
  }

  private ensureSuccess(payload: unknown): void {
    const ll = this.asObject(this.asObject(payload).LL);
    const code = this.readNumber(ll.Code) ?? this.readNumber(ll.code);
    if (code === null) {
      throw new MiniserverAuthError('miniserver-protocol', 'missing miniserver code');
    }
    if (code >= 200 && code < 400) return;
    if (code === 401 || code === 403) {
      throw new MiniserverAuthError('invalid-credentials', 'invalid miniserver credentials');
    }
    throw new MiniserverAuthError('miniserver-protocol', `miniserver rejected command (${code})`);
  }

  private extractValue(payload: unknown): unknown {
    const value = this.asObject(this.asObject(payload).LL).value;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    const parsed = this.tryParseJson(trimmed) ?? this.tryParseLooseJson(trimmed);
    return parsed ?? value;
  }

  private normalizeHashAlgorithm(value: string): HashAlgorithm {
    return value.toUpperCase() === 'SHA256' ? 'SHA256' : 'SHA1';
  }

  private tryParseJson(raw: string): unknown | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  private tryParseLooseJson(raw: string): unknown | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return JSON.parse(trimmed.replace(/\'/g, '"'));
    } catch {
      // fall through to more selective normalization
    }
    const normalized = trimmed
      .replace(/([{,]\s*)'([^']+?)'\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*?)'(\s*[},\]])/g, ':"$1"$2');
    try {
      return JSON.parse(normalized);
    } catch {
      return null;
    }
  }

  private asObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    throw new MiniserverAuthError('miniserver-protocol', 'invalid miniserver object response');
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private readNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
}
