import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { DlnaInputService } from '../src/adapters/inputs/dlna/dlnaInputService';
import { withDlnaReflection } from '../src/adapters/inputs/dlna/dlnaNotifierTap';
import { makeNotifierFake } from './fakes/notifierPort';
import { AudioType } from '../src/domain/zones/enums';
import type { ZoneState } from '../src/domain/zones/zoneState';
import type { ZoneConfig } from '../src/domain/config/types';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { AirplayController } from '../src/ports/InputsPort';
import type { SsdpAdvertiser } from '@sonn-audio/node-upnp';

// Every zone with the DLNA input on is a UPnP renderer, and a control point
// (Home Assistant's dlna_dmr, a TV) is told what that renderer is doing over
// AVTransport. Before the reflection tap existed it only ever heard about the
// casts it made itself, so a zone playing from our own app reported STOPPED with
// a wall-clock position — the tests below go through the SOAP wire rather than
// the renderer's internals, because that is the only part a control point sees.

class FakeResponse extends EventEmitter {
  public statusCode: number | null = null;
  public headers: Record<string, unknown> = {};
  public body = '';

  public writeHead(status: number, headers?: Record<string, unknown>): this {
    this.statusCode = status;
    if (headers) this.headers = headers;
    return this;
  }

  public write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }

  public end(data?: string | Buffer): void {
    if (data !== undefined) this.body += data.toString();
    this.emit('finish');
  }
}

function zoneState(overrides: Partial<ZoneState> = {}): ZoneState {
  return {
    id: 3,
    name: 'Kitchen',
    mode: 'play',
    power: 'on',
    clientState: 'on',
    time: 42.7,
    duration: 210,
    volume: 40,
    plrepeat: 0,
    plshuffle: 0,
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    coverurl: 'http://cover',
    station: '',
    sourceName: 'Library',
    audiopath: 'library://track/9',
    audiotype: AudioType.File,
    type: 2,
    eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    qindex: 0,
    ...overrides,
  } as ZoneState;
}

const ssdpFake = {
  addDevice: () => {
    /* advertising is not what these tests are about */
  },
  removeDevice: () => {
    /* idem */
  },
} as unknown as SsdpAdvertiser;

const configFake = {
  getConfig: () => ({ system: { audioserver: { ip: '10.0.0.5' } } }),
} as unknown as ConfigPort;

const controllerFake = {} as AirplayController;

function dlnaZone(id: number): ZoneConfig {
  return { id, name: 'Kitchen', inputs: { dlna: { enabled: true } } } as unknown as ZoneConfig;
}

/** Ask the renderer a SOAP question the way a control point does. */
async function soap(service: DlnaInputService, zoneId: number, action: string): Promise<string> {
  const envelope =
    '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">` +
    `<InstanceID>0</InstanceID></u:${action}></s:Body></s:Envelope>`;
  // Buffers, not strings: the module concats the chunks it reads off the request.
  const req = Readable.from([Buffer.from(envelope)]) as unknown as IncomingMessage;
  (req as { method?: string }).method = 'POST';
  (req as { headers?: Record<string, string> }).headers = {
    soapaction: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
  };
  const res = new FakeResponse();
  await service.handle(req, res as unknown as ServerResponse, `/dlna-renderer/${zoneId}/avt/control`);
  return res.body;
}

/** The transport state a control point would read out of a GetTransportInfo reply. */
async function transportState(service: DlnaInputService, zoneId: number): Promise<string> {
  const body = await soap(service, zoneId, 'GetTransportInfo');
  return /<CurrentTransportState>([^<]*)</.exec(body)?.[1] ?? '';
}

function makeService(): DlnaInputService {
  const service = new DlnaInputService(configFake, ssdpFake, 7090);
  service.configure(controllerFake);
  service.syncZones([dlnaZone(3)]);
  return service;
}

test('a renderer reports the zone playing, not the last thing cast at it', async () => {
  const service = makeService();

  // Nothing was ever cast to this renderer, and it knows nothing about the zone —
  // which is the whole point: this is a zone playing from our own app, a Loxone
  // panel or a favourite.
  assert.equal(await transportState(service, 3), 'NO_MEDIA_PRESENT');

  service.reflectZoneState(zoneState({ mode: 'play' }));
  assert.equal(await transportState(service, 3), 'PLAYING');

  service.reflectZoneState(zoneState({ mode: 'pause' }));
  assert.equal(await transportState(service, 3), 'PAUSED_PLAYBACK');
});

test('a stopped zone with nothing loaded says so, so no play button is offered', async () => {
  const service = makeService();

  service.reflectZoneState(zoneState({ mode: 'stop', audiopath: 'library://track/9' }));
  assert.equal(await transportState(service, 3), 'STOPPED');

  // An empty audiopath is a zone with nothing to resume — a different answer to a
  // control point than "stopped, press play".
  service.reflectZoneState(zoneState({ mode: 'stop', audiopath: '' }));
  assert.equal(await transportState(service, 3), 'NO_MEDIA_PRESENT');
});

test('the timeline comes from the zone, not from wall-clock since Play', async () => {
  const service = makeService();

  // Without a reflected position the module estimates from its own last Play, which
  // for a renderer that was never cast to is zero.
  assert.match(await soap(service, 3, 'GetPositionInfo'), /<RelTime>0:00:00<\/RelTime>/);

  service.reflectZoneState(zoneState({ time: 42.7, duration: 210 }));
  const info = await soap(service, 3, 'GetPositionInfo');
  // 42.7s into a 3:30 track. A DLNA clock has no fraction, so the module rounds.
  assert.match(info, /<RelTime>0:00:43<\/RelTime>/);
  assert.match(info, /<TrackDuration>0:03:30<\/TrackDuration>/);
});

test('reflecting a zone without a renderer is a no-op, not a crash', () => {
  const service = makeService();
  // Zone 9 has the DLNA input off, which is the default: most zones have no renderer
  // and every one of their state changes still passes through the tap.
  service.reflectZoneState(zoneState({ id: 9 }));
});

test('the tap forwards every notification and survives a failing renderer', () => {
  const delivered: number[] = [];
  const inner = { ...makeNotifierFake(), notifyZoneStateChanged: (s: ZoneState) => delivered.push(s.id) };
  const reflected: number[] = [];

  const notifier = withDlnaReflection(inner, () => ({
    reflectZoneState: (s) => {
      reflected.push(s.id);
      throw new Error('a subscriber went away mid-notify');
    },
  }));

  notifier.notifyZoneStateChanged(zoneState({ id: 3 }));

  // The zone's own state delivery is what the server runs on; a renderer whose
  // subscriber died must not be able to take it down.
  assert.deepEqual(delivered, [3]);
  assert.deepEqual(reflected, [3]);
});

test('the tap tolerates a renderer service that does not exist yet', () => {
  const delivered: number[] = [];
  const inner = { ...makeNotifierFake(), notifyZoneStateChanged: (s: ZoneState) => delivered.push(s.id) };

  // The service is constructed after the notifier it decorates, so the very first
  // notifications can legitimately arrive before there is anything to reflect onto.
  const notifier = withDlnaReflection(inner, () => null);
  notifier.notifyZoneStateChanged(zoneState({ id: 3 }));

  assert.deepEqual(delivered, [3]);
});
