import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { test } from './testHarness';
import { AirplayInstance } from '../src/adapters/inputs/airplay/airplayInstance';
import type { AirplayInstanceController } from '../src/adapters/inputs/airplay/airplayInstance';
import type { MdnsPort, MdnsPublishOptions } from '../src/ports/MdnsPort';
import type { PlayerRegistryPort } from '../src/ports/PlayerRegistryPort';
import type { ZoneAirplayConfig } from '../src/domain/config/types';

// #363. Moving the receiver to node-airplay left the mDNS advertisement to the caller, and the
// caller let the responder default the SRV target to this machine's own hostname: a bare label
// outside `.local`. A sender then drops the address records that arrived with it and asks unicast
// DNS instead -- which in a container, where that name is `sonn-core`, answers nothing at all. The
// zone still browses, so it stays in the picker; it just cannot be reached. These pin the three
// things the native receiver did right and the port did not.

type FakeIface = NonNullable<ReturnType<typeof os.networkInterfaces>[string]>[number];

function iface(address: string): FakeIface {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '02:42:ac:11:00:01',
    internal: false,
    cidr: `${address}/24`,
  } as FakeIface;
}

async function withInterfaces(nets: Record<string, FakeIface[]>, run: () => Promise<void>): Promise<void> {
  const original = os.networkInterfaces;
  (os as { networkInterfaces: unknown }).networkInterfaces = () => nets;
  try {
    await run();
  } finally {
    (os as { networkInterfaces: unknown }).networkInterfaces = original;
  }
}

const noop = (): void => {};

const controller: AirplayInstanceController = {
  startPlayback: noop,
  updateMetadata: noop,
  updateCover: () => undefined,
  updateVolume: noop,
  updateTiming: noop,
  pausePlayback: noop,
  resumePlayback: noop,
  stopPlayback: noop,
};

const playerRegistry = { getPlayer: () => null } as unknown as PlayerRegistryPort;

/** Records what the zone asked to publish; nothing reaches the network. */
function recordingMdns(): { mdns: MdnsPort; published: MdnsPublishOptions[]; stopped: number } {
  const state = {
    published: [] as MdnsPublishOptions[],
    stopped: 0,
    mdns: {} as MdnsPort,
  };
  state.mdns = {
    publish: (options: MdnsPublishOptions) => {
      state.published.push(options);
      return { stop: () => (state.stopped += 1) };
    },
    browse: () => ({ stop: noop }),
    shutdown: noop,
  };
  return state;
}

async function withZone(
  config: ZoneAirplayConfig,
  run: (published: MdnsPublishOptions) => void,
): Promise<void> {
  const recorder = recordingMdns();
  const zone = new AirplayInstance(
    5,
    '03-Schlafzimmer',
    '88AEDD681068',
    config,
    controller,
    playerRegistry,
    recorder.mdns,
  );
  try {
    await zone.start();
    assert.equal(recorder.published.length, 1, 'the zone advertises exactly one service');
    run(recorder.published[0] as MdnsPublishOptions);
  } finally {
    await zone.stop();
  }
}

test('a zone advertises a .local hostname of its own, not this machine\'s name', async () => {
  await withZone({ enabled: true, port: 6205 }, (published) => {
    const label = String(published.name).split('@')[0];
    assert.match(
      String(published.host),
      /^[0-9A-F]{12}\.local$/,
      'the SRV target must be a .local name a sender can resolve over mDNS',
    );
    assert.equal(published.host, `${label}.local`, 'and it must name this zone, not another');
  });
});

test('a zone advertises only the address it is reachable on', async () => {
  // bonjour-service builds A-records from every interface; a host running containers then offers a
  // bridge address next to the real one, and an mDNS address set is unordered.
  await withInterfaces(
    { ens160: [iface('192.168.9.9')], docker0: [iface('172.17.0.1')] },
    () =>
      withZone({ enabled: true, port: 6206 }, (published) => {
        assert.deepEqual(published.addresses, ['192.168.9.9']);
      }),
  );
});

test('a bridge address is never pinned, even when it is the only one found', async () => {
  // The zone's own address lookup takes the first non-internal interface it sees, so on a host
  // whose bridge enumerates first it hands back an unroutable address. Pinning that would be worse
  // than pinning nothing: the responder's own filtering is the better answer.
  await withInterfaces({ docker0: [iface('172.17.0.1')] }, () =>
    withZone({ enabled: true, port: 6209 }, (published) => {
      assert.equal(published.addresses, undefined);
    }),
  );
});

test('a taken port costs the zone a port, not its receiver', async () => {
  // Zones derive their base port from their id, so a stale process or a second server can hold it.
  // Binding the base port alone turned that into a room that never appeared.
  const squatter = net.createServer();
  await new Promise<void>((resolve, reject) => {
    squatter.once('error', reject);
    squatter.listen(6207, () => resolve());
  });
  try {
    await withZone({ enabled: true, port: 6207 }, (published) => {
      assert.equal(published.port, 6208, 'the scan moves on to the next port in the range');
    });
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});
