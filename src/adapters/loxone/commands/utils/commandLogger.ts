import { createLogger } from '@/shared/logging/logger';
import { formatCommand } from '@/adapters/loxone/commands/utils/commandFormatter';

export const loxoneCommandLog = createLogger('LoxoneHttp', 'Commands');

export const logCommand = (label: string, command: string): void => {
  loxoneCommandLog.debug(label, { command: formatCommand(command) });
};
