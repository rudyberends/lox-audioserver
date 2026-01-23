export class SpotifyDeviceRegistry {
  private readonly registry = new Map<number, string>();
  private readonly loginRegistry = new Map<number, string>();

  public setSpotifyDeviceId(zoneId: number, deviceId: string): void {
    if (!deviceId) {
      return;
    }
    const normalized = deviceId.trim();
    if (!normalized) {
      return;
    }
    this.registry.set(zoneId, normalized);
  }

  public getSpotifyDeviceId(zoneId: number): string | undefined {
    return this.registry.get(zoneId);
  }

  public clearSpotifyDeviceId(zoneId: number): void {
    this.registry.delete(zoneId);
  }

  public setSpotifyLoginUser(zoneId: number, username: string): void {
    if (!username) return;
    const normalized = username.trim();
    if (!normalized) return;
    this.loginRegistry.set(zoneId, normalized);
  }

  public getSpotifyLoginUser(zoneId: number): string | undefined {
    return this.loginRegistry.get(zoneId);
  }

  public clearSpotifyLoginUser(zoneId: number): void {
    this.loginRegistry.delete(zoneId);
  }
}
