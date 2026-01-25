import type { AirplayInputService } from '@/adapters/inputs/airplay/airplayInputService';
import type { MusicAssistantInputService } from '@/adapters/inputs/musicassistant/musicAssistantInputService';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { InputsPort } from '@/ports/InputsPort';

type AirplayController = Parameters<InputsPort['configureAirplay']>[0];
type SpotifyConnectController = Parameters<InputsPort['configureSpotify']>[0];
type AirplayResolver = Parameters<InputsPort['setAirplayPlayerResolver']>[0];

export type InputsAdapterDeps = {
  airplay: AirplayInputService;
  spotify: SpotifyInputService;
  musicAssistant: MusicAssistantInputService;
  sendspinLineIn: SendspinLineInService;
};

export class InputsAdapter implements InputsPort {
  constructor(private readonly deps: InputsAdapterDeps) {}

  public configureAirplay(controller: AirplayController): void {
    this.deps.airplay.configure(controller);
  }

  public setAirplayPlayerResolver(resolver: AirplayResolver): void {
    this.deps.airplay.setPlayerResolver(resolver);
  }

  public syncAirplayZones(...args: Parameters<InputsPort['syncAirplayZones']>): void {
    this.deps.airplay.syncZones(...args);
  }

  public renameAirplayZone(...args: Parameters<InputsPort['renameAirplayZone']>): Promise<void> {
    return this.deps.airplay.renameZone(...args);
  }

  public shutdownAirplay(): Promise<void> {
    return this.deps.airplay.shutdown();
  }

  public configureSpotify(controller: SpotifyConnectController): void {
    this.deps.spotify.configure(controller);
  }

  public syncSpotifyZones(...args: Parameters<InputsPort['syncSpotifyZones']>): void {
    this.deps.spotify.syncZones(...args);
  }

  public renameSpotifyZone(...args: Parameters<InputsPort['renameSpotifyZone']>): Promise<void> {
    return this.deps.spotify.renameZone(...args);
  }

  public shutdownSpotify(): Promise<void> {
    return this.deps.spotify.shutdown();
  }

  public configureMusicAssistant(
    handlers?: Parameters<InputsPort['configureMusicAssistant']>[0],
    switchAwayHandlers?: Parameters<InputsPort['configureMusicAssistant']>[1],
  ): void {
    this.deps.musicAssistant.configure(handlers, switchAwayHandlers);
  }

  public syncMusicAssistantZones(...args: Parameters<InputsPort['syncMusicAssistantZones']>): Promise<void> {
    return this.deps.musicAssistant.syncZones(...args);
  }

  public shutdownMusicAssistant(): void {
    this.deps.musicAssistant.shutdown();
  }

  public getMusicAssistantProviderId(): string {
    return this.deps.musicAssistant.getProviderId();
  }

  public startStreamForAudiopath(...args: Parameters<InputsPort['startStreamForAudiopath']>): ReturnType<InputsPort['startStreamForAudiopath']> {
    return this.deps.musicAssistant.startStreamForAudiopath(...args);
  }

  public getPlaybackSourceForUri(...args: Parameters<InputsPort['getPlaybackSourceForUri']>): ReturnType<InputsPort['getPlaybackSourceForUri']> {
    return this.deps.spotify.getPlaybackSourceForUri(...args);
  }

  public getPlaybackSource(...args: Parameters<InputsPort['getPlaybackSource']>): ReturnType<InputsPort['getPlaybackSource']> {
    return this.deps.spotify.getPlaybackSource(...args);
  }

  public markSessionActive(...args: Parameters<InputsPort['markSessionActive']>): void {
    this.deps.spotify.markSessionActive(...args);
  }

  public stopAirplaySession(...args: Parameters<InputsPort['stopAirplaySession']>): void {
    this.deps.airplay.stopActiveSession(...args);
  }

  public stopSpotifySession(...args: Parameters<InputsPort['stopSpotifySession']>): void {
    this.deps.spotify.stopActiveSession(...args);
  }

  public switchAway(...args: Parameters<InputsPort['switchAway']>): ReturnType<InputsPort['switchAway']> {
    return this.deps.musicAssistant.switchAway(...args);
  }

  public remoteControl(...args: Parameters<InputsPort['remoteControl']>): void {
    this.deps.airplay.remoteControl(...args);
  }

  public remoteVolume(...args: Parameters<InputsPort['remoteVolume']>): void {
    this.deps.airplay.remoteVolume(...args);
  }

  public playerCommand(...args: Parameters<InputsPort['playerCommand']>): ReturnType<InputsPort['playerCommand']> {
    return this.deps.musicAssistant.playerCommand(...args);
  }

  public requestLineInStop(...args: Parameters<InputsPort['requestLineInStop']>): void {
    this.deps.sendspinLineIn.requestStop(...args);
  }

  public requestLineInControl(...args: Parameters<InputsPort['requestLineInControl']>): void {
    this.deps.sendspinLineIn.requestControl(...args);
  }
}

export function createInputsAdapter(deps: InputsAdapterDeps): InputsAdapter {
  return new InputsAdapter(deps);
}
