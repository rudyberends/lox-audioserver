import assert from 'node:assert/strict';
import { test } from './testHarness';
import { BrowserZoneRegistry } from '../src/application/zones/browserZoneRegistry';
import type { ZoneManagerFacade } from '../src/application/zones/createZoneManager';

// Every tab sends the same name — a player cannot know it is the second one — so a room list
// showed four entries called "This browser" and a user could not tell which was playing.
// Numbering belongs on the server because only it can see the others.

const fakeZones = () =>
  ({
    replaceZones: async () => undefined,
    removeZone: async () => undefined,
  }) as unknown as ZoneManagerFacade;

test('identical names are numbered, in registration order', async () => {
  const registry = new BrowserZoneRegistry(fakeZones());
  const names: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    names.push((await registry.register({ name: 'This browser' })).name);
  }
  assert.deepEqual(names, ['This browser', 'This browser 2', 'This browser 3']);
});

test('a distinct name is left exactly as given', async () => {
  const registry = new BrowserZoneRegistry(fakeZones());
  await registry.register({ name: 'Kitchen tab' });
  const other = await registry.register({ name: 'Study tab' });
  assert.equal(other.name, 'Study tab');
});

test('a freed name is reused rather than counting upward forever', async () => {
  // Close two tabs and open one: it should be "This browser" again, not "… 4".
  const registry = new BrowserZoneRegistry(fakeZones());
  const first = await registry.register({ name: 'This browser' });
  const second = await registry.register({ name: 'This browser' });
  assert.equal(second.name, 'This browser 2');
  await registry.unregister(first.zoneId);
  assert.equal((await registry.register({ name: 'This browser' })).name, 'This browser');
});

test('reclaiming keeps the name it already had', async () => {
  // A page reload sends the same clientId and must not be renamed to "… 2" for colliding
  // with itself.
  const registry = new BrowserZoneRegistry(fakeZones());
  const first = await registry.register({ name: 'This browser', serial: 'browser-mine' });
  const again = await registry.register({ name: 'This browser', serial: 'browser-mine' });
  assert.equal(again.zoneId, first.zoneId);
  assert.equal(again.name, 'This browser');
});

test('a client that sends no name gets a distinct one anyway', async () => {
  const registry = new BrowserZoneRegistry(fakeZones());
  const a = await registry.register({});
  const b = await registry.register({});
  assert.notEqual(a.name, b.name);
});

test('ownership is visible while the zone is being published', async () => {
  let registry: BrowserZoneRegistry;
  let publishedZoneId = 0;
  const zones = {
    replaceZones: async (configs: Array<{ id: number }>) => {
      publishedZoneId = configs[0]!.id;
      assert.equal(registry.ownerOf(publishedZoneId), 'browser-mine');
    },
    removeZone: async () => undefined,
  } as unknown as ZoneManagerFacade;
  registry = new BrowserZoneRegistry(zones);

  await registry.register({ serial: 'browser-mine' });
  assert.equal(registry.ownerOf(publishedZoneId), 'browser-mine');
});
