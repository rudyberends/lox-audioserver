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

/** How many dropped slots to tolerate before compacting the backing array. */
const COMPACT_THRESHOLD = 1024;

/**
 * Maintains an in-memory rolling buffer of log lines for the admin UI.
 *
 * Kept as a list of lines rather than one string on purpose. Concatenating and
 * re-slicing a 500 KB string on every append is roughly a megabyte of copying
 * per log line, which is invisible at a few lines a second and ruinous at a few
 * hundred: it stalls the event loop for seconds at a time, and on an audio
 * server that is audible. Appending here is amortised constant; the join only
 * happens when someone actually asks for a snapshot.
 */
class LogBuffer extends EventEmitter {
  private lines: string[] = [];
  /** Index of the oldest live line; everything before it has been dropped. */
  private head = 0;
  private bytes = 0;
  private truncated = false;
  private updatedAt: string | null = null;
  private readonly limit = 500_000; // roughly 500 KB of UTF-8 text

  public append(rawLine: string): void {
    if (!rawLine) return;
    const normalized = this.normalize(rawLine);
    this.lines.push(normalized);
    // +1 for the newline this line contributes once the snapshot is joined.
    this.bytes += normalized.length + 1;

    while (this.bytes > this.limit && this.head < this.lines.length - 1) {
      this.bytes -= (this.lines[this.head]?.length ?? 0) + 1;
      this.head += 1;
      this.truncated = true;
    }
    if (this.head >= COMPACT_THRESHOLD) {
      this.lines = this.lines.slice(this.head);
      this.head = 0;
    }

    this.updatedAt = new Date().toISOString();
    this.emit('entry', { line: normalized, timestamp: this.updatedAt } satisfies LogEntry);
  }

  public snapshot(): LogSnapshot {
    const log = this.lines.length > this.head ? this.lines.slice(this.head).join('\n') : '';
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
    return value.replace(/\r\n/g, '\n').replace(/\n$/, '');
  }
}

export const logBuffer = new LogBuffer();
