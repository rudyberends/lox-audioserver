// @ts-nocheck
// extracted top-level state/update helpers

export function setupTabs() {
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



export function updateTabs() {
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



export function updateHeroSummary() {
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



export function setProviderOption(fieldId, value) {
  state.config.mediaProvider = state.config.mediaProvider || { type: '', options: {} };
  const options = state.config.mediaProvider.options = state.config.mediaProvider.options || {};
  if (value === '' || value === null || value === undefined) {
    delete options[fieldId];
  } else {
    options[fieldId] = value;
  }
}



export function updateProviderDiscoveryState(fieldId, patch = {}

export function setModalParameter(fieldId, value) {
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



export function updateDiscoveryState(fieldId, patch = {}

export function setZoneStatusIndicator(zoneId, className, text) {
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



export function clearZoneErrorTimer(zoneId) {
  const timer = zoneErrorTimers.get(zoneId);
  if (typeof timer === 'number') {
    clearTimeout(timer);
  }
  zoneErrorTimers.delete(zoneId);
}



export function setStatus(message, isError = false) {
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



export function clearStatus() {
  setStatus('');
}

