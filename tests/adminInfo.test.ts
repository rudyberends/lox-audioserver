import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { buildMiscRoutes } from '../src/adapters/http/adminApi/misc/miscHandlers';

// /info answers without a session because the Admin UI has to know whether to show a
// login form or a create-admin welcome before it can authenticate. That bootstrap needs
// three flags; the rest of the payload used to be readable by anyone on the network.

const MAC = '000C290E5497';
const MINISERVER_IP = '192.168.1.200';
const MINISERVER_SERIAL = '504F9411157A';

function fetchInfo(authenticated: boolean): { status?: number; body?: any } {
  const sent: { status?: number; body?: any } = {};
  const deps = {
    isAuthenticated: () => authenticated,
    log: { error: () => {}, warn: () => {} },
    configPort: {
      getConfig: () => ({
        system: {
          audioserver: {
            name: 'Test Audioserver',
            macId: MAC,
            paired: true,
            setupComplete: true,
            loxoneEnabled: true,
            extensions: [],
          },
          miniserver: { ip: MINISERVER_IP, serial: MINISERVER_SERIAL },
          // hasAdminUser reads system.users, and needs a usable account: both a
          // username and a password, with admin set.
          users: [{ username: 'admin', password: 'secret', admin: true }],
        },
        zones: [{ id: 1 }],
      }),
    },
    groupManager: {},
    snapcastCore: {},
    sonnCorePeers: {},
    runtimeConfig: {
      loxone: { firmwareVersion: 'f', apiVersion: 'a' },
      http: { publicDir: '/tmp' },
    },
    readJsonBody: async () => null,
    sendJson: (_res: ServerResponse, status: number, body: unknown) => {
      sent.status = status;
      sent.body = body;
    },
  } as any;

  const route = buildMiscRoutes(deps).find((r) => r.pattern.source === /^\/info$/.source);
  assert.ok(route, '/info route exists');
  route!.handler({} as IncomingMessage, {} as ServerResponse, [] as any);
  return sent;
}

test('info answers without a session, so the UI can pick login or first-run', () => {
  const sent = fetchInfo(false);
  assert.equal(sent.status, 200, 'never 401 — a 401 cannot say which screen to show');
  assert.equal(sent.body.hasAdminUser, true);
  assert.equal(sent.body.paired, true);
  assert.equal(sent.body.setupComplete, true);
});

test('info tells an anonymous caller nothing beyond those three flags', () => {
  const sent = fetchInfo(false);
  assert.deepEqual(
    Object.keys(sent.body).sort(),
    ['hasAdminUser', 'paired', 'setupComplete'],
    'anything else is only interesting once you are in',
  );

  const json = JSON.stringify(sent.body);
  assert.ok(!json.includes(MAC), 'no serial/MAC');
  assert.ok(!json.includes(MINISERVER_IP), "no Miniserver's address");
  assert.ok(!json.includes(MINISERVER_SERIAL), "no Miniserver's serial");
  assert.ok(!json.includes('Test Audioserver'), 'not even the server name');
});

test('info still reports everything to an authenticated caller', () => {
  const sent = fetchInfo(true);
  assert.equal(sent.status, 200);
  for (const field of [
    'hasAdminUser',
    'paired',
    'setupComplete',
    'version',
    'name',
    'serial',
    'miniserverIp',
    'miniserverSerial',
    'zones',
    'packages',
    'player',
    'loxoneEnabled',
    'containerized',
    'restartSupervised',
  ]) {
    assert.ok(field in sent.body, `${field} is still reported once logged in`);
  }
  assert.equal(sent.body.serial, MAC);
  assert.equal(sent.body.miniserverIp, MINISERVER_IP);
});
