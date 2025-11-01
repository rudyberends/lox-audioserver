const initialModalState = {
  open: false,
  zoneId: null,
  adapterType: '',
  parameters: {},
  discovery: {},
  contentAdapter: '',
  contentAdapterPlayerId: '',
  contentAdapterPlayers: [],
  contentAdapterHost: '',
  contentAdapterPlayersLoading: false,
  contentAdapterPlayersError: '',
  error: '',
};

function resolveDefaultHostname() {
  if (typeof window === 'undefined' || !window.location) return '';
  return window.location.hostname || '';
}

export function defaultConfig() {
  return {
    miniserver: { ip: '', username: '', password: '' },
    audioserver: { ip: resolveDefaultHostname(), paired: false },
    zones: [],
    mediaProvider: { type: '', options: {} },
    logging: { consoleLevel: 'info', fileLevel: 'none' },
  };
}

export function defaultOptions() {
  return {
    adapters: [],
    providers: [],
    contentPlayers: [],
  };
}

export const state = {
  config: defaultConfig(),
  options: defaultOptions(),
  activeTab: 'miniserver',
  zoneStatus: {},
  zoneStates: {},
  zoneStateUpdatedAt: 0,
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
  modal: { ...initialModalState },
  connectedProvider: {
    type: '',
    options: {},
  },
  providerDiscovery: {},
  extensionPlaceholders: [],
  loadingConfig: true,
  waitingForPairing: false,
  audioserverIpSaving: false,
  lastSavedAudioserverIp: '',
  musicAssistantCache: null,
  showProviderPanel: false,
};

export function resetModalState() {
  state.modal = { ...initialModalState };
}

export function updateModalState(patch = {}) {
  state.modal = {
    ...(state.modal || {}),
    ...patch,
  };
}

export function ensureMusicAssistantCache() {
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
