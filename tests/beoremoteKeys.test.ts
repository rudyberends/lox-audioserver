import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  ASSIGNABLE_BUTTONS,
  assignableButtonForCode,
  codeForAssignableButton,
  defaultFavoriteSlot,
  formatKeyCode,
  parseKeyCode,
  resolveKeyAction,
} from '../src/application/beoremote/beoremoteKeys';

// Every code here was measured against the hardware one button at a time. They are
// not derivable, so this file is the record: if someone "tidies" the table into a
// range, these tests are what catches it.

test('transport keys map to the four transport verbs', () => {
  assert.deepEqual(resolveKeyAction(0xb0), { kind: 'transport', command: 'play' });
  assert.deepEqual(resolveKeyAction(0xb1), { kind: 'transport', command: 'pause' });
  assert.deepEqual(resolveKeyAction(0xb5), { kind: 'transport', command: 'next' });
  assert.deepEqual(resolveKeyAction(0xb6), { kind: 'transport', command: 'previous' });
});

test('the second step pair is an alias, not a replacement', () => {
  // A different physical control reporting the same intent. Both pairs stay live
  // because a remote may send either.
  assert.deepEqual(resolveKeyAction(0x9c), { kind: 'transport', command: 'next' });
  assert.deepEqual(resolveKeyAction(0x9d), { kind: 'transport', command: 'previous' });
  assert.deepEqual(resolveKeyAction(0x9c), resolveKeyAction(0xb5));
  assert.deepEqual(resolveKeyAction(0x9d), resolveKeyAction(0xb6));
});

test('yellow and blue are the reverse of the expected order', () => {
  // The single most surprising fact in the table: 0x03 is yellow, 0x04 is blue.
  assert.deepEqual(resolveKeyAction(0x03), { kind: 'favorite', slot: 3 });
  assert.deepEqual(resolveKeyAction(0x04), { kind: 'favorite', slot: 4 });
});

test('the dot keys are not contiguous', () => {
  // 0x12, 0x14, 0x0f, 0x11 — in that order on the remote, which is not code order.
  assert.deepEqual(resolveKeyAction(0x12), { kind: 'favorite', slot: 5 });
  assert.deepEqual(resolveKeyAction(0x14), { kind: 'favorite', slot: 6 });
  assert.deepEqual(resolveKeyAction(0x0f), { kind: 'favorite', slot: 7 });
  assert.deepEqual(resolveKeyAction(0x11), { kind: 'favorite', slot: 8 });
  // 0x13 sits between two dot codes and is deliberately NOT a dot key.
  assert.equal(resolveKeyAction(0x13), null);
});

test('digits 1-6 select a disc', () => {
  assert.deepEqual(resolveKeyAction(0x06), { kind: 'disc', disc: 1 });
  assert.deepEqual(resolveKeyAction(0x0b), { kind: 'disc', disc: 6 });
  // 0x0c would be "digit 7" if the range continued; the changer has six slots.
  assert.equal(resolveKeyAction(0x0c), null);
});

test('colour keys and dots together cover favorites 1-8 exactly once', () => {
  const slots = [0x01, 0x02, 0x03, 0x04, 0x12, 0x14, 0x0f, 0x11].map((code) => {
    const action = resolveKeyAction(code);
    return action?.kind === 'favorite' ? action.slot : null;
  });
  assert.deepEqual(slots.slice().sort((a, b) => (a ?? 0) - (b ?? 0)), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('volume is absent — it stays on the player', () => {
  // Routing volume over HTTP would be six calls per press and would break whenever
  // the server blinks; the bridge handles it locally.
  assert.equal(resolveKeyAction(0xe9), null);
  assert.equal(resolveKeyAction(0xea), null);
});

test('observed-but-unidentified codes report as known, not as missing', () => {
  // They answer 404 either way, but naming them keeps the bridge's log about
  // genuinely new buttons rather than ones we already know we have not mapped.
  const nav = resolveKeyAction(0x41);
  assert.equal(nav?.kind, 'unassigned');
  assert.equal(resolveKeyAction(0x10)?.kind, 'unassigned', 'menu is known but unbound');
});

test('an unconfigured zone keeps the old defaults', () => {
  // Making these configurable must not change what an existing install does.
  assert.deepEqual(resolveKeyAction(0x01, undefined), { kind: 'favorite', slot: 1 });
  assert.deepEqual(resolveKeyAction(0x11, {}), { kind: 'favorite', slot: 8 });
});

test('a bound key overrides its default slot', () => {
  const bindings = { red: { kind: 'favorite' as const, slot: 4 } };
  assert.deepEqual(resolveKeyAction(0x01, bindings), { kind: 'favorite', slot: 4 });
  // Buttons the config does not mention are untouched.
  assert.deepEqual(resolveKeyAction(0x02, bindings), { kind: 'favorite', slot: 2 });
});

test('a key can be bound to a line-in or a radio station', () => {
  assert.deepEqual(resolveKeyAction(0x04, { blue: { kind: 'lineIn', inputId: 'in-1' } }), {
    kind: 'lineIn',
    inputId: 'in-1',
  });
  assert.deepEqual(
    resolveKeyAction(0x02, { green: { kind: 'radio', audiopath: 'tunein:station:x', name: 'NPO' } }),
    { kind: 'radio', audiopath: 'tunein:station:x' },
  );
});

test('a key switched off is dead, which differs from unconfigured', () => {
  const off = resolveKeyAction(0x03, { yellow: { kind: 'none' } });
  assert.equal(off?.kind, 'unassigned');
  // Unconfigured would have been favorite slot 3.
  assert.deepEqual(resolveKeyAction(0x03, {}), { kind: 'favorite', slot: 3 });
});

test('bindings cannot reach the fixed keys', () => {
  // Transport and disc are not the user's to remap; a stray entry must not apply.
  const bindings = { next: { kind: 'none' as const }, '0xb5': { kind: 'none' as const } };
  assert.deepEqual(resolveKeyAction(0xb5, bindings), { kind: 'transport', command: 'next' });
  assert.deepEqual(resolveKeyAction(0x08, bindings), { kind: 'disc', disc: 3 });
});

test('button-to-code mapping stays hardware, not preference', () => {
  assert.equal(codeForAssignableButton('yellow'), 0x03);
  assert.equal(codeForAssignableButton('blue'), 0x04);
  assert.equal(assignableButtonForCode(0x0f), 'dot3');
  assert.deepEqual(
    ASSIGNABLE_BUTTONS.map(defaultFavoriteSlot),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test('a code nobody has ever seen is simply unknown', () => {
  assert.equal(resolveKeyAction(0x7f), null);
  assert.equal(resolveKeyAction(0xff), null);
});

test('parseKeyCode accepts the shapes a bridge might send', () => {
  assert.equal(parseKeyCode('0xb5'), 0xb5);
  assert.equal(parseKeyCode('0XB5'), 0xb5);
  assert.equal(parseKeyCode('b5'), 0xb5);
  assert.equal(parseKeyCode(' 0xb5 '), 0xb5);
  assert.equal(parseKeyCode(0xb5), 0xb5);
});

test('parseKeyCode rejects nonsense rather than guessing', () => {
  for (const bad of ['', '   ', 'zz', null, undefined, {}, -1, 1.5, 0x10000]) {
    assert.equal(parseKeyCode(bad), null, String(bad));
  }
});

test('formatKeyCode round-trips the table spelling', () => {
  assert.equal(formatKeyCode(0xb5), '0xb5');
  assert.equal(formatKeyCode(0x01), '0x01');
  assert.equal(parseKeyCode(formatKeyCode(0x0f)), 0x0f);
});
