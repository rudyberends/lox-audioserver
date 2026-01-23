import type { ComponentLogger } from '@/shared/logging/logger';

export type BestEffortOptions<T> = {
  fallback: T;
  onError?: 'ignore' | 'debug';
  label?: string;
  context?: Record<string, unknown>;
  log?: ComponentLogger;
};

function logBestEffortFailure(
  error: unknown,
  options: BestEffortOptions<unknown>,
): void {
  if (options.onError !== 'debug' || !options.log) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  options.log.debug(options.label ?? 'best-effort fallback used', {
    ...options.context,
    message,
  });
}

export async function bestEffort<T>(
  fn: () => Promise<T>,
  options: BestEffortOptions<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logBestEffortFailure(error, options);
    return options.fallback;
  }
}

export function bestEffortSync<T>(fn: () => T, options: BestEffortOptions<T>): T {
  try {
    return fn();
  } catch (error) {
    logBestEffortFailure(error, options);
    return options.fallback;
  }
}

export function safeJsonParse<T>(
  raw: string,
  fallback: T,
  options: Omit<BestEffortOptions<T>, 'fallback'> = {},
): T {
  return bestEffortSync(() => JSON.parse(raw) as T, { ...options, fallback });
}

export async function safeReadText(
  response: { text: () => Promise<string> },
  fallback = '',
  options: Omit<BestEffortOptions<string>, 'fallback'> = {},
): Promise<string> {
  return bestEffort(() => response.text(), { ...options, fallback });
}
