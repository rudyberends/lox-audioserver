import { CommandMapperConstructor, registerCommandMapper } from '@/model/registry/commandMapperRegistry';
import { registerStateMapper, StateMapperConstructor } from '@/model/registry/stateMapperRegistry';
import { registerContentProvider } from '@/model/registry/contentProviderRegistry';
import { MusicAssistantStateMapper } from './state/mapper';
import { MusicAssistantCommandMapper } from './command/mapper';
import { MusicAssistantContentProviderMapper } from './provider/mapper';
import { registerContentPlayer } from '@/model/registry/contentPlayerRegistry';
import { MusicAssistantContentPlaybackMapper } from './contentPlayback/mapper';
import { MusicAssistantApi } from './api';

async function validateMusicAssistantAdapterConfig(params: Record<string, any>): Promise<void> {
  const ip = typeof params?.ip === 'string' ? params.ip.trim() : '';
  if (!ip) {
    throw new Error('Add Music Assistant IP before saving.');
  }

  const portCandidate = Number(params?.port ?? params?.maPort ?? 8095);
  const port = Number.isFinite(portCandidate) && portCandidate > 0 ? portCandidate : 8095;

  const playerId = typeof params?.maPlayerId === 'string' ? params.maPlayerId.trim() : '';
  const api = MusicAssistantApi.acquire(ip, port);
  try {
    await api.connect();
    const players = await api.getAllPlayers();
    if (playerId) {
      const normalizedPlayers = Array.isArray(players) ? players : [];
      const hasPlayer = normalizedPlayers.some((player) => {
        if (!player || typeof player !== 'object') {
          return false;
        }
        const candidate =
          player.player_id
          ?? player.queue_id
          ?? player.id
          ?? player.uuid
          ?? player.playerid;
        return typeof candidate === 'string' && candidate.trim() === playerId;
      });
      if (!hasPlayer) {
        throw new Error(`Player "${playerId}" not found on Music Assistant (${ip}).`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to connect to Music Assistant: ${message}`);
  } finally {
    api.release();
  }
}

registerCommandMapper('musicassistant', MusicAssistantCommandMapper as unknown as CommandMapperConstructor<Record<string, any>>, {
  description: 'Music Assistant Player control',
  version: '2.0.0',
  displayName: 'Music Assistant',
  suggestedProviderType: 'musicassistant',
  configSchema: {
    fields: [
      {
        id: 'ip',
        label: 'Music Assistant Host',
        inputType: 'text',
        required: true,
        placeholder: '192.168.1.10',
        helpText: 'Hostname or IP address of the Music Assistant server.',
      },
      {
        id: 'maPlayerId',
        label: 'Music Assistant Player',
        inputType: 'discoveredSelect',
        required: true,
        helpText: 'Select the player to control for this zone.',
        discovery: {
          type: 'musicassistantPlayers',
          endpoint: '/admin/api/musicassistant/players',
          method: 'POST',
          requires: ['ip'],
        },
      },
    ],
  },
}, { validate: validateMusicAssistantAdapterConfig });

registerStateMapper('musicassistant', MusicAssistantStateMapper as unknown as StateMapperConstructor<Record<string, any>>, {
  description: 'State mapper for musicAssistant notifications',
  sourceType: 'http/ndjson',
  version: '2.0.0',
});

registerContentProvider('musicassistant', MusicAssistantContentProviderMapper as unknown as new (params: Record<string, any>) => any, {
  // eslint-disable-next-line max-len
  description: 'Content provider for Music Assistant. Fakes a spotify library on Loxone and serves all library content under this spotify library. If you configure tunein it will be available under radio.',
  version: '2.0.0',
  displayName: 'Music Assistant',
  configSchema: {
    fields: [
      {
        id: 'ip',
        label: 'Music Assistant Host',
        inputType: 'text',
        required: true,
        placeholder: '192.168.1.10',
        helpText: 'Hostname or IP address of the Music Assistant server.',
      },
      {
        id: 'port',
        label: 'Port',
        inputType: 'number',
        required: false,
        placeholder: '8095',
        helpText: 'Defaults to 8095.',
      },
    ],
  },
});

registerContentPlayer('musicassistant-playback', MusicAssistantContentPlaybackMapper, {
  description: 'Music Assistant playback handler (play commands)',
  version: '1.0.0',
  displayName: 'Music Assistant Playback',
  providerType: 'musicassistant',
  requiresPlayerId: true,
});
