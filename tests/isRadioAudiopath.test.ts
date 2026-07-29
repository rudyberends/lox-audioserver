import assert from 'node:assert/strict';
import { test } from './testHarness';
import { isRadioAudiopath } from '../src/application/zones/internal/zoneAudioHelpers';
import { AudioType } from '../src/domain/zones/enums';

test('isRadioAudiopath: tunein audiopath is radio', () => {
  assert.equal(isRadioAudiopath('tunein:station:abc'), true);
});

test('isRadioAudiopath: radio audiopath is radio', () => {
  assert.equal(isRadioAudiopath('radio://service/x'), true);
});

test('isRadioAudiopath: library audiopath is not radio even when audiotype===Radio (stale)', () => {
  // Regression for issue #205: after a radio session, audiotype can stay at 1
  // while audiopath switches to a local library track. The audiopath must win,
  // otherwise the reducer locks the zone into radio mode and the station label
  // never clears.
  assert.equal(
    isRadioAudiopath('library://local/Ed_Sheeran/03_Azizam.mp3', AudioType.Radio),
    false,
  );
});

test('isRadioAudiopath: spotify audiopath is not radio even when audiotype===Radio (stale)', () => {
  assert.equal(isRadioAudiopath('spotify:track:xyz', AudioType.Radio), false);
});

test('isRadioAudiopath: audiotype===Radio fallback only applies when audiopath is empty', () => {
  assert.equal(isRadioAudiopath('', AudioType.Radio), true);
  assert.equal(isRadioAudiopath(undefined, AudioType.Radio), true);
});

test('isRadioAudiopath: audiotype===File overrides radio-looking audiopath', () => {
  assert.equal(isRadioAudiopath('tunein:station:abc', AudioType.File), false);
});

test('isRadioAudiopath: airplay audiopath is never radio', () => {
  assert.equal(isRadioAudiopath('airplay://device', AudioType.Radio), false);
});
