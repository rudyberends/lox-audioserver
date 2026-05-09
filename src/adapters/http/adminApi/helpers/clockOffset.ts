import https from 'node:https';
import type { ComponentLogger } from '@/shared/logging/logger';

const MAX_AGE_MS = 5 * 60 * 1000;
const MIN_LOG_INTERVAL_MS = 30 * 60 * 1000;

type Cache = { offsetMs: number | null; sampledAt: number };
type FailureLog = { message: string | null; loggedAt: number };

/**
 * Tracks the offset between local clock and a remote authoritative time
 * source (currently timeapi.io). Used by /zones/states so that admin UI can
 * display device drift without hammering the upstream service — results are
 * cached for 5 minutes and failures are throttled in the log.
 */
export class ClockOffsetTracker {
  private cache: Cache = { offsetMs: null, sampledAt: 0 };
  private failureLog: FailureLog = { message: null, loggedAt: 0 };

  constructor(private readonly log: ComponentLogger) {}

  public async get(): Promise<number | null> {
    const now = Date.now();
    if (now - this.cache.sampledAt < MAX_AGE_MS) {
      return this.cache.offsetMs;
    }
    try {
      const offset = await this.fetch();
      this.cache = { offsetMs: offset, sampledAt: Date.now() };
      this.failureLog = { message: null, loggedAt: 0 };
      return offset;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logFailure(message);
      return this.cache.offsetMs;
    }
  }

  private fetch(): Promise<number | null> {
    const providers: Array<{ name: string; url: string; parse: (body: string) => number | null }> = [
      {
        name: 'timeapi',
        url: 'https://timeapi.io/api/Time/current/zone?timeZone=Etc/UTC',
        parse: (body) => {
          const parsed = JSON.parse(body) as {
            year?: number;
            month?: number;
            day?: number;
            hour?: number;
            minute?: number;
            seconds?: number;
            milliSeconds?: number;
            dateTime?: string;
          };
          if (
            typeof parsed.year === 'number' &&
            typeof parsed.month === 'number' &&
            typeof parsed.day === 'number' &&
            typeof parsed.hour === 'number' &&
            typeof parsed.minute === 'number' &&
            typeof parsed.seconds === 'number'
          ) {
            const ms = typeof parsed.milliSeconds === 'number' ? parsed.milliSeconds : 0;
            return Date.UTC(
              parsed.year,
              parsed.month - 1,
              parsed.day,
              parsed.hour,
              parsed.minute,
              parsed.seconds,
              ms,
            );
          }
          if (typeof parsed.dateTime === 'string') {
            const ts = Date.parse(parsed.dateTime);
            return Number.isNaN(ts) ? null : ts;
          }
          return null;
        },
      },
    ];

    return new Promise((resolve, reject) => {
      const tryProvider = (index: number, errors: string[]): void => {
        if (index >= providers.length) {
          reject(new Error(`clock offset providers unavailable: ${errors.join('; ')}`));
          return;
        }
        const provider = providers[index]!;
        const req = https.get(
          provider.url,
          {
            timeout: 1500,
            headers: { Accept: 'application/json' },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => {
              if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
                tryProvider(index + 1, [...errors, `${provider.name}:http-${res.statusCode ?? 0}`]);
                return;
              }
              try {
                const remoteMs = provider.parse(body);
                if (!remoteMs) {
                  tryProvider(index + 1, [...errors, `${provider.name}:invalid-payload`]);
                  return;
                }
                resolve(Date.now() - remoteMs);
              } catch {
                tryProvider(index + 1, [...errors, `${provider.name}:parse-error`]);
              }
            });
          },
        );
        req.on('error', () => {
          tryProvider(index + 1, [...errors, `${provider.name}:network-error`]);
        });
        req.on('timeout', () => {
          req.destroy(new Error('timeout'));
          tryProvider(index + 1, [...errors, `${provider.name}:timeout`]);
        });
      };
      tryProvider(0, []);
    });
  }

  private logFailure(message: string): void {
    const now = Date.now();
    const sameMessage = this.failureLog.message === message;
    const recentlyLogged = now - this.failureLog.loggedAt < MIN_LOG_INTERVAL_MS;
    if (sameMessage && recentlyLogged) {
      return;
    }
    this.failureLog = { message, loggedAt: now };
    this.log.debug('clock offset fetch failed', { message });
  }
}
