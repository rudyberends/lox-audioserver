import { createLogger } from '@/shared/logging/logger';

export type StopResult =
  | { kind: 'stopped' }
  | { kind: 'timeout' }
  | { kind: 'error'; error: unknown };

export async function stopWithTimeout(
  name: string,
  stopFn: () => Promise<void>,
  timeoutMs: number,
  log = createLogger('Server'),
): Promise<StopResult> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  const stopPromise = (async (): Promise<StopResult> => {
    try {
      await stopFn();
      return { kind: 'stopped' };
    } catch (error) {
      return { kind: 'error', error };
    }
  })();
  const timeoutPromise = new Promise<StopResult>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });

  const result = await Promise.race([stopPromise, timeoutPromise]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });

  if (result.kind === 'stopped') {
    log.info(`service ${name} stopped`);
    return result;
  }

  if (result.kind === 'timeout') {
    log.warn(`service ${name} stop timed out`, { timeoutMs });
    void stopPromise.then((finalResult) => {
      if (finalResult.kind !== 'error') {
        return;
      }
      const message =
        finalResult.error instanceof Error
          ? finalResult.error.message
          : String(finalResult.error);
      log.error(`failed to stop ${name}`, { message });
    });
    return result;
  }

  const message = result.error instanceof Error ? result.error.message : String(result.error);
  log.error(`failed to stop ${name}`, { message });
  return result;
}
