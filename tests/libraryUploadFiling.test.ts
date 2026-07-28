import assert from 'node:assert/strict';
import { test } from './testHarness';
import { __testing } from '../src/adapters/content/providers/localLibraryProvider';

// A loose upload is filed under its own tags. The names it produces must survive
// verbatim — the old upload path rewrote everything outside [A-Za-z0-9._-] to '_',
// which is why the library still contains folders like 'Ed_Sheeran_-_Play_'.

const { toSafeFolderName, isUnknownTagValue } = __testing;

test('upload filing: keeps accents and non-Latin scripts intact', () => {
  assert.equal(toSafeFolderName('Björk'), 'Björk');
  assert.equal(toSafeFolderName('Sigur Rós'), 'Sigur Rós');
  assert.equal(toSafeFolderName('久石譲'), '久石譲');
  assert.equal(toSafeFolderName('Beyoncé'), 'Beyoncé');
});

test('upload filing: strips only what a filesystem cannot take', () => {
  // Path separators would silently create nesting; Windows reserves the rest.
  assert.equal(toSafeFolderName('AC/DC'), 'AC DC');
  assert.equal(toSafeFolderName('A:B*C?D"E<F>G|H'), 'A B C D E F G H');
  // Collapsed whitespace, no leading dot (would hide the folder) or trailing
  // dot/space (breaks Windows).
  assert.equal(toSafeFolderName('  spaced   out  '), 'spaced out');
  assert.equal(toSafeFolderName('.hidden'), 'hidden');
  assert.equal(toSafeFolderName('trailing.'), 'trailing');
});

test('upload filing: refuses names that reduce to nothing', () => {
  assert.equal(toSafeFolderName('///'), '');
  assert.equal(toSafeFolderName('   '), '');
  assert.equal(toSafeFolderName('...'), '');
});

test('upload filing: caps absurdly long tag values', () => {
  assert.equal(toSafeFolderName('x'.repeat(300)).length, 96);
});

test('upload filing: placeholder tags do not become folders', () => {
  // Taggers emit these for anything they could not identify; filing by them
  // would collect unrelated tracks into one bogus album.
  assert.equal(isUnknownTagValue('Unknown Artist'), true);
  assert.equal(isUnknownTagValue('unknown album'), true);
  assert.equal(isUnknownTagValue('UNKNOWN'), true);
  // A real band whose name merely starts with those letters must pass.
  assert.equal(isUnknownTagValue('Unknown Mortal Orchestra'), false);
  assert.equal(isUnknownTagValue('Björk'), false);
});

// Artist pictures come from Wikimedia Commons, which derives an image's storage
// path from the MD5 of its underscored filename. There is no lookup endpoint for
// that path, so the URL is computed — and a subtly wrong escape yields a 404.

test('artist art: builds the Commons thumbnail path Wikimedia actually serves', () => {
  // Verified against the live URL for this file.
  assert.equal(
    __testing.buildCommonsThumbUrl('Eminem live at D.C. 2014 (cropped).jpg', 500),
    'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/Eminem_live_at_D.C._2014_%28cropped%29.jpg/500px-Eminem_live_at_D.C._2014_%28cropped%29.jpg',
  );
});

test('artist art: escapes the sub-delimiters encodeURIComponent leaves alone', () => {
  // Parentheses are everywhere in Commons filenames ("… (cropped).jpg") and
  // encodeURIComponent does not touch them, which cost a 404 the first time.
  const url = __testing.buildCommonsThumbUrl('A (b) c!.jpg', 500);
  assert.ok(!url.includes('('), 'parentheses must be percent-encoded');
  assert.ok(!url.includes('!'), 'exclamation mark must be percent-encoded');
  assert.ok(url.includes('%28') && url.includes('%29'));
});

test('artist art: spaces become underscores before hashing', () => {
  // The hash is over the underscored name; hashing the spaced form points at a
  // directory that does not exist.
  const spaced = __testing.buildCommonsThumbUrl('Two Words.jpg', 500);
  const underscored = __testing.buildCommonsThumbUrl('Two_Words.jpg', 500);
  assert.equal(spaced, underscored);
});
