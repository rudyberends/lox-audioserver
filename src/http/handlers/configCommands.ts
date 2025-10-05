import NodeRSA from 'node-rsa';
import { CommandResult, emptyCommand } from './requesthandler';
import { config } from '../../config/config';

/**
 * Shared RSA key used for Loxone key exchange endpoints.
 * Created once on module load to avoid regenerating expensive keys per request.
 */
const rsaKey = new NodeRSA({ b: 2048 });
rsaKey.setOptions({ encryptionScheme: 'pkcs1' });

/**
 * Report that the audio configuration is ready and provide a static session identifier.
 */
export function audioCfgReady(url: string): CommandResult {
  const sessionData = { session: 547541322864 };
  return emptyCommand(url, sessionData);
}

/**
 * Return the CRC and extension list for the current audio configuration.
 */
export function audioCfgGetConfig(url: string): CommandResult {
  const configData = {
    crc32: config.audioserver?.musicCRC,
    extensions: [],
  };
  return emptyCommand(url, configData);
}

/**
 * Expose the public RSA key so Loxone clients can encrypt sensitive payloads.
 */
export function audioCfgGetKey(url: string): CommandResult {
  const publicKeyComponents = rsaKey.exportKey('components-public');
  const data = [
    {
      pubkey: publicKeyComponents.n.toString('hex'),
      exp: publicKeyComponents.e,
    },
  ];
  return emptyCommand(url, data);
}
