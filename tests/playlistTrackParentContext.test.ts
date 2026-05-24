import assert from 'node:assert/strict';
import { test } from './testHarness';
import { buildPlaylistTrackItem } from '../src/adapters/loxone/commands/handlers/providerHandlers';
import {
  BASE_PLAYLIST,
  decodeLoxoneId,
} from '../src/adapters/loxone/commands/utils/loxoneIdCodec';
import { parseParentContext } from '../src/application/zones/policies/ParentContextPolicy';

const track = {
  audiopath: 'library:local:track:b64_bGlicmFyeTovL2xvY2FsL3F1ZWVuL3NvbmcubXAz',
  name: 'Song',
  title: 'Song',
  artist: 'Queen',
  album: 'Greatest Hits',
} as const;

test('buildPlaylistTrackItem: round-trip carries playlist parent context', () => {
  // Regression for #205: clicking a track inside a local playlist used to
  // play just that track with empty metadata, because the Loxone encoded id
  // did not carry the playlist parent context.
  const item = buildPlaylistTrackItem(track as never, 4, 16);
  const decoded = decodeLoxoneId(item.id);
  assert.ok(decoded, 'encoded id must decode');
  assert.equal(decoded!.offset, BASE_PLAYLIST + 4);
  assert.equal(typeof decoded!.data, 'string');

  const inner = decoded!.data as string;
  assert.ok(inner.startsWith(track.audiopath), 'inner payload must start with the track audiopath');
  assert.ok(inner.includes('/parentpath/library:playlist:16/4'), 'inner payload must carry playlist parentpath suffix');

  const parent = parseParentContext(inner);
  assert.ok(parent, 'parseParentContext must recognise the suffix');
  assert.equal(parent!.parent, 'library:playlist:16');
  assert.equal(parent!.startItem, track.audiopath);
  assert.equal(parent!.startIndex, 4);
});

test('buildPlaylistTrackItem: omits parent context when no playlistId is provided', () => {
  // Callers outside the playlist-listing flow (none today, but keep the
  // function backwards-compatible) should keep the legacy behaviour.
  const item = buildPlaylistTrackItem(track as never, 0);
  const decoded = decodeLoxoneId(item.id);
  assert.ok(decoded);
  assert.equal(decoded!.data, track.audiopath);
  assert.equal(parseParentContext(decoded!.data as string), null);
});

test('buildPlaylistTrackItem: tolerates string playlistId', () => {
  const item = buildPlaylistTrackItem(track as never, 2, 'foo-7');
  const decoded = decodeLoxoneId(item.id);
  assert.ok(decoded);
  const inner = decoded!.data as string;
  assert.ok(inner.includes('/parentpath/library:playlist:foo-7/2'));
});
