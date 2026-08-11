import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SonnCoreMdnsService } from '../src/adapters/discovery/sonnCoreMdnsService';
import { SonnCorePeerRegistry } from '../src/adapters/discovery/sonnCorePeerRegistry';
import { buildPublicAudioServersList } from '../src/adapters/discovery/audioServersList';
import { API_ROOT } from '../src/adapters/http/api/apiHandler';
import type { MdnsPort, MdnsPublishOptions } from '../src/ports/MdnsPort';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { HttpServerConfig } from '../src/config/http';

// The advertisement is how an integration offers to set itself up instead of asking for an
// address, so what is in it is a contract. The one that matters is `id`: a config entry
// keyed on the instance name breaks the day someone renames the server, and one keyed on
// the address breaks the day DHCP moves it.

const system = {
  audioserver: {
    name: 'Living room server',
    ip: '192.168.1.50',
    // Written the way a Miniserver hands it over, i.e. not the normalised form.
    macId: '50:4f:94:ff:12:34',
  },
};

const configFake = {
  getSystemConfig: () => system,
  getConfig: () => ({ system, zones: [] }),
} as unknown as ConfigPort;

function capturePublish(): { published: MdnsPublishOptions[]; mdns: MdnsPort } {
  const published: MdnsPublishOptions[] = [];
  const mdns = {
    publish: (options: MdnsPublishOptions) => {
      published.push(options);
      return { stop: () => undefined };
    },
    browse: () => ({ stop: () => undefined }),
    shutdown: () => undefined,
  } as unknown as MdnsPort;
  return { published, mdns };
}

function advertise(): MdnsPublishOptions {
  const { published, mdns } = capturePublish();
  const service = new SonnCoreMdnsService(
    { host: '0.0.0.0', port: 7090 } as unknown as HttpServerConfig,
    configFake,
    mdns,
  );
  service.start();
  assert.equal(published.length, 1);
  return published[0]!;
}

test('the server is advertised as _sonncore._tcp under its configured name', () => {
  const record = advertise();

  assert.equal(record.type, 'sonncore');
  assert.equal(record.protocol, 'tcp');
  assert.equal(record.port, 7090);
  assert.equal(record.name, 'Living room server');
});

test('the advertised id is the one the API reports, so both name the same server', () => {
  const record = advertise();
  const api = buildPublicAudioServersList(
    configFake,
    new SonnCorePeerRegistry(capturePublish().mdns),
  );

  // Not merely "an id": a client that discovers us over mDNS and then reads
  // /api/v1/audio-servers has to be able to tell that it found itself, and a client that
  // stored an id from either surface must recognise the other.
  assert.equal(record.txt?.id, api.selfId);
  // Normalised, not the punctuated form the config holds.
  assert.equal(record.txt?.id, '504F94FF1234');
});

test('the advertisement says where the versioned API lives', () => {
  const record = advertise();

  // Followed rather than hard-coded, so a client lands on the contract this server serves.
  assert.equal(record.txt?.api, API_ROOT);
  assert.match(String(record.txt?.api), /^\/api\/v\d+$/);
  assert.ok(String(record.txt?.version).length > 0);
});

test('an empty value is left out rather than advertised as an empty string', () => {
  const { published, mdns } = capturePublish();
  const bare = {
    getSystemConfig: () => ({ audioserver: { name: '', ip: '', macId: '' } }),
    getConfig: () => ({ system: { audioserver: {} }, zones: [] }),
  } as unknown as ConfigPort;
  new SonnCoreMdnsService(
    { host: '0.0.0.0', port: 7090 } as unknown as HttpServerConfig,
    bare,
    mdns,
  ).start();

  const record = published[0]!;
  // A TXT key present but blank reads as "this server has no id" only if you check for it;
  // most clients would take the empty string and key their config on nothing.
  assert.equal(record.txt?.id, undefined);
  assert.equal(record.txt?.mac, undefined);
  // The server still names itself, so discovery does not silently produce a nameless entry.
  assert.equal(record.name, 'Lox Audio Server');
});
