import logger from '@/utils/troxorLogger';

export function logCommand(adapter: string, zoneName: string, action: string, detail?: string): void {
  const extra = detail ? ` ${detail}` : '';
  logger.info(`[${adapter}][${zoneName}] ${action}${extra}`);
}

export function logDebug(adapter: string, zoneName: string, message: string): void {
  logger.debug(`[${adapter}][${zoneName}] ${message}`);
}

export function logWarn(adapter: string, zoneName: string, message: string): void {
  logger.warn(`[${adapter}][${zoneName}] ${message}`);
}

export function logError(adapter: string, zoneName: string, action: string, err: unknown): void {
  logger.error(`[${adapter}][${zoneName}] ${action} failed: ${String(err)}`);
}

