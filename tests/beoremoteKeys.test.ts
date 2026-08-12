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
  assert.deepEqual(resolveKeyAction(207), { kind: 'transport', command: 'play' });
  assert.deepEqual(resolveKeyAction(119), { kind: 'transport', command: 'pause' });
  assert.deepEqual(resolveKeyAction(163), { kind: 'transport', command: 'next' });
  assert.deepEqual(resolveKeyAction(165), { kind: 'transport', command: 'previous' });
});

test('116 (KEY_POWER) is the fixed standby key', () => {
  assert.deepEqual(resolveKeyAction(116), { kind: 'standby' });
});

test('the step keys are known but not bound to transport', () => {
  // Seen on the hardware (KEY_CHANNELUP/DOWN). They answer as a known button rather
  // than a 404, so the client's log stays about genuinely new keys -- but nothing is
  // bound to them until someone says what they should do.
  assert.deepEqual(resolveKeyAction(402), { kind: 'unassigned', label: 'step-up' });
  assert.deepEqual(resolveKeyAction(403), { kind: 'unassigned', label: 'step-down' });
});

test('yellow carries the lowest of the four colour codes', () => {
  // Measured by pressing red, green, yellow, blue in that order: 257, 258, 256, 259.
  // The remote does not number its colours the way it prints them.
  assert.deepEqual(resolveKeyAction(256), { kind: 'favorite', slot: 3 });
  assert.deepEqual(resolveKeyAction(259), { kind: 'favorite', slot: 4 });
});

test('the dot keys are not contiguous', () => {
  // 273, 275, 270, 272 — in that order on the remote, which is not code order.
  assert.deepEqual(resolveKeyAction(273), { kind: 'favorite', slot: 5 });
  assert.deepEqual(resolveKeyAction(275), { kind: 'favorite', slot: 6 });
  assert.deepEqual(resolveKeyAction(270), { kind: 'favorite', slot: 7 });
  assert.deepEqual(resolveKeyAction(272), { kind: 'favorite', slot: 8 });
  // 274 sits between two dot codes and is deliberately NOT a dot key.
  assert.equal(resolveKeyAction(274), null);
});

test('digits 1-6 select a disc', () => {
  assert.deepEqual(resolveKeyAction(261), { kind: 'disc', disc: 1 });
  assert.deepEqual(resolveKeyAction(266), { kind: 'disc', disc: 6 });
  // 267 would be "digit 7" if the range continued; the changer has six slots.
  assert.equal(resolveKeyAction(267), null);
});

test('colour keys and dots together cover favorites 1-8 exactly once', () => {
  const slots = [257, 258, 256, 259, 273, 275, 270, 272].map((code) => {
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
  const nav = resolveKeyAction(402);
  assert.equal(nav?.kind, 'unassigned');
  assert.equal(resolveKeyAction(403)?.kind, 'unassigned', 'the step keys are known but unbound');
});

test('an unconfigured zone keeps the old defaults', () => {
  // Making these configurable must not change what an existing install does.
  assert.deepEqual(resolveKeyAction(257, undefined), { kind: 'favorite', slot: 1 });
  assert.deepEqual(resolveKeyAction(272, {}), { kind: 'favorite', slot: 8 });
});

test('a bound key overrides its default slot', () => {
  const bindings = { red: { kind: 'favorite' as const, slot: 4 } };
  assert.deepEqual(resolveKeyAction(257, bindings), { kind: 'favorite', slot: 4 });
  // Buttons the config does not mention are untouched.
  assert.deepEqual(resolveKeyAction(258, bindings), { kind: 'favorite', slot: 2 });
});

test('a key can be bound to a line-in or a radio station', () => {
  assert.deepEqual(resolveKeyAction(259, { blue: { kind: 'lineIn', inputId: 'in-1' } }), {
    kind: 'lineIn',
    inputId: 'in-1',
  });
  assert.deepEqual(
    resolveKeyAction(258, { green: { kind: 'radio', audiopath: 'tunein:station:x', name: 'NPO' } }),
    { kind: 'radio', audiopath: 'tunein:station:x' },
  );
});

test('a key switched off is dead, which differs from unconfigured', () => {
  const off = resolveKeyAction(256, { yellow: { kind: 'none' } });
  assert.equal(off?.kind, 'unassigned');
  // Unconfigured would have been favorite slot 3.
  assert.deepEqual(resolveKeyAction(256, {}), { kind: 'favorite', slot: 3 });
});

test('bindings cannot reach the fixed keys', () => {
  // Transport and disc are not the user's to remap; a stray entry must not apply.
  const bindings = { next: { kind: 'none' as const }, '163': { kind: 'none' as const } };
  assert.deepEqual(resolveKeyAction(163, bindings), { kind: 'transport', command: 'next' });
  assert.deepEqual(resolveKeyAction(263, bindings), { kind: 'disc', disc: 3 });
});

test('button-to-code mapping stays hardware, not preference', () => {
  assert.equal(codeForAssignableButton('yellow'), 256);
  assert.equal(codeForAssignableButton('blue'), 259);
  assert.equal(assignableButtonForCode(270), 'dot3');
  assert.deepEqual(
    ASSIGNABLE_BUTTONS.map(defaultFavoriteSlot),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test('a code nobody has ever seen is simply unknown', () => {
  assert.equal(resolveKeyAction(127), null);
  assert.equal(resolveKeyAction(255), null);
});

test('parseKeyCode accepts the shapes a client might send', () => {
  // A number is what the client sends; the hex spellings are there so a code copied
  // out of a log or a bug report can be pasted in as-is.
  assert.equal(parseKeyCode(163), 163);
  assert.equal(parseKeyCode('0xa3'), 163);
  assert.equal(parseKeyCode('0XA3'), 163);
  assert.equal(parseKeyCode('a3'), 163);
  assert.equal(parseKeyCode(' 0xa3 '), 163);
});

test('parseKeyCode rejects nonsense rather than guessing', () => {
  for (const bad of ['', '   ', 'zz', null, undefined, {}, -1, 1.5, 0x10000]) {
    assert.equal(parseKeyCode(bad), null, String(bad));
  }
});

test('formatKeyCode spells a code the way the client reports it', () => {
  // Plain decimal, which is what comes off the kernel and what someone reads in the
  // client's log -- so a code seen there can be searched for here without conversion.
  assert.equal(formatKeyCode(163), '163');
  assert.equal(formatKeyCode(257), '257');
});
