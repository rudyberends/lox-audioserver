import {
  getConfig,
  saveConfig,
  reloadConfig,
  clearConfig,
  connectZoneApi,
  validateAdapterConfig,
  fetchZoneStatesApi,
  fetchMusicAssistantPlayersApi,
} from './apiClient.js';
import {
  state,
  defaultConfig,
  defaultOptions,
  ensureMusicAssistantCache,
  updateModalState,
  resetModalState,
} from './state.js';
import { renderInput, renderSelect, escapeHtml } from './ui/helpers.js';
import {
  initLogs,
  renderLogs,
  bindLogEvents,
  bindLoggingEvents,
  maybeLoadLogs,
  stopLogStream,
  setLogFullscreen,
} from './logs.js';


const app = document.getElementById('app');
const statusEl = document.getElementById('status');
const tabsNav = document.getElementById('tabs');
let statusBannerTimeout = 0;
const zoneErrorTimers = new Map();
const FOCUS_PRESERVE_IDS = new Set(['provider-ip', 'provider-port']);

let renderScheduled = false;
let pairingWatcherId = 0;
let pairingWatcherBusy = false;
let zonesRefreshTimerId = 0;
let zonesRefreshBusy = false;

const ZONE_REFRESH_INTERVAL = 5_000;
const ZONE_CONFIG_REFRESH_TICKS = 6;
const MAX_EXTENSION_COUNT = 10;
const AUDIO_SERVER_SERIAL = '504F94FF1BB3';
let zonesConfigRefreshCountdown = 0;

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

initLogs({ scheduleRender, render, setStatus });

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
    const data = await getConfig();
    state.config = data.config || defaultConfig();
    state.options = data.options || defaultOptions();
    state.options.adapters = Array.isArray(state.options.adapters)
      ? state.options.adapters
      : [];
    state.options.providers = Array.isArray(state.options.providers)
      ? state.options.providers
      : [];
    state.options.contentPlayers = Array.isArray(state.options.contentPlayers)
      ? state.options.contentPlayers
      : [];
    if (Array.isArray(state.config.zones)) {
      state.config.zones.forEach((zone) => {
        if (!zone || typeof zone !== 'object') return;
        const adapter = getZoneAdapter(zone);
        zone.adapter = {
          type: adapter.type,
          parameters: adapter.parameters,
        };
        const contentAdapter = adapter.parameters?.contentadapter || zone.contentAdapter;
        if (contentAdapter && typeof contentAdapter === 'object') {
          const adapterId = contentAdapter.id || contentAdapter.type || '';
          const playerId = contentAdapter.playerId || contentAdapter.playerid || '';
          if (adapterId) {
            zone.contentAdapter = { id: adapterId, playerId };
          } else {
            delete zone.contentAdapter;
          }
        } else {
          delete zone.contentAdapter;
        }
        // keep legacy convenience fields cleared
        delete zone.backend;
        delete zone.ip;
        delete zone.maPlayerId;
      });
    }
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
    state.providerDiscovery = {};
    const providerMeta = findProviderMeta(state.config.mediaProvider?.type);
    state.config.mediaProvider = state.config.mediaProvider || { type: '', options: {} };
    state.config.mediaProvider.options = normalizeProviderParameters(providerMeta, state.config.mediaProvider.options);
    state.connectedProvider.options = normalizeProviderParameters(findProviderMeta(state.connectedProvider.type), state.connectedProvider.options);
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
    state.zoneStatus = data.zoneStatus || {};
    mergeCachedZoneStates();
    zonesConfigRefreshCountdown = ZONE_CONFIG_REFRESH_TICKS;
    if (!silent) {
      await refreshZoneStates(true).catch((error) => {
        console.error('Failed to load zone states', error);
      });
    }
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

  let focusSnapshot = null;
  if (typeof document !== 'undefined') {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      const activeId = activeElement.id;
      if (activeId && FOCUS_PRESERVE_IDS.has(activeId)) {
        let selectionStart = null;
        let selectionEnd = null;
        let selectionDirection = null;
        if ('selectionStart' in activeElement && 'selectionEnd' in activeElement) {
          try {
            selectionStart = activeElement.selectionStart;
            selectionEnd = activeElement.selectionEnd;
            selectionDirection = activeElement.selectionDirection || null;
          } catch (error) {
            selectionStart = null;
            selectionEnd = null;
            selectionDirection = null;
          }
        }
        focusSnapshot = { id: activeId, selectionStart, selectionEnd, selectionDirection };
      }
    }
  }

  if (Array.isArray(state.config.zones)) {
    state.config.zones.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  }

  const panelsHtml = renderPanels(state.config);
  const modalHtml = renderAdapterModal();
  app.innerHTML = panelsHtml + modalHtml;
  bindFormEvents();
  updateTabs();
  updateHeroSummary();
  maybeLoadLogs();

  if (focusSnapshot && typeof document !== 'undefined') {
    const nextElement = document.getElementById(focusSnapshot.id);
    if (nextElement instanceof HTMLElement) {
      try {
        if (typeof nextElement.focus === 'function') {
          nextElement.focus({ preventScroll: true });
        }
      } catch {
        try {
          nextElement.focus();
        } catch {
          // Ignore focus errors
        }
      }
      if (
        focusSnapshot.selectionStart !== null &&
        focusSnapshot.selectionEnd !== null &&
        'setSelectionRange' in nextElement
      ) {
        try {
          nextElement.setSelectionRange(
            focusSnapshot.selectionStart,
            focusSnapshot.selectionEnd,
            focusSnapshot.selectionDirection ?? 'none',
          );
        } catch {
          // Ignore selection errors
        }
      }
    }
  }
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
  const connectionCard = `
            <article class="miniserver-card connection">
              <header>
                <div>
                  <h3>Connection</h3>
                  <p>Review the detected MiniServer details after pairing.</p>
                </div>
                <div class="connection-state">${renderMiniserverBadge(config)}</div>
              </header>
              <div class="miniserver-form">
                ${miniserverIpField}
                ${miniserverSerialField}
              </div>
              ${renderPairingWaitIndicator()}
            </article>`;

  const generalPanel = `
    <section data-tabpanel="miniserver" class="${panelClass('miniserver')}">
      <div class="miniserver-header">
        <div class="miniserver-title">
          <h2>AudioServer Setup</h2>
          <p class="miniserver-subtitle">Follow these steps to get paired and start using the AudioServer.</p>
        </div>
        <div class="miniserver-state">
          ${renderPairingBadge(config.audioserver)}
        </div>
      </div>
      <div class="miniserver-layout">
        <div class="miniserver-primary">
          ${connectionCard}
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

  return `${generalPanel}${zonesPanel}${updatePanel}${logsPanel}`;
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
  const activeTab = state.activeTab || 'miniserver';
  tabsNav?.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === activeTab);
  });
  document.querySelectorAll('[data-tabpanel]').forEach((panel) => {
    if (!(panel instanceof HTMLElement)) return;
    const name = panel.getAttribute('data-tabpanel');
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

function coercePlaybackString(value) {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (value == null) return '';
  return String(value).trim().toLowerCase();
}

function derivePlaybackStateLabel(power = '', mode = '') {
  if (power === 'off' || power === 'offline') return '';
  if (mode === 'play' || mode === 'resume') return 'playing';
  if (mode === 'pause') return 'paused';
  if (mode === 'stop') return power === 'on' ? 'stopped' : '';
  if (power && power !== 'on') return power;
  if (mode) return mode;
  return '';
}

function ensureAudioServerLabel(name = '') {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return 'AudioServer';
  if (isAudioServerLabel(trimmed)) return trimmed;
  return `${trimmed} (AudioServer)`;
}

function sanitizeKey(value = '') {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildSourceKey(label = '', fallbackId = '') {
  if (!label && !fallbackId) {
    return '__unknown';
  }
  const index = extractExtensionIndex(label);
  if (Number.isFinite(index) && index !== null) {
    return `extension-${index}`;
  }
  if (isAudioServerLabel(label)) {
    return 'audioserver';
  }
  if (fallbackId) {
    return sanitizeKey(fallbackId);
  }
  const sanitized = sanitizeKey(label);
  return sanitized || '__unknown';
}

function normalizeZoneStatePayload(raw = {}) {
  const id = Number(raw?.id ?? raw?.playerId ?? raw?.playerid);
  if (!Number.isFinite(id) || id <= 0) return null;
  const power = coercePlaybackString(raw?.power);
  const mode = coercePlaybackString(raw?.mode);
  let state = coercePlaybackString(raw?.state);
  if (!state) {
    state = derivePlaybackStateLabel(power, mode);
  }
  let connected;
  if (typeof raw?.connected === 'boolean') {
    connected = raw.connected;
  } else if (power) {
    connected = !['off', 'offline', 'rebooting', 'updating'].includes(power);
  } else {
    connected = false;
  }
  const clampVolume = (value) => {
    const numeric = typeof value === 'number' ? value : Number(value ?? 0);
    if (!Number.isFinite(numeric)) return undefined;
    return Math.max(0, Math.min(100, Math.round(numeric)));
  };
  const trim = (value) => (typeof value === 'string' ? value.trim() : '');
  const coverUrl = trim(raw?.coverUrl ?? raw?.coverurl ?? '');
  const volume = clampVolume(raw?.volume);
  const positionMsRaw = raw?.positionMs ?? raw?.position_ms;
  const durationMsRaw = raw?.durationMs ?? raw?.duration_ms;
  const positionMs =
    typeof positionMsRaw === 'number' && Number.isFinite(positionMsRaw) && positionMsRaw >= 0
      ? Math.floor(positionMsRaw)
      : null;
  const durationMs =
    typeof durationMsRaw === 'number' && Number.isFinite(durationMsRaw) && durationMsRaw >= 0
      ? Math.floor(durationMsRaw)
      : null;
  const parentName = trim(raw?.parent?.name ?? raw?.parentName ?? '');
  const parentId = trim(raw?.parent?.id ?? raw?.parentId ?? '');

  return {
    id,
    name: trim(raw?.name ?? ''),
    title: trim(raw?.title ?? ''),
    artist: trim(raw?.artist ?? ''),
    album: trim(raw?.album ?? ''),
    coverUrl,
    sourceName: trim(raw?.sourceName ?? ''),
    station: trim(raw?.station ?? ''),
    power,
    mode,
    state,
    volume,
    positionMs,
    durationMs,
    updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : null,
    parentName,
    parentId,
    connected,
  };
}

function integrateZonePlayback(playback) {
  if (!playback || typeof playback.id !== 'number' || playback.id <= 0) return;
  const zoneId = playback.id;
  state.zoneStatus = state.zoneStatus || {};
  const zoneConfig = Array.isArray(state.config?.zones)
    ? state.config.zones.find((z) => z.id === zoneId)
    : null;
  const adapter = zoneConfig ? getZoneAdapter(zoneConfig) : { type: 'null', parameters: {} };
  const existing = state.zoneStatus[zoneId] || {
    id: zoneId,
    adapterType: normalizeAdapterType(adapter?.type || 'null'),
    connected: false,
    name: zoneConfig?.name ?? '',
    connectError: '',
  };
  let connected = existing.connected;
  if (typeof playback.connected === 'boolean') {
    connected = playback.connected;
  } else if (playback.power) {
    connected = !['off', 'offline', 'rebooting', 'updating'].includes(playback.power);
  }
  const volume = typeof playback.volume === 'number' && Number.isFinite(playback.volume)
    ? Math.max(0, Math.min(100, Math.round(playback.volume)))
    : existing.volume;
  const zoneSourceFromConfig = typeof zoneConfig?.source === 'string' ? zoneConfig.source.trim() : '';
  const audioServerName = typeof state.config?.audioserver?.name === 'string'
    ? state.config.audioserver.name.trim()
    : '';
  const playbackParentName = typeof playback.parentName === 'string' ? playback.parentName.trim() : '';
  const playbackSourceName = typeof playback.sourceName === 'string' ? playback.sourceName.trim() : '';
  let sourceLabel =
    playbackParentName
    || zoneSourceFromConfig
    || (typeof existing.sourceLabel === 'string' ? existing.sourceLabel : '')
    || playbackSourceName;
  if (!sourceLabel) {
    sourceLabel = audioServerName ? ensureAudioServerLabel(audioServerName) : 'AudioServer';
  } else if (audioServerName && sourceLabel === audioServerName && !isAudioServerLabel(sourceLabel)) {
    sourceLabel = ensureAudioServerLabel(audioServerName);
  }
  const sourceId = typeof playback.parentId === 'string' ? playback.parentId : (typeof existing.sourceId === 'string' ? existing.sourceId : '');
  const sourceKey = buildSourceKey(sourceLabel, sourceId);
  if (zoneConfig && typeof zoneConfig === 'object') {
    zoneConfig.source = sourceLabel;
    if (sourceId) {
      zoneConfig.sourceSerial = sourceId;
    }
  }

  const zoneName = zoneConfig?.name ?? existing.name ?? '';

  state.zoneStatus[zoneId] = {
    ...existing,
    name: zoneName,
    coverUrl: playback.coverUrl || '',
    artist: playback.artist || '',
    title: playback.title || '',
    album: playback.album || '',
    state: playback.state || '',
    power: playback.power || existing.power || '',
    mode: playback.mode || existing.mode || '',
    volume,
    sourceName: playback.sourceName || existing.sourceName || '',
    station: playback.station || existing.station || '',
    updatedAt: typeof playback.updatedAt === 'number'
      ? playback.updatedAt
      : (typeof existing.updatedAt === 'number' ? existing.updatedAt : Date.now()),
    connected,
    sourceLabel,
    sourceKey,
    sourceId,
  };
}

function applyZoneStates(payloadStates = []) {
  const list = Array.isArray(payloadStates) ? payloadStates : [];
  const nextStates = {};
  list.forEach((entry) => {
    const normalized = normalizeZoneStatePayload(entry);
    if (!normalized) return;
    integrateZonePlayback(normalized);
    nextStates[normalized.id] = normalized;
  });
  const prevSerialized = JSON.stringify(state.zoneStates || {});
  const nextSerialized = JSON.stringify(nextStates);
  const changed = prevSerialized !== nextSerialized;
  state.zoneStates = nextStates;
  state.zoneStateUpdatedAt = Date.now();
  return changed;
}

function mergeCachedZoneStates() {
  const cached = state.zoneStates;
  if (!cached || typeof cached !== 'object') return;
  Object.values(cached).forEach((entry) => {
    integrateZonePlayback(entry);
  });
}

async function refreshZoneStates(silent = false) {
  try {
    const data = await fetchZoneStatesApi();
    const zones = Array.isArray(data?.zones) ? data.zones : [];
    const changed = applyZoneStates(zones);
    if (changed) {
      scheduleRender();
    }
    return true;
  } catch (error) {
    console.error('Failed to refresh zone states', error);
    if (!silent) {
      setStatus(`Failed to refresh zone states: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    return false;
  }
}

async function refreshZones() {
  if (!shouldRefreshZones()) {
    stopZonesRefresh();
    return;
  }
  zonesRefreshBusy = true;
  zonesRefreshTimerId = 0;
  try {
    await refreshZoneStates(true);
  } catch (error) {
    console.error('Failed to refresh zone states', error);
  }
  try {
    if (zonesConfigRefreshCountdown <= 0) {
      await loadConfig(true);
      zonesConfigRefreshCountdown = ZONE_CONFIG_REFRESH_TICKS;
    } else {
      zonesConfigRefreshCountdown -= 1;
    }
  } catch (error) {
    console.error('Failed to refresh zones', error);
    zonesConfigRefreshCountdown = 0;
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
  const hasUnassignedZones = zones.some((zone = {}) => isNullAdapter(getZoneAdapter(zone).type));
  const assignmentStepClass = hasUnassignedZones ? 'pairing-step-pending' : 'pairing-step-complete';
  const assignmentBadgeClass = hasUnassignedZones ? 'pending' : 'complete';
  const assignmentBadgeLabel = hasUnassignedZones ? 'Incomplete' : 'Complete';
  const providerConfig = config.mediaProvider ?? {};
  const providerTypeRaw = typeof providerConfig.type === 'string' ? providerConfig.type : '';
  const providerType = providerTypeRaw.trim();
  const providerOptions = providerConfig.options && typeof providerConfig.options === 'object' ? providerConfig.options : {};
  const providerHostRaw = typeof providerOptions.IP === 'string' ? providerOptions.IP : '';
  const providerHost = providerHostRaw.trim();
  const providerRequiresHost = Boolean(providerType && providerType !== 'DummyProvider');
  const providerConfigured = Boolean(providerType && (!providerRequiresHost || providerHost));
  const providerStepClass = providerConfigured ? 'pairing-step-complete' : 'pairing-step-pending';
  const providerBadgeClass = providerConfigured ? 'complete' : 'pending';
  const providerBadgeLabel = providerConfigured ? 'Complete' : 'Pending';
  const zoneActionLabel = hasUnassignedZones ? 'Go to Zones tab' : 'Review zones';
  const providerActionLabel = providerConfigured ? 'Review provider' : 'Open provider setup';
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
              <span class="pairing-step-description">Loxone zones are downloaded from the Miniserver config. Assign an adapter to each zone in the Zones tab.</span>
              <div class="pairing-step-actions">
                <button type="button" class="pairing-step-link" data-nav-tab="zones">${zoneActionLabel}</button>
              </div>
            </div>
          </li>
          <li class="pairing-step-optional ${providerStepClass}">
            <span class="pairing-step-indicator" aria-hidden="true"></span>
            <div class="pairing-step-content">
              <div class="pairing-step-heading">
                <strong>Add a provider</strong>
                <span class="pairing-step-status optional">Optional</span>
                <span class="pairing-step-status ${providerBadgeClass}">${providerBadgeLabel}</span>
              </div>
              <span class="pairing-step-description">Enable a provider to expose sources to the AudioServer. Without a provider the server returns empty lists for every source request.</span>
              <div class="pairing-step-actions">
                <button type="button" class="pairing-step-link" data-nav-tab="zones" data-scroll-target="#zones-provider">${providerActionLabel}</button>
              </div>
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
              <span class="pairing-step-description">Use IP of this service and serial <code>50:4F:94:FF:1B:B3</code>.</span>
            </div>
          </li>
          <li class="pairing-step-required">
            <span class="pairing-step-indicator" aria-hidden="true"></span>
            <div class="pairing-step-content">
              <div class="pairing-step-heading">
                <strong>Configure audio zones</strong>
                <span class="pairing-step-status required">Required</span>
              </div>
              <span class="pairing-step-description">Drop the AudioServer outputs into your project. You start with two stereo outputs (two zones) but can split them for four zones. Loxone labels the split outputs as mono, yet they remain full stereo.</span>
            </div>
          </li>
          <li class="pairing-step-required">
            <span class="pairing-step-indicator" aria-hidden="true"></span>
            <div class="pairing-step-content">
              <div class="pairing-step-heading">
                <strong>Deploy changes</strong>
                <span class="pairing-step-status required">Required</span>
              </div>
              <span class="pairing-step-description">Save your changes and let the Miniserver reboot. The Miniserver initiates pairing with the AudioServer automatically after it boots with the updated project.</span>
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

function renderZonesPanel({ zones, mediaProvider } = {}) {
  const zoneList = Array.isArray(zones) ? [...zones] : [];
  const sortedZones = zoneList.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const stats = computeZoneStats(sortedZones);
  const groupedZones = groupZonesBySource(sortedZones);
  const extensionStats = deriveExtensionStats(groupedZones, state.extensionPlaceholders || []);
  state.extensionPlaceholders = extensionStats.placeholders;

  const placeholderGroups = extensionStats.placeholders.map((placeholder) => {
    const label = placeholder.label || `Stereo Extension ${placeholder.index}`;
    return {
      key: `extension-placeholder-${placeholder.index}`,
      label,
      zones: [
        {
          placeholder: 'extension',
          index: placeholder.index,
          serial: placeholder.serial,
          label,
        },
      ],
    };
  });

  const combinedGroups = sortZoneGroups([...groupedZones, ...placeholderGroups]);
  const extensionGroups = combinedGroups.filter((group) => isExtensionLabel(group.label));
  const extensionStretchKey =
    extensionGroups.length % 2 === 1 && extensionGroups.length > 0
      ? extensionGroups[extensionGroups.length - 1]?.key ?? null
      : null;
  const zoneGroupsHtml = combinedGroups
    .map((group, index) => {
      const stretch = Boolean(extensionStretchKey && group.key === extensionStretchKey);
      return renderZoneGroup(group, index, stretch);
    })
    .join('');

  const zonesContent = combinedGroups.length
    ? `<div class="zone-groups">${zoneGroupsHtml}</div>`
    : `
      <div class="zones-empty">
        <div class="zones-empty__card">
          <h3>No zones detected yet</h3>
          <p>Add Loxone zones to your configuration and reboot the Miniserver to see them listed here.</p>
          <p class="zones-empty__hint">Once zones are available you can assign an adapter and manage playback.</p>
        </div>
      </div>
    `;
  const addExtensionControls = renderAddExtensionControls(extensionStats);
  const extensionControlsSection = addExtensionControls
    ? `<div class="zones-footer">${addExtensionControls}</div>`
    : '';

  const providerPanel = `
    <div class="zones-provider-panel" id="zones-provider">
      ${renderProviderContent(mediaProvider)}
    </div>
  `;

  return `
    <header class="zones-header">
      <div class="zones-header__copy">
        <h2>Imported Loxone Zones</h2>
        <p>Splitting the default outputs in Loxone Config gives you four controllable zones. Need more coverage? Use the button below to add an extension and follow the inline steps.</p>
      </div>
      <div class="zones-header__sidebar">
        ${renderZonesOverview(stats)}
      </div>
    </header>
    ${providerPanel}
    ${zonesContent}
    ${extensionControlsSection}
  `;
}

function renderZoneGroup(group, index = 0, stretch = false) {
  if (!group) return '';
  const { label = 'Unknown source', zones = [] } = group;
  const realZoneCount = zones.filter((zone) => !zone || zone.placeholder !== 'extension').length;
  const groupCount = realZoneCount;
  const countLabel = `${groupCount} ${groupCount === 1 ? 'zone' : 'zones'}`;
  const safeLabel = escapeHtml(label);
  const safeCount = escapeHtml(countLabel);
  const groupKey = typeof group.key === 'string' && group.key ? group.key : `group-${index}`;
  const groupId = `zone-group-${groupKey.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || index}`;
  const isExtensionGroup = isExtensionLabel(label);
  const isAudioServerGroup = isAudioServerLabel(label);
  const classes = ['zone-group'];
  if (isExtensionGroup) classes.push('zone-group--extension');
  if (isAudioServerGroup) classes.push('zone-group--audioserver');
  if (stretch) classes.push('zone-group--stretch');
  const groupClass = classes.join(' ');
  const groupSerial = resolveSourceSerial(label);
  const serialLine = groupSerial ? `<span class="zone-group-serial">Serial ${escapeHtml(groupSerial)}</span>` : '';
  const cards = zones.map((zone) => renderZoneCard(zone)).join('');

  return `
    <section class="${groupClass}" aria-labelledby="${groupId}">
      <header class="zone-group-header">
        <div class="zone-group-heading">
          <h3 class="zone-group-title" id="${groupId}">${safeLabel}</h3>
          ${serialLine}
        </div>
        <span class="zone-group-count">${safeCount}</span>
      </header>
      <div class="zones">
        ${cards}
      </div>
    </section>
  `;
}

function renderZoneCard(zone) {
  if (!zone) return '';
  if (zone && zone.placeholder === 'extension') {
    return renderExtensionPlaceholderCard(zone);
  }
  const status = getZoneStatusEntry(zone);
  const adapter = getZoneAdapter(zone);
  const adapterType = normalizeAdapterType(status?.adapterType ?? adapter.type);
  const adapterLabel = formatAdapterLabel(adapterType);
  const adapterDescription = describeAdapter(adapterType);
  const adapterParams = adapter.parameters || {};
  const musicAssistant = isMusicAssistantAdapter(adapterType);
  const isNull = isNullAdapter(adapterType);
  const connected = !isNull && Boolean(status?.connected);
  const statusPrefix = connected ? 'Online' : 'Pending connection';
  const statusText = isNull ? 'Unassigned' : statusPrefix;
  const statusClass = isNull ? 'dummy' : connected ? 'connected' : 'disconnected';
  const safeStatusText = escapeHtml(statusText);
  const zoneNumber = typeof zone.id === 'number' ? zone.id : '—';
  const safeZoneId = escapeHtml(String(zoneNumber));
  const zoneNameRaw = `${status?.name ?? zone.name ?? ''}`.trim();
  const safeZoneName = zoneNameRaw ? escapeHtml(zoneNameRaw) : '';
  const zoneTitle = safeZoneName ? safeZoneName : `#${safeZoneId}`;
  const metadataBlock = renderZoneMetadata(status, { isDummy: isNull });
  const hasPlayerSelection = Boolean(String(adapterParams.maPlayerId || '').trim());
  let connectHint = '';
  const connectError = state.zoneStatus?.[zone.id]?.connectError || '';
  const cardStateClass = connected
    ? 'zone-card--connected'
    : isNull
      ? 'zone-card--unassigned'
      : 'zone-card--pending';

  if (!connected && musicAssistant && !hasPlayerSelection) {
    connectHint = '<p class="zone-card-hint">Configure a Music Assistant player before connecting.</p>';
  }

  const zoneLabel = safeZoneName || `Zone ${safeZoneId}`;
  const zoneLabelAria = escapeHtml(zoneLabel);
  let adapterSubDetail = '';
  if (musicAssistant) {
    const playerId = String(adapterParams.maPlayerId ?? '').trim();
    if (playerId) adapterSubDetail = escapeHtml(playerId);
  } else {
    const ipRaw = adapterParams.ip ?? adapterParams.IP;
    const ip = typeof ipRaw === 'string' ? ipRaw.trim() : '';
    if (ip) adapterSubDetail = escapeHtml(ip);
  }

  const adapterDescriptionMarkup = adapterDescription && !musicAssistant
    ? `<span class="zone-adapter-description">${escapeHtml(adapterDescription)}</span>`
    : '';
  const adapterSubDetailMarkup = adapterSubDetail && !musicAssistant
    ? `<span class="zone-adapter-sub">${adapterSubDetail}</span>`
    : '';

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
      <div class="zone-card-adapter">
        <span class="zone-adapter-label">Zone adapter</span>
        <div class="zone-adapter-info">
          <span class="zone-adapter-name">${escapeHtml(adapterLabel)}</span>
        </div>
        ${adapterDescriptionMarkup}
        ${adapterSubDetailMarkup}
      </div>
      <div class="zone-card-divider" aria-hidden="true"></div>
      <div class="zone-card-actions">
        <button type="button" class="zone-adapter-button" data-action="configure-zone" data-id="${zone.id}" aria-label="Configure ${zoneLabelAria}">
          <span class="zone-adapter-button__label">Configure</span>
          <span class="zone-adapter-button__icon" aria-hidden="true">→</span>
        </button>
      </div>
      ${connectHint}
      ${connectError ? `<p class="zone-card-error">${escapeHtml(connectError)}</p>` : ''}
    </article>
  `;
}

function renderExtensionPlaceholderCard(placeholder) {
  const index = Number(placeholder?.index) || 0;
  const label = placeholder?.label || (index ? `Stereo Extension ${index}` : 'New Extension');
  const serial = typeof placeholder?.serial === 'string' && placeholder.serial ? placeholder.serial.toUpperCase() : '';
  const safeLabel = escapeHtml(label);
  const safeSerial = serial ? escapeHtml(serial) : '—';

  const macSerial = safeSerial.replace(/(..)(?=.)/g, '$1:');
  const safeSerialMac = escapeHtml(macSerial);
  return `
    <article class="zone-card zone-card--placeholder">
      <header class="zone-card-header zone-card-placeholder-header">
        <div class="zone-card-heading">
          <span class="zone-card-placeholder-status">Awaiting MiniServer configuration</span>
        </div>
      </header>
      <div class="zone-card-placeholder-body">
        <p>Use the serial ${safeSerialMac} when creating the extension in Loxone Config.</p>
      </div>
    </article>
  `;
}

function getZoneStatusEntry(zone = {}) {
  const zoneId = zone?.id;
  if (typeof zoneId !== 'number') {
    return {
      id: zoneId,
      adapterType: getZoneAdapter(zone).type,
      connected: false,
      name: zone?.name ?? '',
      connectError: '',
      sourceLabel: typeof zone?.source === 'string' ? zone.source.trim() : '',
      sourceKey: typeof zone?.source === 'string' ? buildSourceKey(zone.source, '') : '',
      sourceId: '',
    };
  }
  const existing = state.zoneStatus?.[zoneId];
  if (existing) return existing;
  const rawSource = typeof zone?.source === 'string' ? zone.source.trim() : '';
  const fallback = {
    id: zoneId,
    adapterType: getZoneAdapter(zone).type,
    connected: false,
    name: zone?.name ?? '',
    connectError: '',
    sourceLabel: rawSource,
    sourceKey: rawSource ? buildSourceKey(rawSource, '') : '',
    sourceId: '',
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
    activeAdapters: 0,
    coreTotal: 0,
    extensionTotal: 0,
    coreConfigured: 0,
    extensionConfigured: 0,
  };

  const activeAdapters = new Set();

  zones.forEach((zone) => {
    const status = getZoneStatusEntry(zone);
    const adapter = getZoneAdapter(zone);
    const adapterType = normalizeAdapterType(status?.adapterType ?? adapter.type);
    const isNull = isNullAdapter(adapterType);
    const connected = Boolean(status?.connected) && !isNull;
    const source = resolveZoneSource(zone);
    const sourceIsExtension = isExtensionLabel(source.label);

    if (sourceIsExtension) {
      stats.extensionTotal += 1;
    } else {
      stats.coreTotal += 1;
    }

    if (connected) {
      stats.connected += 1;
    } else if (!isNull) {
      stats.awaiting += 1;
    }

    if (isNull) {
      stats.unassigned += 1;
      return;
    }

    if (adapterType) {
      activeAdapters.add(formatAdapterLabel(adapterType));
    }

    if (sourceIsExtension) {
      stats.extensionConfigured += 1;
    } else {
      stats.coreConfigured += 1;
    }
  });

  stats.configured = stats.coreConfigured + stats.extensionConfigured;
  stats.activeAdapters = activeAdapters.size;

  return stats;
}

function groupZonesBySource(zones = []) {
  const groups = new Map();

  zones.forEach((zone) => {
    const { key, label } = resolveZoneSource(zone);
    const status = getZoneStatusEntry(zone);
    if (status && typeof zone?.id === 'number') {
      status.sourceKey = key || '__unknown';
      status.sourceLabel = label;
      state.zoneStatus = state.zoneStatus || {};
      state.zoneStatus[zone.id] = status;
    }
    const groupKey = key || '__unknown';
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { key: groupKey, label, zones: [], sourceKey: groupKey });
    }
    groups.get(groupKey).zones.push(zone);
  });

  return sortZoneGroups(Array.from(groups.values()));
}

function resolveZoneSource(zone = {}) {
  const rawSource = typeof zone?.source === 'string' ? zone.source.trim() : '';
  const zoneId = typeof zone?.id === 'number' ? zone.id : 0;
  const status = zoneId ? state.zoneStatus?.[zoneId] : null;
  const playback = zoneId ? state.zoneStates?.[zoneId] : null;
  const audioServerName = typeof state.config?.audioserver?.name === 'string'
    ? state.config.audioserver.name.trim()
    : '';
  let label = rawSource;
  if (!label && typeof status?.sourceLabel === 'string' && status.sourceLabel.trim()) {
    label = status.sourceLabel.trim();
  }
  if (!label && typeof playback?.parentName === 'string' && playback.parentName.trim()) {
    label = playback.parentName.trim();
  }
  if (!label && typeof playback?.sourceName === 'string' && playback.sourceName.trim()) {
    label = playback.sourceName.trim();
  }
  if (!label && audioServerName) {
    label = ensureAudioServerLabel(audioServerName);
  }
  if (!label) {
    label = 'AudioServer';
  }
  const key = buildSourceKey(label, status?.sourceId || (typeof playback?.parentId === 'string' ? playback.parentId : ''));
  if (zone && typeof zone === 'object') {
    zone.source = label;
  }
  return { key: key || '__unknown', label };
}

function resolveSourceSerial(label) {
  const index = extractExtensionIndex(label);
  if (Number.isFinite(index) && index > 0) {
    return computeExtensionSerial(index);
  }
  if (isAudioServerLabel(label)) {
    return AUDIO_SERVER_SERIAL;
  }
  return '';
}

function isAudioServerLabel(label) {
  if (typeof label !== 'string') return false;
  const normalized = label.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes('audioserver') || normalized.includes('audio server');
}

function sortZoneGroups(groups = []) {
  return (groups || []).sort((a, b) => {
    const aUnknown = a?.key === '__unknown';
    const bUnknown = b?.key === '__unknown';
    if (aUnknown && !bUnknown) return 1;
    if (bUnknown && !aUnknown) return -1;
    const aIsExtension = isExtensionLabel(a?.label);
    const bIsExtension = isExtensionLabel(b?.label);
    if (aIsExtension && !bIsExtension) return 1;
    if (bIsExtension && !aIsExtension) return -1;
    const aIndex = extractExtensionIndex(a?.label);
    const bIndex = extractExtensionIndex(b?.label);
    if (Number.isFinite(aIndex) && Number.isFinite(bIndex)) {
      if (aIndex !== bIndex) return aIndex - bIndex;
    } else if (Number.isFinite(aIndex)) {
      return -1;
    } else if (Number.isFinite(bIndex)) {
      return 1;
    }
    return (a?.label || '').localeCompare(b?.label || '', undefined, { sensitivity: 'base' });
  });
}

function deriveExtensionStats(groups = [], placeholders = []) {
  const actualIndexes = new Set();
  let highestActual = 0;

  (groups || []).forEach((group) => {
    const index = extractExtensionIndex(group?.label);
    if (Number.isFinite(index) && index > 0) {
      actualIndexes.add(index);
      if (index > highestActual) highestActual = index;
    }
  });

  const filteredPlaceholders = [];
  let highestPlaceholder = 0;

  (placeholders || []).forEach((placeholder) => {
    if (!placeholder || !Number.isFinite(placeholder.index)) return;
    if (actualIndexes.has(placeholder.index)) {
      return;
    }
    const normalizedSerial = typeof placeholder.serial === 'string'
      ? placeholder.serial.toUpperCase()
      : computeExtensionSerial(placeholder.index);
    const normalizedLabel = placeholder.label || `Stereo Extension ${placeholder.index}`;
    filteredPlaceholders.push({
      index: placeholder.index,
      serial: normalizedSerial,
      label: normalizedLabel,
    });
    if (placeholder.index > highestPlaceholder) highestPlaceholder = placeholder.index;
  });

  const highestIndex = Math.max(highestActual, highestPlaceholder);
  const totalCount = actualIndexes.size + filteredPlaceholders.length;

  return {
    actualIndexes,
    placeholders: filteredPlaceholders,
    highestIndex,
    totalCount,
  };
}

function extractExtensionIndex(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/extension\s*(\d+)/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function computeExtensionSerial(extensionIndex) {
  if (!Number.isFinite(extensionIndex)) return '';
  const baseValue = parseInt(AUDIO_SERVER_SERIAL, 16);
  if (!Number.isFinite(baseValue)) return '';
  const value = baseValue + extensionIndex;
  const hex = value.toString(16).toUpperCase();
  return hex.padStart(AUDIO_SERVER_SERIAL.length, '0');
}

function renderAddExtensionControls(extensionStats) {
  if (!extensionStats) return '';
  const totalCount = Number(extensionStats.totalCount) || 0;
  const highestIndex = Number(extensionStats.highestIndex) || 0;
  const remaining = Math.max(0, MAX_EXTENSION_COUNT - totalCount);
  const nextIndex = highestIndex + 1;
  const canAdd = remaining > 0 && nextIndex <= MAX_EXTENSION_COUNT;
  const buttonDisabledAttr = canAdd ? '' : 'disabled';

  return `
    <div class="zone-add-extension">
      <button type="button" id="add-extension" class="secondary" ${buttonDisabledAttr}>Add Extension</button>
    </div>
  `;
}

function isExtensionLabel(value) {
  return typeof value === 'string' && value.toLowerCase().includes('extension');
}

function renderZonesMetricIcon(name) {
  switch (name) {
    case 'active-adapters':
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
  const coreZones = stats.core ?? 0;
  const extensionZones = stats.extension ?? 0;
  const metrics = [
    {
      id: 'total',
      label: 'Total zones',
      value: stats.total,
      tone: 'primary',
      note: stats.total
        ? `${stats.coreTotal} AudioServer · ${stats.extensionTotal} Extension`
        : 'Add zones to begin',
      icon: renderZonesMetricIcon('total'),
    },
    {
      id: 'active-adapters',
      label: 'Active adapters',
      value: stats.activeAdapters,
      tone: stats.activeAdapters ? 'success' : 'neutral',
      note: stats.activeAdapters
        ? `${stats.activeAdapters === 1 ? 'Adapter online' : 'Adapters online'}`
        : 'Assign an adapter to enable playback',
      icon: renderZonesMetricIcon('active-adapters'),
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


function getProviderOptions() {
  return Array.isArray(state.options?.providers) ? state.options.providers : [];
}

function findProviderMeta(type = '') {
  const normalized = normalizeProviderType(type);
  return getProviderOptions().find((meta) => {
    const metaType = meta?.id ?? meta?.type ?? meta?.legacyName ?? '';
    return normalizeProviderType(metaType) === normalized;
  }) || null;
}

function formatProviderLabel(value = '') {
  const meta = findProviderMeta(value);
  if (meta?.label) return meta.label;
  const normalized = normalizeProviderType(value);
  if (!normalized || normalized === 'dummy') return 'Dummy Provider';
  const withSpaces = normalized.replace(/[-_]+/g, ' ');
  return withSpaces.replace(/\w/g, (char) => char.toUpperCase());
}

function describeProviderType(value = '') {
  const meta = findProviderMeta(value);
  if (meta?.description) return meta.description;
  return 'Configure this provider to expose sources to the AudioServer.';
}

function isMusicAssistantProviderType(value = '') {
  const normalized = normalizeProviderType(value);
  return normalized === 'musicassistant';
}

function getProviderFields(type = '') {
  const meta = findProviderMeta(type);
  return Array.isArray(meta?.configSchema?.fields) ? meta.configSchema.fields : [];
}

function normalizeProviderParameters(meta, rawOptions = {}) {
  const parameters = {};
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  const fields = Array.isArray(meta?.configSchema?.fields) ? meta.configSchema.fields : [];
  fields.forEach((field) => {
    const keysToCheck = [field.id, field.id?.toLowerCase(), field.id?.toUpperCase()];
    let value;
    for (const key of keysToCheck) {
      if (key && Object.prototype.hasOwnProperty.call(options, key)) {
        value = options[key];
        break;
      }
    }
    if (value === undefined || value === null) {
      if (field.inputType === 'checkbox') {
        parameters[field.id] = Boolean(field.defaultValue);
      } else if (field.defaultValue !== undefined && field.defaultValue !== null) {
        parameters[field.id] = field.inputType === 'number'
          ? String(field.defaultValue)
          : String(field.defaultValue);
      } else {
        parameters[field.id] = '';
      }
    } else if (typeof value === 'string') {
      parameters[field.id] = value.trim();
    } else {
      parameters[field.id] = value;
    }
  });
  return parameters;
}

function normalizeProviderType(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return 'dummy';
  if (/provider$/i.test(raw)) {
    return raw.replace(/provider$/i, '').toLowerCase();
  }
  return raw.toLowerCase();
}


function resolveMusicAssistantHost(zone = null) {
  const adapter = zone ? getZoneAdapter(zone) : { type: '', parameters: {} };
  const adapterHost = adapter && adapter.parameters ? String(adapter.parameters.ip || adapter.parameters.IP || '').trim() : '';
  if (adapterHost) return adapterHost;
  const providerOptions = state.config?.mediaProvider?.options || {};
  const providerHost = String(providerOptions.ip || providerOptions.IP || '').trim();
  if (providerHost) return providerHost;
  const cache = ensureMusicAssistantCache();
  return cache.providerHost || cache.lastIP || '';
}

function getAdapterOptions() {
  return Array.isArray(state.options?.adapters) ? state.options.adapters : [];
}

function getContentPlayerOptions() {
  return Array.isArray(state.options?.contentPlayers) ? state.options.contentPlayers : [];
}

function findContentPlayerMeta(id = '') {
  const normalized = String(id || '').trim();
  if (!normalized) return null;
  return getContentPlayerOptions().find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const entryId = entry.id ?? entry.type ?? entry.baseType ?? '';
    return String(entryId || '').trim() === normalized;
  }) || null;
}

function toMusicAssistantDiscoveryOptions(players = []) {
  return players
    .filter((player) => player && typeof player === 'object' && player.id)
    .map((player) => ({
      value: player.id,
      label: `${player.name} (${player.id})`,
    }));
}

function findAdapterMeta(type = '') {
  const normalized = normalizeAdapterType(type);
  return getAdapterOptions().find((entry) => normalizeAdapterType(entry.id ?? entry.type) === normalized) || null;
}

function formatAdapterLabel(type = '') {
  const normalized = normalizeAdapterType(type);
  if (normalized === 'null') return 'Unassigned';
  const meta = findAdapterMeta(normalized);
  if (meta?.label) return meta.label;
  return formatContentPlayerLabel(normalized);
}

function describeAdapter(type = '') {
  return findAdapterMeta(type)?.description || '';
}

function adapterSupportsContentPlayback(type = '') {
  return Boolean(findAdapterMeta(type)?.supportsContentPlayback);
}

function getAdapterFields(type = '') {
  const meta = findAdapterMeta(type);
  return Array.isArray(meta?.configSchema?.fields) ? meta.configSchema.fields : [];
}

function normalizeAdapterType(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || 'null';
}

function normalizeAdapterParametersOutput(raw = {}) {
  if (!raw || typeof raw !== 'object') return {};
  const normalized = {};
  Object.entries(raw).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string') {
      normalized[key] = value.trim();
      return;
    }
    normalized[key] = value;
  });
  return normalized;
}


function isNullAdapter(type = '') {
  return normalizeAdapterType(type) === 'null';
}

function isMusicAssistantAdapter(type = '') {
  return normalizeAdapterType(type) === 'musicassistant';
}

function getZoneAdapter(zone = {}) {
  const adapter = zone?.adapter;
  if (adapter && typeof adapter === 'object') {
    const type = normalizeAdapterType(adapter.type);
    const parameters = adapter.parameters && typeof adapter.parameters === 'object' ? { ...adapter.parameters } : {};
    return { type, parameters };
  }
  const legacyType = normalizeAdapterType(zone?.backend || '');
  const parameters = {};
  if (typeof zone?.ip === 'string') parameters.ip = zone.ip;
  if (typeof zone?.maPlayerId === 'string') parameters.maPlayerId = zone.maPlayerId;
  if (zone?.contentAdapter && typeof zone.contentAdapter === 'object') {
    parameters.contentAdapter = { ...zone.contentAdapter };
  }
  return { type: legacyType, parameters };
}



function renderProviderContent(mediaProvider = {}) {
  const providerOptions = getProviderOptions();
  if (!providerOptions.length) {
    return `
      <section class="zones-provider-card zones-provider-card--empty">
        <header class="zones-provider-card__header">
          <div>
            <h3>Media Provider</h3>
            <p>No providers registered. Check server configuration.</p>
          </div>
        </header>
      </section>
    `;
  }

  let providerTypeLegacy = typeof mediaProvider.type === 'string' ? mediaProvider.type : '';
  let providerMeta = findProviderMeta(providerTypeLegacy);
  if (!providerMeta) {
    providerMeta = providerOptions[0];
    providerTypeLegacy = providerMeta?.legacyName || providerMeta?.type || providerMeta?.id || 'DummyProvider';
    mediaProvider.type = providerTypeLegacy;
  }

  const providerTypeId = normalizeProviderType(providerMeta?.id ?? providerMeta?.type ?? providerMeta?.legacyName ?? 'dummy');
  const schemaFields = Array.isArray(providerMeta?.configSchema?.fields) ? providerMeta.configSchema.fields : [];
  const parameters = normalizeProviderParameters(providerMeta, mediaProvider.options || {});
  if (providerTypeId === 'musicassistant') {
    const hostKeys = ['ip', 'host', 'hostname', 'address', 'url', 'endpoint'];
    const portKeys = ['port', 'tlsPort', 'securePort'];
    const currentHostKey = hostKeys.find((key) => parameters[key]);
    let currentHost = currentHostKey ? String(parameters[currentHostKey] || '').trim() : '';
    if (!currentHost) {
      const fallbackHost = resolveMusicAssistantHost(null);
      if (fallbackHost) {
        parameters.ip = fallbackHost;
        currentHost = fallbackHost;
        state.config.mediaProvider = state.config.mediaProvider || {};
        state.config.mediaProvider.options = {
          ...(state.config.mediaProvider.options || {}),
          ip: fallbackHost,
        };
        const cache = ensureMusicAssistantCache();
        cache.providerHost = fallbackHost;
        if (!cache.lastIP) cache.lastIP = fallbackHost;
      }
    }
    const currentPortKey = portKeys.find((key) => parameters[key]);
    const currentPort = currentPortKey ? String(parameters[currentPortKey] || '').trim() : '';
    const hasPortField = schemaFields.some((field) => portKeys.includes(field.id));
    if (!currentPort && hasPortField) {
      parameters.port = '8095';
    }
  }
  state.config.mediaProvider.options = {
    ...(state.config.mediaProvider.options || {}),
    ...parameters,
  };
  mediaProvider.options = parameters;

  const fields = schemaFields;
  let fieldsHtml = '';
  if (!fields.length) {
    fieldsHtml = '<p class="zones-provider-card__hint">This provider does not require additional configuration.</p>';
  } else if (providerTypeId === 'musicassistant') {
    const hostField = fields.find((field) => ['ip', 'host', 'hostname', 'address'].includes(field.id));
    const portField = fields.find((field) => ['port', 'tlsPort', 'securePort'].includes(field.id));
    const inlineFields = [hostField, portField]
      .filter(Boolean)
      .map((field) => renderProviderField(field, parameters, state.providerDiscovery?.[field.id]))
      .join('');
    const remainingFields = fields
      .filter((field) => field !== hostField && field !== portField)
      .map((field) => renderProviderField(field, parameters, state.providerDiscovery?.[field.id]))
      .join('');
    fieldsHtml = `
      ${inlineFields ? `<div class="zones-provider-card__inline">${inlineFields}</div>` : ''}
      ${remainingFields}
    `;
  } else {
    fieldsHtml = fields.map((field) => renderProviderField(field, parameters, state.providerDiscovery?.[field.id])).join('');
  }

  const connectedProvider = state.connectedProvider || {};
  const activeProviderTypeId = normalizeProviderType(connectedProvider.type || '');
  const activeMeta = findProviderMeta(connectedProvider.type);
  const activeParameters = normalizeProviderParameters(activeMeta, connectedProvider.options || {});
  const activeFields = getProviderFields(activeProviderTypeId);

  const hasTypeChange = providerTypeId !== activeProviderTypeId;
  let hasFieldChanges = false;
  if (!hasTypeChange) {
    hasFieldChanges = fields.some((field) => String(parameters[field.id] ?? '') !== String(activeParameters[field.id] ?? ''));
  } else {
    hasFieldChanges = Boolean(fields.length);
  }

  let missingRequired = fields.some((field) => {
    if (!field.required) return false;
    const value = parameters[field.id] ?? state.config.mediaProvider?.options?.[field.id];
    if (field.inputType === 'checkbox') {
      return !value;
    }
    return !String(value ?? '').trim();
  });
  if (providerTypeId === 'musicassistant') {
    const hostValue = parameters.ip || parameters.host || parameters.hostname || parameters.address;
    if (hostValue && String(hostValue).trim()) {
      missingRequired = false;
    }
  }

  const providerHasChanges = hasTypeChange || hasFieldChanges;
  const isDummyProvider = providerTypeId === 'dummy';
  const canConnectProvider = isDummyProvider || !missingRequired;
  const connectButtonAttrs = canConnectProvider ? '' : 'disabled aria-disabled="true"';
  const connectButtonText = canConnectProvider ? 'Connect provider' : 'Fill in required fields';
  const connectButtonHint = !canConnectProvider
    ? '<p class="zones-provider-card__hint zones-provider-card__hint--warning">Complete all required fields to enable Connect.</p>'
    : '';

  const providerDescription = describeProviderType(providerTypeLegacy);
  const providerLabel = formatProviderLabel(providerTypeLegacy);
  const providerSelectOptions = providerOptions.map((meta) => ({
    value: meta.legacyName || meta.id || meta.type,
    label: meta.label || formatProviderLabel(meta.id || meta.type || meta.legacyName || ''),
  }));
  const providerSelect = renderSelect('provider-type', 'Provider', providerSelectOptions, providerMeta?.legacyName || providerMeta?.id || providerMeta?.type || '', 'class="zones-provider-card__select-field"');

  const guidance = providerDescription
    ? 'Configure this provider to expose sources to every zone.'
    : 'Select a provider and press Connect to apply the configuration.';
  let activeStatusTone = 'success';
  let activeStatusMessage = 'Serving zones using this provider.';
  if (!activeProviderTypeId || activeProviderTypeId === 'dummy') {
    activeStatusTone = 'warning';
    activeStatusMessage = 'No provider connected.';
  } else if (activeFields.some((field) => field.required && !String(activeParameters[field.id] ?? '').trim())) {
    activeStatusTone = 'warning';
    activeStatusMessage = 'Saved provider may be missing required details.';
  }

  const changeChip = providerHasChanges ? '<span class="zones-provider-card__chip">Unsaved changes</span>' : '';

  return `
    <section class="zones-provider-card">
      <header class="zones-provider-card__header">
        <div class="zones-provider-card__title">
          <h3>Media Provider</h3>
          <p>Expose sources to every zone by configuring a global media provider.</p>
        </div>
        <span class="zones-provider-card__status zones-provider-card__status--${activeStatusTone}">
          ${escapeHtml(activeStatusMessage)}
        </span>
      </header>
      <div class="zones-provider-card__body">
        <div class="zones-provider-card__form">
          <div class="zones-provider-card__select">
            ${providerSelect}
            ${changeChip}
          </div>
          <div class="zones-provider-card__fields" data-provider-fields="true">
            ${fieldsHtml}
          </div>
          <div class="zones-provider-card__actions">
            <button type="button" class="primary" id="provider-connect" ${connectButtonAttrs}>${connectButtonText}</button>
          </div>
          ${connectButtonHint}
        </div>
        <aside class="zones-provider-card__summary">
          <div class="zones-provider-card__summary-header">
            <span class="zones-provider-card__summary-badge">Provider</span>
            <h4 class="zones-provider-card__summary-title">${escapeHtml(providerLabel)}</h4>
          </div>
          <p class="zones-provider-card__summary-copy">${escapeHtml(providerDescription)}</p>
          <p class="zones-provider-card__summary-hint">${escapeHtml(guidance)}</p>
        </aside>
      </div>
    </section>
  `;
}

function renderProviderField(field, parameters, discoveryState = {}) {
  if (!field || typeof field !== 'object') return '';
  const fieldId = `provider-field-${field.id}`;
  const rawValue = parameters[field.id];
  const isCheckbox = field.inputType === 'checkbox';
  const isNumber = field.inputType === 'number';
  let value = rawValue;
  if (isCheckbox) {
    value = typeof rawValue === 'boolean' ? rawValue : Boolean(field.defaultValue);
  } else if (rawValue === undefined || rawValue === null || rawValue === '') {
    value = field.defaultValue ?? '';
  }
  const requiredIndicator = field.required ? ' *' : '';
  const helpText = field.helpText ? `<p class="provider-field__hint">${escapeHtml(field.helpText)}</p>` : '';
  const baseAttrs = [`data-provider-field="${field.id}"`, field.required ? 'data-required="true"' : ''];
  const placeholderAttr = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : '';
  const discovery = discoveryState || {};

  if (field.inputType === 'checkbox') {
    return `
      <div class="provider-field provider-field--checkbox" data-provider-field-wrapper="${field.id}" data-field-type="checkbox">
        <label class="provider-field-checkbox" for="${fieldId}">
          <input id="${fieldId}" type="checkbox" ${value ? 'checked' : ''} ${baseAttrs.join(' ').trim()} />
          <span>${escapeHtml(field.label)}${requiredIndicator}</span>
        </label>
        ${helpText}
      </div>
    `;
  }

  if (field.inputType === 'select') {
    const options = Array.isArray(field.options) ? field.options : [];
    const optionHtml = options
      .map((option) => {
        const optionValue = typeof option === 'object' ? option.value : option;
        const optionLabel = typeof option === 'object' ? option.label : option;
        const selected = optionValue === value;
        return `<option value="${escapeHtml(optionValue)}" ${selected ? 'selected' : ''}>${escapeHtml(optionLabel || optionValue)}</option>`;
      })
      .join('');
    const placeholderOption = field.required ? '' : '<option value="">None</option>';
    return `
      <div class="form-control provider-field" data-provider-field-wrapper="${field.id}" data-field-type="select">
        <label for="${fieldId}">${escapeHtml(field.label)}${requiredIndicator}</label>
        <select id="${fieldId}" ${baseAttrs.join(' ').trim()}>
          ${placeholderOption}
          ${optionHtml}
        </select>
        ${helpText}
      </div>
    `;
  }

  if (field.inputType === 'discoveredSelect') {
    const options = Array.isArray(discovery.options) ? discovery.options : [];
    const loading = Boolean(discovery.loading);
    const discoveryError = discovery.error ? `<p class="provider-field__error">${escapeHtml(discovery.error)}</p>` : '';
    const requires = Array.isArray(field.discovery?.requires) ? field.discovery.requires : [];
    const selectOptions = [{ value: '', label: 'Select a value' }];
    options.forEach((option) => {
      if (!option || typeof option !== 'object') return;
      selectOptions.push({ value: option.value, label: option.label });
    });
    const hasSelectedOption = selectOptions.some((option) => option.value === value);
    if (!hasSelectedOption && value) {
      selectOptions.push({ value, label: String(value) });
    }
    const optionsHtml = selectOptions
      .map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`)
      .join('');
    const requiresAttr = requires.length ? `data-provider-discovery-requires="${requires.map((dep) => dep.trim()).join(',')}"` : '';
    const buttonDisabled = loading ? 'disabled aria-disabled="true"' : '';
    const discoveryType = field.discovery?.type || '';
    return `
      <div class="form-control provider-field provider-field--discovered" data-provider-field-wrapper="${field.id}" data-field-type="discoveredSelect">
        <label for="${fieldId}">${escapeHtml(field.label)}${requiredIndicator}</label>
        <div class="provider-field__inline">
          <select id="${fieldId}" ${baseAttrs.join(' ').trim()}>
            ${optionsHtml}
          </select>
          <button type="button" class="tertiary provider-field__discover" data-provider-discovery="${field.id}" data-provider-discovery-type="${escapeHtml(discoveryType)}" ${requiresAttr} ${buttonDisabled}>${loading ? 'Scanning…' : 'Scan'}</button>
        </div>
        ${helpText}
        ${discoveryError}
      </div>
    `;
  }

  const inputType = isNumber ? 'text' : (field.inputType || 'text');
  const extraAttrs = [
    ...baseAttrs,
    placeholderAttr,
    isNumber ? 'inputmode="numeric"' : '',
  ].filter(Boolean).join(' ');
  const inputValue = value == null ? '' : String(value);
  return `
    <div class="form-control provider-field" data-provider-field-wrapper="${field.id}" data-field-type="${escapeHtml(field.inputType || 'text')}">
      ${renderInput(fieldId, `${field.label}${requiredIndicator}`, inputValue, inputType, false, extraAttrs)}
      ${helpText}
    </div>
  `;
}

function setProviderOption(fieldId, value) {
  state.config.mediaProvider = state.config.mediaProvider || { type: '', options: {} };
  const options = state.config.mediaProvider.options = state.config.mediaProvider.options || {};
  if (value === '' || value === null || value === undefined) {
    delete options[fieldId];
  } else {
    options[fieldId] = value;
  }
}

function bindProviderEvents() {
  const providerSelectEl = document.getElementById('provider-type');
  if (providerSelectEl instanceof HTMLSelectElement) {
    providerSelectEl.addEventListener('change', (event) => {
      const value = event.target.value;
      const meta = findProviderMeta(value);
      const legacyName = meta?.legacyName || value || 'DummyProvider';
      state.config.mediaProvider.type = legacyName;
      state.config.mediaProvider.options = {};
      state.providerDiscovery = {};
      render();
    });
  }

  document.querySelectorAll('[data-provider-field]').forEach((element) => {
    const fieldId = element.getAttribute('data-provider-field');
    if (!fieldId) return;
    if (element instanceof HTMLInputElement) {
      const handler = () => {
        if (element.type === 'checkbox') {
          setProviderOption(fieldId, element.checked);
        } else {
          setProviderOption(fieldId, element.value);
        }
      };
      element.addEventListener('input', handler);
      element.addEventListener('change', handler);
    } else if (element instanceof HTMLSelectElement) {
      element.addEventListener('change', (event) => {
        setProviderOption(fieldId, event.target.value);
      });
    }
  });

  document.querySelectorAll('[data-provider-discovery]').forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    const fieldId = button.getAttribute('data-provider-discovery');
    if (!fieldId) return;
    button.addEventListener('click', () => {
      runProviderDiscovery(fieldId).catch((error) => {
        console.error('Provider discovery failed', error);
      });
    });
  });
}

async function runProviderDiscovery(fieldId) {
  const fields = getProviderFields(state.config.mediaProvider?.type);
  const field = fields.find((entry) => entry.id === fieldId);
  if (!field || field.inputType !== 'discoveredSelect' || !field.discovery) return;
  updateProviderDiscoveryState(fieldId, { loading: true, error: '' });
  render();
  try {
    updateProviderDiscoveryState(fieldId, { options: [], loading: false, error: 'No discovery handler registered.' });
  } catch (error) {
    updateProviderDiscoveryState(fieldId, { loading: false, error: error instanceof Error ? error.message : String(error) });
  }
  render();
}

function updateProviderDiscoveryState(fieldId, patch = {}) {
  state.providerDiscovery = state.providerDiscovery || {};
  const current = state.providerDiscovery[fieldId] || {};
  state.providerDiscovery[fieldId] = {
    options: [],
    loading: false,
    error: '',
    ...current,
    ...patch,
  };
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
      ? 'Assign an adapter to enable playback.'
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

function renderAdapterModal() {
  const modalState = state.modal || {};
  const open = Boolean(modalState.open && typeof modalState.zoneId === 'number');
  if (typeof document !== 'undefined') {
    document.body.classList.toggle('modal-open', open);
  }
  if (!open) {
    return '<div id="adapter-modal" class="adapter-modal adapter-modal--hidden" aria-hidden="true"></div>';
  }

  const zone = state.config?.zones.find((z) => z.id === modalState.zoneId);
  if (!zone) {
    if (typeof document !== 'undefined') document.body.classList.remove('modal-open');
    resetModalState();
    return '<div id="adapter-modal" class="adapter-modal adapter-modal--hidden" aria-hidden="true"></div>';
  }

  const adapterOptions = getAdapterOptions();
  const currentAdapter = getZoneAdapter(zone);
  const selectedAdapterType = modalState.adapterType || currentAdapter.type || adapterOptions[0]?.id || 'null';
  const normalizedAdapterType = normalizeAdapterType(selectedAdapterType);
  const adapterFields = getAdapterFields(normalizedAdapterType);
  const adapterMeta = findAdapterMeta(normalizedAdapterType);
  const parameters = {
    ...normalizeAdapterParametersOutput(currentAdapter.parameters || {}),
    ...(modalState.parameters || {}),
  };

  updateModalState({
    adapterType: normalizedAdapterType,
    parameters,
  });

  const modalError = typeof modalState.error === 'string' ? modalState.error.trim() : '';
  const zoneDisplayName = (zone.name ?? '').trim();
  const summaryZoneName = zoneDisplayName || `Zone ${zone.id}`;

  const adapterOptionsValues = adapterOptions.map((option) => {
    const value = option.id ?? option.type ?? '';
    const label = option.label ?? formatAdapterLabel(value);
    return { value, label };
  });
  const adapterSelect = renderSelect(
    'adapter-type',
    'Adapter',
    adapterOptionsValues,
    normalizedAdapterType,
    'class="adapter-modal__select"'
  );

  const discoveryState = modalState.discovery || {};
  const fieldsHtml = adapterFields
    .map((field) => renderAdapterField(field, parameters, discoveryState[field.id]))
    .join('');

  const supportsContentPlayback = adapterSupportsContentPlayback(normalizedAdapterType);
  const allContentPlayers = getContentPlayerOptions();
  const activeProviderTypeId = normalizeProviderType(state.config.mediaProvider?.type || '');
  const hasActiveProvider = Boolean(activeProviderTypeId && activeProviderTypeId !== 'dummy');
  const compatibleContentPlayers = hasActiveProvider ? allContentPlayers.filter((player) => {
    const providerType = normalizeProviderType(player.providerType || player.baseType || '');
    return providerType && providerType === activeProviderTypeId;
  }) : [];
  const beolinkContentOptions = compatibleContentPlayers.filter((player) => normalizeAdapterType(player.adapterType || player.id || '') === 'musicassistant');
  const shouldRestrictContentAdapter = normalizedAdapterType === 'beolink';
  let contentAdapterHost = typeof modalState.contentAdapterHost === 'string' ? modalState.contentAdapterHost : '';
  if (!contentAdapterHost) {
    contentAdapterHost = shouldRestrictContentAdapter
      ? resolveMusicAssistantHost(null)
      : resolveMusicAssistantHost(zone);
    if (contentAdapterHost) {
      updateModalState({ contentAdapterHost });
    }
  }
  const cachedContentPlayers = Array.isArray(modalState.contentAdapterPlayers)
    ? modalState.contentAdapterPlayers
    : [];
  const contentPlayersLoading = Boolean(modalState.contentAdapterPlayersLoading);
  const contentPlayersError = typeof modalState.contentAdapterPlayersError === 'string'
    ? modalState.contentAdapterPlayersError.trim()
    : '';

  const selectedContentAdapter = modalState.contentAdapter || zone.contentAdapter?.id || '';
  const contentAdapterPlayerId = modalState.contentAdapterPlayerId || zone.contentAdapter?.playerId || '';
  let contentAdapterHtml = '';
  if (!supportsContentPlayback && compatibleContentPlayers.length) {
    const availableContentPlayers = shouldRestrictContentAdapter ? beolinkContentOptions : compatibleContentPlayers;
    const normalizedSelectedContentAdapter = shouldRestrictContentAdapter ? (beolinkContentOptions.length ? (modalState.contentAdapter || zone.contentAdapter?.id || beolinkContentOptions[0].id) : '') : selectedContentAdapter;
    if (shouldRestrictContentAdapter && modalState.contentAdapter !== normalizedSelectedContentAdapter) {
      updateModalState({
        contentAdapter: normalizedSelectedContentAdapter,
        contentAdapterPlayerId: '',
      });
    }
    const contentOptions = [
      { value: '', label: 'None' },
      ...availableContentPlayers.map((player) => ({ value: player.id, label: player.label })),
    ];
    const contentSelect = renderSelect(
      'adapter-content',
      'Content Player',
      contentOptions,
      normalizedSelectedContentAdapter,
      'class="adapter-modal__select"'
    );
    const selectedContent = availableContentPlayers.find((player) => player.id === normalizedSelectedContentAdapter);
    const description = selectedContent?.description
      ? `<p class="adapter-modal__hint">${escapeHtml(selectedContent.description)}</p>`
      : '<p class="adapter-modal__hint">Optional: choose a content player to handle library playback for this adapter.</p>';

    let contentPlayerField = '';
    if (selectedContent?.requiresPlayerId) {
      const playerOptions = [
        { value: '', label: 'Select a player' },
        ...cachedContentPlayers.map((player) => ({ value: player.id, label: `${player.name} (${player.id})` })),
      ];
      const hasPlayers = cachedContentPlayers.length > 0;
      const resolvedProviderHost = resolveMusicAssistantHost(null);
      const scanHost = shouldRestrictContentAdapter ? resolvedProviderHost : contentAdapterHost;
      const hostHint = scanHost
        ? ''
        : '<p class="adapter-modal__hint">Set the Music Assistant host in the adapter or provider before scanning.</p>';
      const scanDisabledAttr = scanHost && !contentPlayersLoading ? '' : 'disabled aria-disabled="true"';
      const scanLabel = contentPlayersLoading ? 'Scanning…' : (hasPlayers ? 'Rescan players' : 'Scan players');
      const selectAttrs = [
        'class="adapter-modal__select"',
        contentPlayersLoading ? 'disabled aria-disabled="true"' : '',
      ].filter(Boolean).join(' ');
      const selectHtml = renderSelect(
        'adapter-content-player',
        'Music Assistant Player',
        playerOptions,
        contentAdapterPlayerId,
        selectAttrs
      );
      contentPlayerField = `
        <div class="adapter-modal__content-player">
          ${selectHtml}
          <div class="adapter-modal__ma-actions">
            <button type="button" class="tertiary" data-action="adapter-content-scan" data-host="${escapeHtml(scanHost || '')}" ${scanDisabledAttr}>${scanLabel}</button>
          </div>
          ${contentPlayersError ? `<p class="adapter-modal__content-player-error">${escapeHtml(contentPlayersError)}</p>` : ''}
          ${!hasPlayers && contentAdapterHost && !contentPlayersLoading ? '<p class="adapter-modal__hint">No players cached for this host yet. Scan to discover available players.</p>' : ''}
          ${hostHint}
        </div>
      `;
    }

    contentAdapterHtml = `
      <div class="adapter-modal__content">
        ${contentSelect}
        ${description}
        ${contentPlayerField}
      </div>
    `;
  } else if (!supportsContentPlayback && allContentPlayers.length && !compatibleContentPlayers.length) {
    contentAdapterHtml = '<p class="adapter-modal__hint">Configure a compatible media provider to enable content playback selection.</p>';
  }

  const adapterDescription = adapterMeta?.description || '';
  const summaryDescription = adapterDescription
    ? adapterDescription
    : 'Select an adapter to see configuration details and requirements.';

  return `
    <div id="adapter-modal" class="adapter-modal" role="dialog" aria-modal="true" aria-labelledby="adapter-modal-title">
      <div class="adapter-modal__backdrop" data-modal-close="true"></div>
      <div class="adapter-modal__dialog">
        <header class="adapter-modal__header">
          <div>
            <h2 id="adapter-modal-title">Configure ${escapeHtml(summaryZoneName)}</h2>
            <p class="adapter-modal__subtitle">Adjust adapter settings and connection details.</p>
          </div>
          <button type="button" class="adapter-modal__close" data-modal-close="true" aria-label="Close">×</button>
        </header>
        <div class="adapter-modal__body">
          <div class="adapter-modal__layout">
            <aside class="adapter-modal__summary">
              <h3 class="adapter-modal__summary-title">${escapeHtml(formatAdapterLabel(normalizedAdapterType))}</h3>
              <p class="adapter-modal__summary-text">${escapeHtml(summaryDescription)}</p>
              <div class="adapter-modal__summary-zone">
                <span class="adapter-modal__summary-label">Zone</span>
                <span class="adapter-modal__summary-value">${escapeHtml(summaryZoneName)}</span>
                <span class="adapter-modal__summary-meta">ID ${escapeHtml(String(zone.id))}</span>
              </div>
            </aside>
            <div class="adapter-modal__form">
              ${adapterSelect}
              <div class="adapter-modal__fields" data-adapter-fields="true">
                ${fieldsHtml}
              </div>
              ${contentAdapterHtml}
            </div>
          </div>
          ${modalError ? `<div class="adapter-modal__error" role="alert">${escapeHtml(modalError)}</div>` : ''}
        </div>
        <footer class="adapter-modal__footer">
          <button type="button" class="primary" id="adapter-modal-save">Save</button>
          <button type="button" class="secondary" data-modal-close="true">Cancel</button>
        </footer>
      </div>
    </div>
  `;
}

function renderAdapterField(field, parameters, discoveryState = {}) {
  if (!field || typeof field !== 'object') return '';
  const fieldId = `adapter-field-${field.id}`;
  const rawValue = parameters[field.id];
  const isCheckbox = field.inputType === 'checkbox';
  const isNumber = field.inputType === 'number';
  let value = rawValue;
  if (isCheckbox) {
    value = typeof rawValue === 'boolean' ? rawValue : Boolean(field.defaultValue);
  } else if (rawValue === undefined || rawValue === null || rawValue === '') {
    value = field.defaultValue ?? '';
  }
  const requiredIndicator = field.required ? ' *' : '';
  const helpText = field.helpText ? `<p class="adapter-field__hint">${escapeHtml(field.helpText)}</p>` : '';
  const baseAttrs = [`data-adapter-field="${field.id}"`, field.required ? 'data-required="true"' : ''];
  const placeholderAttr = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : '';
  const discovery = discoveryState || {};

  if (field.inputType === 'checkbox') {
    return `
      <div class="adapter-field adapter-field--checkbox" data-field-id="${field.id}" data-field-type="checkbox">
        <label class="adapter-field-checkbox" for="${fieldId}">
          <input id="${fieldId}" type="checkbox" ${value ? 'checked' : ''} ${baseAttrs.join(' ').trim()} />
          <span>${escapeHtml(field.label)}${requiredIndicator}</span>
        </label>
        ${helpText}
      </div>
    `;
  }

  if (field.inputType === 'select') {
    const options = Array.isArray(field.options) ? field.options : [];
    const optionHtml = options
      .map((option) => {
        const optionValue = typeof option === 'object' ? option.value : option;
        const optionLabel = typeof option === 'object' ? option.label : option;
        const selected = optionValue === value;
        return `<option value="${escapeHtml(optionValue)}" ${selected ? 'selected' : ''}>${escapeHtml(optionLabel || optionValue)}</option>`;
      })
      .join('');
    const placeholderOption = field.required ? '' : '<option value="">None</option>';
    return `
      <div class="form-control adapter-field" data-field-id="${field.id}" data-field-type="select">
        <label for="${fieldId}">${escapeHtml(field.label)}${requiredIndicator}</label>
        <select id="${fieldId}" ${baseAttrs.join(' ').trim()}>
          ${placeholderOption}
          ${optionHtml}
        </select>
        ${helpText}
      </div>
    `;
  }

  if (field.inputType === 'discoveredSelect') {
    const options = Array.isArray(discovery.options) ? discovery.options : [];
    const loading = Boolean(discovery.loading);
    const discoveryError = discovery.error ? `<p class="adapter-field__error">${escapeHtml(discovery.error)}</p>` : '';
    const requires = Array.isArray(field.discovery?.requires) ? field.discovery.requires : [];
    const selectOptions = [{ value: '', label: 'Select a value' }];
    options.forEach((option) => {
      if (!option || typeof option !== 'object') return;
      selectOptions.push({ value: option.value, label: option.label });
    });
    const hasSelectedOption = selectOptions.some((option) => option.value === value);
    if (!hasSelectedOption && value) {
      selectOptions.push({ value, label: value });
    }
    const optionsHtml = selectOptions
      .map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`)
      .join('');
    const requiresAttr = requires.length ? `data-discovery-requires="${requires.map((dep) => dep.trim()).join(',')}"` : '';
    const buttonDisabled = loading ? 'disabled aria-disabled="true"' : '';
    const discoveryType = field.discovery?.type || '';
    return `
      <div class="form-control adapter-field adapter-field--discovered" data-field-id="${field.id}" data-field-type="discoveredSelect">
        <label for="${fieldId}">${escapeHtml(field.label)}${requiredIndicator}</label>
        <div class="adapter-field__inline">
          <select id="${fieldId}" ${baseAttrs.join(' ').trim()}>
            ${optionsHtml}
          </select>
          <button type="button" class="tertiary adapter-field__discover" data-discovery-field="${field.id}" data-discovery-type="${escapeHtml(discoveryType)}" ${requiresAttr} ${buttonDisabled}>${loading ? 'Scanning…' : 'Scan'}</button>
        </div>
        ${helpText}
        ${discoveryError}
      </div>
    `;
  }

  const inputType = isNumber ? 'text' : (field.inputType || 'text');
  const extraAttrs = [
    ...baseAttrs,
    placeholderAttr,
    isNumber ? 'inputmode="numeric"' : '',
  ].filter(Boolean).join(' ');
  const inputValue = value == null ? '' : String(value);
  return `
    <div class="form-control adapter-field" data-field-id="${field.id}" data-field-type="${escapeHtml(field.inputType || 'text')}">
      <label for="${fieldId}">${escapeHtml(field.label)}${requiredIndicator}</label>
      <input id="${fieldId}" type="${inputType}" value="${escapeHtml(inputValue)}" ${extraAttrs} />
      ${helpText}
    </div>
  `;
}

function setModalParameter(fieldId, value) {
  const next = { ...(state.modal?.parameters || {}) };
  if (value === '' || value === null || value === undefined) {
    delete next[fieldId];
  } else {
    next[fieldId] = value;
  }
  const updates = { parameters: next, error: '' };
  if (fieldId === 'ip') {
    const normalized = typeof value === 'string' ? value.trim() : '';
    updates.contentAdapterHost = normalized;
    updates.contentAdapterPlayers = [];
    updates.contentAdapterPlayersLoading = false;
    updates.contentAdapterPlayersError = '';
    if (!normalized) {
      updates.contentAdapterPlayerId = '';
    }
  }
  updateModalState(updates);
}

function updateDiscoveryState(fieldId, patch = {}) {
  const current = state.modal?.discovery || {};
  const next = {
    ...current,
    [fieldId]: {
      options: [],
      loading: false,
      error: '',
      ...(current[fieldId] || {}),
      ...patch,
    },
  };
  updateModalState({ discovery: next });
}

function openAdapterModal(zoneId) {
  const zone = state.config?.zones.find((z) => z.id === zoneId);
  if (!zone) return;
  const adapter = getZoneAdapter(zone);
  const adapterType = normalizeAdapterType(adapter.type);
  const parameters = normalizeAdapterParametersOutput(adapter.parameters || {});
  const cache = ensureMusicAssistantCache();
  if (typeof parameters.ip === 'string' && parameters.ip) {
    cache.lastIP = parameters.ip.trim();
  }

  const discovery = {};
  if (adapterType === 'musicassistant') {
    const ip = String(parameters.ip || cache.lastIP || cache.providerHost || '').trim();
    if (ip) {
      const cachedPlayers = cache.playersByIp?.[ip];
      if (Array.isArray(cachedPlayers) && cachedPlayers.length) {
        discovery.maPlayerId = {
          options: cachedPlayers.map((player) => ({ value: player.id, label: `${player.name} (${player.id})` })),
          loading: false,
          error: '',
        };
        if (!parameters.maPlayerId && cachedPlayers.length === 1) {
          parameters.maPlayerId = cachedPlayers[0].id;
        }
      }
    }
    if (!parameters.ip) {
      const fallbackIp = cache.lastIP || cache.providerHost || '';
      if (fallbackIp) parameters.ip = fallbackIp;
    }
  }

  const contentAdapterHost = resolveMusicAssistantHost(zone);
  const cachedContentPlayers = contentAdapterHost
    ? (cache.playersByIp?.[contentAdapterHost] || [])
    : [];

  updateModalState({
    open: true,
    zoneId,
    adapterType,
    parameters,
    discovery,
    contentAdapter: zone.contentAdapter?.id || '',
    contentAdapterPlayerId: zone.contentAdapter?.playerId || '',
    contentAdapterPlayers: cachedContentPlayers,
    contentAdapterHost,
    contentAdapterPlayersLoading: false,
    contentAdapterPlayersError: '',
    error: '',
  });
  if (contentAdapterHost && !cachedContentPlayers.length) {
    scanContentAdapterPlayers({ host: contentAdapterHost, autoSelect: true, silent: true }).catch((error) => {
      console.error('Auto discovery of content players failed', error);
    });
  }
  scheduleRender();
}

function closeAdapterModal(shouldRender = true) {
  resetModalState();
  if (typeof document !== 'undefined') {
    document.body.classList.remove('modal-open');
  }
  if (shouldRender) render();
}

function bindAdapterModalEvents() {
  const modal = document.getElementById('adapter-modal');
  if (!(modal instanceof HTMLElement)) return;
  if (!state.modal.open) return;

  const adapterSelectEl = modal.querySelector('#adapter-type');
  if (adapterSelectEl instanceof HTMLSelectElement) {
    adapterSelectEl.addEventListener('change', (event) => {
      const nextType = normalizeAdapterType(event.target.value);
      updateModalState({
        adapterType: nextType,
        parameters: {},
        discovery: {},
        contentAdapter: '',
        contentAdapterPlayerId: '',
        contentAdapterPlayers: [],
        contentAdapterHost: '',
        contentAdapterPlayersLoading: false,
        contentAdapterPlayersError: '',
        error: '',
      });
      const cache = ensureMusicAssistantCache();
      const zone = state.config?.zones.find((z) => z.id === state.modal.zoneId);
      let reusedExistingAdapter = false;
      let autoScanHost = '';
      if (zone) {
        const adapter = getZoneAdapter(zone);
        if (nextType === adapter.type) {
          const host = resolveMusicAssistantHost(zone);
          const cachedPlayers = host
            ? (cache.playersByIp?.[host] || [])
            : [];
          updateModalState({
            parameters: normalizeAdapterParametersOutput(adapter.parameters || {}),
            contentAdapter: zone.contentAdapter?.id || '',
            contentAdapterPlayerId: zone.contentAdapter?.playerId || '',
            contentAdapterHost: host,
            contentAdapterPlayers: cachedPlayers,
            contentAdapterPlayersLoading: false,
            contentAdapterPlayersError: '',
          });
          reusedExistingAdapter = true;
        } else if (nextType === 'musicassistant') {
          autoScanHost = resolveMusicAssistantHost(zone) || '';
        }
      } else if (nextType === 'musicassistant') {
        autoScanHost = resolveMusicAssistantHost(null) || '';
      }

      if (!reusedExistingAdapter && nextType === 'musicassistant') {
        const normalizedHost = autoScanHost.trim() || cache.lastIP || cache.providerHost || '';
        const adapterFields = getAdapterFields(nextType);
        const defaultParameters = {};
        adapterFields.forEach((field) => {
          if (!field || !field.id) return;
          if (field.inputType === 'checkbox') {
            defaultParameters[field.id] = Boolean(field.defaultValue);
          } else if (field.defaultValue !== undefined && field.defaultValue !== null && field.defaultValue !== '') {
            defaultParameters[field.id] = String(field.defaultValue);
          }
        });
        if (normalizedHost) {
          defaultParameters.ip = normalizedHost;
          cache.lastIP = normalizedHost;
        }
        const cachedPlayers = normalizedHost
          ? (cache.playersByIp?.[normalizedHost] || [])
          : [];
        if (cachedPlayers.length === 1 && !defaultParameters.maPlayerId) {
          defaultParameters.maPlayerId = cachedPlayers[0].id;
        }
        const discovery = cachedPlayers.length
          ? {
              maPlayerId: {
                options: toMusicAssistantDiscoveryOptions(cachedPlayers),
                loading: false,
                error: '',
              },
            }
          : {};
        const cachedContentPlayers = normalizedHost
          ? (cache.playersByIp?.[normalizedHost] || [])
          : [];
        updateModalState({
          parameters: defaultParameters,
          discovery,
          contentAdapterHost: normalizedHost,
          contentAdapterPlayers: cachedContentPlayers,
          contentAdapterPlayersLoading: false,
          contentAdapterPlayersError: '',
        });
        autoScanHost = cachedContentPlayers.length ? '' : normalizedHost;
      }
      render();
      if (!reusedExistingAdapter && nextType === 'musicassistant' && autoScanHost) {
        scanContentAdapterPlayers({ host: autoScanHost, autoSelect: true, silent: true }).catch((error) => {
          console.error('Automatic Music Assistant player discovery failed', error);
        });
      }
    });
  }

  modal.querySelectorAll('[data-adapter-field]').forEach((element) => {
    const fieldId = element.getAttribute('data-adapter-field');
    if (!fieldId) return;
    if (element instanceof HTMLInputElement) {
      const handler = (evt) => {
        const previousHost = state.modal?.contentAdapterHost || '';
        if (element.type === 'checkbox') {
          setModalParameter(fieldId, element.checked);
        } else {
          setModalParameter(fieldId, element.value);
        }
        if (fieldId === 'ip') {
          const adapterType = normalizeAdapterType(state.modal?.adapterType || '');
          const nextHost = state.modal?.contentAdapterHost || '';
          if (
            adapterType === 'musicassistant'
            && nextHost
            && nextHost !== previousHost
            && evt?.type === 'change'
          ) {
            scanContentAdapterPlayers({ host: nextHost, autoSelect: true, silent: true }).catch((error) => {
              console.error('Automatic Music Assistant player discovery failed', error);
            });
          }
        }
      };
      element.addEventListener('input', handler);
      element.addEventListener('change', handler);
    } else if (element instanceof HTMLSelectElement) {
      element.addEventListener('change', (event) => {
        setModalParameter(fieldId, event.target.value);
        if (fieldId === 'ip') {
          const adapterType = normalizeAdapterType(state.modal?.adapterType || '');
          const nextHost = (event.target.value || '').trim();
          if (adapterType === 'musicassistant' && nextHost) {
            scanContentAdapterPlayers({ host: nextHost, autoSelect: true, silent: true }).catch((error) => {
              console.error('Automatic Music Assistant player discovery failed', error);
            });
          }
        }
      });
    }
  });

  modal.querySelectorAll('[data-discovery-field]').forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    const fieldId = button.getAttribute('data-discovery-field');
    if (!fieldId) return;
    button.addEventListener('click', () => {
      runAdapterDiscovery(fieldId).catch((error) => {
        console.error('Discovery failed', error);
      });
    });
  });

  const contentSelectEl = modal.querySelector('#adapter-content');
  if (contentSelectEl instanceof HTMLSelectElement) {
    contentSelectEl.addEventListener('change', (event) => {
      const value = event.target.value;
      const previousAdapterId = state.modal?.contentAdapter || '';
      const meta = findContentPlayerMeta(value);
      const requiresPlayer = Boolean(meta?.requiresPlayerId);
      const patch = {
        contentAdapter: value,
        contentAdapterPlayersError: '',
        error: '',
      };
      if (!requiresPlayer || value !== previousAdapterId) {
        patch.contentAdapterPlayerId = '';
      }
      if (!requiresPlayer) {
        patch.contentAdapterPlayersLoading = false;
      }
      updateModalState(patch);
      render();
      if (requiresPlayer) {
        const host = (state.modal?.contentAdapterHost || '').trim();
        const hasPlayers = Array.isArray(state.modal?.contentAdapterPlayers)
          && state.modal.contentAdapterPlayers.length > 0;
        if (host && !hasPlayers) {
          scanContentAdapterPlayers({ host, autoSelect: true, silent: true }).catch((error) => {
            console.error('Automatic Music Assistant player discovery failed', error);
          });
        }
      }
    });
  }

  const contentPlayerInputEl = modal.querySelector('#adapter-content-player');
  if (contentPlayerInputEl instanceof HTMLInputElement) {
    contentPlayerInputEl.addEventListener('input', (event) => {
      updateModalState({
        contentAdapterPlayerId: event.target.value,
        contentAdapterPlayersError: '',
      });
    });
  }

  modal.querySelectorAll('[data-action="adapter-content-scan"]').forEach((element) => {
    if (!(element instanceof HTMLButtonElement)) return;
    element.addEventListener('click', () => {
      const host = element.getAttribute('data-host') || '';
      scanContentAdapterPlayers({ host, autoSelect: false, silent: false }).catch((error) => {
        console.error('Manual Music Assistant player discovery failed', error);
      });
    });
  });

  modal.querySelectorAll('[data-modal-close="true"]').forEach((element) => {
    element.addEventListener('click', () => closeAdapterModal());
  });

  const saveButton = modal.querySelector('#adapter-modal-save');
  if (saveButton instanceof HTMLButtonElement) {
    saveButton.addEventListener('click', (event) => {
      event.preventDefault();
      saveAdapterModal().catch((error) => {
        console.error('Failed to save adapter configuration', error);
        setStatus(`Failed to save adapter configuration: ${error instanceof Error ? error.message : String(error)}`, true);
      });
    });
  }
}

async function runAdapterDiscovery(fieldId) {
  const modalState = state.modal || {};
  const adapterType = normalizeAdapterType(modalState.adapterType || 'null');
  const fields = getAdapterFields(adapterType);
  const field = fields.find((entry) => entry.id === fieldId);
  if (!field || field.inputType !== 'discoveredSelect' || !field.discovery) {
    return;
  }

  const discoveryType = field.discovery.type;
  if (!discoveryType) return;
  const requires = Array.isArray(field.discovery.requires) ? field.discovery.requires : [];
  const parameters = modalState.parameters || {};

  for (const dependency of requires) {
    const value = parameters[dependency];
    if (!value || !String(value).trim()) {
      updateModalState({ error: `Set ${dependency} before scanning.` });
      render();
      return;
    }
  }

  updateDiscoveryState(fieldId, { loading: true, error: '' });
  render();

  try {
    if (discoveryType === 'musicassistantPlayers') {
      const ip = String(parameters.ip || '').trim();
      if (!ip) {
        updateDiscoveryState(fieldId, { loading: false, error: 'Enter the Music Assistant host before scanning.' });
        render();
        return;
      }
      const data = await fetchMusicAssistantPlayersApi({ ip, zoneId: modalState.zoneId });
      const players = Array.isArray(data.players) ? data.players : [];
      const options = players.map((player) => ({
        value: player.id,
        label: `${player.name} (${player.id})`,
      }));
      updateDiscoveryState(fieldId, { options, loading: false, error: '' });
      const cache = ensureMusicAssistantCache();
      cache.playersByIp[ip] = players.map((player) => ({ id: player.id, name: player.name }));
      cache.lastIP = ip;
      if (!parameters[fieldId] && options.length === 1) {
        setModalParameter(fieldId, options[0].value);
      }
      setStatus(`Loaded ${options.length} Music Assistant players.`);
    } else {
      updateDiscoveryState(fieldId, { loading: false, error: 'Unsupported discovery type.' });
    }
  } catch (error) {
    updateDiscoveryState(fieldId, {
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error('Adapter discovery failed', error);
  }
  render();
}

async function scanContentAdapterPlayers({ host = '', autoSelect = false, silent = false } = {}) {
  const modalState = state.modal || {};
  if (!modalState.open) return;
  const trimmedHost = typeof host === 'string' && host.trim()
    ? host.trim()
    : (typeof modalState.contentAdapterHost === 'string' ? modalState.contentAdapterHost.trim() : '');
  const zone = state.config?.zones.find((z) => z.id === modalState.zoneId) || null;
  const resolvedHost = trimmedHost || resolveMusicAssistantHost(zone);

  if (!resolvedHost) {
    updateModalState({
      contentAdapterPlayersLoading: false,
      contentAdapterPlayersError: 'Enter the Music Assistant host before scanning.',
    });
    if (!silent) {
      setStatus('Enter the Music Assistant host before scanning.', true);
      render();
    } else {
      render();
    }
    return;
  }

  updateModalState({
    contentAdapterHost: resolvedHost,
    contentAdapterPlayersLoading: true,
    contentAdapterPlayersError: '',
  });
  render();

  try {
    const payload = await fetchMusicAssistantPlayersApi({ ip: resolvedHost, zoneId: modalState.zoneId });
    const playersRaw = Array.isArray(payload?.players) ? payload.players : [];
    const normalizedPlayers = playersRaw
      .map((player) => {
        const id = typeof player?.id === 'string' ? player.id.trim() : String(player?.id ?? '').trim();
        if (!id) return null;
        const name = typeof player?.name === 'string' && player.name.trim()
          ? player.name.trim()
          : id;
        return { id, name };
      })
      .filter(Boolean);

    const cache = ensureMusicAssistantCache();
    cache.playersByIp[resolvedHost] = normalizedPlayers;
    cache.lastIP = resolvedHost;

    const modalParameters = { ...(state.modal?.parameters || {}) };
    const currentAdapterPlayer = typeof modalParameters.maPlayerId === 'string'
      ? modalParameters.maPlayerId
      : '';
    const adapterHasCurrent = currentAdapterPlayer
      ? normalizedPlayers.some((player) => player.id === currentAdapterPlayer)
      : false;
    if (!adapterHasCurrent) {
      if (autoSelect && normalizedPlayers.length === 1) {
        modalParameters.maPlayerId = normalizedPlayers[0].id;
      } else {
        delete modalParameters.maPlayerId;
      }
    }

    const currentContentSelection = state.modal?.contentAdapterPlayerId || '';
    const contentHasCurrent = currentContentSelection
      ? normalizedPlayers.some((player) => player.id === currentContentSelection)
      : false;
    let nextContentSelection = currentContentSelection;
    if (!contentHasCurrent) {
      if (autoSelect && normalizedPlayers.length === 1) {
        nextContentSelection = normalizedPlayers[0].id;
      } else {
        nextContentSelection = '';
      }
    }

    const discovery = state.modal?.discovery || {};
    const nextDiscovery = {
      ...discovery,
      maPlayerId: {
        options: toMusicAssistantDiscoveryOptions(normalizedPlayers),
        loading: false,
        error: '',
      },
    };

    const nextState = {
      contentAdapterPlayers: normalizedPlayers,
      contentAdapterPlayersLoading: false,
      contentAdapterPlayersError: '',
      contentAdapterPlayerId: nextContentSelection,
      discovery: nextDiscovery,
      parameters: modalParameters,
    };
    updateModalState(nextState);
    if (!silent) {
      setStatus(`Loaded ${normalizedPlayers.length} Music Assistant players.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateModalState({
      contentAdapterPlayersLoading: false,
      contentAdapterPlayersError: message || 'Failed to load players.',
    });
    if (!silent) {
      setStatus(`Player discovery failed: ${message}`, true);
    }
    console.error('Content adapter discovery failed', error);
  }
  render();
}

async function saveAdapterModal() {
  const modalState = state.modal || {};
  if (!modalState.open || typeof modalState.zoneId !== 'number') {
    closeAdapterModal();
    return;
  }
  const zone = state.config?.zones.find((z) => z.id === modalState.zoneId);
  if (!zone) {
    closeAdapterModal();
    return;
  }

  const adapterType = normalizeAdapterType(modalState.adapterType || getZoneAdapter(zone).type);
  const parameters = { ...(modalState.parameters || {}) };
  const adapterFields = getAdapterFields(adapterType);
  let providerNeedsSave = false;
  let providerSaveMessage = '';

  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value === 'string') {
      parameters[key] = value.trim();
    }
  }

  for (const field of adapterFields) {
    if (!field || !field.required) continue;
    const value = parameters[field.id];
    const isCheckbox = field.inputType === 'checkbox';
    if (isCheckbox && value === true) continue;
    if (isCheckbox && !value) {
      updateModalState({ error: `Enable ${field.label} or choose a different adapter.` });
      render();
      return;
    }
    if (value === undefined || value === null || String(value).trim() === '') {
      updateModalState({ error: `Fill in ${field.label} before saving.` });
      render();
      return;
    }
  }

  if (adapterType === 'musicassistant') {
    if (!parameters.ip || !String(parameters.ip).trim()) {
      updateModalState({ error: 'Enter the Music Assistant host before saving.' });
      render();
      return;
    }
    if (!parameters.maPlayerId || !String(parameters.maPlayerId).trim()) {
      updateModalState({ error: 'Select a Music Assistant player before saving.' });
      render();
      return;
    }
  }

  const supportsContentPlayback = adapterSupportsContentPlayback(adapterType);
  const modalContentAdapter = modalState.contentAdapter || '';
  const contentAdapterPlayerId = modalState.contentAdapterPlayerId || '';

  if (supportsContentPlayback) {
    delete parameters.contentadapter;
  } else if (modalContentAdapter) {
    const baseType = fromContentAdapterSelectId(modalContentAdapter);
    if (baseType) {
      const contentConfig = { type: baseType };
      if (contentAdapterPlayerId) {
        contentConfig.playerid = String(contentAdapterPlayerId).trim();
      }
      parameters.contentadapter = contentConfig;
    }
  } else {
    delete parameters.contentadapter;
  }

  Object.keys(parameters).forEach((key) => {
    const val = parameters[key];
    if (val === '' || val === null || val === undefined) {
      delete parameters[key];
    }
  });

  if (adapterType !== 'null') {
    try {
      setStatus('Adapterconfiguratie valideren…');
      await validateAdapterConfig(adapterType, { ...parameters });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateModalState({ error: message });
      render();
      setStatus(`Adapter validatie mislukt: ${message}`, true);
      return;
    }
  }

  zone.adapter = {
    type: adapterType,
    parameters,
  };

  state.zoneStatus = state.zoneStatus || {};
  Object.values(state.zoneStatus).forEach((entry) => {
    if (!entry) return;
    entry.recentlySaved = false;
  });

  if (!supportsContentPlayback && modalContentAdapter) {
    zone.contentAdapter = {
      id: modalContentAdapter,
      playerId: contentAdapterPlayerId || '',
    };
  } else {
    delete zone.contentAdapter;
  }

  state.zoneStatus = state.zoneStatus || {};
  const previousStatus = state.zoneStatus[zone.id] || {};
  state.zoneStatus[zone.id] = {
    id: zone.id,
    adapterType,
    connected: false,
    name: zone.name ?? '',
    connectError: '',
    sourceKey: previousStatus.sourceKey,
    sourceLabel: previousStatus.sourceLabel,
    recentlySaved: true,
  };

  if (adapterType === 'musicassistant' && parameters.ip) {
    const cache = ensureMusicAssistantCache();
    const trimmedIp = String(parameters.ip).trim();
    cache.lastIP = trimmedIp;
    const discovery = state.modal?.discovery?.maPlayerId;
    if (discovery && Array.isArray(discovery.options)) {
      cache.playersByIp[trimmedIp] = discovery.options.map((option) => ({
        id: option.value,
        name: option.label.replace(/\s*\([^)]*\)\s*$/, ''),
      }));
    }

    const providerMeta = findProviderMeta('musicassistant');
    if (providerMeta) {
      const providerTypeId = normalizeProviderType(state.config.mediaProvider?.type || '');
      const providerParameters = normalizeProviderParameters(providerMeta, state.config.mediaProvider?.options || {});
      if (providerTypeId !== 'musicassistant') {
        if (window.confirm?.('Use this Music Assistant host for the media provider as well?')) {
          state.config.mediaProvider.type = providerMeta.legacyName || 'MusicAssistantProvider';
          state.config.mediaProvider.options = {
            ...providerParameters,
            ip: trimmedIp,
            port: providerParameters.port || '8095',
          };
          providerNeedsSave = true;
          providerSaveMessage = 'Music Assistant provider configuration saved.';
        }
      } else if (providerParameters.ip && providerParameters.ip !== trimmedIp) {
        if (window.confirm?.('Update the Music Assistant provider host to match this zone?')) {
          state.config.mediaProvider.options = {
            ...providerParameters,
            ip: trimmedIp,
          };
          providerNeedsSave = true;
          providerSaveMessage = 'Music Assistant provider host updated.';
        }
      }
    }
  }

  if (providerNeedsSave) {
    try {
      await saveConfig(state.config);
    } catch (error) {
      setStatus(`Failed to save Music Assistant provider configuration: ${error instanceof Error ? error.message : String(error)}`, true);
      return;
    }
    if (!providerSaveMessage) {
      providerSaveMessage = 'Music Assistant provider configuration saved.';
    }
  }

  closeAdapterModal(false);
  render();
  const statusPrefix = providerNeedsSave && providerSaveMessage ? `${providerSaveMessage} ` : '';
  setStatus(`${statusPrefix}Saved configuration for zone ${zone.id}. Connecting…`);
  await connectZone(zone.id);
}

function bindFormEvents() {
  if (!state.config) return;

  document.querySelectorAll('[data-action="configure-zone"]').forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    button.addEventListener('click', () => {
      const zoneId = Number(button.getAttribute('data-id'));
      if (Number.isNaN(zoneId)) return;
      openAdapterModal(zoneId);
    });
  });

  document.getElementById('audioserver-ip')?.addEventListener('input', (event) => {
    if (!state.config) return;
    const audioserver = state.config.audioserver = state.config.audioserver || {};
    audioserver.ip = event.target.value;
    scheduleRender();
  });

  bindLoggingEvents();
  bindActions();
  bindLogEvents();

  document.getElementById('provider-connect')?.addEventListener('click', connectProvider);

  bindProviderEvents();
  bindAdapterModalEvents();
  bindExtensionEvents();
  bindStatusShortcuts();
}

async function connectZone(zoneId, button) {
  if (!(button instanceof HTMLButtonElement)) button = undefined;
  const zone = state.config?.zones.find((z) => z.id === zoneId);
  if (!zone) return;

  const adapterType = normalizeAdapterType(zone.adapter?.type);
  const adapterParams = zone.adapter?.parameters || {};
  if (adapterType === 'musicassistant' && !String(adapterParams.maPlayerId || '').trim()) {
    setStatus('Configure a Music Assistant player before connecting.', true);
    if (button) {
      button.disabled = true;
      button.textContent = 'Connect';
      button.classList.remove('connected');
    }
    state.zoneStatus = state.zoneStatus || {};
    state.zoneStatus[zoneId] = {
      ...(state.zoneStatus[zoneId] || { id: zoneId }),
      adapterType,
      connectError: 'Configure a Music Assistant player before connecting.',
      connected: false,
    };
    render();
    return;
  }
  state.zoneStatus = state.zoneStatus || {};
  state.zoneStatus[zoneId] = {
    ...(state.zoneStatus[zoneId] || { id: zoneId }),
    adapterType,
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
  const data = await connectZoneApi(zoneId, zonePayload);
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
      adapterType,
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
    setStatus(`${message} Check your adapter settings and try again.`, true);
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

function bindStatusShortcuts() {
  document.querySelectorAll('[data-nav-tab]').forEach((element) => {
    if (!(element instanceof HTMLElement)) return;
    element.onclick = (event) => {
      event.preventDefault();
      const targetTab = element.getAttribute('data-nav-tab');
      const scrollTarget = element.getAttribute('data-scroll-target');
      const scrollToAnchor = () => {
        if (!scrollTarget) return;
        const selector = scrollTarget.startsWith('#') ? scrollTarget : `#${scrollTarget}`;
        const anchor = document.querySelector(selector);
        if (anchor instanceof HTMLElement) {
          anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
          anchor.classList.add('highlight-target');
          window.setTimeout(() => anchor.classList.remove('highlight-target'), 1200);
        }
      };
      if (targetTab && state.activeTab !== targetTab) {
        state.activeTab = targetTab;
        render();
        const targetButton = tabsNav?.querySelector(`.tab[data-tab="${targetTab}"]`);
        if (targetButton instanceof HTMLElement) {
          targetButton.focus();
        }
        window.requestAnimationFrame(scrollToAnchor);
      } else {
        scrollToAnchor();
      }
    };
  });
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

async function saveAudioserverIp() {
  if (!state.config || state.audioserverIpSaving) return;
  const audioserver = state.config.audioserver = state.config.audioserver || {};
  const currentValue = typeof audioserver.ip === 'string' ? audioserver.ip.trim() : '';
  audioserver.ip = currentValue;
  const lastSaved = typeof state.lastSavedAudioserverIp === 'string' ? state.lastSavedAudioserverIp.trim() : '';
  if (currentValue === lastSaved) {
    setStatus('No AudioServer IP changes to save.');
    return;
  }

  state.audioserverIpSaving = true;
  scheduleRender();
  setStatus('Saving AudioServer IP…');

  try {
    const data = await updateAudioServerIp(currentValue);
    await loadConfig(true);
    const savedIp = typeof data?.ip === 'string' ? data.ip : currentValue;
    const trimmedSaved = savedIp.trim();
    state.lastSavedAudioserverIp = trimmedSaved;
    state.config.audioserver.ip = savedIp;
    setStatus(data?.message || 'AudioServer IP saved.');
  } catch (error) {
    setStatus(`Failed to save AudioServer IP: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    state.audioserverIpSaving = false;
    scheduleRender();
  }
}

async function connectProvider() {
  if (!state.config) return;
  const providerMeta = findProviderMeta(state.config.mediaProvider?.type);
  const providerTypeId = normalizeProviderType(state.config.mediaProvider?.type || '');
  const parameters = normalizeProviderParameters(providerMeta, state.config.mediaProvider?.options || {});
  state.config.mediaProvider.options = parameters;

  const requiredMissing = getProviderFields(providerTypeId).some((field) => {
    if (!field.required) return false;
    const value = parameters[field.id];
    if (field.inputType === 'checkbox') {
      return !value;
    }
    return !String(value ?? '').trim();
  });

  if (requiredMissing) {
    setStatus('Fill in all required provider fields before connecting.', true);
    return;
  }

  const previousProviderType = normalizeProviderType(state.connectedProvider?.type || '');
  const previousParameters = normalizeProviderParameters(findProviderMeta(state.connectedProvider?.type), state.connectedProvider?.options || {});
  const previousHost = previousProviderType === 'musicassistant' ? String(previousParameters.ip || '').trim() : '';
  const newHost = providerTypeId === 'musicassistant' ? String(parameters.ip || '').trim() : '';

  let propagateZones = false;
  if (providerTypeId === 'musicassistant' && previousHost && newHost && previousHost !== newHost) {
    propagateZones = window.confirm?.('Update all Music Assistant zones to use the new host?') === true;
  }

  if (providerTypeId === 'musicassistant' && newHost) {
    const cache = ensureMusicAssistantCache();
    cache.providerHost = newHost;
    cache.lastIP = newHost;
  }

  if (propagateZones) {
    (state.config.zones || []).forEach((zone) => {
      if (!zone || typeof zone !== 'object') return;
      const adapter = zone.adapter = zone.adapter || { type: 'null', parameters: {} };
      if (normalizeAdapterType(adapter.type) !== 'musicassistant') return;
      adapter.parameters = adapter.parameters || {};
      adapter.parameters.ip = newHost;
    });
  }

  setStatus('Connecting provider…');
  try {
    await saveConfig(state.config);
    await loadConfig(true);
    setStatus(propagateZones
      ? 'Provider configuration saved and zones updated.'
      : 'Provider configuration saved.');
  } catch (error) {
    setStatus(`Failed to connect provider: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

function bindActions() {
  document.getElementById('clear-config')?.addEventListener('click', handleClearConfig);
  document.getElementById('save-audioserver-ip')?.addEventListener('click', () => {
    saveAudioserverIp();
  });
}

function bindExtensionEvents() {
  const button = document.getElementById('add-extension');
  if (button instanceof HTMLButtonElement) {
    button.addEventListener('click', handleAddExtensionClick);
  }
}

function handleAddExtensionClick(event) {
  if (event && typeof event.preventDefault === 'function') {
    event.preventDefault();
  }
  const zones = Array.isArray(state.config?.zones) ? [...state.config.zones] : [];
  zones.sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0));
  const groupedZones = groupZonesBySource(zones);
  const extensionStats = deriveExtensionStats(groupedZones, state.extensionPlaceholders || []);
  state.extensionPlaceholders = extensionStats.placeholders;

  if (extensionStats.totalCount >= MAX_EXTENSION_COUNT || extensionStats.highestIndex >= MAX_EXTENSION_COUNT) {
    setStatus(`Maximum of ${MAX_EXTENSION_COUNT} extensions reached.`, true);
    render();
    return;
  }

  const nextIndex = extensionStats.highestIndex + 1;
  if (nextIndex > MAX_EXTENSION_COUNT) {
    setStatus(`Maximum of ${MAX_EXTENSION_COUNT} extensions reached.`, true);
    render();
    return;
  }

  const serial = computeExtensionSerial(nextIndex);
  const label = `Stereo Extension ${nextIndex}`;
  state.extensionPlaceholders = [
    ...state.extensionPlaceholders,
    {
      index: nextIndex,
      serial,
      label,
    },
  ];

  setStatus(`Placeholder added for ${label}. Use serial ${serial} in your MiniServer project.`);
  render();
}

async function persistConfig() {
  if (!state.config) {
    throw new Error('No configuration loaded.');
  }
  return saveConfig(state.config);
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
    const data = await reloadConfig();
    const message = data.message || 'Configuration saved. Reboot the Miniserver to initiate pairing.';
    await loadConfig();
    setStatus(message);
  } catch (error) {
    setStatus(`Pairing failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function handleClearConfig() {
  const confirmClear = window.confirm?.('This will reset the configuration to defaults. Continue?');
  if (confirmClear === false) return;
  setStatus('Clearing configuration…');
  try {
    const data = await clearConfig();
    await loadConfig();
    state.config = defaultConfig();
    state.options = defaultOptions();
    state.zoneStatus = {};
    state.zoneStates = {};
    state.zoneStateUpdatedAt = 0;
    state.discoveryCache = {};
    state.connectedProvider = { type: '', options: {} };
    state.audioserverIpSaving = false;
    state.lastSavedAudioserverIp = typeof state.config?.audioserver?.ip === 'string'
      ? state.config.audioserver.ip.trim()
      : '';
    resetModalState();
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
