const state = {
  config: defaultConfig(),
  options: defaultOptions(),
  suggestions: {},
  activeTab: 'miniserver',
  zoneStatus: {},
  version: '',
  logs: {
    content: '',
    loading: false,
    error: '',
    truncated: false,
    missing: false,
    size: 0,
    path: '',
    updatedAt: null,
    limit: 0,
    hasFetched: false,
    scrollToBottom: false,
    stream: null,
    streaming: false,
    streamError: '',
    autoScroll: true,
    fullscreen: false,
  },
  modal: {
    open: false,
    zoneId: null,
    backend: '',
    ip: '',
    maPlayerId: '',
    maSuggestions: [],
    error: '',
  },
  connectedProvider: {
    type: '',
    options: {},
  },
};


const LOG_LEVELS = ['none', 'error', 'warn', 'info', 'debug'];
const LOG_VIEW_LIMIT = 250_000;
const ICON_GLYPHS = {
  expand: '⤢',
  compress: '⤡',
};

const app = document.getElementById('app');
const statusEl = document.getElementById('status');
const tabsNav = document.getElementById('tabs');
let statusBannerTimeout = 0;
const zoneErrorTimers = new Map();

let renderScheduled = false;
let logFullscreenEscHandler = null;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  const raf = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : (callback) => setTimeout(callback, 16);
  raf(() => {
    renderScheduled = false;
    render();
  });
}

setupTabs();

init();

async function init() {
  render();
  await loadConfig();
}

async function loadConfig(silent = false) {
  if (!silent) setStatus('Loading configuration…');
  let failed = false;
  try {
    const response = await fetch('/admin/api/config');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.config = data.config;
    state.options = data.options;
    state.version = typeof data.version === 'string' ? data.version : '';
    const connectedProviderType = data.config?.mediaProvider?.type || '';
    const connectedProviderOptions = {
      ...(data.config?.mediaProvider?.options || {}),
    };
    state.connectedProvider = {
      type: connectedProviderType,
      options: connectedProviderOptions,
    };
    state.suggestions = Object.fromEntries(
      (data.suggestions || []).map((suggestion) => [suggestion.zoneId, suggestion.players]),
    );
    state.zoneStatus = data.zoneStatus || {};
    render();
  } catch (error) {
    console.error('Failed to load configuration', error);
    failed = true;
    setStatus(
      `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}. You can still edit settings and press Save to create/update the configuration file.`,
      true,
    );
  } finally {
    if (!silent && !failed) clearStatus();
  }
  return !failed;
}

function render() {
  if (!state.config) return;

  if (Array.isArray(state.config.zones)) {
    state.config.zones.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  }

  const panelsHtml = renderPanels(state.config);
  const modalHtml = renderBackendModal();
  app.innerHTML = panelsHtml + modalHtml;
  bindFormEvents();
  updateTabs();
  updateHeroSummary();
  maybeLoadLogs();
}

function renderPanels(config) {
  const activeTab = state.activeTab || 'miniserver';
  const panelClass = (name) => `tabpanel${activeTab === name ? ' active' : ''}`;
  const isPaired = Boolean(config.audioserver?.paired);
  const miniserverSerialRaw = config.miniserver?.serial || '';
  const miniserverSerialValue = escapeHtml(isPaired ? miniserverSerialRaw : '');
  const miniserverSerialField = `
            <div class="form-control readonly-field">
              <label for="miniserver-serial">Miniserver Serial</label>
              <input id="miniserver-serial" type="text" value="${miniserverSerialValue}" readonly aria-readonly="true" />
            </div>`;

  const generalPanel = `
    <section data-tabpanel="miniserver" class="${panelClass('miniserver')}">
      <div class="miniserver-header">
        <div class="miniserver-title">
          <h2>Miniserver</h2>
          <p class="miniserver-subtitle">Connect your Loxone Miniserver to establish communication with the AudioServer.</p>
        </div>
        <div class="miniserver-state">
          ${renderPairingBadge(config.audioserver)}
        </div>
      </div>
      <div class="miniserver-layout">
        <article class="miniserver-card connection">
          <header>
            <div>
              <h3>Connection</h3>
              <p>Enter Miniserver credentials.</p>
            </div>
            <div class="connection-state">${renderMiniserverBadge(config)}</div>
          </header>
          <div class="miniserver-form">
            ${renderInput('miniserver-ip', 'Miniserver IP', config.miniserver.ip)}
            ${renderInput('miniserver-username', 'Username', config.miniserver.username)}
            ${renderInput('miniserver-password', 'Password', config.miniserver.password, 'password')}
            ${miniserverSerialField}
          </div>
        </article>
        ${renderStatus(config)}
      </div>
    </section>
  `;

  const zonesPanel = `
    <section data-tabpanel="zones" class="${panelClass('zones')}">
      ${renderZonesPanel(config)}
    </section>
  `;

  const providerPanel = `
    <section data-tabpanel="provider" class="${panelClass('provider')}">
      <h2>Provider</h2>
      ${renderProviderContent(config.mediaProvider)}
    </section>
  `;

  const logsPanel = `
    <section data-tabpanel="logs" class="${panelClass('logs')}">
      ${renderLogs(config.logging)}
    </section>
  `;

  return `${generalPanel}${zonesPanel}${providerPanel}${logsPanel}`;
}

function setupTabs() {
  if (!tabsNav) return;
  tabsNav.addEventListener('click', (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const button = target?.closest('.tab');
    if (!(button instanceof HTMLElement)) return;
    const tabId = button.dataset.tab;
    if (!tabId || tabId === state.activeTab) return;
    state.activeTab = tabId;
    render();
  });
}

function updateTabs() {
  const paired = Boolean(state.config?.audioserver?.paired);
  if (!paired && (state.activeTab === 'zones' || state.activeTab === 'provider')) {
    state.activeTab = 'miniserver';
  }
  const activeTab = state.activeTab || 'miniserver';
  tabsNav?.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === activeTab);
    const tab = button.dataset.tab;
    if (!tab) return;
    const isRestricted = tab === 'zones' || tab === 'provider';
    button.disabled = isRestricted && !paired;
  });
  document.querySelectorAll('[data-tabpanel]').forEach((panel) => {
    if (!(panel instanceof HTMLElement)) return;
    const name = panel.getAttribute('data-tabpanel');
    const isRestricted = name === 'zones' || name === 'provider';
    if (isRestricted && !paired) {
      panel.classList.remove('active');
      return;
    }
    panel.classList.toggle('active', name === activeTab);
  });

  if (activeTab !== 'logs' && state.logs?.fullscreen) {
    setLogFullscreen(false);
  }
}

function renderStatus(config) {
  const audioserver = config.audioserver ?? {};
  const zones = Array.isArray(config.zones) ? config.zones : [];
  const hasUnassignedZones = zones.some((zone = {}) => String(zone?.backend || '').toLowerCase() === 'dummybackend');
  const assignmentStepClass = hasUnassignedZones ? 'pairing-step-pending' : 'pairing-step-complete';
  const assignmentBadgeClass = hasUnassignedZones ? 'pending' : 'complete';
  const assignmentBadgeLabel = hasUnassignedZones ? 'Incomplete' : 'Complete';
  const pairingHelp = audioserver.paired
    ? `
        <ol class="pairing-steps">
          <li class="${assignmentStepClass}">
            <span class="pairing-step-indicator" aria-hidden="true"></span>
            <div class="pairing-step-content">
              <div class="pairing-step-heading">
                <strong>Assign players</strong>
                <span class="pairing-step-status ${assignmentBadgeClass}">${assignmentBadgeLabel}</span>
              </div>
              <span class="pairing-step-description">Loxone zones are downloaded from the Miniserver config. Assign a backend to each zone in the Zones tab.</span>
            </div>
          </li>
          <li class="pairing-step-optional">
            <span class="pairing-step-indicator" aria-hidden="true"></span>
            <div class="pairing-step-content">
              <div class="pairing-step-heading">
                <strong>Add a provider</strong>
                <span class="pairing-step-status optional">Optional</span>
              </div>
              <span class="pairing-step-description">Enable a provider to expose sources to the AudioServer. Without a provider the server returns empty lists for every source request.</span>
            </div>
          </li>
        </ol>
      `
    : `
        <ol class="pairing-steps">
          <li class="pairing-step-required">
            <span class="pairing-step-indicator" aria-hidden="true"></span>
            <div class="pairing-step-content">
              <div class="pairing-step-heading">
                <strong>Add an Audio Server in Loxone Config</strong>
                <span class="pairing-step-status required">Required</span>
              </div>
              <span class="pairing-step-description">Use IP of this service and serial <code>50:4F:94:FF:1B:B3</code>, then drop the players into your project. <span class="pairing-warning"><span class="pairing-warning__icon" aria-hidden="true">⚠️</span><span>The serial must match exactly or pairing will fail.</span></span></span>
            </div>
          </li>
          <li class="pairing-step-required">
            <span class="pairing-step-indicator" aria-hidden="true"></span>
            <div class="pairing-step-content">
              <div class="pairing-step-heading">
                <strong>Deploy & reboot</strong>
                <span class="pairing-step-status required">Required</span>
              </div>
              <span class="pairing-step-description">Save your project to the Miniserver and reboot so the configuration is active.</span>
            </div>
          </li>
        </ol>
      `;
  const pairingHeaderTitle = audioserver.paired ? 'Pairing completed 🎉' : 'Pairing setup';
  const pairingHeaderSubtitle = audioserver.paired
    ? 'Follow these steps to complete the configuration.'
    : 'Follow these steps before attempting to pair with the Miniserver.';
  return `
    <div class="miniserver-stack">
      <article class="miniserver-card pairing-info">
        <header>
          <h3>${pairingHeaderTitle}</h3>
          <p>${pairingHeaderSubtitle}</p>
        </header>
        ${pairingHelp}
        <div class="pairing-info-actions">
          <div class="pairing-actions">
            <button type="button" id="trigger-pairing" class="primary pairing-action" ${audioserver.paired ? 'disabled aria-disabled="true"' : ''}>${audioserver.paired ? 'Paired' : 'Pair'}</button>
            <button type="button" id="clear-config" class="danger">Reset config</button>
          </div>
        </div>
      </article>
    </div>
  `;
}

function renderPairingBadge(audioserver = {}) {
  const isPaired = Boolean(audioserver?.paired);
  const label = isPaired ? 'Paired' : 'Awaiting pairing';
  const pillClass = isPaired ? 'success' : 'warning';
  return `
    <span class="status-label">Pairing state</span>
    <span class="status-pill ${pillClass}">${label}</span>
  `;
} 

function renderLogs(loggingConfig = {}) {
  const logsState = state.logs || {};
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
    statusMessages.push({ type: 'subtle', text: 'No log entries yet. Interact with the system to generate activity.' });
  }

  const viewerContent = logsState.missing
    ? ''
    : `<pre id="logs-output" class="logs-output" tabindex="0">${logsState.content ? escapeHtml(logsState.content) : 'No log entries yet.'}</pre>`;

  const logLevelControl = renderSelect(
    'log-level',
    'Log level',
    LOG_LEVELS,
    loggingConfig.consoleLevel,
    'class="log-level-select"'
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

function renderMiniserverBadge(config = {}) {
  const audioserver = config.audioserver ?? {};
  const isPaired = Boolean(audioserver?.paired);
  const pillClass = isPaired ? 'success' : 'warning';
  return `
    <span class="status-label">Status</span>
    <span class="status-pill status-pill--dot ${pillClass}"></span>
  `;
}

function updateHeroSummary() {
  const serialEl = document.getElementById('status-serial');
  const firmwareEl = document.getElementById('status-firmware');
  const providerEl = document.getElementById('status-provider');
  const zonesEl = document.getElementById('status-zones');
  const versionEl = document.getElementById('status-version');
  const audioserver = state.config?.audioserver ?? {};
  const provider = state.config?.mediaProvider ?? {};
  const zones = Array.isArray(state.config?.zones) ? state.config.zones : [];
  const zoneCount = zones.length;

  if (serialEl) serialEl.textContent = audioserver.name || audioserver.ip || '—';
  if (versionEl) versionEl.textContent = state.version || '—';
  if (firmwareEl) firmwareEl.textContent = audioserver.paired ? 'Paired' : 'Unpaired';
  if (providerEl) {
    if (!audioserver.paired) {
      providerEl.textContent = 'Unconfigured';
    } else {
      providerEl.textContent = provider.type ? provider.type : 'Not configured';
    }
  }
  if (zonesEl) zonesEl.textContent = String(zoneCount);
}

function renderZonesPanel({ zones } = {}) {
  const zoneList = Array.isArray(zones) ? [...zones] : [];
  const sortedZones = zoneList.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const stats = computeZoneStats(sortedZones);

  const zoneCards = sortedZones
    .map((zone) => {
      const status = getZoneStatusEntry(zone);
      const rawBackend = status?.backend ?? zone.backend ?? '';
      const isDummy = isDummyBackend(rawBackend);
      const connected = !isDummy && Boolean(status?.connected);
      const statusPrefix = connected ? 'Online' : 'Pending connection';
      const statusText = isDummy ? 'Unassigned' : statusPrefix;
      const statusClass = isDummy ? 'dummy' : connected ? 'connected' : 'disconnected';
      const safeStatusText = escapeHtml(statusText);
      const zoneNumber = typeof zone.id === 'number' ? zone.id : '—';
      const safeZoneId = escapeHtml(String(zoneNumber));
      const connectionDetails = renderZoneConnectionDetails(zone, status, { isDummy, connected });
      const metadataBlock = renderZoneMetadata(status, { isDummy });
      const isMusicAssistant = normalizeBackend(zone.backend) === 'BackendMusicAssistant';
      const hasPlayerSelection = Boolean((zone.maPlayerId || '').trim());
      let connectHint = '';
      const connectError = state.zoneStatus?.[zone.id]?.connectError || '';
      const cardStateClass = connected
        ? 'zone-card--connected'
        : isDummy
          ? 'zone-card--unassigned'
          : 'zone-card--pending';

      if (!connected && isMusicAssistant && !hasPlayerSelection) {
        connectHint = '<p class="zone-card-hint">Configure a Music Assistant player before connecting.</p>';
      }

      return `
        <article class="zone-card ${cardStateClass}" data-index="${zone.id}">
          <header class="zone-card-header">
            <div class="zone-card-heading">
              <span class="zone-card-heading-label">Zone</span>
              <h3 class="zone-card-title">#${safeZoneId}</h3>
            </div>
            <div class="zone-card-status zone-card-status--${statusClass}">
              <span class="status-pill status-pill--dot ${statusClass}" data-zone-status="${zone.id}" aria-hidden="true"></span>
              <span class="zone-status-text" data-zone-status-text="${zone.id}">${safeStatusText}</span>
            </div>
          </header>
          <div class="zone-card-section zone-card-summary">
            <div class="zone-card-pane zone-card-pane--connection">
              <h4 class="zone-section-title">Connection</h4>
              <div class="zone-card-details">${connectionDetails}</div>
            </div>
            <div class="zone-card-pane zone-card-pane--playback">
              <h4 class="zone-section-title">Playback</h4>
              <div class="zone-card-nowplaying">${metadataBlock}</div>
            </div>
          </div>
          ${connectHint}
          ${connectError ? `<p class="zone-card-error">${escapeHtml(connectError)}</p>` : ''}
          <div class="zone-card-actions">
            <button type="button" class="secondary" data-action="configure-zone" data-id="${zone.id}">Configure…</button>
          </div>
        </article>
      `;
    })
    .join('');

  const zonesContent = zoneCards
    ? `<div class="zones">${zoneCards}</div>`
    : `
      <div class="zones-empty">
        <div class="zones-empty__card">
          <h3>No zones detected yet</h3>
          <p>Add Loxone zones to your configuration and reload to see them listed here.</p>
          <p class="zones-empty__hint">Once zones are available you can assign a backend and manage playback.</p>
        </div>
      </div>
    `;

  return `
    <header class="zones-header">
      <div class="zones-header__copy">
        <h2>Imported Loxone Zones</h2>
        <p>Monitor connections, assign backends, and check the now playing status for each Loxone zone.</p>
      </div>
      ${renderZonesOverview(stats)}
    </header>
    ${zonesContent}
  `;
}

function getZoneStatusEntry(zone = {}) {
  const zoneId = zone?.id;
  if (typeof zoneId !== 'number') return { id: zoneId, backend: zone?.backend, ip: zone?.ip, connected: false };
  const existing = state.zoneStatus?.[zoneId];
  if (existing) return existing;
  const fallback = {
    id: zoneId,
    backend: zone?.backend,
    ip: zone?.ip,
    connected: false,
  };
  state.zoneStatus ??= {};
  state.zoneStatus[zoneId] = fallback;
  return fallback;
}

function computeZoneStats(zones = []) {
  const stats = {
    total: zones.length,
    connected: 0,
    awaiting: 0,
    unassigned: 0,
    configured: 0,
    activeBackends: 0,
  };

  const activeBackends = new Set();

  zones.forEach((zone) => {
    const status = getZoneStatusEntry(zone);
    const rawBackend = status?.backend ?? zone.backend ?? '';
    const normalizedBackend = normalizeBackend(rawBackend);
    const dummy = isDummyBackend(normalizedBackend);
    const connected = Boolean(status?.connected);

    if (connected) {
      stats.connected += 1;
    } else if (!dummy) {
      stats.awaiting += 1;
    }

    if (dummy) {
      stats.unassigned += 1;
    } else if (normalizedBackend) {
      activeBackends.add(formatBackendLabel(normalizedBackend));
    }
  });

  stats.configured = stats.total - stats.unassigned;
  stats.activeBackends = activeBackends.size;

  return stats;
}

function renderZonesOverview(stats) {
  if (!stats) return '';
  const metrics = [
    {
      id: 'total',
      label: 'Total zones',
      value: stats.total,
      tone: 'primary',
      note: stats.total ? `${stats.configured} configured` : 'Add zones to begin',
    },
    {
      id: 'connected',
      label: 'Connected',
      value: stats.connected,
      tone: 'success',
      note: stats.connected
        ? `${stats.connected === 1 ? 'Zone online' : 'Zones online'}`
        : 'Waiting for players',
    },
    {
      id: 'awaiting',
      label: 'Awaiting',
      value: stats.awaiting,
      tone: stats.awaiting ? 'warn' : 'neutral',
      note: stats.awaiting
        ? `${stats.awaiting === 1 ? 'Needs attention' : 'Need attention'}`
        : 'All reachable',
    },
  ];

  const backendNote = stats.activeBackends
    ? `${stats.activeBackends} active ${stats.activeBackends === 1 ? 'backend' : 'backends'}`
    : 'No backends connected yet';

  return `
    <div class="zones-overview">
      <ul class="zones-metrics" role="list">
        ${metrics
          .map((metric) => `
            <li class="zones-metric zones-metric--${metric.tone}">
              <span class="zones-metric-label">${escapeHtml(metric.label)}</span>
              <span class="zones-metric-value">${escapeHtml(String(metric.value))}</span>
              <span class="zones-metric-note">${escapeHtml(metric.note)}</span>
            </li>
          `)
          .join('')}
      </ul>
      <p class="zones-overview-note">${escapeHtml(backendNote)}</p>
    </div>
  `;
}

function normalizeBackend(value = '') {
  return String(value || '').trim();
}

function isDummyBackend(value = '') {
  const normalized = normalizeBackend(value);
  return !normalized || normalized.toLowerCase() === 'dummybackend';
}

function formatBackendLabel(value = '') {
  const normalized = normalizeBackend(value);
  if (!normalized) return 'Unassigned';
  if (normalized.toLowerCase() === 'dummybackend') return 'Unassigned';
  if (/^backend/i.test(normalized)) {
    const label = normalized.replace(/^backend/i, '');
    const spaced = label.replace(/([a-z])([A-Z])/g, '$1 $2');
    return spaced.trim() || 'Backend';
  }
  return normalized;
}

function renderProviderContent(mediaProvider = {}) {
  const providerOptionsRaw = state.options?.providers ?? [];
  const providerOptions = providerOptionsRaw.map((option) => ({ value: option, label: formatProviderLabel(option) }));
  if (!mediaProvider.type && providerOptions.length) {
    mediaProvider.type = providerOptions[0].value;
  }

  const providerType = mediaProvider.type || '';
  const providerLabel = formatProviderLabel(providerType) || 'None';
  const connectedProvider = state.connectedProvider || {};
  const connectedProviderType = typeof connectedProvider.type === 'string' ? connectedProvider.type : '';
  const connectedProviderLabel = formatProviderLabel(connectedProviderType) || 'None';
  const options = typeof mediaProvider.options === 'object' && mediaProvider.options
    ? mediaProvider.options
    : (mediaProvider.options = {});
  const requiresHost = providerType && providerType !== 'DummyProvider';
  const hostValueRaw = typeof options.IP === 'string' ? options.IP : '';
  const hostValue = hostValueRaw.trim();
  const portValueRaw =
    typeof options.PORT === 'string' || typeof options.PORT === 'number' ? String(options.PORT) : '';
  const portValue = portValueRaw.trim();
  const hasHost = Boolean(hostValue);
  const hasPort = Boolean(portValue);
  const showPortField = providerType === 'MusicAssistantProvider' || providerType === 'MusicAssistantRadioProvider';
  const isDummyProvider = providerType === 'DummyProvider';
  const connectedOptions = typeof connectedProvider.options === 'object' && connectedProvider.options
    ? connectedProvider.options
    : {};
  const connectedHostRaw = typeof connectedOptions.IP === 'string' ? connectedOptions.IP : '';
  const connectedHost = connectedHostRaw.trim();
  const connectedPortRaw =
    typeof connectedOptions.PORT === 'string' || typeof connectedOptions.PORT === 'number'
      ? String(connectedOptions.PORT)
      : '';
  const connectedPort = connectedPortRaw.trim();
  const hasProviderTypeChange = providerType !== connectedProviderType;
  const hasHostChange = requiresHost && hostValue !== connectedHost;
  const hasPortChange = showPortField && portValue !== connectedPort;
  const hasUnsavedChanges = hasProviderTypeChange || hasHostChange || hasPortChange;
  const isConfigured = !isDummyProvider && (!requiresHost || hasHost);
  const statusTone = isDummyProvider
    ? 'warning'
    : hasUnsavedChanges || (requiresHost && !hasHost)
      ? 'pending'
      : isConfigured
        ? 'success'
        : requiresHost
          ? 'pending'
          : 'neutral';
  const statusLabel = (() => {
    if (isDummyProvider) return 'Dummy provider — no sources';
    if (!providerType) return '';
    if (!requiresHost) {
      if (hasUnsavedChanges) {
        return 'Press Connect to apply this provider.';
      }
      return '';
    }
    if (!hasHost) return 'Add the provider host so the AudioServer can connect.';
    if (hasUnsavedChanges) {
      return 'Press Connect to apply this provider.';
    }
    return '';
  })();

  const providerFields = requiresHost
    ? renderInput('provider-ip', 'Provider IP/Host', hostValue || '', 'text', false, 'placeholder="192.168.1.10"') +
      (showPortField
        ? renderInput('provider-port', 'Provider Port (optional)', portValue || '', 'text', false, 'placeholder="8095" inputmode="numeric" pattern="[0-9]*"')
        : '')
    : '';

  const summaryMetrics = [
    { id: 'provider-type', label: 'Selected provider', value: providerLabel || 'None' },
    { id: 'provider-host', label: 'Host', value: hasHost ? hostValue : 'Not set' },
    {
      id: 'provider-port',
      label: showPortField ? 'Port' : 'Port',
      value: showPortField ? (hasPort ? portValue : 'Using default (8095)') : 'Not required',
    },
  ];

  const guidance = isDummyProvider
    ? 'Dummy provider is useful for testing and won’t expose any sources to Loxone.'
    : requiresHost
      ? showPortField
        ? 'Set the Music Assistant host. Port defaults to 8095 if left blank.'
        : 'Set the provider host so the AudioServer can fetch sources.'
      : providerType
        ? 'This provider does not require any connection details.'
        : 'Select a provider to begin configuration.';

  return `
    <div class="provider-layout">
      <section class="provider-summary">
        <div class="provider-summary__title">
          <span class="provider-label">Provider</span>
          <h3 class="provider-summary__heading">${escapeHtml(providerLabel || 'None')}</h3>
          ${statusLabel ? `<p class="provider-summary__status provider-summary__status--${statusTone}">${escapeHtml(statusLabel)}</p>` : ''}
        </div>
        <ul class="provider-metrics" role="list">
          ${summaryMetrics
            .map((metric) => `
              <li class="provider-metric">
                <span class="provider-metric__label">${escapeHtml(metric.label)}</span>
                <span class="provider-metric__value">${escapeHtml(String(metric.value || ''))}</span>
              </li>
            `)
            .join('')}
        </ul>
        <p class="provider-summary__hint">${escapeHtml(guidance)}</p>
      </section>
      <div class="provider-card">
        <header class="provider-card__header">
          <div>
            <h2>Media Provider</h2>
            <p>Select and configure the backend that exposes sources to your zones.</p>
          </div>
          <div class="provider-status provider-status--${statusTone}">
            <span class="status-label">Connected</span>
            <span class="status-badge">${escapeHtml(connectedProviderLabel || 'None')}</span>
          </div>
        </header>
        <div class="provider-card__body">
          ${renderSelect('provider-type', 'Provider', providerOptions, providerType, 'class="provider-select"')}
          <div id="provider-fields" class="provider-fields-grid ${requiresHost ? '' : 'hidden'}">
            ${providerFields}
          </div>
        </div>
        <footer class="provider-card__footer">
          <button type="button" id="provider-connect" class="primary">Connect provider</button>
        </footer>
      </div>
    </div>
  `;
}

function formatProviderLabel(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) return 'None';
  const withoutSuffix = normalized.replace(/Provider$/i, '');
  const withSpaces = withoutSuffix.replace(/([a-z])([A-Z])/g, '$1 $2');
  return withSpaces.replace(/\s+/g, ' ').trim() || normalized;
}

function renderInput(id, label, value, type = 'text', inline = false, extraAttrs = '') {
  const safeValue = escapeHtml(value ?? '');
  const baseInput = `<input id="${id}" type="${type}" value="${safeValue}" ${extraAttrs} />`;
  if (inline) {
    return `
      <div class="form-field">
        <label for="${id}">${label}</label>
        ${baseInput}
      </div>
    `;
  }
  return `
    <div class="form-control">
      <label for="${id}">${label}</label>
      ${baseInput}
    </div>
  `;
}

function renderSelect(id, label, values, selectedValue = '', extraAttrs = '') {
  const options = (values || []).map((value) => {
    if (typeof value === 'object' && value !== null) {
      const optionValue = escapeHtml(value.value ?? '');
      const optionLabelRaw = value.label ?? value.value ?? '';
      const optionLabel = escapeHtml(optionLabelRaw);
      const isSelected = value.value === selectedValue;
      return `<option value="${optionValue}" ${isSelected ? 'selected' : ''}>${optionLabel}</option>`;
    }
    const optionValueRaw = value ?? '';
    const optionValue = escapeHtml(optionValueRaw);
    const optionLabel = escapeHtml(optionValueRaw || 'None');
    const isSelected = optionValueRaw === selectedValue;
    return `<option value="${optionValue}" ${isSelected ? 'selected' : ''}>${optionLabel}</option>`;
  }).join('');

  return `
    <div class="form-control">
      <label for="${id}">${label}</label>
      <select id="${id}" ${extraAttrs}>${options}</select>
    </div>
  `;
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes = 0) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const formatted = size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function normalizeLogContent(value = '') {
  return String(value ?? '').replace(/\r\n/g, '\n');
}

function trimLogContent(content, limit) {
  if (!limit || content.length <= limit) return content;
  const start = content.length - limit;
  const boundary = content.indexOf('\n', start);
  return content.slice(boundary >= 0 ? boundary + 1 : start);
}

function appendLogLine(line) {
  const logsState = state.logs || (state.logs = {});
  const limit = Number.isFinite(Number(logsState.limit)) && Number(logsState.limit) > 0
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

function renderZoneMetadata(status = {}, options = {}) {
  const { isDummy = false } = options || {};
  const cover = status?.coverUrl?.trim();
  const title = status?.title?.trim();
  const artist = status?.artist?.trim();
  const state = status?.state?.trim();
  const hasMedia = Boolean(cover || title || artist || state);

  const fallbackCover = '/admin/unknownalbum.png';
  const coverSrc = cover || fallbackCover;
  const coverHtml = `<img src="${escapeHtml(coverSrc)}" alt="Cover art" class="zone-track-cover${cover ? '' : ' zone-track-cover--fallback'}" loading="lazy" />`;

  const lines = [];
  if (hasMedia) {
    if (title || artist) {
      lines.push(
        `<div class="zone-track-title">${escapeHtml(title || 'Unknown title')}</div>` +
          (artist ? `<div class="zone-track-artist">${escapeHtml(artist)}</div>` : ''),
      );
    }
    if (state) {
      lines.push(`<div class="zone-track-state">${escapeHtml(state.charAt(0).toUpperCase() + state.slice(1))}</div>`);
    }
  } else {
    const placeholder = isDummy
      ? 'Assign a backend to enable playback.'
      : 'Waiting for playback data.';
    lines.push(`<div class="zone-track-placeholder">${escapeHtml(placeholder)}</div>`);
  }

  return `
    <div class="zone-track-nowplaying${hasMedia ? '' : ' zone-track-nowplaying--empty'}">
      ${coverHtml}
      <div class="zone-track-meta">${lines.join('')}</div>
    </div>
  `;
}

function renderZoneConnectionDetails(zone = {}, status = {}, options = {}) {
  const { isDummy = false, connected = false } = options || {};
  const rawBackend = status?.backend ?? zone?.backend ?? '';
  const backendLabel = formatBackendLabel(rawBackend);
  const ipValue = status?.ip ?? zone?.ip ?? '';
  const isMusicAssistant = normalizeBackend(zone?.backend) === 'BackendMusicAssistant';
  const showIp = !isMusicAssistant;
  const showPendingState = isDummy || (showIp && !ipValue);
  const detailsClass = [
    'zone-connection-details',
    showPendingState && !connected ? 'zone-connection-details--pending' : '',
    connected ? 'zone-connection-details--connected' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const safeBackend = escapeHtml(backendLabel || 'Unassigned');
  const safeIp = escapeHtml(ipValue || 'Not set');
  const maPlayerId = isMusicAssistant ? (zone?.maPlayerId || '').trim() : '';
  const segments = [
    `
        <div class="zone-connection-row">
          <span class="zone-connection-label">Backend</span>
          <span class="zone-connection-value">${safeBackend}</span>
        </div>
      `,
  ];

  if (showIp) {
    segments.push(`
        <div class="zone-connection-divider" aria-hidden="true"></div>
        <div class="zone-connection-row zone-connection-row--ip">
          <span class="zone-connection-label">IP</span>
          <span class="zone-connection-value zone-connection-value--ip">${safeIp}</span>
        </div>
      `);
  }

  if (maPlayerId) {
    segments.push(`
        <div class="zone-connection-divider" aria-hidden="true"></div>
        <div class="zone-connection-row zone-connection-row--player">
          <span class="zone-connection-label">Player</span>
          <span class="zone-connection-value zone-connection-value--player">${escapeHtml(maPlayerId)}</span>
        </div>
      `);
  }

  return `
    <div class="${detailsClass}">
      <div class="zone-connection-tile">
        ${segments.join('')}
      </div>
    </div>
  `;
}

function renderBackendModal() {
  const modalState = state.modal || {};
  const open = Boolean(modalState.open && typeof modalState.zoneId === 'number');
  if (typeof document !== 'undefined') {
    document.body.classList.toggle('modal-open', open);
  }
  if (!open) {
    return '<div id="backend-modal" class="backend-modal backend-modal--hidden" aria-hidden="true"></div>';
  }

  const zone = state.config?.zones.find((z) => z.id === modalState.zoneId);
  if (!zone) {
    if (typeof document !== 'undefined') document.body.classList.remove('modal-open');
    state.modal = { open: false, zoneId: null, backend: '', ip: '', maPlayerId: '', maSuggestions: [], error: '' };
    return '<div id="backend-modal" class="backend-modal backend-modal--hidden" aria-hidden="true"></div>';
  }

  const backendOptions = state.options?.backends || [];
  const backend = modalState.backend || zone.backend || backendOptions[0] || '';
  const ipValue = modalState.ip ?? zone.ip ?? '';
  const maSuggestions = modalState.maSuggestions?.length
    ? modalState.maSuggestions
    : state.suggestions?.[zone.id] || [];
  const maPlayerId = modalState.maPlayerId ?? zone.maPlayerId ?? '';
  const modalError = typeof modalState.error === 'string' ? modalState.error.trim() : '';

  const backendSelect = renderSelect('modal-backend', 'Backend', backendOptions, backend, 'class="backend-modal__select"');
  const ipAttrs = backend === 'DummyBackend' ? 'disabled aria-disabled="true"' : '';
  const ipField = renderInput('modal-backend-ip', 'Backend IP', backend === 'DummyBackend' ? '' : ipValue, 'text', false, `${ipAttrs}`);

  let maField = '';
  let maActions = '';
  if (backend === 'BackendMusicAssistant') {
    if (maSuggestions.length) {
      const suggestionsOptions = [{ value: '', label: 'Select a player' }, ...maSuggestions.map((player) => ({ value: player.id, label: `${player.name} (${player.id})` }))];
      maField = renderSelect('modal-ma-player', 'Music Assistant Player', suggestionsOptions, maPlayerId, 'class="backend-modal__select"');
    } else {
      maField = renderInput('modal-ma-player', 'Music Assistant Player ID', maPlayerId, 'text');
    }
    maActions = `
      <div class="backend-modal__ma-actions">
        <button type="button" class="tertiary" data-action="modal-scan-zone" data-id="${zone.id}">Scan players</button>
      </div>
    `;
  }

  const errorHtml = modalError
    ? `<div class="backend-modal__error" role="alert">${escapeHtml(modalError)}</div>`
    : '';

  return `
    <div id="backend-modal" class="backend-modal" role="dialog" aria-modal="true" aria-labelledby="backend-modal-title">
      <div class="backend-modal__backdrop" data-modal-close="true"></div>
      <div class="backend-modal__dialog">
        <header class="backend-modal__header">
          <div>
            <h2 id="backend-modal-title">Configure Zone #${escapeHtml(String(zone.id))}</h2>
            <p class="backend-modal__subtitle">Adjust backend settings and connection details.</p>
          </div>
          <button type="button" class="backend-modal__close" data-modal-close="true" aria-label="Close">×</button>
        </header>
        <div class="backend-modal__body">
          ${errorHtml}
          <div class="backend-modal__form">
            ${backendSelect}
            ${ipField}
            ${backend === 'BackendMusicAssistant' ? `<div class="backend-modal__ma">${maField}${maActions}</div>` : ''}
          </div>
        </div>
        <footer class="backend-modal__footer">
          <button type="button" class="secondary" data-modal-close="true">Cancel</button>
          <button type="button" class="primary" id="backend-modal-save">Save</button>
        </footer>
      </div>
    </div>
  `;
}

function openBackendModal(zoneId) {
  const zone = state.config?.zones.find((z) => z.id === zoneId);
  if (!zone) return;
  const backendOptions = state.options?.backends || [];
  const backend = zone.backend || backendOptions[0] || '';
  const suggestions = state.suggestions?.[zone.id] || [];
  state.modal = {
    open: true,
    zoneId: zone.id,
    backend,
    ip: zone.ip || '',
    maPlayerId: zone.maPlayerId || '',
    maSuggestions: suggestions,
    error: '',
  };
  render();
}

function closeBackendModal(shouldRender = true) {
  state.modal = {
    open: false,
    zoneId: null,
    backend: '',
    ip: '',
    maPlayerId: '',
    maSuggestions: [],
    error: '',
  };
  if (typeof document !== 'undefined') {
    document.body.classList.remove('modal-open');
  }
  if (shouldRender) render();
}

function updateModalState(patch = {}) {
  state.modal = {
    ...(state.modal || {}),
    ...patch,
  };
}

function bindModalEvents() {
  const modal = document.getElementById('backend-modal');
  if (!(modal instanceof HTMLElement)) return;
  if (!state.modal.open) return;

  modal.querySelectorAll('[data-modal-close="true"]').forEach((element) => {
    element.addEventListener('click', () => closeBackendModal());
  });

  const backendSelectEl = modal.querySelector('#modal-backend');
  if (backendSelectEl instanceof HTMLSelectElement) {
    backendSelectEl.addEventListener('change', (event) => {
      updateModalState({ backend: event.target.value, error: '' });
      if (event.target.value === 'DummyBackend') {
        updateModalState({ ip: '' });
      }
      if (event.target.value !== 'BackendMusicAssistant') {
        updateModalState({ maPlayerId: '' });
      }
      render();
    });
  }

  const ipInputEl = modal.querySelector('#modal-backend-ip');
  if (ipInputEl instanceof HTMLInputElement) {
    ipInputEl.addEventListener('input', (event) => {
      updateModalState({ ip: event.target.value, error: '' });
    });
  }

  const maFieldEl = modal.querySelector('#modal-ma-player');
  if (maFieldEl instanceof HTMLSelectElement) {
    maFieldEl.addEventListener('change', (event) => {
      updateModalState({ maPlayerId: event.target.value, error: '' });
    });
  } else if (maFieldEl instanceof HTMLInputElement) {
    maFieldEl.addEventListener('input', (event) => {
      updateModalState({ maPlayerId: event.target.value, error: '' });
    });
  }

  const saveButton = modal.querySelector('#backend-modal-save');
  if (saveButton instanceof HTMLButtonElement) {
    saveButton.addEventListener('click', (event) => {
      event.preventDefault();
      saveBackendModal();
    });
  }

  const scanButton = modal.querySelector('[data-action="modal-scan-zone"]');
  if (scanButton instanceof HTMLButtonElement) {
    scanButton.addEventListener('click', () => {
      const zoneId = Number(scanButton.getAttribute('data-id'));
      if (Number.isNaN(zoneId)) return;
      const zone = state.config?.zones.find((z) => z.id === zoneId);
      if (!zone) return;
      const zonePayload = { ...zone, ip: state.modal.ip || zone.ip || '' };
      fetchMusicAssistantPlayers(zonePayload, scanButton).catch((error) => {
        console.error('Failed to scan Music Assistant players', error);
      });
    });
  }
}

async function saveBackendModal() {
  const modalState = state.modal || {};
  if (!modalState.open || typeof modalState.zoneId !== 'number') {
    closeBackendModal();
    return;
  }
  const zone = state.config?.zones.find((z) => z.id === modalState.zoneId);
  if (!zone) {
    closeBackendModal();
    return;
  }

  const backendSelectEl = document.getElementById('modal-backend');
  if (!(backendSelectEl instanceof HTMLSelectElement)) return;
  const backend = backendSelectEl.value;

  const ipInputEl = document.getElementById('modal-backend-ip');
  const ipValue = ipInputEl instanceof HTMLInputElement ? ipInputEl.value.trim() : '';

  let maPlayerId = '';
  if (backend === 'BackendMusicAssistant') {
    const maFieldEl = document.getElementById('modal-ma-player');
    if (maFieldEl instanceof HTMLSelectElement || maFieldEl instanceof HTMLInputElement) {
      maPlayerId = (maFieldEl.value || '').trim();
    }
    if (!maPlayerId) {
      updateModalState({ error: 'Select or enter a Music Assistant player.' });
      render();
      return;
    }
  }

  if (backend !== 'DummyBackend' && backend !== 'BackendMusicAssistant' && !ipValue) {
    updateModalState({ error: 'Backend IP is required for this backend.' });
    render();
    return;
  }

  zone.backend = backend;
  zone.ip = backend === 'DummyBackend' ? '' : ipValue;
  if (backend === 'BackendMusicAssistant') {
    zone.maPlayerId = maPlayerId;
    if (state.modal.maSuggestions?.length) {
      state.suggestions = state.suggestions || {};
      state.suggestions[zone.id] = state.modal.maSuggestions;
    }
  } else if ('maPlayerId' in zone) {
    delete zone.maPlayerId;
  }

  state.zoneStatus = state.zoneStatus || {};
  state.zoneStatus[zone.id] = {
    ...(state.zoneStatus[zone.id] || { id: zone.id }),
    backend: zone.backend,
    ip: zone.ip,
    connected: false,
  };

  if (backend !== 'BackendMusicAssistant' && state.suggestions) {
    delete state.suggestions[zone.id];
  }

  closeBackendModal(false);
  render();
  setStatus(`Saved configuration for zone ${zone.id}. Connecting…`);
  await connectZone(zone.id);
}

function bindFormEvents() {
  if (!state.config) return;

  bindMiniserverEvents();

  document.getElementById('trigger-pairing')?.addEventListener('click', pairConfig);

  document.querySelectorAll('[data-action="configure-zone"]').forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    button.addEventListener('click', () => {
      const zoneId = Number(button.getAttribute('data-id'));
      if (Number.isNaN(zoneId)) return;
      openBackendModal(zoneId);
    });
  });

  document.getElementById('audioserver-ip')?.addEventListener('input', (event) => {
    state.config.audioserver.ip = event.target.value;
  });

  const providerSelect = document.getElementById('provider-type');
  providerSelect?.addEventListener('change', (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;
    const newType = select.value;
    const previousType = state.config.mediaProvider.type;
    state.config.mediaProvider.type = newType;
    if (newType !== previousType) {
      state.config.mediaProvider.options = {};
    }
    render();
  });

  document.getElementById('provider-ip')?.addEventListener('input', (event) => {
    state.config.mediaProvider.options = state.config.mediaProvider.options || {};
    state.config.mediaProvider.options.IP = event.target.value;
  });

  document.getElementById('provider-port')?.addEventListener('input', (event) => {
    state.config.mediaProvider.options = state.config.mediaProvider.options || {};
    state.config.mediaProvider.options.PORT = event.target.value;
  });

  bindLoggingEvents();
  bindActions();
  bindLogEvents();

  document.getElementById('provider-connect')?.addEventListener('click', connectProvider);

  bindModalEvents();
}

async function connectZone(zoneId, button) {
  if (!(button instanceof HTMLButtonElement)) button = undefined;
  const zone = state.config?.zones.find((z) => z.id === zoneId);
  if (zone?.backend === 'BackendMusicAssistant' && !(zone.maPlayerId || '').trim()) {
    setStatus('Configure a Music Assistant player before connecting.', true);
    if (button) {
      button.disabled = true;
      button.textContent = 'Connect';
      button.classList.remove('connected');
    }
    state.zoneStatus = state.zoneStatus || {};
    state.zoneStatus[zoneId] = {
      ...(state.zoneStatus[zoneId] || { id: zoneId }),
      connectError: 'Configure a Music Assistant player before connecting.',
    };
    render();
    return;
  }
  state.zoneStatus = state.zoneStatus || {};
  state.zoneStatus[zoneId] = {
    ...(state.zoneStatus[zoneId] || { id: zoneId }),
    connected: false,
    connectError: '',
  };

  if (button) {
    button.disabled = true;
    button.classList.remove('connected');
    button.textContent = 'Connecting…';
  }

  setZoneStatusIndicator(zoneId, 'disconnected', 'Awaiting connection');

  setStatus(`Connecting Loxone player ${zoneId}…`);
  try {
    const zonePayload = zone;
    const response = await fetch('/admin/api/zones/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: zoneId, zone: zonePayload }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
    if (data?.zoneStatus) {
      state.zoneStatus = data.zoneStatus;
      Object.values(state.zoneStatus || {}).forEach((entry) => {
        if (entry && typeof entry === 'object') {
          entry.connectError = '';
        }
      });
    } else {
      state.zoneStatus = state.zoneStatus || {};
      state.zoneStatus[zoneId] = {
        ...(state.zoneStatus[zoneId] || { id: zoneId }),
        connected: true,
        connectError: '',
      };
    }
    clearZoneErrorTimer(zoneId);
    setZoneStatusIndicator(zoneId, 'connected', 'Connected');
    if (button) {
      button.disabled = true;
      button.textContent = 'Connected';
      button.classList.add('connected');
    }
    render();
    setStatus(data?.message || `Loxone player ${zoneId} connected.`);
  } catch (error) {
    if (button) {
      button.disabled = true;
      button.textContent = 'Failed';
      button.classList.remove('connected');
    }
    const message = `Failed to connect zone ${zoneId}.`;
    state.zoneStatus = state.zoneStatus || {};
    state.zoneStatus[zoneId] = {
      ...(state.zoneStatus[zoneId] || { id: zoneId }),
      connectError: message,
    };
    render();
    setStatus(`${message} Check your backend settings and try again.`, true);
    clearZoneErrorTimer(zoneId);
    const timer = setTimeout(() => {
      zoneErrorTimers.delete(zoneId);
      if (state.zoneStatus?.[zoneId]) {
        state.zoneStatus[zoneId].connectError = '';
        render();
      }
    }, 6000);
    zoneErrorTimers.set(zoneId, timer);
  }
}

function setZoneStatusIndicator(zoneId, className, text) {
  const statusEl = document.querySelector(`[data-zone-status="${zoneId}"]`);
  if (statusEl instanceof HTMLElement) {
    statusEl.setAttribute('aria-hidden', 'true');
    statusEl.classList.remove('connected', 'disconnected', 'dummy');
    statusEl.classList.add(className);
  }

  const statusTextEl = document.querySelector(`[data-zone-status-text="${zoneId}"]`);
  if (statusTextEl instanceof HTMLElement) {
    statusTextEl.textContent = text;
  }
}

function clearZoneErrorTimer(zoneId) {
  const timer = zoneErrorTimers.get(zoneId);
  if (typeof timer === 'number') {
    clearTimeout(timer);
  }
  zoneErrorTimers.delete(zoneId);
}

async function connectProvider() {
  if (!state.config) return;
  setStatus('Connecting provider…');
  try {
    const response = await fetch('/admin/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: state.config }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
    await loadConfig(true);
    setStatus('Provider configuration saved.');
  } catch (error) {
    setStatus(`Failed to connect provider: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function fetchMusicAssistantPlayers(zone, button) {
  const ip = (zone.ip || '').trim();
  if (!ip) {
    setStatus('Set the Music Assistant host before scanning players.', true);
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
      button.textContent = 'Scan players';
    }
    return;
  }

  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
    button.textContent = 'Scanning…';
  }

  try {
    const response = await fetch('/admin/api/musicassistant/players', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, zoneId: zone.id }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
    state.suggestions = state.suggestions || {};
    state.suggestions[zone.id] = data.players || [];
    if (state.modal?.open && state.modal.zoneId === zone.id) {
      state.modal.maSuggestions = data.players || [];
      if (!state.modal.maPlayerId && Array.isArray(data.players) && data.players.length === 1) {
        state.modal.maPlayerId = data.players[0]?.id || '';
      }
      state.modal.error = '';
    }
    render();
    setStatus(`Loaded ${data.players?.length ?? 0} Music Assistant players.`);
  } catch (error) {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
      button.textContent = 'Scan players';
    }
    if (state.modal?.open && state.modal.zoneId === zone.id) {
      updateModalState({
        error: `Failed to load Music Assistant players: ${error instanceof Error ? error.message : String(error)}`,
      });
      render();
      return;
    }
    setStatus(`Failed to load Music Assistant players: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

function bindMiniserverEvents() {
  document.getElementById('miniserver-ip')?.addEventListener('input', (event) => {
    state.config.miniserver.ip = event.target.value;
  });
  document.getElementById('miniserver-username')?.addEventListener('input', (event) => {
    state.config.miniserver.username = event.target.value;
  });
  document.getElementById('miniserver-password')?.addEventListener('input', (event) => {
    state.config.miniserver.password = event.target.value;
  });
}

function bindLoggingEvents() {
  document.getElementById('log-level')?.addEventListener('change', (event) => {
    const level = event.target.value;
    state.config.logging.consoleLevel = level;
    updateLogLevel(level);
  });
}

function bindActions() {
  document.getElementById('clear-config')?.addEventListener('click', clearConfig);
}

function bindLogEvents() {
  document.getElementById('toggle-log-fullscreen')?.addEventListener('click', () => {
    const enabled = !(state.logs?.fullscreen);
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
    viewer.addEventListener('scroll', () => {
      if (!state.logs) return;
      const threshold = viewer.scrollHeight - viewer.clientHeight;
      const nearBottom = threshold <= 0 || threshold - viewer.scrollTop < 40;
      state.logs.autoScroll = nearBottom;
    }, { passive: true });
    viewer.dataset.scrollBound = 'true';
  }

  if (state.logs?.scrollToBottom || state.logs?.autoScroll) {
    viewer.scrollTop = viewer.scrollHeight;
  }
  if (state.logs) state.logs.scrollToBottom = false;
}

function ensureLogStream() {
  if (typeof EventSource === 'undefined') return;
  const logsState = state.logs || (state.logs = {});
  if (logsState.stream instanceof EventSource) return;

  try {
    const source = new EventSource('/admin/api/logs/stream');
    logsState.stream = source;
    logsState.streamError = '';

    source.addEventListener('open', () => {
      logsState.streaming = true;
      logsState.streamError = '';
      scheduleRender();
    });

    source.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data || '{}');
        const formatted = typeof payload.formatted === 'string'
          ? payload.formatted
          : typeof payload.message === 'string'
            ? payload.message
            : '';
        if (!formatted) return;
        appendLogLine(formatted);
        logsState.updatedAt = payload.timestamp || new Date().toISOString();
        logsState.streaming = true;
        logsState.streamError = '';
        scheduleRender();
      } catch (error) {
        console.error('Failed to parse log stream payload', error);
      }
    });

    source.addEventListener('error', () => {
      logsState.streaming = false;
      logsState.streamError = 'Live stream disconnected. Retrying…';
      scheduleRender();
    });
  } catch (error) {
    logsState.streamError = `Failed to start live stream: ${error instanceof Error ? error.message : String(error)}`;
    scheduleRender();
  }
}

function maybeLoadLogs() {
  if (state.activeTab !== 'logs') return;
  const logsState = state.logs || {};
  if (!logsState.loading && !logsState.hasFetched && !logsState.error) {
    loadLogs();
  }
  ensureLogStream();
}

async function loadLogs(force = false) {
  const logsState = state.logs || (state.logs = {});
  if (logsState.loading) return;
  if (!force && logsState.hasFetched) return;

  logsState.loading = true;
  logsState.error = '';
  logsState.hasFetched = true;
  render();

  try {
    const response = await fetch('/admin/api/logs');
    const data = await response.json();
    if (!response.ok || data?.success === false) {
      const message = data?.message || `HTTP ${response.status}`;
      throw new Error(message);
    }

    const limitFromServer = Number.isFinite(Number(data.limit)) && Number(data.limit) > 0
      ? Number(data.limit)
      : 0;
    logsState.limit = limitFromServer || logsState.limit || LOG_VIEW_LIMIT;
    logsState.missing = Boolean(data.missing);
    logsState.path = typeof data.path === 'string' ? data.path : '';
    logsState.updatedAt = data.updatedAt || new Date().toISOString();
    logsState.size = Number.isFinite(Number(data.size)) ? Number(data.size) : logsState.size || 0;

    if (logsState.missing) {
      logsState.content = '';
      logsState.truncated = false;
    } else {
      const rawContent = typeof data.log === 'string' ? data.log : '';
      const normalized = normalizeLogContent(rawContent);
      const trimmed = trimLogContent(normalized, logsState.limit || LOG_VIEW_LIMIT);
      logsState.content = trimmed;
      logsState.truncated = Boolean(data.truncated) || trimmed.length < normalized.length;
    }

    logsState.autoScroll = logsState.autoScroll !== false;
    logsState.scrollToBottom = logsState.autoScroll !== false;
  } catch (error) {
    console.error('Failed to load logs', error);
    logsState.error = `Failed to load logs: ${error instanceof Error ? error.message : String(error)}`;
    logsState.hasFetched = false;
  } finally {
    logsState.loading = false;
    render();

    if (state.activeTab === 'logs') ensureLogStream();
  }
}

async function updateLogLevel(level) {
  setStatus('Updating log level…');
  try {
    const response = await fetch('/admin/api/logs/level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level }),
    });
    const data = await response.json();
    if (!response.ok || data?.success === false) {
      const message = data?.message || `HTTP ${response.status}`;
      throw new Error(message);
    }
    setStatus(data?.message || `Log level set to ${level}.`);
  } catch (error) {
    setStatus(`Failed to update log level: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

function setLogFullscreen(enabled) {
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

  scheduleRender();

  if (next) {
    setTimeout(() => {
      const viewer = document.getElementById('logs-output');
      if (viewer instanceof HTMLElement) {
        viewer.focus();
      }
    }, 60);
  }
}

async function persistConfig() {
  const response = await fetch('/admin/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: state.config }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
  return data;
}

async function pairConfig() {
  if (!state.config) return;
  const miniserver = state.config.miniserver ?? {};
  const missingFields = [];
  if (!miniserver.ip || !miniserver.ip.trim()) missingFields.push('IP address');
  if (!miniserver.username || !miniserver.username.trim()) missingFields.push('username');
  if (!miniserver.password || !miniserver.password.trim()) missingFields.push('password');

  if (missingFields.length) {
    setStatus('Add Miniserver credentials before pairing.', true);
    return;
  }

  setStatus('Saving configuration and attempting to pair…');
  try {
    await persistConfig();
    const response = await fetch('/admin/api/config/reload', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
    const message = data.message || 'Pairing attempt finished.';
    await loadConfig();
    setStatus(message);
  } catch (error) {
    setStatus(`Pairing failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function reloadRuntimeOnly() {
  setStatus('Reloading runtime…');
  try {
    const response = await fetch('/admin/api/config/reload', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
    await loadConfig();
    setStatus(data.message || 'Runtime reloaded.');
  } catch (error) {
    setStatus(`Failed to reload runtime: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function clearConfig() {
  const confirmClear = window.confirm?.('This will reset the admin configuration to defaults. Continue?');
  if (confirmClear === false) return;
  setStatus('Clearing configuration…');
  try {
    const response = await fetch('/admin/api/config/clear', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
    await loadConfig();
    setStatus(data?.message || 'Configuration cleared.');
  } catch (error) {
    setStatus(`Failed to clear configuration: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

function setStatus(message, isError = false) {
  if (!statusEl) return;
  const text = (message || '').trim();
  if (!text) {
    statusEl.textContent = '';
    statusEl.classList.add('status-banner--hidden');
    statusEl.classList.remove('status-banner--error');
    clearTimeout(statusBannerTimeout);
    return;
  }
  statusEl.textContent = text;
  statusEl.classList.remove('status-banner--hidden');
  if (isError) {
    statusEl.classList.add('status-banner--error');
  } else {
    statusEl.classList.remove('status-banner--error');
  }
  clearTimeout(statusBannerTimeout);
  statusBannerTimeout = window.setTimeout(() => {
    clearStatus();
  }, 4000);
}

function clearStatus() {
  setStatus('');
}

function defaultConfig() {
  return {
    miniserver: { ip: '', username: '', password: '' },
    audioserver: { ip: window.location.hostname || '', paired: false },
    zones: [],
    mediaProvider: { type: '', options: {} },
    logging: { consoleLevel: 'info', fileLevel: 'none' },
  };
}

function defaultOptions() {
  return {
    backends: [],
    providers: [],
  };
}
