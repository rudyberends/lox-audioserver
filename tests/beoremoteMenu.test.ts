import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  BEOREMOTE_MAX_ENTRIES,
  BEOREMOTE_MAX_NAME_CHARS,
  activeSourceToIndex,
  buildBeoremoteMenu,
  resolveBeoremoteSelection,
  truncateName,
  type BeoremoteCandidate,
} from '../src/application/beoremote/beoremoteMenu';

// The Beoremote One's firmware imposes three limits that are not negotiable and not
// visible in the wire format: one submenu, position-as-identity, and a ~512 byte list
// budget. They were measured against the hardware, so these tests are the only place
// that keeps them from silently regressing.

function source(name: string, id = name): BeoremoteCandidate {
  return { name, id, action: { kind: 'content', audiopath: `path:${id}` } };
}

test('truncateName prefers a word boundary over cutting mid-word', () => {
  assert.equal(truncateName('Jazz Mix'), 'Jazz Mix');
  // The remote itself would cut mid-word, which reads as a typo.
  assert.equal(truncateName('Bang Olufsen Radio Selection'), 'Bang Olufsen Radio');
  assert.ok(truncateName('Bang Olufsen Radio Selection').length <= BEOREMOTE_MAX_NAME_CHARS);
});

test('truncateName keeps the budget when there is no usable word boundary', () => {
  // A boundary too early would collapse the name to almost nothing, so a hard cut wins.
  const cut = truncateName('A Supercalifragilisticexpialidocious');
  assert.ok(cut.length <= BEOREMOTE_MAX_NAME_CHARS);
  assert.ok(cut.startsWith('A Supercalifrag'));
});

test('truncateName collapses whitespace so the display gets one clean line', () => {
  assert.equal(truncateName('  NPO   Radio  2 '), 'NPO Radio 2');
});

test('limit 1: at most one source carries the submenu flag', () => {
  const plan = buildBeoremoteMenu({
    zoneId: 12,
    sources: [source('B&O Radio'), source('Jazz Mix'), source('BeoSound 9000')],
    submenu: [source('NPO Radio 2'), source('RTV Noord')],
    submenuOwnerIndex: 0,
  });
  const flagged = plan.menu.sources.filter((entry) => entry.submenu === true);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0]?.name, 'B&O Radio');
});

test('limit 1: no flag at all when the submenu is empty', () => {
  // A flagged source with nothing behind it opens a blank list on the remote.
  const plan = buildBeoremoteMenu({
    zoneId: 12,
    sources: [source('B&O Radio')],
    submenu: [],
    submenuOwnerIndex: 0,
  });
  assert.equal(plan.menu.sources[0]?.submenu, undefined);
});

test('limit 2: entries are published in the order given, with their index', () => {
  const plan = buildBeoremoteMenu({
    zoneId: 12,
    sources: [source('First'), source('Second'), source('Third')],
  });
  assert.deepEqual(
    plan.menu.sources.map((entry) => [entry.index, entry.name]),
    [[0, 'First'], [1, 'Second'], [2, 'Third']],
  );
});

test('limit 2: reordering changes the revision, so a stale pick is rejected', () => {
  const before = buildBeoremoteMenu({ zoneId: 12, sources: [source('A'), source('B')] });
  const after = buildBeoremoteMenu({ zoneId: 12, sources: [source('B'), source('A')] });
  assert.notEqual(before.menu.revision, after.menu.revision);

  // The remote reports a position, so without this check index 0 would silently
  // start 'B' when the user picked 'A'.
  const stale = resolveBeoremoteSelection(after, {
    list: 'source',
    index: 0,
    revision: before.menu.revision,
  });
  assert.deepEqual(stale, { ok: false, reason: 'stale-revision' });
});

test('limit 2: an unchanged menu keeps its revision across rebuilds', () => {
  const build = () =>
    buildBeoremoteMenu({
      zoneId: 12,
      sources: [source('A'), source('B')],
      submenu: [source('S1')],
      submenuOwnerIndex: 0,
    }).menu.revision;
  assert.equal(build(), build());
});

test('limit 2: revision ignores changes the remote cannot observe', () => {
  const withCover = buildBeoremoteMenu({
    zoneId: 12,
    sources: [{ name: 'A', action: { kind: 'content', audiopath: 'x', coverurl: 'http://a/1.jpg' } }],
  });
  const withoutCover = buildBeoremoteMenu({
    zoneId: 12,
    sources: [{ name: 'A', action: { kind: 'content', audiopath: 'y' } }],
  });
  // Only ordering and naming matter; churn elsewhere must not invalidate a live pick.
  assert.equal(withCover.menu.revision, withoutCover.menu.revision);
});

test('limit 2: the revision is zone-scoped', () => {
  const zoneA = buildBeoremoteMenu({ zoneId: 1, sources: [source('A')] });
  const zoneB = buildBeoremoteMenu({ zoneId: 2, sources: [source('A')] });
  assert.notEqual(zoneA.menu.revision, zoneB.menu.revision);
});

test('limit 3: the list is capped to roughly 30 short names', () => {
  const many = Array.from({ length: 60 }, (_, i) => source(`Station ${i}`));
  const plan = buildBeoremoteMenu({ zoneId: 12, sources: many });
  assert.ok(plan.menu.sources.length <= BEOREMOTE_MAX_ENTRIES);
  assert.ok(plan.droppedSources > 0, 'dropped entries must be reported, not silently cut');
});

test('limit 3: the byte budget cuts before the entry cap for long names', () => {
  const many = Array.from({ length: 30 }, (_, i) => source(`${'x'.repeat(20)} ${i}`));
  const plan = buildBeoremoteMenu({ zoneId: 12, sources: many });
  const bytes = plan.menu.sources.reduce(
    (total, entry) => total + Buffer.byteLength(entry.name, 'utf8') + 1,
    0,
  );
  assert.ok(bytes <= 512, `list must fit the measured 512 byte limit, got ${bytes}`);
  assert.ok(plan.menu.sources.length < 30);
});

test('limit 3: multi-byte names are budgeted by bytes, not characters', () => {
  // 'Sigur Rós' and CJK names cost more than their length suggests.
  const many = Array.from({ length: 40 }, () => source('日本のラジオ局'));
  const plan = buildBeoremoteMenu({ zoneId: 12, sources: many });
  const bytes = plan.menu.sources.reduce(
    (total, entry) => total + Buffer.byteLength(entry.name, 'utf8') + 1,
    0,
  );
  assert.ok(bytes <= 512, `byte budget must account for UTF-8, got ${bytes}`);
});

test('a dropped submenu owner loses its flag rather than shifting position', () => {
  // Moving it would break limit 2 for every entry after it.
  const many = Array.from({ length: 40 }, (_, i) => source(`Source ${i}`));
  const plan = buildBeoremoteMenu({
    zoneId: 12,
    sources: many,
    submenu: [source('Child')],
    submenuOwnerIndex: 39,
  });
  assert.equal(plan.menu.sources.filter((entry) => entry.submenu === true).length, 0);
  assert.deepEqual(plan.menu.sources.map((e) => e.index), plan.menu.sources.map((_, i) => i));
});

test('selection resolves to the server-side action, which is never published', () => {
  const plan = buildBeoremoteMenu({
    zoneId: 12,
    sources: [
      { name: 'Jazz Mix', action: { kind: 'favorite', favoriteId: 42, audiopath: 'spotify:playlist:x' } },
      { name: 'BeoSound 9000', action: { kind: 'lineIn', inputId: 'ms3h9f42' } },
    ],
  });
  // The published menu must not leak audiopaths — the remote has no use for them
  // and the bridge must not be able to ask for arbitrary playback.
  assert.equal(JSON.stringify(plan.menu).includes('spotify:playlist'), false);

  const picked = resolveBeoremoteSelection(plan, {
    list: 'source',
    index: 1,
    revision: plan.menu.revision,
  });
  assert.equal(picked.ok, true);
  assert.deepEqual(picked.ok && picked.action, { kind: 'lineIn', inputId: 'ms3h9f42' });
});

test('inert entries are visible but not selectable', () => {
  const plan = buildBeoremoteMenu({
    zoneId: 12,
    sources: [{ name: 'Favorites', action: { kind: 'inert' } }, source('Jazz Mix')],
  });
  const picked = resolveBeoremoteSelection(plan, {
    list: 'source',
    index: 0,
    revision: plan.menu.revision,
  });
  assert.deepEqual(picked, { ok: false, reason: 'not-selectable' });
});

test('an out-of-range index is rejected rather than clamped', () => {
  const plan = buildBeoremoteMenu({ zoneId: 12, sources: [source('A')] });
  for (const index of [1, -1, 1.5]) {
    const picked = resolveBeoremoteSelection(plan, {
      list: 'source',
      index,
      revision: plan.menu.revision,
    });
    assert.deepEqual(picked, { ok: false, reason: 'out-of-range' }, `index ${index}`);
  }
});

test('submenu selections resolve against the submenu list', () => {
  const plan = buildBeoremoteMenu({
    zoneId: 12,
    sources: [source('B&O Radio')],
    submenu: [
      { name: 'NPO Radio 2', action: { kind: 'radio', audiopath: 'radio:npo2' } },
      { name: 'RTV Noord', action: { kind: 'radio', audiopath: 'radio:noord' } },
    ],
    submenuOwnerIndex: 0,
  });
  const picked = resolveBeoremoteSelection(plan, {
    list: 'submenu',
    index: 1,
    revision: plan.menu.revision,
  });
  assert.equal(picked.ok && picked.name, 'RTV Noord');
  assert.deepEqual(picked.ok && picked.action, { kind: 'radio', audiopath: 'radio:noord' });
});

test('blank names are skipped so indices stay dense', () => {
  const plan = buildBeoremoteMenu({
    zoneId: 12,
    sources: [source('A'), { name: '   ', action: { kind: 'inert' } }, source('C')],
  });
  assert.deepEqual(plan.menu.sources.map((e) => e.name), ['A', 'C']);
  assert.deepEqual(plan.menu.sources.map((e) => e.index), [0, 1]);
});

test('activeSourceToIndex undoes the protocol offset', () => {
  assert.equal(activeSourceToIndex(20), 0);
  assert.equal(activeSourceToIndex(22), 2);
  assert.equal(activeSourceToIndex(19), null);
});
