import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from './testHarness';
import {
  DAV_ROOT,
  davRelativePath,
  encodeDavHref,
  isJunkName,
  isProtectedPath,
  resolveDavTarget,
} from '../src/adapters/webdav/davPaths';

// The WebDAV share is a writable network mount over the music folder, so path
// handling is the security boundary: traversal must be rejected, the index
// database must be unreachable, and names must survive a round trip unaltered.

test('davRelativePath strips the mount prefix', () => {
  assert.equal(davRelativePath('/dav/local/Artist/track.mp3'), 'local/Artist/track.mp3');
  assert.equal(davRelativePath('/dav/'), '');
  assert.equal(davRelativePath('/dav'), '');
});

test('davRelativePath decodes percent-encoded names', () => {
  assert.equal(davRelativePath('/dav/local/Sigur%20R%C3%B3s/track.mp3'), 'local/Sigur Rós/track.mp3');
});

test('davRelativePath rejects traversal instead of rewriting it', () => {
  assert.equal(davRelativePath('/dav/../../etc/passwd'), null);
  assert.equal(davRelativePath('/dav/local/../../secret'), null);
  // Encoded traversal must be caught after decoding, not before.
  assert.equal(davRelativePath('/dav/%2e%2e/%2e%2e/etc/passwd'), null);
});

test('davRelativePath keeps names verbatim', () => {
  // The upload path sanitizer rewrites these to underscores; WebDAV must not,
  // or the file a client PUT would not come back from the next PROPFIND.
  assert.equal(davRelativePath('/dav/local/Ed Sheeran/01 - Café.mp3'), 'local/Ed Sheeran/01 - Café.mp3');
  assert.equal(davRelativePath('/dav/local/%E6%97%A5%E6%9C%AC/a.mp3'), 'local/日本/a.mp3');
});

test('resolveDavTarget confines resolution to the base directory', () => {
  const base = path.resolve('/tmp/music-base');
  assert.equal(resolveDavTarget(base, 'local/a.mp3'), path.join(base, 'local/a.mp3'));
  assert.equal(resolveDavTarget(base, ''), base);
  // Defence in depth: even if a traversal string reached here it must not escape.
  assert.equal(resolveDavTarget(base, '../outside.mp3'), null);
  assert.equal(resolveDavTarget(base, '../music-base-sibling/x.mp3'), null);
});

test('isProtectedPath hides the library index from the share', () => {
  // Deleting or truncating these over the mount would corrupt the library.
  assert.equal(isProtectedPath('library.db'), true);
  assert.equal(isProtectedPath('library.db-wal'), true);
  assert.equal(isProtectedPath('library.db-shm'), true);
  assert.equal(isProtectedPath('collage'), true);
  assert.equal(isProtectedPath('collage/anything.jpg'), true);
  // Real music is not protected.
  assert.equal(isProtectedPath('local/Artist/track.mp3'), false);
  assert.equal(isProtectedPath('nas/share1/track.mp3'), false);
});

test('isJunkName filters desktop sidecar files', () => {
  // Finder and Explorer scatter these into every folder they touch.
  assert.equal(isJunkName('.DS_Store'), true);
  assert.equal(isJunkName('._track.mp3'), true);
  assert.equal(isJunkName('Thumbs.db'), true);
  assert.equal(isJunkName('track.mp3'), false);
});

test('encodeDavHref percent-encodes segments but keeps separators', () => {
  assert.equal(encodeDavHref('local/Sigur Rós/a.mp3'), `${DAV_ROOT}/local/Sigur%20R%C3%B3s/a.mp3`);
  assert.equal(encodeDavHref(''), `${DAV_ROOT}/`);
  // A href must round-trip back to the path it came from.
  const relative = 'local/Ed Sheeran/01 - Café.mp3';
  assert.equal(davRelativePath(encodeDavHref(relative)), relative);
});
