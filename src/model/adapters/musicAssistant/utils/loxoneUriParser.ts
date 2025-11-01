/**
 * Clean and normalize a Loxone-style media URI.
 *
 * - Decode URI
 * - Strip query string
 * - Drop Spotify prefixes (spotify/nouser/, spotify:track:0/)
 * - Collapse duplicate slashes (but preserve ://)
 * - Remove trailing slashes
 * - Drop redundant provider prefixes (e.g. "spotify/library://..." → "library://...")
 */
export function cleanLoxoneUri(input: string): string {
  if (!input || typeof input !== 'string') {
    return '';
  }

  let uri = decodeURIComponent(input).trim();

  // Strip query parameters
  uri = uri.split('?')[0];

  // Legacy Spotty quirks
  uri = uri.replace(/^spotify\/nouser\//i, '');
  uri = uri.replace(/^spotify:track:0\//i, '');

  // Collapse duplicate slashes (preserve scheme://)
  uri = uri.replace(/([^:])\/{2,}/g, '$1/');

  // Remove trailing slashes
  uri = uri.replace(/\/+$/, '');

  // If it starts with "<provider>/<scheme>://", remove provider prefix
  const schemeRe = /^[a-z][a-z0-9+.\-_]*:\/\//i;
  while (true) {
    const match = uri.match(/^([a-z0-9_]+)\/(.+)$/i);
    if (!match) {
      break;
    }
    const rest = match[2];
    if (schemeRe.test(rest)) {
      uri = rest;
      continue;
    }
    break;
  }

  return uri;
}