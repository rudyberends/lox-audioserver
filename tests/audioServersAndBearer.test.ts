import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { extractSessionId } from '../src/adapters/http/adminApi/auth/adminSessionStore';
import { AUTH_COOKIE_NAME } from '../src/adapters/http/adminApi/auth/types';
import { buildMiscRoutes, type MiscHandlerDeps } from '../src/adapters/http/adminApi/misc/miscHandlers';

class FakeResponse extends EventEmitter {
  public statusCode: number | null = null;
  public body = '';
  public writableEnded = false;
  public end(data?: string | Buffer): void {
    if (data !== undefined) this.body += data.toString();
    this.writableEnded = true;
    this.emit('finish');
  }
}

function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test('extractSessionId prefers the Authorization bearer token', () => {
  const req = fakeReq({
    authorization: 'Bearer tok-from-header',
    cookie: `${AUTH_COOKIE_NAME}=tok-from-cookie`,
  });
  assert.equal(extractSessionId(req), 'tok-from-header');
});

test('extractSessionId falls back to the auth cookie', () => {
  const req = fakeReq({ cookie: `${AUTH_COOKIE_NAME}=tok-from-cookie` });
  assert.equal(extractSessionId(req), 'tok-from-cookie');
});

test('extractSessionId returns undefined without a token or cookie', () => {
  assert.equal(extractSessionId(fakeReq({})), undefined);
});

test('extractSessionId reads the token query param (for EventSource/WebSocket)', () => {
  const req = { headers: {}, url: '/admin/api/logs/stream?token=tok-from-query' } as unknown as IncomingMessage;
  assert.equal(extractSessionId(req), 'tok-from-query');
});

// Mirrors the real rawAudioConfig.raw shape: an array of single-key {<MAC>: section} objects.
const RAW_AUDIO_CONFIG = {
  raw: [
    { '000C29678C56': { name: 'Audioserver', host: '192.168.1.252', ip: '192.168.1.200', port: 80, uuid: 'u1', master: '504f9411157a' } },
    { '000C290E5497': { name: 'Test Audioserver', host: '192.168.1.209', ip: '192.168.1.200', port: 80, uuid: 'u2', master: '504f9411157a' } },
  ],
  rawString: null,
  crc32: 'abc',
};

function audioServersRoute() {
  const deps = {
    log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, spam: () => {} },
    configPort: {
      getConfig: () => ({
        system: { audioserver: { macId: '000c290e5497' } },
        rawAudioConfig: RAW_AUDIO_CONFIG,
      }),
    },
    sendJson: (res: ServerResponse, status: number, body: unknown) => {
      const fake = res as unknown as FakeResponse;
      fake.statusCode = status;
      fake.end(JSON.stringify(body));
    },
    // Fake mDNS peer registry: the peer .252 advertises lox-audioserver, an unrelated mac doesn't.
    sonnCorePeers: { has: (mac: string) => mac === '000C29678C56' },
  } as unknown as MiscHandlerDeps;
  const routes = buildMiscRoutes(deps);
  const route = routes.find((r) => r.method === 'GET' && r.pattern.test('/audioservers'));
  assert.ok(route, 'no /audioservers route');
  return route!;
}

test('GET /audioservers lists every peer and flags self by macId', async () => {
  const route = audioServersRoute();
  const res = new FakeResponse();
  await route.handler({ headers: {} } as IncomingMessage, res as unknown as ServerResponse, '/audioservers'.match(route.pattern)!, '/audioservers');
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body) as {
    self: string;
    servers: Array<{ macId: string; name: string; host: string; isSelf: boolean; isSonnCore: boolean }>;
  };
  assert.equal(payload.self, '000C290E5497');
  assert.equal(payload.servers.length, 2);
  const self = payload.servers.find((s) => s.macId === '000C290E5497');
  const peer = payload.servers.find((s) => s.macId === '000C29678C56');
  assert.equal(self?.isSelf, true);
  assert.equal(self?.name, 'Test Audioserver');
  assert.equal(peer?.isSelf, false);
  assert.equal(peer?.host, '192.168.1.252');
  // Self is always ours; the peer is flagged from the mDNS registry.
  assert.equal(self?.isSonnCore, true);
  assert.equal(peer?.isSonnCore, true);
});

test('GET /audioservers flags a non-advertising server (real Loxone) as not lox-audioserver', async () => {
  // Same config, but the registry knows of no peers — only self should be flagged ours.
  const deps = {
    log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, spam: () => {} },
    configPort: {
      getConfig: () => ({
        system: { audioserver: { macId: '000c290e5497' } },
        rawAudioConfig: RAW_AUDIO_CONFIG,
      }),
    },
    sendJson: (res: ServerResponse, status: number, body: unknown) => {
      const fake = res as unknown as FakeResponse;
      fake.statusCode = status;
      fake.end(JSON.stringify(body));
    },
    sonnCorePeers: { has: () => false },
  } as unknown as MiscHandlerDeps;
  const route = buildMiscRoutes(deps).find((r) => r.method === 'GET' && r.pattern.test('/audioservers'))!;
  const res = new FakeResponse();
  await route.handler({ headers: {} } as IncomingMessage, res as unknown as ServerResponse, '/audioservers'.match(route.pattern)!, '/audioservers');
  const payload = JSON.parse(res.body) as {
    servers: Array<{ macId: string; isSonnCore: boolean }>;
  };
  const self = payload.servers.find((s) => s.macId === '000C290E5497');
  const peer = payload.servers.find((s) => s.macId === '000C29678C56');
  assert.equal(self?.isSonnCore, true);
  assert.equal(peer?.isSonnCore, false);
});
