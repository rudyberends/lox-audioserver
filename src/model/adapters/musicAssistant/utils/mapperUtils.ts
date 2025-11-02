/**
 * Safely converts any input value to a string.
 */
export function ensureString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (!value) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map(ensureString).filter(Boolean).join(', ');
  }

  if (typeof value === 'object') {
    if (typeof (value as any).name === 'string') {
      return (value as any).name;
    }
    if (typeof (value as any).title === 'string') {
      return (value as any).title;
    }
  }

  return '';
}

/**
 * Maps the artists field from a Music Assistant entity to a string.
 */
export function mapArtists(source: unknown): string {
  const s = source as any;
  if (Array.isArray(s?.artists) && s.artists.length > 0) {
    return s.artists.map(ensureString).filter(Boolean).join(', ');
  }
  return ensureString(s?.artist ?? s);
}

