import crypto from 'crypto';

const pkceState = new Map<string, string>();

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function createPkcePair(stateKey: string): { codeChallenge: string } {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
  pkceState.set(stateKey, verifier);
  return { codeChallenge: challenge };
}

export function consumePkceVerifier(stateKey: string): string | undefined {
  const verifier = pkceState.get(stateKey);
  if (verifier) {
    pkceState.delete(stateKey);
  }
  return verifier;
}
