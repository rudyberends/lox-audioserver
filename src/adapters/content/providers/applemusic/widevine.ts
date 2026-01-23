import { join } from 'node:path';
import { ensureDir, ensureFile, readFileBuffer, resolveDataDir } from '@/shared/utils/file';

const CDM_DIR = resolveDataDir('widevine_cdm');
const PRIVATE_KEY_PATH = join(CDM_DIR, 'private_key.pem');
const CLIENT_ID_PATH = join(CDM_DIR, 'client_id.bin');

type WidevineArtifacts = {
  privateKey: Buffer;
  clientIdBlob: Buffer;
};

let cachedArtifacts: WidevineArtifacts | null = null;

async function ensureWidevineCdm(): Promise<void> {
  await ensureDir(CDM_DIR);
  await ensureFile(PRIVATE_KEY_PATH);
  await ensureFile(CLIENT_ID_PATH);
}

export async function loadWidevineArtifacts(): Promise<WidevineArtifacts> {
  if (cachedArtifacts) {
    return cachedArtifacts;
  }

  await ensureWidevineCdm();

  const privateKey = await readFileBuffer(PRIVATE_KEY_PATH);
  const clientIdBlob = await readFileBuffer(CLIENT_ID_PATH);

  cachedArtifacts = { privateKey, clientIdBlob };
  return cachedArtifacts;
}
