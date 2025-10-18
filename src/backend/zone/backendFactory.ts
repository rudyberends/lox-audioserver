import Backend, { BackendProbeOptions } from './backendBaseClass';
import BackendBeolink from './Beolink/backend';
import BackendMusicAssistant from './MusicAssistant/backend';
import BackendSonos from './Sonos/backend';
import NullBackend from './nullBackend';

interface BackendFactoryEntry {
  new (ip: string, playerId: number, extra?: any): Backend;
  probe?(opts: BackendProbeOptions): Promise<void>;
}

export interface BackendCreateOptions {
  maPlayerId?: string;
}

const backendMap: Record<string, BackendFactoryEntry> = {
  BackendBeolink: BackendBeolink as BackendFactoryEntry,
  BackendMusicAssistant: BackendMusicAssistant as BackendFactoryEntry,
  BackendSonos: BackendSonos as BackendFactoryEntry,
  NullBackend: NullBackend as BackendFactoryEntry,
};

/** Returns the list of available backend identifiers. */
export function listBackends(): string[] {
  return Object.keys(backendMap);
}

/**
 * Creates an instance of the specified backend class.
 *
 * @param backendName - The name of the backend class to instantiate.
 * @param ip - The IP address of the backend device or server.
 * @param loxoneZoneId - The Loxone zone ID (used for mapping .env vars).
 */
export function createBackend(
  backendName: string,
  ip: string,
  loxoneZoneId: number,
  options: BackendCreateOptions = {},
): Backend | null {
  const BackendClass = backendMap[backendName];
  if (!BackendClass) return null;

  if (backendName === 'BackendMusicAssistant') {
    return new BackendClass(ip, loxoneZoneId, options.maPlayerId);
  }

  if (backendName === 'BackendBeolink') {
    return new BackendClass(ip, loxoneZoneId, { maPlayerId: options.maPlayerId });
  }

  // Default: 2-arg constructor
  return new BackendClass(ip, loxoneZoneId);
}

export async function validateBackendConfig(
  backendName: string,
  options: BackendProbeOptions,
): Promise<void> {
  const BackendClass = backendMap[backendName];
  if (!BackendClass) {
    throw new Error(`Unknown backend "${backendName}"`);
  }
  if (typeof BackendClass.probe === 'function') {
    await BackendClass.probe(options);
  }
}
