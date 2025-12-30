import type { ContentServiceAccount } from '@/modules/content/types';
import {
  SpotifyAccountProvider,
  type SpotifyAccountProviderOptions,
} from '@/modules/content/providers/spotify/spotifyAccountProvider';

/**
 * Reuses the Spotify account provider but exposes it under a different provider id/label.
 * Useful for "fake" providers that piggy-back on a Spotify account (e.g., Apple Music).
 */
export class FakeSpotifyAccountProvider extends SpotifyAccountProvider {
  private readonly providerType: string;
  private readonly labelOverride?: string;

  constructor(
    providerType: string,
    labelOverride: string | undefined,
    options: SpotifyAccountProviderOptions,
  ) {
    super(options);
    this.providerType = providerType || 'spotify';
    this.labelOverride = labelOverride;
  }

  public override get displayLabel(): string {
    return this.labelOverride || super.displayLabel;
  }

  public override getServiceAccount(): ContentServiceAccount {
    const base = super.getServiceAccount();
    return {
      ...base,
      label: this.displayLabel,
      provider: this.providerType,
      fake: true,
    };
  }
}
