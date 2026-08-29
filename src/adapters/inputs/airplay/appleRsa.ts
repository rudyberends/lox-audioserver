import path from 'node:path';
import { readFileSync } from 'node:fs';
import { constants, privateDecrypt, privateEncrypt } from 'node:crypto';

/**
 * The RSA half of an AirPlay 1 receiver.
 *
 * A sender wraps its AES audio key in the receiver's RSA public key, and there
 * is no key exchange in the protocol to negotiate which one: every sender has
 * the AirPort Express public key built in, so a receiver has to hold the
 * matching private key or it cannot read a single audio packet. That is why a
 * receiver advertising `et=0` gets abandoned right after OPTIONS — an iPhone
 * will not send audio it cannot encrypt.
 *
 * The key itself is deliberately not in this repository. It is read from
 * `data/airplay-rsa.pem` at startup; without that file the receiver still runs
 * and still answers RTSP, it just advertises no encryption and only senders
 * that accept a clear stream will talk to it.
 */
export interface AppleRsa {
  decryptAesKey(wrapped: Buffer): Buffer;
  answerChallenge(challenge: Buffer, localAddress: string, mac: Buffer): string;
}

const KEY_PATH = path.resolve(process.cwd(), 'data', 'airplay-rsa.pem');

export function loadAppleRsa(): AppleRsa | null {
  let pem: string;
  try {
    pem = readFileSync(KEY_PATH, 'utf8');
  } catch {
    return null;
  }

  return {
    decryptAesKey(wrapped) {
      return privateDecrypt({ key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING }, wrapped);
    },

    answerChallenge(challenge, localAddress, mac) {
      // The signed blob is the challenge followed by our address and MAC,
      // zero-filled to 32 bytes. The sender rebuilds it from what it knows
      // about us, so both halves have to agree byte for byte.
      const data = Buffer.alloc(32);
      const used = challenge.copy(data, 0, 0, Math.min(challenge.length, 32 - 10));
      const octets = localAddress.split('.');
      if (octets.length === 4) {
        Buffer.from(octets.map((o) => Number(o) & 0xff)).copy(data, used);
        mac.copy(data, used + 4, 0, 6);
      } else {
        mac.copy(data, used, 0, 6);
      }
      const signed = privateEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, data);
      return signed.toString('base64').replace(/=+$/, '');
    },
  };
}
