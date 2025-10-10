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
  loadingConfig: true,
  waitingForPairing: false,
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
let pairingWatcherId = 0;
let pairingWatcherBusy = false;
let zonesRefreshTimerId = 0;
let zonesRefreshBusy = false;

const ZONE_REFRESH_INTERVAL = 20_000;

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
  state.loadingConfig = true;
  try {
    const response = await fetch('/admin/api/config');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.config = data.config || defaultConfig();
    state.options = data.options || defaultOptions();
    state.version = typeof data.version === 'string' ? data.version : '';
    const audioserver = state.config.audioserver = state.config.audioserver || {};
    const pairedRaw = audioserver.paired;
    let pairedNormalized = false;
    if (typeof pairedRaw === 'string') {
      const normalized = pairedRaw.trim().toLowerCase();
      pairedNormalized = normalized === 'true' || normalized === '1' || normalized === 'yes';
    } else {
      pairedNormalized = Boolean(pairedRaw);
    }
    audioserver.paired = pairedNormalized;

    const connectedProviderType = data.config?.mediaProvider?.type || '';
    const connectedProviderOptions = {
      ...(data.config?.mediaProvider?.options || {}),
    };
    state.connectedProvider = {
      type: connectedProviderType,
      options: connectedProviderOptions,
    };
    const cache = ensureMusicAssistantCache();
    state.config.mediaProvider = state.config.mediaProvider || { type: '', options: {} };
    const providerType = state.config.mediaProvider?.type || '';
    const providerOptions = (state.config.mediaProvider?.options
      && typeof state.config.mediaProvider.options === 'object')
      ? state.config.mediaProvider.options
      : (state.config.mediaProvider.options = {});
    const providerHostRaw = typeof providerOptions.IP === 'string' ? providerOptions.IP : '';
    const providerHost = providerHostRaw.trim();
    if (isMusicAssistantProviderType(providerType)) {
      if (providerHost) {
        cache.providerHost = providerHost;
        if (!cache.lastIP) cache.lastIP = providerHost;
      } else {
        const fallbackHost = cache.providerHost || cache.lastIP || '';
        if (fallbackHost) {
          providerOptions.IP = fallbackHost;
        }
      }
    }
    state.suggestions = Object.fromEntries(
      (data.suggestions || []).map((suggestion) => [suggestion.zoneId, suggestion.players]),
    );
    state.zoneStatus = data.zoneStatus || {};
  } catch (error) {
    console.error('Failed to load configuration', error);
    failed = true;
    setStatus(
      `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}. You can still edit settings and press Save to create/update the configuration file.`,
      true,
    );
  } finally {
    state.loadingConfig = false;
    render();
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
  const miniserverIpRaw = config.miniserver?.ip || '';
  const miniserverIpValue = escapeHtml(miniserverIpRaw);
  const miniserverSerialRaw = config.miniserver?.serial || '';
  const miniserverSerialValue = escapeHtml(isPaired ? miniserverSerialRaw : '');
  const miniserverIpField = `
            <div class="form-control readonly-field">
              <label for="miniserver-ip">Miniserver IP</label>
              <input id="miniserver-ip" type="text" value="${miniserverIpValue}" readonly aria-readonly="true" placeholder="Will populate after pairing" />
            </div>`;
  const miniserverSerialField = `
            <div class="form-control readonly-field">
              <label for="miniserver-serial">Miniserver Serial</label>
              <input id="miniserver-serial" type="text" value="${miniserverSerialValue}" readonly aria-readonly="true" placeholder="Will populate after pairing" />
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
        <div class="miniserver-primary">
          <article class="miniserver-card connection">
            <header>
              <div>
                <h3>Connection</h3>
              </div>
              <div class="connection-state">${renderMiniserverBadge(config)}</div>
            </header>
            <div class="miniserver-form">
              ${miniserverIpField}
              ${miniserverSerialField}
            </div>
            ${renderPairingWaitIndicator()}
          </article>
          ${renderToolsCard()}
        </div>
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

  const updatePanel = `
    <section data-tabpanel="update" class="${panelClass('update')}">
      ${renderUpdatePanel()}
    </section>
  `;

  const logsPanel = `
    <section data-tabpanel="logs" class="${panelClass('logs')}">
      ${renderLogs(config.logging)}
    </section>
  `;

  return `${generalPanel}${zonesPanel}${providerPanel}${updatePanel}${logsPanel}`;
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

  if (activeTab !== 'logs') {
    stopLogStream();
  }

  if (activeTab !== 'logs' && state.logs?.fullscreen) {
    setLogFullscreen(false);
  }

  ensurePairingWatcher();
  ensureZonesRefresh();
}

function shouldWatchPairing() {
  if (typeof window === 'undefined') return false;
  const activeTab = state.activeTab || 'miniserver';
  if (activeTab !== 'miniserver') return false;
  if (state.loadingConfig) return false;
  return !Boolean(state.config?.audioserver?.paired);
}

function ensurePairingWatcher() {
  if (!shouldWatchPairing()) {
    stopPairingWatcher();
    return;
  }
  if (!state.waitingForPairing) {
    state.waitingForPairing = true;
    scheduleRender();
  }
  if (pairingWatcherId || pairingWatcherBusy || typeof window === 'undefined') return;

  const poll = async () => {
    if (!shouldWatchPairing()) {
      stopPairingWatcher();
      return;
    }
    pairingWatcherBusy = true;
    pairingWatcherId = 0;
    let success = false;
    try {
      success = await loadConfig(true);
    } catch (error) {
      console.error('Failed to refresh pairing status', error);
    } finally {
      const continueWatching = shouldWatchPairing();
      if (continueWatching && typeof window !== 'undefined') {
        const delay = success ? 5000 : 10000;
        pairingWatcherId = window.setTimeout(poll, delay);
      } else {
        pairingWatcherId = 0;
      }
      pairingWatcherBusy = false;
    }
  };

  pairingWatcherId = window.setTimeout(poll, 5000);
}

function stopPairingWatcher() {
  if (pairingWatcherId && typeof window !== 'undefined') {
    window.clearTimeout(pairingWatcherId);
  }
  pairingWatcherId = 0;
  pairingWatcherBusy = false;
  if (state.waitingForPairing) {
    state.waitingForPairing = false;
    scheduleRender();
  }
}

function shouldRefreshZones() {
  if (typeof window === 'undefined') return false;
  const activeTab = state.activeTab || 'miniserver';
  if (activeTab !== 'zones') return false;
  if (state.loadingConfig) return false;
  if (state.modal?.open) return false;
  return true;
}

function ensureZonesRefresh() {
  if (!shouldRefreshZones()) {
    stopZonesRefresh();
    return;
  }
  if (zonesRefreshTimerId || zonesRefreshBusy || typeof window === 'undefined') return;
  zonesRefreshTimerId = window.setTimeout(refreshZones, ZONE_REFRESH_INTERVAL);
}

function stopZonesRefresh() {
  if (zonesRefreshTimerId && typeof window !== 'undefined') {
    window.clearTimeout(zonesRefreshTimerId);
  }
  zonesRefreshTimerId = 0;
}

async function refreshZones() {
  if (!shouldRefreshZones()) {
    stopZonesRefresh();
    return;
  }
  zonesRefreshBusy = true;
  zonesRefreshTimerId = 0;
  try {
    await loadConfig(true);
  } catch (error) {
    console.error('Failed to refresh zones', error);
  } finally {
    zonesRefreshBusy = false;
    if (shouldRefreshZones() && typeof window !== 'undefined') {
      zonesRefreshTimerId = window.setTimeout(refreshZones, ZONE_REFRESH_INTERVAL);
    } else {
      stopZonesRefresh();
    }
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
                <strong>Deploy changes</strong>
                <span class="pairing-step-status required">Required</span>
              </div>
              <span class="pairing-step-description">Save your project to the Miniserver so the configuration is active.</span>
            </div>
          </li>
          <li class="pairing-step-required">
            <span class="pairing-step-indicator" aria-hidden="true"></span>
            <div class="pairing-step-content">
              <div class="pairing-step-heading">
                <strong>Reboot the Miniserver</strong>
                <span class="pairing-step-status required">Required</span>
              </div>
              <span class="pairing-step-description">The Miniserver initiates pairing with the AudioServer automatically after it boots with the updated project.</span>
            </div>
          </li>
        </ol>
      `;
  const pairingHeaderTitle = audioserver.paired ? 'Pairing completed 🎉' : 'Pairing setup';
  const pairingHeaderSubtitle = audioserver.paired
    ? 'Follow these steps to complete the configuration.'
    : 'The Miniserver will initiate pairing automatically after rebooting with your updated project.';
  return `
    <article class="miniserver-card pairing-info">
      <header>
        <h3>${pairingHeaderTitle}</h3>
        <p>${pairingHeaderSubtitle}</p>
      </header>
      ${pairingHelp}
    </article>
  `;
}

function renderToolsCard() {
  return `
    <article class="miniserver-card pairing-actions-card">
      <header>
        <h3>Tools</h3>
        <p>Need to start over? Reset clears the saved admin configuration.</p>
      </header>
      <div class="pairing-actions">
        <button type="button" id="clear-config" class="danger">Reset config</button>
      </div>
    </article>
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

function renderPairingWaitIndicator() {
  if (!state.waitingForPairing) return '';
  return `
    <div class="connection-wait" role="status" aria-live="polite">
      <span class="connection-wait__pulse" aria-hidden="true"></span>
      <span class="connection-wait__text">Waiting for the Miniserver to initiate pairing…</span>
    </div>
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
    : `<div id="logs-output" class="logs-output" tabindex="0"><pre class="logs-output__content">${escapeHtml(
        logsState.content ? String(logsState.content) : 'No log entries yet.'
      )}</pre></div>`;

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

function renderUpdatePanel() {
  const version = typeof state.version === 'string' && state.version ? state.version : 'Unknown';
  return `
    <section class="updates-panel">
      <header class="updates-panel__header">
        <h2>Update</h2>
        <p class="updates-panel__subtitle">Check the currently installed lox-audioserver version.</p>
      </header>
      <div class="updates-panel__body">
        <dl class="updates-panel__meta">
          <div>
            <dt>Current version</dt>
            <dd>${escapeHtml(version)}</dd>
          </div>
        </dl>
      </div>
    </section>
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
  if (versionEl) versionEl.textContent = state.version ? `v${state.version}` : 'v—';
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
      const zoneNameRaw = `${status?.name ?? zone.name ?? ''}`.trim();
      const safeZoneName = zoneNameRaw ? escapeHtml(zoneNameRaw) : '';
      const zoneTitle = safeZoneName ? safeZoneName : `#${safeZoneId}`;
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

      const backendLabel = formatBackendLabel(rawBackend);
      const zoneLabel = safeZoneName || `Zone ${safeZoneId}`;
      const backendName = escapeHtml(backendLabel);
      const zoneLabelAria = escapeHtml(zoneLabel);
      let backendSubDetail = '';
      if (isMusicAssistant) {
        const playerId = (status?.maPlayerId ?? zone.maPlayerId ?? '').trim();
        if (playerId) backendSubDetail = escapeHtml(playerId);
      } else {
        const ip = (status?.ip ?? zone.ip ?? '').trim();
        if (ip) backendSubDetail = escapeHtml(ip);
      }

      return `
        <article class="zone-card ${cardStateClass}" data-index="${zone.id}">
          <header class="zone-card-header">
            <div class="zone-card-heading">
              <h3 class="zone-card-title">${zoneTitle}</h3>
            </div>
            <div class="zone-card-status-dot zone-card-status-dot--${statusClass}" title="${safeStatusText}" data-zone-status="${zone.id}" aria-hidden="true"></div>
          </header>
          <div class="zone-card-playback">
            <div class="zone-card-nowplaying">${metadataBlock}</div>
          </div>
          <div class="zone-card-backend">
            <span class="zone-backend-label">Zone backend</span>
            <div class="zone-backend-info">
              <span class="zone-backend-name">${backendName}</span>
            </div>
            ${backendSubDetail ? `<span class="zone-backend-sub">${backendSubDetail}</span>` : ''}
          </div>
          <div class="zone-card-divider" aria-hidden="true"></div>
          <div class="zone-card-actions">
            <button type="button" class="zone-backend-button" data-action="configure-zone" data-id="${zone.id}" aria-label="Configure ${zoneLabelAria}">Configure</button>
          </div>
          ${connectHint}
          ${connectError ? `<p class="zone-card-error">${escapeHtml(connectError)}</p>` : ''}
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
        <p>These zones were imported from the Loxone configuration on your MiniServer. Please assign an appropriate backend to each zone.</p>
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

function renderZonesMetricIcon(name) {
  switch (name) {
    case 'active-backends':
      return `
        <svg viewBox="0 0 24 24" role="presentation" aria-hidden="true">
          <path d="M5 5h4v4H5zM10 10h4v4h-4zM15 5h4v4h-4zM15 15h4v4h-4zM5 15h4v4H5zM10 5h4v4h-4z" fill="currentColor"></path>
        </svg>
      `;
    case 'total':
    default:
      return `
        <svg viewBox="0 0 24 24" role="presentation" aria-hidden="true">
          <path d="M4 5h16v3H4zM4 10h16v3H4zM4 15h16v3H4z" fill="currentColor"></path>
        </svg>
      `;
  }
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
      icon: renderZonesMetricIcon('total'),
    },
    {
      id: 'active-backends',
      label: 'Active backends',
      value: stats.activeBackends,
      tone: stats.activeBackends ? 'success' : 'neutral',
      note: stats.activeBackends
        ? `${stats.activeBackends === 1 ? 'Backend online' : 'Backends online'}`
        : 'Add a backend to enable playback',
      icon: renderZonesMetricIcon('active-backends'),
    },
  ];

  return `
    <div class="zones-overview">
      <ul class="zones-metrics" role="list">
        ${metrics
          .map((metric) => `
            <li class="zones-metric zones-metric--${metric.tone}">
              <div class="zones-metric-icon" aria-hidden="true">${metric.icon}</div>
              <div class="zones-metric-content">
                <span class="zones-metric-label">${escapeHtml(metric.label)}</span>
                <span class="zones-metric-value">${escapeHtml(String(metric.value))}</span>
                <span class="zones-metric-note">${escapeHtml(metric.note)}</span>
              </div>
            </li>
          `)
          .join('')}
      </ul>
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
  const cache = ensureMusicAssistantCache();
  const providerLabel = formatProviderLabel(providerType) || 'None';
  const connectedProvider = state.connectedProvider || {};
  const connectedProviderType = typeof connectedProvider.type === 'string' ? connectedProvider.type : '';
  const connectedProviderLabel = formatProviderLabel(connectedProviderType) || 'None';
  const options = typeof mediaProvider.options === 'object' && mediaProvider.options
    ? mediaProvider.options
    : (mediaProvider.options = {});
  const requiresHost = providerType && providerType !== 'DummyProvider';
  const hostValueRaw = typeof options.IP === 'string' ? options.IP : '';
  let hostValue = hostValueRaw.trim();
  const musicAssistantProvider = isMusicAssistantProviderType(providerType);
  const cachedProviderHost = cache.providerHost || cache.lastIP || '';
  if (!hostValue && musicAssistantProvider && cachedProviderHost) {
    hostValue = cachedProviderHost;
    options.IP = cachedProviderHost;
  }
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

  const hostPlaceholder = musicAssistantProvider && cachedProviderHost
    ? cachedProviderHost
    : '192.168.1.10';
  const hostExtraAttrs = `placeholder="${escapeHtml(hostPlaceholder)}"`;
  const providerFields = requiresHost
    ? renderInput('provider-ip', 'Provider IP/Host', hostValue || '', 'text', false, hostExtraAttrs) +
      (showPortField
        ? renderInput('provider-port', 'Provider Port (optional)', portValue || '', 'text', false, 'placeholder="8095" inputmode="numeric" pattern="[0-9]*"')
        : '')
    : '';

  const providerDescription = describeProviderType(providerType);
  const selectedHostDisplay = requiresHost ? (hasHost ? hostValue : 'Host not set yet') : 'Not required';
  const selectedPortDisplay = showPortField ? (hasPort ? portValue : 'Default (8095)') : 'Not required';
  const providerHasChanges = Boolean(statusLabel);

  const guidance = isDummyProvider
    ? 'Dummy provider is useful for testing and won’t expose any sources to Loxone.'
    : requiresHost
      ? showPortField
        ? 'Set the Music Assistant host. Port defaults to 8095 if left blank.'
        : 'Set the provider host so the AudioServer can fetch sources.'
      : providerType
        ? 'This provider does not require any connection details.'
        : 'Select a provider to begin configuration.';

  const activeProviderType = connectedProviderType;
  const activeProviderLabel = formatProviderLabel(activeProviderType) || 'None';
  const activeRequiresHost = activeProviderType && activeProviderType !== 'DummyProvider';
  const activeShowPortField = activeProviderType === 'MusicAssistantProvider' || activeProviderType === 'MusicAssistantRadioProvider';
  const activeHostValue = activeRequiresHost ? (connectedHost ? connectedHost : 'Not set') : 'Not required';
  const activePortValue = activeShowPortField ? (connectedPort ? connectedPort : 'Using default (8095)') : 'Not required';
  let activeStatusTone = 'success';
  let activeStatusMessage = 'Serving zones using this provider.';
  if (!activeProviderType) {
    activeStatusTone = 'warning';
    activeStatusMessage = 'No provider connected.';
  } else if (activeRequiresHost && !connectedHost) {
    activeStatusTone = 'warning';
    activeStatusMessage = 'Saved provider is missing a host.';
  }
  const activeDescription = activeProviderType
    ? `${activeProviderLabel} (last saved)`
    : 'None saved yet.';
  const activeTile = `
        <section class="provider-summary provider-summary--active">
          <div class="provider-summary__title">
            <h3 class="provider-summary__heading">Active provider</h3>
            <p class="provider-summary__description">${escapeHtml(activeDescription)}</p>
          </div>
          <dl class="provider-meta provider-meta--dense">
            <div>
              <dt>Type</dt>
              <dd>${escapeHtml(activeProviderLabel || 'None')}</dd>
            </div>
            <div>
              <dt>Host</dt>
              <dd>${escapeHtml(activeHostValue)}</dd>
            </div>
            <div>
              <dt>Port</dt>
              <dd>${escapeHtml(activePortValue)}</dd>
            </div>
          </dl>
          <p class="provider-summary__hint provider-summary__hint--emph provider-summary__hint--tight">${escapeHtml(activeStatusMessage)}</p>
        </section>
      `;

  const selectedInfoTile = `
        <section class="provider-summary provider-summary--info">
          <div class="provider-summary__header">
            <span class="provider-summary__tag">${escapeHtml(providerType ? 'Editing' : 'No selection')}</span>
            <strong class="provider-summary__name">${escapeHtml(providerLabel || 'Choose a provider')}</strong>
            ${providerHasChanges ? `<span class="provider-change-chip">Unsaved</span>` : ''}
          </div>
          ${providerDescription ? `<p class="provider-info-copy">${escapeHtml(providerDescription)}</p>` : ''}
          <dl class="provider-meta provider-meta--two provider-meta--dense">
            <div>
              <dt>Host</dt>
              <dd>${escapeHtml(selectedHostDisplay)}</dd>
            </div>
            <div>
              <dt>Port</dt>
              <dd>${escapeHtml(selectedPortDisplay)}</dd>
            </div>
          </dl>
          <p class="provider-summary__hint">${escapeHtml(guidance)}</p>
        </section>
      `;

  return `
    <div class="provider-layout">
      <div class="provider-overview">
        ${activeTile}
        ${selectedInfoTile}
      </div>
      <div class="provider-card provider-card--compact">
        <div class="provider-card__form">
          <div class="provider-card__header">
            <h2>Media Provider</h2>
            <p>Pick a provider, adjust its details, then connect.</p>
            ${connectedProviderLabel ? `<span class="provider-card__caption">Last connected: ${escapeHtml(connectedProviderLabel)}</span>` : ''}
          </div>
          ${renderSelect('provider-type', 'Provider', providerOptions, providerType, 'class="provider-select"')}
          <div id="provider-fields" class="provider-fields-grid ${requiresHost ? '' : 'hidden'}">
            ${providerFields}
          </div>
          <div class="provider-card__actions">
            <button type="button" id="provider-connect" class="primary">Connect provider</button>
          </div>
        </div>
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

function isMusicAssistantProviderType(value = '') {
  const normalized = String(value || '').trim();
  return normalized === 'MusicAssistantProvider' || normalized === 'MusicAssistantRadioProvider';
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
      if (artist) {
        lines.push(`<div class="zone-track-artist">${escapeHtml(artist)}</div>`);
      }
      lines.push(`<div class="zone-track-title">${escapeHtml(title || 'Unknown title')}</div>`);
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
  const cache = ensureMusicAssistantCache();
  const knownIps = Object.keys(cache.playersByIp || {});
  const cacheFallbackIp = cache.lastIP || knownIps[0] || '';
  const isLoopback = (value = '') => {
    const trimmed = String(value || '').trim();
    return trimmed === '127.0.0.1' || trimmed === 'localhost';
  };
  let ipValue = modalState.ip ?? zone.ip ?? '';
  if (typeof ipValue === 'string') {
    ipValue = ipValue.trim();
  }
  if (backend !== 'BackendMusicAssistant' && isLoopback(ipValue)) {
    ipValue = '';
    if (state.modal) state.modal.ip = '';
  }

  let maSuggestions = [];
  if (Array.isArray(modalState.maSuggestions) && modalState.maSuggestions.length) {
    maSuggestions = modalState.maSuggestions;
  } else if (Array.isArray(state.suggestions?.[zone.id]) && state.suggestions[zone.id].length) {
    maSuggestions = state.suggestions[zone.id];
  } else if (backend === 'BackendMusicAssistant') {
    const cachedPlayers = cache.playersByIp?.[ipValue] || [];
    if (cachedPlayers.length) {
      maSuggestions = cachedPlayers;
    }
  }
  if (backend === 'BackendMusicAssistant' && maSuggestions.length && (!Array.isArray(modalState.maSuggestions) || !modalState.maSuggestions.length)) {
    state.modal = {
      ...(state.modal || {}),
      maSuggestions,
    };
  }
  const maPlayerId = modalState.maPlayerId ?? zone.maPlayerId ?? '';
  const modalError = typeof modalState.error === 'string' ? modalState.error.trim() : '';
  const zoneDisplayName = (zone.name ?? '').trim();
  const summaryZoneName = zoneDisplayName || `Zone ${zone.id}`;
  let backendDescription = describeBackend(backend);
  if (backend === 'BackendMusicAssistant' && maSuggestions.length && cache.playersByIp?.[ipValue]) {
    const reuseNote = ' Players previously discovered will remain available for other zones using this server.';
    backendDescription = backendDescription ? backendDescription + reuseNote : reuseNote.trim();
  }

  const backendOptionsLabels = backendOptions.map((option) => {
    const value = option;
    const label = formatBackendLabel(option);
    return { value, label };
  });
  const backendSelect = renderSelect('modal-backend', 'Backend', backendOptionsLabels, backend, 'class="backend-modal__select"');
  const ipAttrs = backend === 'DummyBackend' ? 'disabled aria-disabled="true"' : '';
  const ipPlaceholderValue = backend === 'BackendMusicAssistant' ? cacheFallbackIp : '';
  const ipPlaceholder = ipPlaceholderValue ? `placeholder="${escapeHtml(ipPlaceholderValue)}"` : '';
  const ipField = renderInput(
    'modal-backend-ip',
    backend === 'BackendMusicAssistant' ? 'Music Assistant Host' : 'Backend IP',
    backend === 'DummyBackend' ? '' : ipValue,
    'text',
    false,
    `${ipAttrs} ${ipPlaceholder}`.trim(),
  );

  let maField = '';
  let maActions = '';
  if (backend === 'BackendMusicAssistant') {
    const hasSuggestions = maSuggestions.length > 0;
    if (hasSuggestions) {
      const maPlayerOptions = [{ value: '', label: 'Select a player' }, ...maSuggestions.map((player) => ({ value: player.id, label: `${player.name} (${player.id})` }))];
      maField = renderSelect(
        'modal-ma-player',
        'Music Assistant Player',
        maPlayerOptions,
        hasSuggestions ? maPlayerId : '',
        'class="backend-modal__select"',
      );
    } else {
      maField = `
        <div class="backend-modal__ma-empty" role="status">
          <h4>Scan for players</h4>
          <p>Launch a scan to discover Music Assistant players for this zone.</p>
        </div>
      `;
    }
    const scanDisabledAttr = backend === 'BackendMusicAssistant' && !ipValue ? 'disabled aria-disabled="true"' : '';
    maActions = `
      <div class="backend-modal__ma-actions">
        <button type="button" class="tertiary" data-action="modal-scan-zone" data-id="${zone.id}" ${scanDisabledAttr}>${hasSuggestions ? 'Rescan players' : 'Scan players'}</button>
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
            <h2 id="backend-modal-title">Configure ${escapeHtml(summaryZoneName)}</h2>
            <p class="backend-modal__subtitle">Adjust backend settings and connection details.</p>
          </div>
          <button type="button" class="backend-modal__close" data-modal-close="true" aria-label="Close">×</button>
        </header>
        <div class="backend-modal__body">
          ${errorHtml}
          <div class="backend-modal__layout">
            <aside class="backend-modal__summary">
              <h3 class="backend-modal__summary-title">${formatBackendLabel(backend)}</h3>
              <p class="backend-modal__summary-text">${backendDescription || 'Select a backend to see configuration details and requirements.'}</p>
              <div class="backend-modal__summary-zone">
                <span class="backend-modal__summary-label">Zone</span>
                <span class="backend-modal__summary-value">${escapeHtml(summaryZoneName)}</span>
                <span class="backend-modal__summary-meta">ID ${escapeHtml(String(zone.id))}</span>
              </div>
            </aside>
            <div class="backend-modal__form">
              ${backendSelect}
              ${ipField}
              ${backend === 'BackendMusicAssistant' ? `<div class="backend-modal__ma">${maField}${maActions}</div>` : ''}
            </div>
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
  const cache = ensureMusicAssistantCache();
  const knownIps = Object.keys(cache.playersByIp || {});
  const cacheFallbackIp = cache.lastIP || knownIps[0] || '';
  const isLoopback = (value = '') => {
    const trimmed = String(value || '').trim();
    return trimmed === '127.0.0.1' || trimmed === 'localhost';
  };
  const originalIp = (zone.ip || '').trim();
  let defaultIp = originalIp;
  if (!defaultIp && backend === 'BackendMusicAssistant') {
    defaultIp = cacheFallbackIp;
  } else if (defaultIp && backend !== 'BackendMusicAssistant' && isLoopback(defaultIp)) {
    defaultIp = '';
  }
  const suggestionKey = backend === 'BackendMusicAssistant' ? (defaultIp || cacheFallbackIp) : '';
  const suggestions = state.suggestions?.[zone.id]
    || (backend === 'BackendMusicAssistant' ? cache.playersByIp?.[suggestionKey] || [] : []);
  state.modal = {
    open: true,
    zoneId: zone.id,
    backend,
    ip: defaultIp,
    maPlayerId: zone.maPlayerId || '',
    maSuggestions: suggestions,
    error: '',
  };
  if (backend === 'BackendMusicAssistant') {
    state.suggestions = state.suggestions || {};
    if (suggestions.length) {
      state.suggestions[zone.id] = suggestions;
    }
    if (!state.modal.maPlayerId && suggestions.length === 1) {
      state.modal.maPlayerId = suggestions[0].id || '';
    }
  }
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

function ensureMusicAssistantCache() {
  if (!state.musicAssistantCache) {
    state.musicAssistantCache = { lastIP: '', playersByIp: {}, providerHost: '' };
  }
  const cache = state.musicAssistantCache;
  cache.playersByIp ||= {};
  if (typeof cache.lastIP !== 'string') {
    cache.lastIP = cache.lastIP ? String(cache.lastIP).trim() : '';
  }
  if (typeof cache.providerHost !== 'string') {
    cache.providerHost = cache.providerHost ? String(cache.providerHost).trim() : '';
  }
  return cache;
}

const BACKEND_DESCRIPTIONS = {
  DummyBackend: 'Use this placeholder when a zone should be ignored or remains unassigned.',
  BackendMusicAssistant: 'Integrates with Music Assistant to expose players from your MA instance. Scan once to discover available players, then reuse them across zones.',
  BackendSonos: 'Connects the zone to a Sonos player for playback control and metadata updates.',
  BackendBeolink: 'Links the zone with a Bang & Olufsen Beolink player using the BeoApp middleware.',
};

const PROVIDER_DESCRIPTIONS = {
  DummyProvider: 'Disables external media sources. Useful for testing or when no provider should be exposed to Loxone.',
  MusicAssistantProvider: 'Connects directly to your Music Assistant server, exposing its full library, search, and playback features inside the Loxone AudioServer.',
  MusicAssistantRadioProvider: 'Publishes radio presets from Music Assistant so you can tune curated stations from the AudioServer.',
};

function describeBackend(backendName = '') {
  const normalized = String(backendName || '').trim();
  return BACKEND_DESCRIPTIONS[normalized] || '';
}

function describeProviderType(providerName = '') {
  const normalized = String(providerName || '').trim();
  if (!normalized) return '';
  return PROVIDER_DESCRIPTIONS[normalized] || 'Configure this provider to expose sources to the AudioServer.';
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
      } else {
        const cache = ensureMusicAssistantCache();
        const updates = {};
        const knownIps = Object.keys(cache.playersByIp || {});
        const cacheFallbackIp = cache.lastIP || knownIps[0] || '';
        const isLoopback = (value = '') => {
          const trimmed = String(value || '').trim();
          return trimmed === '127.0.0.1' || trimmed === 'localhost';
        };

        if ((!state.modal.ip || isLoopback(state.modal.ip)) && cacheFallbackIp) {
          updates.ip = cacheFallbackIp;
        }
        const resolvedIp = (updates.ip || state.modal.ip || cacheFallbackIp || '').trim();
        const cachedPlayers = cache.playersByIp?.[resolvedIp] || [];
        if (cachedPlayers.length) {
          updates.maSuggestions = cachedPlayers;
          if (!state.modal.maPlayerId) {
            updates.maPlayerId = cachedPlayers.length === 1 ? cachedPlayers[0].id : '';
          }
          state.suggestions = state.suggestions || {};
          if (typeof state.modal?.zoneId === 'number') {
            state.suggestions[state.modal.zoneId] = cachedPlayers;
          }
        } else {
          updates.maSuggestions = [];
          updates.maPlayerId = '';
        }
        if (Object.keys(updates).length) {
          updateModalState(updates);
        }
      }
      render();
    });
  }

  const ipInputEl = modal.querySelector('#modal-backend-ip');
  if (ipInputEl instanceof HTMLInputElement) {
    ipInputEl.addEventListener('input', (event) => {
      const value = event.target.value;
      const updates = { ip: value, error: '' };
      if ((state.modal?.backend || '') === 'BackendMusicAssistant') {
        const cache = ensureMusicAssistantCache();
        const trimmed = value.trim();
        const fallbackIp = cache.lastIP || Object.keys(cache.playersByIp || {})[0] || '';
        const resolvedIp = trimmed || fallbackIp;
        const cachedPlayers = cache.playersByIp?.[resolvedIp] || [];
        updates.maSuggestions = cachedPlayers;
        if (!cachedPlayers.length) {
          updates.maPlayerId = '';
        } else if (!state.modal.maPlayerId) {
          updates.maPlayerId = cachedPlayers.length === 1 ? cachedPlayers[0].id : '';
        }
        state.suggestions = state.suggestions || {};
        if (typeof state.modal?.zoneId === 'number') {
          if (cachedPlayers.length) {
            state.suggestions[state.modal.zoneId] = cachedPlayers;
          } else {
            delete state.suggestions[state.modal.zoneId];
          }
        }
      }
      updateModalState(updates);
      const scanButton = modal.querySelector('[data-action="modal-scan-zone"]');
      if (scanButton instanceof HTMLButtonElement) {
        const backend = state.modal?.backend || '';
        const trimmedIp = (value || '').trim();
        const shouldDisable = backend === 'BackendMusicAssistant' && !trimmedIp;
        scanButton.disabled = shouldDisable;
        if (shouldDisable) {
          scanButton.setAttribute('aria-disabled', 'true');
        } else {
          scanButton.removeAttribute('aria-disabled');
          scanButton.removeAttribute('disabled');
        }
      }
    });
  }

  const maFieldEl = modal.querySelector('#modal-ma-player');
  if (maFieldEl instanceof HTMLSelectElement) {
    maFieldEl.addEventListener('change', (event) => {
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

  if (backend === 'BackendMusicAssistant' && !ipValue) {
    updateModalState({ error: 'Enter the Music Assistant host before saving.' });
    render();
    return;
  }

  let maPlayerId = '';
  if (backend === 'BackendMusicAssistant') {
    const maFieldEl = document.getElementById('modal-ma-player');
    if (maFieldEl instanceof HTMLSelectElement) {
      maPlayerId = (maFieldEl.value || '').trim();
    }
    if (!maPlayerId) {
      updateModalState({ error: 'Scan for players and choose one before saving.' });
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
      const cache = ensureMusicAssistantCache();
      cache.playersByIp[ipValue] = state.modal.maSuggestions;
      cache.lastIP = ipValue;
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
  const providerType = state.config.mediaProvider?.type || '';
  if (isMusicAssistantProviderType(providerType)) {
    const hostValue = state.config.mediaProvider?.options?.IP;
    const trimmedHost = typeof hostValue === 'string' ? hostValue.trim() : '';
    if (trimmedHost) {
      const cache = ensureMusicAssistantCache();
      cache.providerHost = trimmedHost;
      cache.lastIP = trimmedHost;
    }
  }
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
    const trimmedIp = ip.trim();
    state.suggestions = state.suggestions || {};
    state.suggestions[zone.id] = data.players || [];
    const cache = ensureMusicAssistantCache();
    cache.playersByIp[trimmedIp] = data.players || [];
    cache.lastIP = trimmedIp;
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

function stopLogStream() {
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
  if (!miniserver.ip || !miniserver.ip.trim()) {
    setStatus('Add the Miniserver IP before saving.', true);
    return;
  }

  setStatus('Saving configuration…');
  try {
    await persistConfig();
    const response = await fetch('/admin/api/config/reload', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
    const message = data.message || 'Configuration saved. Reboot the Miniserver to initiate pairing.';
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
    state.config = defaultConfig();
    state.options = defaultOptions();
    state.zoneStatus = {};
    state.suggestions = {};
    state.connectedProvider = { type: '', options: {} };
    state.modal = {
      open: false,
      zoneId: null,
      backend: '',
      ip: '',
      maPlayerId: '',
      maSuggestions: [],
      error: '',
    };
    state.waitingForPairing = true;
    render();
    setStatus(data?.message || 'Configuration reset. Awaiting new pairing…');
    ensurePairingWatcher();
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
