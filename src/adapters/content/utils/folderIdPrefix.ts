/**
 * Strip the account slug a multi-account service puts in front of a folder id.
 *
 * A service-native id names its account only when there is more than one account of
 * that service: `ytmusic:playlist:VL…` with one, `ytmusic:1ryw2i:playlist:VL…` with
 * two (see `serviceNativeKey`). Providers strip their own service token themselves;
 * what is left over is that middle segment, and a provider matching `^playlist:`
 * against it recognises nothing and browses into an empty folder.
 *
 * The rule is the structural one `parseServiceNativeAudiopath` already uses: the
 * leading segment is the account unless it belongs to the closed kind vocabulary.
 * That vocabulary is the caller's, because a provider's folder ids are its own
 * (`genre:` and `search:` exist here and nowhere else), so it is passed in.
 */
export function stripAccountSlug(value: string, kinds: readonly string[]): string {
  const raw = (value || '').trim();
  const idx = raw.indexOf(':');
  if (idx <= 0) {
    return raw;
  }
  const head = raw.slice(0, idx).toLowerCase();
  if (kinds.some((k) => k.toLowerCase() === head)) {
    return raw;
  }
  return raw.slice(idx + 1);
}
