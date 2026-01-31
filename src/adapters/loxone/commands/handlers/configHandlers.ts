import {
  generateKeyPairSync,
  privateDecrypt,
  constants as cryptoConstants,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { LoxoneHttpConfig } from '@/config/loxone';
import { buildResponse } from '@/adapters/loxone/commands/responses';
import type { CommandResult, HandlerFn } from '@/adapters/loxone/commands/types';
import { decodeBase64Segment, safeJsonParse } from '@/adapters/loxone/commands/utils/payload';
import type { LoxoneConfigService } from '@/adapters/loxone/services/loxoneConfigService';
import { createLogger } from '@/shared/logging/logger';
import { buildSpotifyAuthLink, deleteSpotifyAccount } from '@/adapters/content/providers/spotify/serviceAuth';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';

type KeyMaterial = {
  modulusHex: string;
  exponent: number;
  publicKeyPem: string;
};

type JsonWebKey = {
  n?: string;
  e?: string;
};

let keyPair: { publicKey: KeyObject; privateKey: KeyObject } | null = null;
let cachedMaterial: KeyMaterial | null = null;
let cachedPublicPemSpki: string | null = null;

type ConfigHandlerOptions = {
  onRestart?: () => Promise<boolean>;
  notifier: NotifierPort;
  configService: LoxoneConfigService;
  configPort: ConfigPort;
  contentManager: ContentManager;
  spotifyInputService: SpotifyInputService;
};

/**
 * Implements the core `/audio/cfg/*` command set.
 */
export function createConfigHandlers(config: LoxoneHttpConfig, options: ConfigHandlerOptions) {
  if (!keyPair) {
    keyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
  }
  const keyMaterial = createKeyMaterial();
  const log = createLogger('Loxone', 'ConfigHandlers');
  const notifier = options.notifier;
  const configService = options.configService;
  const configPort = options.configPort;
  const contentManager = options.contentManager;
  const spotifyInputService = options.spotifyInputService;

  return {
    ready: handler((command) =>
      buildResponse(command, 'ready', {
        session: Date.now(),
      }),
    ),
    getConfig: handler((command) => {
      const info = configService.getCurrentConfigInfo();
      return buildEmptyResponseWithPayload(command, {
        crc32: info.crc32 ?? null,
        extensions: info.extensions ?? [],
      });
    }),
    getKey: handler((command) =>
      buildEmptyResponseWithPayload(command, [
        { pubkey: keyMaterial.modulusHex, exp: keyMaterial.exponent },
      ]),
    ),
    getKeyFull: handler((command) =>
      buildResponse(command, 'getkey', [{ pubkey: exportPublicKeyPemSpki() }]),
    ),
    identify: handler((command) =>
      buildEmptyResponseWithPayload(command, {
        mac: config.macAddress,
        services: [],
      }),
    ),
    miniserverTime: handler((command) =>
      buildEmptyResponseWithPayload(command, Date.now()),
    ),
    restart: handler(async (command) => {
      if (!options.onRestart) {
        return buildEmptyResponseWithPayload(command, true);
      }
      const ok = await options.onRestart();
      return buildEmptyResponseWithPayload(command, ok);
    }),
    diagnosis: handler(async (command) => {
      try {
        const cfg = configPort.getConfig();
        return buildResponse(command, 'diagnosis', cfg ?? {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return buildResponse(command, 'diagnosis', {
          error: 'diagnosis-failed',
          message,
        });
      }
    }),
    setConfig: handler(async (command) => {
      const encoded = getSegment(command, 3);
      if (!encoded) {
        return buildResponse(command, 'setconfig', {
          success: false,
          error: 'missing-payload',
        });
      }

      const decoded = decodeBase64Segment(decodeURIComponent(encoded));
      const parsed = safeJsonParse<unknown>(decoded);
      if (!parsed) {
        return buildResponse(command, 'setconfig', {
          success: false,
          error: 'invalid-config',
        });
      }

      const crc32 = await configService.setRawAudioConfig({
        raw: parsed,
        rawString: decoded,
      });

      const info = configService.getCurrentConfigInfo();
      return buildEmptyResponseWithPayload(command, {
        crc32: crc32 ?? info.crc32 ?? null,
        extensions: info.extensions ?? [],
      });
    }),
    setConfigTimestamp: handler(async (command) => {
      const timestamp = Number(getSegment(command, 3));
      if (!Number.isFinite(timestamp)) {
        return buildResponse(command, 'setconfigtimestamp', {
          success: false,
          error: 'invalid-timestamp',
        });
      }

      const info = configService.getCurrentConfigInfo();
      return buildResponse(command, 'setconfigtimestamp', {
        success: true,
        timestamp,
        crc32: info.crc32 ?? null,
      });
    }),
    setVolumes: handler(async (command) => {
      const encoded = getSegment(command, 3);
      if (!encoded) {
        return buildResponse(command, 'volumes', {
          success: false,
          error: 'missing-payload',
        });
      }

      const decoded = decodeBase64Segment(decodeURIComponent(encoded));
      const parsed = safeJsonParse<{ players?: unknown[] }>(decoded);

      if (!parsed?.players) {
        return buildResponse(command, 'volumes', {
          success: false,
          error: 'invalid-volume-payload',
        });
      }

      const count = await configService.applyVolumePreset(parsed.players);
      return buildResponse(command, 'volumes', { success: true, players: count });
    }),
    setDefaultVolume: handler(async (command) => {
      const [, , , zone, value] = command.split('/');
      const zoneId = Number(zone);
      const volume = Number(value);

      if (!Number.isFinite(zoneId) || !Number.isFinite(volume)) {
        return buildResponse(command, 'setdefaultvolume', {
          success: false,
          error: 'invalid-parameters',
        });
      }

      await configService.applyDefaultVolume(zoneId, volume);
      return buildResponse(command, 'setdefaultvolume', {
        success: true,
        value: volume,
      });
    }),
    setMaxVolume: handler(async (command) => {
      const [, , , zone, value] = command.split('/');
      const zoneId = Number(zone);
      const volume = Number(value);

      if (!Number.isFinite(zoneId) || !Number.isFinite(volume)) {
        return buildResponse(command, 'setmaxvolume', {
          success: false,
          error: 'invalid-parameters',
        });
      }

      await configService.applyMaxVolume(zoneId, volume);
      return buildResponse(command, 'setmaxvolume', {
        success: true,
        value: volume,
      });
    }),
    setEventVolumes: handler(async (command) => {
      const encoded = getSegment(command, 3);
      if (!encoded) {
        return buildResponse(command, 'seteventvolumes', {
          success: false,
          error: 'missing-payload',
        });
      }

      const decoded = decodeBase64Segment(decodeURIComponent(encoded));
      const parsed = safeJsonParse<Record<string, number>>(decoded);

      if (!parsed) {
        return buildResponse(command, 'seteventvolumes', {
          success: false,
          error: 'invalid-event-payload',
        });
      }

      await configService.applyEventVolumes(parsed);
      return buildResponse(command, 'seteventvolumes', { success: true });
    }),
    getEq: handler((command) => buildResponse(command, 'geteq', [])),
    playerName: handler(async (command) => {
      const encoded = getSegment(command, 3);
      if (!encoded) {
        return buildResponse(command, 'playername', {
          success: false,
          error: 'missing-player-payload',
        });
      }
      try {
        const decoded = decodeURIComponent(encoded);
        const jsonStr = decodeBase64Segment(decoded);
        const parsed = safeJsonParse<unknown>(jsonStr);
        if (!parsed) {
          throw new Error('player payload is not valid JSON');
        }
        const updates = extractPlayerNameUpdates(parsed);
        if (!updates.length) {
          return buildResponse(command, 'playername', { success: true, result: '' });
        }
        await configService.applyPlayerNames(updates);
        log.info('updated player names', {
          updates: updates.length,
          zones: updates.map((u) => u.zoneId),
        });
        return buildResponse(command, 'playername', { success: true, result: '' });
      } catch (error) {
        log.warn('failed to apply player names', {
          message: error instanceof Error ? error.message : String(error),
        });
        return buildResponse(command, 'playername', {
          success: false,
          error: 'invalid-player-payload',
        });
      }
    }),
    serviceCfgGetLink: handler(async (command) => {
      const parts = command.split('/');
      const service = (parts[4] ?? parts[3] ?? '').toLowerCase();

      if (service !== 'spotify') {
        return buildResponse(command, 'servicecfg', { link: '' });
      }

      const cfg = configPort.getConfig();
      const host = cfg.system?.audioserver?.ip?.trim() || '127.0.0.1';

      const link = buildSpotifyAuthLink({ audioServerHost: host }, configPort);
      return buildResponse(command, 'servicecfg', { link: link ?? '' });
    }),
    serviceCfgDelete: handler(async (command) => {
      const parts = command.split('/');
      const service = (parts[4] ?? '').toLowerCase();
      const userId = parts[5] ?? '';

      if (service === 'spotify' && userId) {
        await deleteSpotifyAccount(configPort, userId, notifier, contentManager, spotifyInputService);
        // notify frontend to refresh service state
        configService.notifyReloadMusicApp('userdel', 'spotify', userId);
      }

      return buildResponse(command, 'servicecfg', { action: 'deleted', error: 0 });
    }),
  };
}

function handler(
  fn: (command: string, payload?: Buffer) => CommandResult | Promise<CommandResult>,
): HandlerFn {
  return (command, payload) => fn(command, payload);
}

function buildEmptyResponseWithPayload(
  command: string,
  payload: unknown,
): CommandResult {
  const name = inferName(command);
  return buildResponse(command, name, payload as CommandResult['payload']);
}

function inferName(command: string): string {
  const parts = command.split('/').filter(Boolean);
  return parts.pop() ?? 'response';
}

function getSegment(command: string, index: number): string | undefined {
  return command.split('/')[index];
}

function createKeyMaterial(): KeyMaterial {
  if (cachedMaterial) {
    return cachedMaterial;
  }
  if (!keyPair) {
    keyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
  }
  const { publicKey } = keyPair;

  const publicKeyPem = publicKey.export({ type: 'pkcs1', format: 'pem' }) as string;
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;

  const modulusHex = jwk.n
    ? Buffer.from(jwk.n.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex')
    : '';
  const exponentBuffer = jwk.e
    ? Buffer.from(jwk.e.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    : Buffer.from([0x01, 0x00, 0x01]);
  const exponent = exponentBuffer.readUIntBE(0, exponentBuffer.length);

  cachedMaterial = { modulusHex, exponent, publicKeyPem };
  return cachedMaterial;
}

function exportPublicKeyPemSpki(): string {
  if (cachedPublicPemSpki) {
    return cachedPublicPemSpki;
  }
  if (!keyPair) {
    keyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
  }
  cachedPublicPemSpki = keyPair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  return cachedPublicPemSpki;
}

export function decryptWithAudioCfgKey(cipherBase64: string | undefined): string | null {
  if (!cipherBase64) {
    return null;
  }
  if (!keyPair) {
    keyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
  }
  try {
    const decrypted = privateDecrypt(
      {
        key: keyPair.privateKey,
        padding: cryptoConstants.RSA_PKCS1_PADDING,
      },
      Buffer.from(cipherBase64, 'base64'),
    );
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

function extractPlayerNameUpdates(payload: unknown): Array<{ zoneId: number; name: string }> {
  const updates: Array<{ zoneId: number; name: string }> = [];

  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const candidate = entry as Record<string, unknown>;
    const zoneId = Number(
      candidate.playerid ?? candidate.id ?? candidate.zoneid ?? candidate.zoneId,
    );
    const rawName =
      typeof candidate.name === 'string'
        ? candidate.name
        : typeof candidate.title === 'string'
          ? candidate.title
          : undefined;
    const trimmed = rawName?.trim();
    if (Number.isFinite(zoneId) && trimmed) {
      updates.push({ zoneId, name: trimmed });
    }
  };

  if (Array.isArray(payload)) {
    payload.forEach(visit);
  } else if (payload && typeof payload === 'object') {
    const container: unknown =
      (payload as Record<string, unknown>).players ??
      (payload as Record<string, unknown>).player;
    if (Array.isArray(container)) {
      container.forEach(visit);
    } else if (container && typeof container === 'object') {
      Object.values(container).forEach(visit);
    } else {
      visit(payload);
    }
  }

  const deduped = new Map<number, string>();
  for (const update of updates) {
    deduped.set(update.zoneId, update.name);
  }
  return Array.from(deduped.entries()).map(([zoneId, name]) => ({ zoneId, name }));
}
