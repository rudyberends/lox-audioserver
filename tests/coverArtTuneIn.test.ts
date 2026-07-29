import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  COVER_ART_BROWSE_SIZE,
  COVER_ART_NOW_PLAYING_SIZE,
  resizeTuneInCoverUrl,
} from '../src/shared/coverArt';

// TuneIn encodes the size as a single letter in `.../logo<letter>.jpg`. Sizes checked
// against cdn-profiles.tunein.com: q=145, d=300, g=600. `g` was missing here, so a
// now-playing cover asking for 640 quantized down to 300 — visibly soft on anything
// bigger than a phone. The LoxBerry plugin's own cover proxy had found `g` already.

const logo = (letter: string) => `https://cdn-profiles.tunein.com/s6814/images/logo${letter}.jpg`;
const variantOf = (url: string) => url.split('/').pop();

test('a now-playing cover asks for the 600px TuneIn variant', () => {
  assert.equal(variantOf(resizeTuneInCoverUrl(logo('q'), COVER_ART_NOW_PLAYING_SIZE)), 'logog.jpg');
});

test('a browse cover stays at the 300px variant', () => {
  // 256 is nearer 300 than 600, and a list of thumbnails should not pull 600px images.
  assert.equal(variantOf(resizeTuneInCoverUrl(logo('q'), COVER_ART_BROWSE_SIZE)), 'logod.jpg');
});

test('any starting variant can be moved either way', () => {
  // The rewrite used to match a literal `q`, so a url that already arrived as `logod`
  // could never be upgraded — which is exactly the browse-then-play path.
  for (const from of ['q', 'd', 'g']) {
    assert.equal(
      variantOf(resizeTuneInCoverUrl(logo(from), COVER_ART_NOW_PLAYING_SIZE)),
      'logog.jpg',
      `${from} upgrades`,
    );
    assert.equal(
      variantOf(resizeTuneInCoverUrl(logo(from), 145)),
      'logoq.jpg',
      `${from} downgrades`,
    );
  }
});

test('a browse-sized url still upgrades when it becomes the now-playing art', () => {
  const browse = resizeTuneInCoverUrl(logo('q'), COVER_ART_BROWSE_SIZE);
  const nowPlaying = resizeTuneInCoverUrl(browse, COVER_ART_NOW_PLAYING_SIZE);
  assert.equal(variantOf(browse), 'logod.jpg');
  assert.equal(variantOf(nowPlaying), 'logog.jpg');
});

test('a url that is not a TuneIn logo is left alone', () => {
  for (const url of [
    'https://example.com/art/cover.jpg',
    'https://cdn-profiles.tunein.com/s1/images/banner.png',
    '',
  ]) {
    assert.equal(resizeTuneInCoverUrl(url, COVER_ART_NOW_PLAYING_SIZE), url);
  }
});

test('the letter is only replaced in the filename, not elsewhere in the path', () => {
  // A station id or folder can contain anything; only the trailing `logo<x>.<ext>` may move.
  const url = 'https://cdn-profiles.tunein.com/logos/s6814/images/logoq.jpg';
  assert.equal(
    resizeTuneInCoverUrl(url, COVER_ART_NOW_PLAYING_SIZE),
    'https://cdn-profiles.tunein.com/logos/s6814/images/logog.jpg',
  );
});
