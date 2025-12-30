const registry = new Map<number, string>();
const loginRegistry = new Map<number, string>();

export function setSpotifyDeviceId(zoneId: number, deviceId: string): void {
  if (!deviceId) {
    return;
  }
  const normalized = deviceId.trim();
  if (!normalized) {
    return;
  }
  registry.set(zoneId, normalized);
}

export function getSpotifyDeviceId(zoneId: number): string | undefined {
  return registry.get(zoneId);
}

export function clearSpotifyDeviceId(zoneId: number): void {
  registry.delete(zoneId);
}

export function setSpotifyLoginUser(zoneId: number, username: string): void {
  if (!username) return;
  const normalized = username.trim();
  if (!normalized) return;
  loginRegistry.set(zoneId, normalized);
}

export function getSpotifyLoginUser(zoneId: number): string | undefined {
  return loginRegistry.get(zoneId);
}

export function clearSpotifyLoginUser(zoneId: number): void {
  loginRegistry.delete(zoneId);
}
