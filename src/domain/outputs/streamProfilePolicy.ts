/**
 * Which wire format an HTTP-pull output asks the engine for.
 *
 * The four HTTP-pull outputs each carried a hardcoded `profile: 'mp3'`, so a lossless source was
 * re-encoded to 256 kbit MP3 whatever the endpoint could actually take. Measured against the original
 * on a real track, that stage adds -40.6 dBFS RMS of error — some forty-five decibels more than
 * everything else in the signal path put together, on material that arrived intact.
 *
 * So the decision moves here, in one place, with the endpoint's own capability as the input.
 */

export type StreamFormatPreference =
  /** Lossless when the endpoint is known to take it, MP3 when it is not — or when we cannot tell. */
  | 'auto'
  /** Lossless regardless: for an endpoint the owner knows better than we can detect. */
  | 'lossless'
  /** MP3 regardless: an endpoint that stutters on the bandwidth, or a slow link. */
  | 'lossy';

export type StreamProfileChoice = 'flac' | 'mp3';

export interface StreamProfileInputs {
  preference: StreamFormatPreference;
  /**
   * Whether the endpoint takes FLAC. `null` means unknown — a DLNA renderer we have not asked, for
   * instance — and unknown must read as "no", because a renderer that cannot decode the stream plays
   * silence and the owner has no way to see why.
   */
  losslessSupported: boolean | null;
  /**
   * Set once an endpoint has actually failed on a lossless stream. Beats every preference, including an
   * explicit one: the evidence from the device outranks our configuration.
   */
  losslessFailed?: boolean;
}

/**
 * Parse the per-output `streamFormat` setting. Anything unrecognised reads as `auto`, so a typo cannot
 * silently pin a zone to a format nobody chose.
 */
export function parseStreamFormatPreference(raw: unknown): StreamFormatPreference {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'lossless' || value === 'flac') {
    return 'lossless';
  }
  if (value === 'lossy' || value === 'mp3') {
    return 'lossy';
  }
  return 'auto';
}

export function chooseStreamProfile(inputs: StreamProfileInputs): StreamProfileChoice {
  if (inputs.losslessFailed) {
    return 'mp3';
  }
  if (inputs.preference === 'lossy') {
    return 'mp3';
  }
  if (inputs.preference === 'lossless') {
    return 'flac';
  }
  return inputs.losslessSupported === true ? 'flac' : 'mp3';
}

/**
 * HTTP transfer settings that follow from the chosen profile.
 *
 * FLAC is variable-bitrate, so its length cannot be computed from a track duration. A forced
 * Content-Length would therefore be a guess, and a body that ends short of its advertised length is the
 * bug that clipped the tail off every Cast track — so lossless always goes out chunked.
 */
export function streamProfileNeedsChunked(profile: StreamProfileChoice): boolean {
  return profile === 'flac';
}

/** The MIME type an endpoint should be told to expect. */
export function streamProfileContentType(profile: StreamProfileChoice): string {
  return profile === 'flac' ? 'audio/flac' : 'audio/mpeg';
}
