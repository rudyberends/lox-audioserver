import { createLogger } from '@/core/logging/logger';
import { formatCommand } from '@/modules/loxone/commands/utils/commandFormatter';

export const loxoneCommandLog = createLogger('LoxoneHttp', 'Commands');

export const logCommand = (label: string, command: string): void => {
  loxoneCommandLog.debug(label, { command: formatCommand(command) });
};
