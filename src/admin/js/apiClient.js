const API_PREFIX = '/admin/api';

async function request(path, { method = 'GET', body } = {}) {
  const url = `${API_PREFIX}${path}`;
  const init = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  };

  const response = await fetch(url, init);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? payload.message
        : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

export async function getConfig() {
  return request('/config');
}

export async function saveConfig(config) {
  return request('/config', { method: 'POST', body: { config } });
}

export async function reloadConfig() {
  return request('/config/reload', { method: 'POST' });
}

export async function clearConfig() {
  return request('/config/clear', { method: 'POST' });
}

export async function connectZoneApi(playerId, zone) {
  return request('/zones/connect', { method: 'POST', body: { playerId, zone } });
}

export async function validateAdapterConfig(type, parameters) {
  return request('/adapters/validate', { method: 'POST', body: { type, parameters } });
}

export async function fetchZoneStatesApi() {
  return request('/zones/states');
}

export async function fetchMusicAssistantPlayersApi(payload) {
  return request('/musicassistant/players', { method: 'POST', body: payload });
}

export async function fetchLogsApi() {
  return request('/logs');
}

export async function updateLogLevelApi(level) {
  return request('/logs/level', { method: 'POST', body: { level } });
}

export function openLogsStream() {
  return new EventSource(`${API_PREFIX}/logs/stream`);
}
