/**
 * -----------------------------------------------------------------------------
 * BeoLink Adapter Registration
 * -----------------------------------------------------------------------------
 * Registers BeoLink-specific state and command mappers in the global registries.
 * This file is automatically executed when the BeoLink adapter is imported.
 * -----------------------------------------------------------------------------
 */

import { CommandMapperConstructor, registerCommandMapper } from '@/model/registry/commandMapperRegistry';
import { registerStateMapper, StateMapperConstructor } from '@/model/registry/stateMapperRegistry';
import { BeoLinkCommandMapper } from './mappers/beoLinkCommandMapper';
import { BeoLinkStateMapper } from './mappers/beoLinkStateMapper';

registerCommandMapper('beolink', BeoLinkCommandMapper as unknown as CommandMapperConstructor<Record<string, any>>, {
  description: 'Command mapper for the BeoLink HTTP API',
  version: '2.0.0',
  displayName: 'BeoLink',
  configSchema: {
    fields: [
      {
        id: 'ip',
        label: 'BeoLink Host',
        inputType: 'text',
        required: true,
        placeholder: '192.168.1.20',
        helpText: 'IP address of the BeoLink device.',
      },
    ],
  },
  suggestedProviderType: '',
});

registerStateMapper('beolink', BeoLinkStateMapper as unknown as StateMapperConstructor<Record<string, any>>, {
  description: 'State mapper for BeoLink NDJSON notifications',
  sourceType: 'http/ndjson',
  version: '2.0.0',
});
