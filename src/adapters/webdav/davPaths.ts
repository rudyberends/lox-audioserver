import path from 'node:path';

/**
 * Path handling for the WebDAV share.
 *
 * WebDAV differs from the upload endpoint in one important way: the name the
 * client PUTs must come back byte-identical from the next PROPFIND, or the
 * client believes the write failed. So nothing here rewrites a name — a path
 * that escapes the share is rejected outright instead of being sanitized into
 * something that happens to be safe.
 */

/** URL prefix the share is mounted on. */
export const DAV_ROOT = '/dav';

/**
 * Decodes a request URL into a path relative to the share root.
 *
 * Returns null when the path escapes the root (`..`), which the caller must
 * answer with 403 rather than silently redirecting somewhere safe.
 */
export function davRelativePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const withoutRoot = decoded.startsWith(DAV_ROOT) ? decoded.slice(DAV_ROOT.length) : decoded;
  const parts = withoutRoot
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.');

  if (parts.some((part) => part === '..')) {
    return null;
  }
  return parts.join('/');
}

/**
 * Normalizes a caller-supplied relative path (an upload, not a request URL).
 *
 * Keeps the name exactly as given — accents, spaces and CJK all survive — and
 * rejects traversal instead of rewriting it. Returns '' when nothing usable is
 * left, which callers must treat as a refusal.
 */
export function normalizeIncomingPath(value: string): string {
  const parts = String(value ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.');
  if (parts.some((part) => part === '..')) {
    return '';
  }
  return parts.join('/');
}

/**
 * Absolute filesystem path for a share-relative path, or null if it would land
 * outside `baseDir`. The prefix check is the last line of defence — symlinks and
 * odd encodings both end up here.
 */
export function resolveDavTarget(baseDir: string, relative: string): string | null {
  const candidate = path.resolve(baseDir, relative);
  const normalizedBase = baseDir.endsWith(path.sep) ? baseDir : `${baseDir}${path.sep}`;
  if (candidate !== baseDir && !candidate.startsWith(normalizedBase)) {
    return null;
  }
  return candidate;
}

/** Percent-encodes a path for an href, keeping `/` separators intact. */
export function encodeDavHref(relative: string): string {
  const encoded = relative
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return encoded ? `${DAV_ROOT}/${encoded}` : `${DAV_ROOT}/`;
}

/**
 * Files a desktop client scatters into any folder it touches. They are not audio
 * and must never reach the indexer; kept out of listings too so the share looks
 * like the music library rather than a filesystem.
 */
export function isJunkName(name: string): boolean {
  return (
    name === '.DS_Store' ||
    name === 'Thumbs.db' ||
    name === 'desktop.ini' ||
    name.startsWith('._')
  );
}

/**
 * Names that must never be served or written at the share root.
 *
 * The share is normally rooted at the local library folder, which contains only
 * music — but the music dir one level up holds the SQLite index and the generated
 * cover collages. This guard stays in place so that rooting the share higher (or
 * a stray `library.db` appearing inside the music folder) still can't expose or
 * corrupt the index. Only the *first* segment is checked: a band called "Collage"
 * nested under an artist folder is ordinary music and stays browsable.
 */
const PROTECTED_ROOT_ENTRIES = new Set(['collage']);

export function isProtectedPath(relative: string): boolean {
  const first = relative.split('/')[0] ?? '';
  // -shm / -wal are SQLite's sidecars; they come and go with the connection.
  return PROTECTED_ROOT_ENTRIES.has(first) || first.startsWith('library.db');
}
