import React from 'react';
import { fetchLogs, openLogsStream, updateLogLevel } from '../services/logsApi';
import './LogsView.css';

type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

interface LogsState {
  content: string;
  updatedAt: string | null;
  size: number;
  limit: number;
  truncated: boolean;
  missing: boolean;
  loading: boolean;
  error: string | null;
  streamError: string | null;
  streaming: boolean;
  autoScroll: boolean;
  consoleLevel: LogLevel;
}

const LOG_VIEW_LIMIT = 250_000;
const LOG_LEVELS: LogLevel[] = ['none', 'error', 'warn', 'info', 'debug', 'spam'];

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value.toFixed(0)} B`;
  const units = ['KB', 'MB', 'GB'];
  let result = value;
  let unitIndex = 0;
  while (result >= 1024 && unitIndex < units.length - 1) {
    result /= 1024;
    unitIndex++;
  }
  return `${result.toFixed(1)} ${units[unitIndex]}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString();
}

function normalizeLogContent(raw: string): string {
  if (!raw) return '';
  return String(raw).replace(/\r\n/g, '\n');
}

function trimLogContent(content: string, limit: number): string {
  if (!limit || content.length <= limit) return content;
  return content.slice(content.length - limit);
}

type LogTone = 'error' | 'warn' | 'info' | 'debug' | 'trace';

function classifyLogLine(line: string): LogTone | null {
  if (!line) return null;
  const value = line.toLowerCase();
  if (/\b(error|fatal|err)\b/.test(value)) return 'error';
  if (/\b(warn|warning)\b/.test(value)) return 'warn';
  if (/\b(info|notice)\b/.test(value)) return 'info';
  if (/\b(debug)\b/.test(value)) return 'debug';
  if (/\b(trace)\b/.test(value)) return 'trace';
  return null;
}

export default function LogsView(): JSX.Element {
  const [state, setState] = React.useState<LogsState>({
    content: '',
    updatedAt: null,
    size: 0,
    limit: LOG_VIEW_LIMIT,
    truncated: false,
    missing: false,
    loading: false,
    error: null,
    streamError: null,
    streaming: false,
    autoScroll: true,
    consoleLevel: 'info',
  });
  const [filterText, setFilterText] = React.useState('');
  const [wrapLines, setWrapLines] = React.useState(true);

  const viewerRef = React.useRef<HTMLDivElement | null>(null);
  const streamRef = React.useRef<EventSource | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const data = await fetchLogs();
        if (cancelled) return;
        const limit =
          typeof data.limit === 'number' && data.limit > 0 ? data.limit : LOG_VIEW_LIMIT;
        const missing = Boolean(data.missing);
        let content = '';
        let truncated = false;
        if (!missing && typeof data.log === 'string') {
          const normalized = normalizeLogContent(data.log);
          content = trimLogContent(normalized, limit);
          truncated = content.length < normalized.length || Boolean(data.truncated);
        }
        const normalizedLevel =
          typeof data.consoleLevel === 'string' ? data.consoleLevel.toLowerCase() : '';
        const nextLevel = LOG_LEVELS.includes(normalizedLevel as LogLevel)
          ? (normalizedLevel as LogLevel)
          : null;

        setState((prev) => ({
          ...prev,
          loading: false,
          error: null,
          missing,
          content,
          truncated,
          limit,
          size:
            typeof data.size === 'number' && Number.isFinite(data.size) ? data.size : prev.size,
          updatedAt:
            typeof data.updatedAt === 'string' && data.updatedAt
              ? data.updatedAt
              : new Date().toISOString(),
          consoleLevel: nextLevel ?? prev.consoleLevel,
        }));
      } catch (err) {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load logs.',
        }));
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const source = openLogsStream();
    if (!source) return;
    streamRef.current = source;

    source.addEventListener('open', () => {
      setState((prev) => ({ ...prev, streaming: true, streamError: null }));
    });

    source.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data || '{}') as {
          line?: string;
          formatted?: string;
          message?: string;
          timestamp?: string;
        };
        const line = payload.line ?? payload.formatted ?? payload.message ?? '';
        if (!line) return;
        setState((prev) => {
          const limit = prev.limit || LOG_VIEW_LIMIT;
          const normalized = normalizeLogContent(line);
          if (!normalized) return prev;
          const needsSeparator = prev.content && !prev.content.endsWith('\n');
          const combined = needsSeparator
            ? `${prev.content}\n${normalized}`
            : `${prev.content}${normalized}`;
          const trimmed = trimLogContent(combined, limit);
          const truncated = prev.truncated || trimmed.length < combined.length;
          return {
            ...prev,
            content: trimmed,
            truncated,
            missing: false,
            updatedAt:
              typeof payload.timestamp === 'string' && payload.timestamp
                ? payload.timestamp
                : new Date().toISOString(),
            streaming: true,
            streamError: null,
          };
        });
      } catch {
        // ignore malformed events
      }
    });

    source.addEventListener('error', () => {
      setState((prev) => ({
        ...prev,
        streaming: false,
        streamError: 'Live stream disconnected. Retrying…',
      }));
    });

    return () => {
      if (streamRef.current) {
        try {
          streamRef.current.close();
        } catch {
          // ignore
        }
      }
      streamRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    if (!state.autoScroll) return;
    const node = viewerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [state.content, state.autoScroll]);

  const handleViewerScroll = (): void => {
    const node = viewerRef.current;
    if (!node) return;
    const threshold = node.scrollHeight - node.clientHeight;
    const nearBottom = threshold <= 0 || threshold - node.scrollTop < 40;
    setState((prev) => (prev.autoScroll === nearBottom ? prev : { ...prev, autoScroll: nearBottom }));
  };

  const handleLevelChange = async (event: React.ChangeEvent<HTMLSelectElement>): Promise<void> => {
    const level = event.target.value as LogLevel;
    setState((prev) => ({ ...prev, consoleLevel: level }));
    try {
      await updateLogLevel(level);
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to update log level.',
      }));
    }
  };

  const handleDownload = (): void => {
    if (!state.content) return;
    const blob = new Blob([state.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const timestamp = state.updatedAt
      ? new Date(state.updatedAt).toISOString().replace(/[:.]/g, '-')
      : new Date().toISOString().replace(/[:.]/g, '-');
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `lox-audioserver-logs-${timestamp}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const handleCopy = (): void => {
    if (!displayContent) return;
    void navigator.clipboard?.writeText(displayContent).catch(() => {});
  };

  const handleClear = (): void => {
    setState((prev) => ({ ...prev, content: '', truncated: false, size: 0 }));
  };

  const filteredContent = React.useMemo(() => {
    if (!filterText.trim()) return state.content;
    const needle = filterText.toLowerCase();
    return state.content
      .split('\n')
      .filter((line) => line.toLowerCase().includes(needle))
      .join('\n');
  }, [state.content, filterText]);

  const displayContent = filteredContent;
  const displayLines = React.useMemo(() => {
    if (!displayContent) return [];
    return displayContent.split('\n');
  }, [displayContent]);

  return (
    <div className="logs-layout">
      <div className="logs-shell">
        <div className="logs-hero">
          <div>
            <p className="logs-eyebrow">System logs</p>
            <h1>Live output</h1>
            <p className="logs-subtitle">Inspect runtime output, adjust verbosity, and follow the live stream.</p>
          </div>
        </div>

        <div className="logs-header">
          <div className="logs-toolbar">
            <div className="logs-filter">
              <label htmlFor="logs-filter">Filter</label>
              <input
                id="logs-filter"
                type="text"
                placeholder="Filter lines…"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                className="logs-filter-control"
              />
            </div>
            <div className="logs-header-level">
              <select
                id="log-level"
                aria-label="Console level"
                value={state.consoleLevel}
                onChange={handleLevelChange}
                className="logs-filter-control"
              >
                {LOG_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </div>
            <div className="logs-toolbar__actions">
              <button
                type="button"
                className={`logs-pill ${state.autoScroll ? 'is-active' : ''}`}
                onClick={() => setState((prev) => ({ ...prev, autoScroll: !prev.autoScroll }))}
              >
                Auto-scroll
              </button>
              <button
                type="button"
                className={`logs-pill ${wrapLines ? 'is-active' : ''}`}
                onClick={() => setWrapLines((prev) => !prev)}
              >
                Wrap lines
              </button>
              <button type="button" className="logs-pill" onClick={handleCopy} disabled={!displayContent}>
                Copy
              </button>
              <button type="button" className="logs-pill" onClick={handleDownload} disabled={!state.content}>
                Download
              </button>
              <button type="button" className="logs-pill logs-pill--ghost" onClick={handleClear} disabled={!state.content}>
                Clear
              </button>
            </div>
          </div>
        </div>

        <div className="logs-status-row">
          {state.loading && <span className="logs-status subtle">Loading logs…</span>}
          {state.error && <span className="logs-status error">{state.error}</span>}
          {state.streamError && !state.error && (
            <span className="logs-status warning">{state.streamError}</span>
          )}
          {state.missing && !state.loading && !state.error && (
            <span className="logs-status subtle">
              No log entries yet. Interact with the system to generate activity.
            </span>
          )}
          {!state.autoScroll && (
            <button
              type="button"
              className="logs-autoscroll"
              onClick={() => setState((prev) => ({ ...prev, autoScroll: true }))}
            >
              Jump to latest
            </button>
          )}
        </div>

        {!state.missing && (
          <div
            className={`logs-output ${wrapLines ? 'is-wrapped' : 'is-unwrapped'}`}
            tabIndex={0}
            ref={viewerRef}
            onScroll={handleViewerScroll}
            aria-label="Log output"
          >
            <pre className="logs-output__content">
              {displayLines.length > 0
                ? displayLines.map((line, index) => {
                    const tone = classifyLogLine(line);
                    const suffix = index < displayLines.length - 1 ? '\n' : '';
                    return (
                      <span
                        key={`${index}-${line.slice(0, 24)}`}
                        className={tone ? `log-line log-line--${tone}` : 'log-line'}
                      >
                        {line}
                        {suffix}
                      </span>
                    );
                  })
                : state.loading
                  ? ''
                  : 'No log entries yet.'}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
