import assert from 'node:assert/strict';
import { test } from './testHarness';
import { isBrowserClientId, resolveAnchorLeadMs } from '../src/adapters/outputs/sendspin/sendspinOutput';

// Frames are sent ahead of the play clock so a client has time to place them. 250 ms suits a
// dedicated receiver — a Pi on ethernet with a predictable scheduler. A browser tab is not
// that: measured against one, jitter reached 194 ms against a 246 ms lead, leaving 52 ms of
// margin. One garbage collection past that and the frame is too late to place, which is what a
// listener hears as a stutter.

test('a browser client gets enough lead to survive a GC pause', () => {
  // Measured jitter maxed at ~194 ms; the lead has to leave real room above that.
  const lead = resolveAnchorLeadMs('browser-9001');
  assert.ok(lead >= 1000, `expected at least a second, got ${lead}ms`);
});

test('a dedicated receiver keeps the low-latency lead', () => {
  // Raising it for everything would add latency to every play and seek on hardware that does
  // not need it, and break sync groups tuned around the smaller figure.
  for (const clientId of ['living-room-pi', 'aa:bb:cc:dd:ee:ff', 'kitchen', '']) {
    assert.equal(resolveAnchorLeadMs(clientId), 250, clientId || '(empty)');
  }
});

test('the browser id prefix is what identifies one', () => {
  // The registry mints these as `browser-<zoneId>`; a dedicated receiver never carries it.
  assert.equal(isBrowserClientId('browser-9001'), true);
  assert.equal(isBrowserClientId('BROWSER-9001'), true, 'case does not matter');
  assert.equal(isBrowserClientId('  browser-x  '), true, 'nor does whitespace');
  assert.equal(isBrowserClientId('browserless'), false, 'the hyphen is part of the prefix');
  assert.equal(isBrowserClientId('my-browser-thing'), false, 'and it has to be at the start');
});
