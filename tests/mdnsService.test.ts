import assert from 'node:assert/strict';
import { test } from './testHarness';
import { MdnsService } from '../src/adapters/discovery/mdnsService';

/**
 * A soft restart must leave the server findable.
 *
 * Everything else survives one: the HTTP API answers, zones come back, music plays. mDNS did not —
 * the responder was destroyed on the way down and the same dead object reused on the way up, so the
 * server stopped announcing itself and no speaker could find it again. Nothing logged an error,
 * because publishing on a destroyed responder simply does nothing.
 */
test('mDNS still advertises after a shutdown and a restart', () => {
  const service = new MdnsService();

  const first = service.publish({ name: 'Test Audioserver', type: 'sonncore', port: 7090 });
  first.stop();
  service.shutdown();

  // The proof is the responder, not the return value: a destroyed one hands back a registration
  // just the same and quietly puts nothing on the wire.
  const before = (service as unknown as { instance: unknown }).instance;
  assert.equal(before, null, 'shutdown lets go of the responder');

  service.publish({ name: 'Test Audioserver', type: 'sonncore', port: 7090 });
  const after = (service as unknown as { instance: unknown }).instance;
  assert.notEqual(after, null, 'publishing again builds a new one');

  service.shutdown();
});
