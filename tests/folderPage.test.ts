import assert from 'node:assert/strict';
import { test } from './testHarness';
import { estimatedPage, knownPage, slicedPage } from '../src/adapters/content/folderPage';
import type { ContentFolderItem } from '../src/ports/ContentTypes';

// `totalitems` is a plain number, so it cannot say "unknown" — and providers that cannot
// know it guessed, differently. Two same-named `estimateTotal` helpers existed with
// different formulas, one adding a phantom item and one a whole page, which is why DLNA
// substitutes its own figure and Subsonic pages until it sees a short page.

const items = (n: number): ContentFolderItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `i${i}`, name: `Item ${i}`, type: 2 }) as ContentFolderItem);

const base = { id: 'f', name: 'Folder', service: 'svc', start: 0 };

test('a total from upstream is passed through and marked known', () => {
  // It describes the whole collection, not the slice, so it must not be derived from
  // items.length — a page of 10 out of 5000 still reports 5000.
  const page = knownPage({ ...base, items: items(10) }, 5000);
  assert.equal(page.totalitems, 5000);
  assert.equal(page.totalKnown, true);
});

test('a full page with no upstream count keeps a client paging, but says it is a guess', () => {
  const page = estimatedPage({ ...base, start: 40, items: items(20) }, 20);
  assert.equal(page.totalKnown, false, 'this is the whole point');
  assert.ok(page.totalitems > 60, 'sits ahead so the client asks again');
});

test('a short page means the end, and then the count is exact after all', () => {
  const page = estimatedPage({ ...base, start: 40, items: items(7) }, 20);
  assert.equal(page.totalitems, 47);
  assert.equal(page.totalKnown, true, 'nothing left to guess about');
});

test('an empty page is the end too', () => {
  const page = estimatedPage({ ...base, start: 40, items: [] }, 20);
  assert.equal(page.totalitems, 40);
  assert.equal(page.totalKnown, true);
});

test('slicing a list you already hold gives an exact total', () => {
  // This is the shape that used to be written longhand, with an estimate beside it even
  // though the full list was right there.
  const all = items(37);
  const page = slicedPage({ ...base, start: 10 }, all, 20);
  assert.equal(page.items.length, 20);
  assert.equal(page.totalitems, 37, 'the whole list, not the slice');
  assert.equal(page.totalKnown, true);
});

test('a slice past the end is empty but still reports the real total', () => {
  const page = slicedPage({ ...base, start: 100 }, items(37), 20);
  assert.deepEqual(page.items, []);
  assert.equal(page.totalitems, 37);
});

test('a negative or absurd total cannot escape', () => {
  assert.equal(knownPage({ ...base, items: [] }, -5).totalitems, 0);
  assert.equal(knownPage({ ...base, items: [] }, 12.7).totalitems, 13);
});

test('service is omitted rather than sent empty when there is none', () => {
  const page = knownPage({ id: 'f', name: 'F', start: 0, items: [] }, 0);
  assert.ok(!('service' in page));
});
