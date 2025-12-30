import { EventEmitter } from 'node:events';

export interface LogEntry {
  line: string;
  timestamp: string;
}

export interface LogSnapshot {
  log: string;
  size: number;
  limit: number;
  truncated: boolean;
  missing: boolean;
  updatedAt: string | null;
}

type LogListener = (entry: LogEntry) => void;

/**
 * Maintains an in-memory rolling buffer of log lines for the admin UI.
 */
class LogBuffer extends EventEmitter {
  private buffer = '';
  private truncated = false;
  private updatedAt: string | null = null;
  private readonly limit = 500_000; // roughly 500 KB of UTF-8 text

  public append(rawLine: string): void {
    if (!rawLine) return;
    const normalized = this.normalize(rawLine);
    const needsSeparator = this.buffer && !this.buffer.endsWith('\n');
    let combined = needsSeparator ? `${this.buffer}\n${normalized}` : `${this.buffer}${normalized}`;
    let truncated = this.truncated;
    if (combined.length > this.limit) {
      combined = combined.slice(combined.length - this.limit);
      truncated = true;
    }
    this.buffer = combined;
    this.truncated = truncated;
    this.updatedAt = new Date().toISOString();
    this.emit('entry', { line: normalized, timestamp: this.updatedAt } satisfies LogEntry);
  }

  public snapshot(): LogSnapshot {
    const log = this.buffer;
    return {
      log,
      size: Buffer.byteLength(log, 'utf8'),
      limit: this.limit,
      truncated: this.truncated,
      missing: log.length === 0,
      updatedAt: this.updatedAt,
    };
  }

  public subscribe(listener: LogListener): () => void {
    this.on('entry', listener);
    return () => this.off('entry', listener);
  }

  private normalize(value: string): string {
    return value.replace(/\r\n/g, '\n');
  }
}

export const logBuffer = new LogBuffer();
