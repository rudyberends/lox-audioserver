// @ts-nocheck
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

export function shouldWatchPairing() {
  if (typeof window === 'undefined') return false;
  const activeTab = state.activeTab || 'miniserver';
  if (activeTab !== 'miniserver') return false;
  if (state.loadingConfig) return false;
  return !Boolean(state.config?.audioserver?.paired);
}

export function ensurePairingWatcher() {
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

export function stopPairingWatcher() {
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

export function shouldRefreshZones() {
  if (typeof window === 'undefined') return false;
  const activeTab = state.activeTab || 'miniserver';
  if (activeTab !== 'zones') return false;
  if (state.loadingConfig) return false;
  if (state.modal?.open) return false;
  return true;
}

export function ensureZonesRefresh() {
  if (!shouldRefreshZones()) {
    stopZonesRefresh();
    return;
  }
  if (zonesRefreshTimerId || zonesRefreshBusy || typeof window === 'undefined') return;
  zonesRefreshTimerId = window.setTimeout(refreshZones, ZONE_REFRESH_INTERVAL);
}

export function stopZonesRefresh() {
  if (zonesRefreshTimerId && typeof window !== 'undefined') {
    window.clearTimeout(zonesRefreshTimerId);
  }
  zonesRefreshTimerId = 0;
}

export function coercePlaybackString(value) {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (value == null) return '';
  return String(value).trim().toLowerCase();
}

export function derivePlaybackStateLabel(power = '', mode = '') {
  if (power === 'off' || power === 'offline') return '';
  if (mode === 'play' || mode === 'resume') return 'playing';
  if (mode === 'pause') return 'paused';
  if (mode === 'stop') return power === 'on' ? 'stopped' : '';
  if (power && power !== 'on') return power;
  if (mode) return mode;
  return '';
}

export function ensureAudioServerLabel(name = '') {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return 'AudioServer';
  if (isAudioServerLabel(trimmed)) return trimmed;
  return `${trimmed} (AudioServer)`;
}

export function sanitizeKey(value = '') {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildSourceKey(label = '', fallbackId = '') {
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

export function normalizeZoneStatePayload(raw = {}

export function integrateZonePlayback(playback) {
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

export function applyZoneStates(payloadStates = []) {
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

export function mergeCachedZoneStates() {
  const cached = state.zoneStates;
  if (!cached || typeof cached !== 'object') return;
  Object.values(cached).forEach((entry) => {
    integrateZonePlayback(entry);
  });
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

export function groupZonesBySource(zones = []) {
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

export function resolveZoneSource(zone = {}

export function resolveSourceSerial(label) {
  const index = extractExtensionIndex(label);
  if (Number.isFinite(index) && index > 0) {
    return computeExtensionSerial(index);
  }
  if (isAudioServerLabel(label)) {
    return AUDIO_SERVER_SERIAL;
  }
  return '';
}

export function isAudioServerLabel(label) {
  if (typeof label !== 'string') return false;
  const normalized = label.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes('audioserver') || normalized.includes('audio server');
}

export function sortZoneGroups(groups = []) {
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

export function deriveExtensionStats(groups = [], placeholders = []) {
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

export function extractExtensionIndex(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/extension\s*(\d+)/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isExtensionLabel(value) {
  return typeof value === 'string' && value.toLowerCase().includes('extension');
}

export function findProviderMeta(type = '') {
  const normalized = normalizeProviderType(type);
  return getProviderOptions().find((meta) => {
    const metaType = meta?.id ?? meta?.type ?? meta?.legacyName ?? '';
    return normalizeProviderType(metaType) === normalized;
  }) || null;
}

export function formatProviderLabel(value = '') {
  const meta = findProviderMeta(value);
  if (meta?.label) return meta.label;
  const normalized = normalizeProviderType(value);
  if (!normalized || normalized === 'dummy') return 'Dummy Provider';
  const withSpaces = normalized.replace(/[-_]+/g, ' ');
  return withSpaces.replace(/\w/g, (char) => char.toUpperCase());
}

export function describeProviderType(value = '') {
  const meta = findProviderMeta(value);
  if (meta?.description) return meta.description;
  return 'Configure this provider to expose sources to the AudioServer.';
}

export function isMusicAssistantProviderType(value = '') {
  const normalized = normalizeProviderType(value);
  return normalized === 'musicassistant';
}

export function normalizeProviderParameters(meta, rawOptions = {}

export function normalizeProviderType(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return 'dummy';
  if (/provider$/i.test(raw)) {
    return raw.replace(/provider$/i, '').toLowerCase();
  }
  return raw.toLowerCase();
}

export function resolveMusicAssistantHost(zone = null) {
  const adapter = zone ? getZoneAdapter(zone) : { type: '', parameters: {} };
  const adapterHost = adapter && adapter.parameters ? String(adapter.parameters.ip || adapter.parameters.IP || '').trim() : '';
  if (adapterHost) return adapterHost;
  const providerOptions = state.config?.mediaProvider?.options || {};
  const providerHost = String(providerOptions.ip || providerOptions.IP || '').trim();
  if (providerHost) return providerHost;
  const cache = ensureMusicAssistantCache();
  return cache.providerHost || cache.lastIP || '';
}

export function findContentPlayerMeta(id = '') {
  const normalized = String(id || '').trim();
  if (!normalized) return null;
  return getContentPlayerOptions().find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const entryId = entry.id ?? entry.type ?? entry.baseType ?? '';
    return String(entryId || '').trim() === normalized;
  }) || null;
}

export function toMusicAssistantDiscoveryOptions(players = []) {
  return players
    .filter((player) => player && typeof player === 'object' && player.id)
    .map((player) => ({
      value: player.id,
      label: `${player.name} (${player.id})`,
    }));
}

export function findAdapterMeta(type = '') {
  const normalized = normalizeAdapterType(type);
  return getAdapterOptions().find((entry) => normalizeAdapterType(entry.id ?? entry.type) === normalized) || null;
}

export function formatAdapterLabel(type = '') {
  const normalized = normalizeAdapterType(type);
  if (normalized === 'null') return 'Unassigned';
  const meta = findAdapterMeta(normalized);
  if (meta?.label) return meta.label;
  return formatContentPlayerLabel(normalized);
}

export function describeAdapter(type = '') {
  return findAdapterMeta(type)?.description || '';
}

export function adapterSupportsContentPlayback(type = '') {
  return Boolean(findAdapterMeta(type)?.supportsContentPlayback);
}

export function normalizeAdapterType(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || 'null';
}

export function isNullAdapter(type = '') {
  return normalizeAdapterType(type) === 'null';
}

export function isMusicAssistantAdapter(type = '') {
  return normalizeAdapterType(type) === 'musicassistant';
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

export function bindProviderEvents() {
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

export function openAdapterModal(zoneId) {
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

export function closeAdapterModal(shouldRender = true) {
  resetModalState();
  if (typeof document !== 'undefined') {
    document.body.classList.remove('modal-open');
  }
  if (shouldRender) render();
}

export function bindAdapterModalEvents() {
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

export function bindFormEvents() {
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

export function bindStatusShortcuts() {
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

export function bindActions() {
  document.getElementById('clear-config')?.addEventListener('click', handleClearConfig);
  document.getElementById('save-audioserver-ip')?.addEventListener('click', () => {
    saveAudioserverIp();
  });
}

export function bindExtensionEvents() {
  const button = document.getElementById('add-extension');
  if (button instanceof HTMLButtonElement) {
    button.addEventListener('click', handleAddExtensionClick);
  }
}

export function handleAddExtensionClick(event) {
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