// @ts-nocheck
import {
  fetchLogsApi,
  openLogsStream,
  updateLogLevelApi,
} from './apiClient.js';
import { state } from './state.js';
import { renderSelect, escapeHtml } from './ui/helpers.js';
import {
  formatBytes,
  formatTimestamp,
  normalizeLogContent,
  trimLogContent,
} from './utils/format.js';

const LOG_LEVELS = ['none', 'error', 'warn', 'info', 'debug'];
const LOG_VIEW_LIMIT = 250_000;
const ICON_GLYPHS = {
  expand: '⤢',
  compress: '⤡',
};

let scheduleRenderRef = () => {};
let renderRef = () => {};
let setStatusRef = () => {};
let logFullscreenEscHandler = null;

export function initLogs({ scheduleRender, render, setStatus }) {
  if (typeof scheduleRender === 'function') {
    scheduleRenderRef = scheduleRender;
  }
  if (typeof render === 'function') {
    renderRef = render;
  }
  if (typeof setStatus === 'function') {
    setStatusRef = setStatus;
  }
}

export function renderLogs(loggingConfig = {}) {
  const logsState = state.logs || (state.logs = {});
  const fullscreen = Boolean(logsState.fullscreen);
  const metaItems = [];

  const updatedLabel = formatTimestamp(logsState.updatedAt);
  if (updatedLabel) {
    metaItems.push(`Updated ${updatedLabel}`);
  }

  const bufferLength = logsState.content?.length || 0;
  if (!logsState.missing && bufferLength) {
    if (logsState.truncated && logsState.limit) {
      metaItems.push(`Showing last ${formatBytes(logsState.limit)} of ${formatBytes(bufferLength)}`);
    } else {
      metaItems.push(`Buffer ${formatBytes(bufferLength)}`);
    }
  }

  if (logsState.stream) {
    metaItems.push(logsState.streaming ? 'Live stream active' : 'Live stream reconnecting…');
  }

  const metadata = metaItems.length
    ? `<span class="logs-meta">${metaItems
        .map((item) => {
          const isLive = /live stream/i.test(item);
          const isBuffer = /Buffer|Showing last/i.test(item);
          const badgeClass = isLive ? 'badge-live' : isBuffer ? 'badge-buffer' : 'badge-neutral';
          return `<span class="logs-meta-badge ${badgeClass}">${escapeHtml(item)}</span>`;
        })
        .join('')}</span>`
    : '';

  const statusMessages = [];
  if (logsState.error) {
    statusMessages.push({ type: 'error', text: logsState.error });
  }

  if (logsState.streamError) {
    statusMessages.push({ type: 'warning', text: logsState.streamError });
  }

  if (logsState.missing) {
    statusMessages.push({
      type: 'subtle',
      text: 'No log entries yet. Interact with the system to generate activity.',
    });
  }

  const viewerContent = logsState.missing
    ? ''
    : `<div id="logs-output" class="logs-output" tabindex="0"><pre class="logs-output__content">${escapeHtml(
        logsState.content ? String(logsState.content) : 'No log entries yet.',
      )}</pre></div>`;

  const logLevelControl = renderSelect(
    'log-level',
    'Log level',
    LOG_LEVELS,
    loggingConfig.consoleLevel,
    'class="log-level-select"',
  );

  const overlay = fullscreen
    ? '<div class="logs-backdrop" id="logs-fullscreen-backdrop" aria-hidden="true"></div>'
    : '';

  return `
    ${overlay}
    <div class="logs-section${fullscreen ? ' fullscreen' : ''}">
      <div class="logs-header">
        <h2>Logs</h2>
        <button type="button" id="toggle-log-fullscreen" class="logs-fs-toggle" aria-pressed="${fullscreen}" aria-label="${fullscreen ? 'Exit full screen log view' : 'View logs in full screen'}">
          <span aria-hidden="true">${ICON_GLYPHS[fullscreen ? 'compress' : 'expand']}</span>
        </button>
      </div>
      <div class="logs-toolbar">
        <div class="logs-toolbar-row">
          <div class="logs-level">${logLevelControl}</div>
          ${metadata}
        </div>
      </div>
      <div class="logs-status-row">
        ${statusMessages
          .map((status) => `<span class="logs-status ${status.type}">${escapeHtml(status.text)}</span>`)
          .join('')}
      </div>
      ${viewerContent}
    </div>
  `;
}

function appendLogLine(line) {
  const logsState = state.logs || (state.logs = {});
  const limit =
    Number.isFinite(Number(logsState.limit)) && Number(logsState.limit) > 0
      ? Number(logsState.limit)
      : LOG_VIEW_LIMIT;
  logsState.limit = limit;

  const normalized = normalizeLogContent(line);
  if (!normalized) return;

  const existing = logsState.content || '';
  const needsSeparator = existing && !existing.endsWith('\n');
  const combined = needsSeparator ? `${existing}\n${normalized}` : `${existing}${normalized}`;
  const trimmed = trimLogContent(combined, limit);

  logsState.content = trimmed;
  logsState.truncated = logsState.truncated || trimmed.length < combined.length;
  logsState.missing = false;
  logsState.loading = false;
  logsState.hasFetched = true;
  logsState.scrollToBottom = logsState.autoScroll !== false;
  logsState.size = Math.max(Number(logsState.size) || 0, trimmed.length);
}

export function bindLogEvents() {
  document.getElementById('toggle-log-fullscreen')?.addEventListener('click', () => {
    const enabled = !state.logs?.fullscreen;
    setLogFullscreen(enabled);
  });

  document.getElementById('logs-fullscreen-backdrop')?.addEventListener('click', () => {
    setLogFullscreen(false);
  });

  const viewer = document.getElementById('logs-output');
  if (!(viewer instanceof HTMLElement)) return;

  if (state.logs && typeof state.logs.autoScroll !== 'boolean') {
    state.logs.autoScroll = true;
  }

  if (!viewer.dataset.scrollBound) {
    viewer.addEventListener(
      'scroll',
      () => {
        if (!state.logs) return;
        const threshold = viewer.scrollHeight - viewer.clientHeight;
        const nearBottom = threshold <= 0 || threshold - viewer.scrollTop < 40;
        state.logs.autoScroll = nearBottom;
      },
      { passive: true },
    );
    viewer.dataset.scrollBound = 'true';
  }

  if (state.logs?.scrollToBottom || state.logs?.autoScroll) {
    viewer.scrollTop = viewer.scrollHeight;
  }
  if (state.logs) state.logs.scrollToBottom = false;
}

export function bindLoggingEvents() {
  document.getElementById('log-level')?.addEventListener('change', (event) => {
    const level = event.target.value;
    state.config.logging.consoleLevel = level;
    updateLogLevel(level);
  });
}

export function maybeLoadLogs() {
  if (state.activeTab !== 'logs') return;
  const logsState = state.logs || {};
  if (!logsState.loading && !logsState.hasFetched && !logsState.error) {
    loadLogs();
  }
  ensureLogStream();
}

export function stopLogStream() {
  const logsState = state.logs;
  if (!logsState) return;
  if (logsState.stream instanceof EventSource) {
    try {
      logsState.stream.close();
    } catch (error) {
      console.warn('Failed to close log stream', error);
    }
  }
  logsState.stream = null;
  logsState.streaming = false;
  logsState.streamError = '';
}

export function setLogFullscreen(enabled) {
  const logsState = state.logs || (state.logs = {});
  const next = Boolean(enabled);
  if (Boolean(logsState.fullscreen) === next) return;

  logsState.fullscreen = next;
  if (next && logsState.autoScroll !== false) {
    logsState.scrollToBottom = true;
  }

  const body = typeof document !== 'undefined' ? document.body : null;
  if (body) {
    body.classList.toggle('logs-fullscreen-active', next);
  }

  if (next) {
    if (!logFullscreenEscHandler) {
      logFullscreenEscHandler = (event) => {
        if (event.key === 'Escape') {
          setLogFullscreen(false);
        }
      };
      document.addEventListener('keydown', logFullscreenEscHandler);
    }
  } else if (logFullscreenEscHandler) {
    document.removeEventListener('keydown', logFullscreenEscHandler);
    logFullscreenEscHandler = null;
  }

  scheduleRenderRef();

  if (next) {
    setTimeout(() => {
      const viewer = document.getElementById('logs-output');
      if (viewer instanceof HTMLElement) {
        viewer.focus();
      }
    }, 60);
  }
}

async function loadLogs(force = false) {
  const logsState = state.logs || (state.logs = {});
  if (logsState.loading) return;
  if (!force && logsState.hasFetched) return;

  logsState.loading = true;
  logsState.error = '';
  logsState.hasFetched = true;
  renderRef();

  try {
    const data = await fetchLogsApi();
    if (data?.success === false) {
      throw new Error(data?.message || 'Failed to load logs.');
    }

    const limitFromServer =
      Number.isFinite(Number(data.limit)) && Number(data.limit) > 0
        ? Number(data.limit)
        : 0;
    logsState.limit = limitFromServer || logsState.limit || LOG_VIEW_LIMIT;
    logsState.missing = Boolean(data.missing);
    logsState.path = typeof data.path === 'string' ? data.path : '';
    logsState.updatedAt = data.updatedAt || new Date().toISOString();
    logsState.size = Number.isFinite(Number(data.size))
      ? Number(data.size)
      : logsState.size || 0;

    if (logsState.missing) {
      logsState.content = '';
      logsState.truncated = false;
    } else {
      const rawContent = typeof data.log === 'string' ? data.log : '';
      const normalized = normalizeLogContent(rawContent);
      const trimmed = trimLogContent(normalized, logsState.limit || LOG_VIEW_LIMIT);
      logsState.content = trimmed;
      logsState.truncated =
        Boolean(data.truncated) || trimmed.length < normalized.length;
    }

    logsState.autoScroll = logsState.autoScroll !== false;
    logsState.scrollToBottom = logsState.autoScroll !== false;
  } catch (error) {
    console.error('Failed to load logs', error);
    logsState.error = `Failed to load logs: ${
      error instanceof Error ? error.message : String(error)
    }`;
    logsState.hasFetched = false;
  } finally {
    logsState.loading = false;
    renderRef();

    if (state.activeTab === 'logs') ensureLogStream();
  }
}

function ensureLogStream() {
  if (typeof EventSource === 'undefined') return;
  const logsState = state.logs || (state.logs = {});
  if (logsState.stream instanceof EventSource) return;

  try {
    const source = openLogsStream();
    logsState.stream = source;
    logsState.streamError = '';

    source.addEventListener('open', () => {
      logsState.streaming = true;
      logsState.streamError = '';
      scheduleRenderRef();
    });

    source.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data || '{}');
        const formatted =
          typeof payload.line === 'string'
            ? payload.line
            : typeof payload.formatted === 'string'
              ? payload.formatted
              : typeof payload.message === 'string'
                ? payload.message
                : '';
        if (!formatted) return;
        appendLogLine(formatted);
        logsState.updatedAt = payload.timestamp || new Date().toISOString();
        logsState.streaming = true;
        logsState.streamError = '';
        scheduleRenderRef();
      } catch (error) {
        console.error('Failed to parse log stream payload', error);
      }
    });

    source.addEventListener('error', () => {
      logsState.streaming = false;
      logsState.streamError = 'Live stream disconnected. Retrying…';
      scheduleRenderRef();
    });
  } catch (error) {
    logsState.streamError = `Failed to start live stream: ${
      error instanceof Error ? error.message : String(error)
    }`;
    scheduleRenderRef();
  }
}

async function updateLogLevel(level) {
  setStatusRef('Updating log level…');
  try {
    const data = await updateLogLevelApi(level);
    if (data?.success === false) {
      throw new Error(data?.message || 'Failed to update log level.');
    }
    setStatusRef(data?.message || `Log level set to ${level}.`);
  } catch (error) {
    setStatusRef(
      `Failed to update log level: ${
        error instanceof Error ? error.message : String(error)
      }`,
      true,
    );
  }
}
