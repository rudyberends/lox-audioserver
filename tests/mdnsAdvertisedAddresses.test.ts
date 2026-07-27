import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from './testHarness';
import {
  advertisableIpv4Addresses,
  defaultLocalIp,
  localIpv4Candidates,
  resolveMdnsHost,
} from '../src/shared/utils/net';
import { MdnsService } from '../src/adapters/discovery/mdnsService';

// A host running containers has bridge interfaces that Node reports as internal:false, so they look
// like real NICs. Advertising one sends a remote device to an address it cannot route -- or to a
// different machine that uses the same private range locally, which fails silently instead of
// loudly. These tests pin the interface selection, because the bug is invisible on a host with no
// containers running.

type FakeIface = NonNullable<ReturnType<typeof os.networkInterfaces>[string]>[number];

function iface(address: string, extra: Partial<FakeIface> = {}): FakeIface {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '02:42:ac:11:00:01',
    internal: false,
    cidr: `${address}/24`,
    ...extra,
  } as FakeIface;
}

function withInterfaces<T>(nets: Record<string, FakeIface[]>, run: () => T): T {
  const original = os.networkInterfaces;
  (os as { networkInterfaces: unknown }).networkInterfaces = () => nets;
  try {
    return run();
  } finally {
    (os as { networkInterfaces: unknown }).networkInterfaces = original;
  }
}

test('the LAN address wins over container bridges regardless of enumeration order', () => {
  // docker0 first: relying on "first non-loopback interface" picked this before.
  const candidates = withInterfaces(
    {
      docker0: [iface('172.17.0.1')],
      'br-9f2c1a': [iface('172.20.0.1')],
      lo: [iface('127.0.0.1', { internal: true })],
      ens160: [iface('192.168.1.209')],
    },
    () => localIpv4Candidates(),
  );
  assert.equal(candidates[0], '192.168.1.209');
  assert.equal(withInterfaces(
    {
      docker0: [iface('172.17.0.1')],
      ens160: [iface('192.168.1.209')],
    },
    () => defaultLocalIp(),
  ), '192.168.1.209');
});

test('a 172.16/12 address on a real NIC stays usable', () => {
  // Docker's default pools live in this range, but so do plenty of real LANs; only the interface
  // name distinguishes them, so the range itself must not be blacklisted.
  const candidates = withInterfaces({ eth0: [iface('172.20.5.4')] }, () => localIpv4Candidates());
  assert.deepEqual(candidates, ['172.20.5.4']);
});

test('link-local and CGNAT addresses are never offered', () => {
  const candidates = withInterfaces(
    {
      eth0: [iface('169.254.10.5')],
      eth1: [iface('100.100.20.3')],
      eth2: [iface('192.168.4.7')],
    },
    () => localIpv4Candidates(),
  );
  assert.deepEqual(candidates, ['192.168.4.7']);
});

test('a bridge address is still offered when it is all we have', () => {
  // Degrading to an unreachable address beats handing out nothing at all.
  const candidates = withInterfaces({ docker0: [iface('172.17.0.1')] }, () => localIpv4Candidates());
  assert.deepEqual(candidates, ['172.17.0.1']);
});

test('advertising never offers a bridge address alongside a real one', () => {
  // localIpv4Candidates keeps bridges as a fallback so callers that need *an* address get one, but
  // an mDNS record set is unordered: publishing both lets the client pick the unroutable half.
  const nets = {
    ens160: [iface('192.168.1.209')],
    docker0: [iface('172.17.0.1')],
    'br-9f2c1a': [iface('172.20.0.1')],
  };
  assert.deepEqual(withInterfaces(nets, () => advertisableIpv4Addresses()), ['192.168.1.209']);
  assert.deepEqual(
    withInterfaces(nets, () => localIpv4Candidates()),
    ['192.168.1.209', '172.17.0.1', '172.20.0.1'],
    'the fallback tier is still available to non-advertising callers',
  );
});

test('publish drops A-records for addresses we would not hand out', () => {
  const service = new MdnsService();
  const records = [
    { type: 'PTR', data: 'whatever' },
    { type: 'SRV', data: { port: 7090 } },
    { type: 'A', data: '192.168.1.209' },
    { type: 'A', data: '172.20.0.1' },
    { type: 'A', data: '172.17.0.1' },
    { type: 'AAAA', data: 'fe80::20c:29ff:fe0e:5497' },
  ];
  const fake = { records: () => records.slice() };

  withInterfaces(
    {
      ens160: [iface('192.168.1.209')],
      docker0: [iface('172.17.0.1')],
      'br-9f2c1a': [iface('172.20.0.1')],
    },
    () => {
      (service as unknown as {
        restrictAdvertisedAddresses: (s: unknown, t: string) => void;
      }).restrictAdvertisedAddresses(fake, 'sonncore');
      const filtered = fake.records();
      const advertised = filtered.filter((r) => r.type === 'A').map((r) => r.data);
      assert.deepEqual(advertised, ['192.168.1.209'], 'only the LAN address may be advertised');
      // Non-A records must survive untouched, or the service stops resolving entirely.
      assert.deepEqual(
        filtered.filter((r) => r.type !== 'A').map((r) => r.type),
        ['PTR', 'SRV', 'AAAA'],
      );
    },
  );
  service.shutdown();
});

// bonjour-service uses the SRV target as the name of every A/AAAA record too, so a bare IP there
// publishes an A-record literally named "192.168.1.209". Resolvers that tie SRV to an address record
// (mdns-sd in the line-in bridge, avahi-resolve) get NXDOMAIN and never see the service; clients
// that read the address set directly still work, which is why this hid for so long.

test('an IP is never advertised as the SRV target', () => {
  assert.equal(resolveMdnsHost('192.168.1.209', undefined), undefined);
  assert.equal(resolveMdnsHost('0.0.0.0', '192.168.1.209'), undefined);
  assert.equal(resolveMdnsHost(undefined, '10.0.0.4'), undefined);
  assert.equal(resolveMdnsHost(undefined, 'fd37:a540::1'), undefined);
  // undefined lets the library fall back to os.hostname(), which publishes a real <host>.local.
});

test('a hostname is passed through unchanged', () => {
  // Verbatim: the library uses this as the SRV target, and qualifying it ourselves would claim a
  // second .local name for a host avahi already answers for.
  assert.equal(resolveMdnsHost('devhost', undefined), 'devhost');
  assert.equal(resolveMdnsHost(undefined, 'audioserver'), 'audioserver');
  assert.equal(resolveMdnsHost('devhost.local', undefined), 'devhost.local');
});

test('nothing usable yields no SRV override', () => {
  assert.equal(resolveMdnsHost(undefined, undefined), undefined);
  assert.equal(resolveMdnsHost('', '   '), undefined);
});
