import { join } from 'node:path';
import { ensureDir, readFileBuffer, resolveDataDir } from '@/shared/utils/file';

const CDM_DIR = resolveDataDir('widevine_cdm');
const PRIVATE_KEY_PATH = join(CDM_DIR, 'private_key.pem');
const CLIENT_ID_PATH = join(CDM_DIR, 'client_id.bin');

type WidevineArtifacts = {
  privateKey: Buffer;
  clientIdBlob: Buffer;
};

let cachedArtifacts: WidevineArtifacts | null = null;

export class WidevineArtifactsError extends Error {
  public readonly code: 'missing' | 'invalid';
  public readonly details: string[];

  constructor(code: 'missing' | 'invalid', message: string, details: string[]) {
    super(message);
    this.name = 'WidevineArtifactsError';
    this.code = code;
    this.details = details;
  }
}

async function ensureWidevineCdm(): Promise<void> {
  await ensureDir(CDM_DIR);
}

export async function loadWidevineArtifacts(): Promise<WidevineArtifacts> {
  if (cachedArtifacts) {
    return cachedArtifacts;
  }

  await ensureWidevineCdm();

  let privateKey: Buffer;
  let clientIdBlob: Buffer;
  try {
    privateKey = await readFileBuffer(PRIVATE_KEY_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WidevineArtifactsError('missing', 'Widevine artifacts missing', ['private_key.pem missing']);
    }
    throw err;
  }
  try {
    clientIdBlob = await readFileBuffer(CLIENT_ID_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WidevineArtifactsError('missing', 'Widevine artifacts missing', ['client_id.bin missing']);
    }
    throw err;
  }

  const issues: string[] = [];
  if (!privateKey.length) {
    issues.push('private_key.pem empty');
  } else {
    const keyText = privateKey.toString('utf-8');
    if (!/-----BEGIN [A-Z ]+-----/.test(keyText)) {
      issues.push('private_key.pem invalid');
    }
  }
  if (!clientIdBlob.length) {
    issues.push('client_id.bin empty');
  }
  if (issues.length) {
    throw new WidevineArtifactsError('invalid', 'Widevine artifacts missing or invalid', issues);
  }

  cachedArtifacts = { privateKey, clientIdBlob };
  return cachedArtifacts;
}
