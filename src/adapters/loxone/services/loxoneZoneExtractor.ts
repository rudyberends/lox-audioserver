import type { ZoneConfig } from '@/domain/config/types';

export interface ZoneDescriptor {
  id: number;
  name: string;
  sourceSerial: string;
  sourceMac: string;
  sourceLabel: string;
  loxoneUuid?: string;
}

/**
 * Extracts AudioServer zone definitions from the parsed Loxone config payload.
 */
export function extractZonesFromLoxoneConfig(
  parsedConfig: any,
  macId: string,
): ZoneDescriptor[] {
  if (!Array.isArray(parsedConfig)) {
    return [];
  }

  let server: any | undefined;

  for (const item of parsedConfig) {
    if (item && typeof item === 'object') {
      const matchKey = Object.keys(item).find(
        (key) => key.trim().toUpperCase() === macId,
      );
      if (matchKey) {
        server = item[matchKey];
        break;
      }
    }
  }

  if (!server) {
    return [];
  }

  const players = Array.isArray(server.players) ? server.players : [];
  if (!players.length) {
    return [];
  }

  const extensions = Array.isArray(server.extensions) ? server.extensions : [];

  const extensionMap = new Map<string, { label: string }>();

  extensions.forEach((ext: any, index: number) => {
    if (!ext || typeof ext !== 'object') {
      return;
    }

    const serial = String(ext.serial ?? '').trim().toUpperCase();
    if (!serial) {
      return;
    }

    const label =
      typeof ext.name === 'string' && ext.name.trim()
        ? ext.name.trim()
        : `Stereo Extension ${index + 1}`;

    extensionMap.set(serial, { label });
  });

  const audioSerial = macId;
  const serverName =
    typeof server.name === 'string' && server.name.trim()
      ? server.name.trim()
      : 'AudioServer';

  const resolvePlayerSource = (player: any) => {
    const outputs = Array.isArray(player.outputs) ? player.outputs : [];
    let serial = '';

    outputsLoop: for (const output of outputs) {
      const channels = Array.isArray(output?.channels)
        ? output.channels
        : [];

      for (const channel of channels) {
        if (channel && typeof channel.id === 'string') {
          const [rawSerial] = channel.id.split('#');
          if (rawSerial) {
            serial = rawSerial.trim().toUpperCase();
            break outputsLoop;
          }
        }
      }
    }

    let label = serverName;

    if (serial) {
      if (extensionMap.has(serial)) {
        label = extensionMap.get(serial)!.label;
      } else if (audioSerial && serial !== audioSerial) {
        const suffix = serial.slice(-4) || serial;
        label = `Stereo Extension ${suffix}`;
      }
    } else {
      serial = audioSerial;
      label = serverName;
    }

    return { serial, label };
  };

  return players.map((player: any, index: number) => {
    const id = Number(player.playerid ?? player.id ?? 0);
    const resolved = resolvePlayerSource(player);

    return {
      id,
      name:
        typeof player.name === 'string' && player.name.trim()
          ? player.name.trim()
          : `Zone ${id || index + 1}`,
      sourceSerial: resolved.serial,
      sourceMac: resolved.serial,
      sourceLabel: resolved.label,
      loxoneUuid:
        typeof player.uuid === 'string' && player.uuid.trim()
          ? player.uuid.trim()
          : undefined,
    };
  });
}

export function buildZoneConfigs(descriptors: ZoneDescriptor[]): ZoneConfig[] {
  return descriptors.map((descriptor) => ({
    id: descriptor.id,
    name: descriptor.name,
    sourceMac: descriptor.sourceMac,
    transports: [],
    inputs: {
      airplay: {
        enabled: true,
        port: undefined,
        model: 'generic',
      } as any,
    },
    volumes: defaultVolumes(),
  }));
}

function defaultVolumes() {
  return {
    default: 30,
    alarm: 40,
    fire: 50,
    bell: 35,
    buzzer: 35,
    tts: 40,
    volstep: 2,
    fading: 5,
    maxVolume: 80,
  };
}
