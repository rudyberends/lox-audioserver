import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { buildLineInRoutes } from '../src/adapters/http/adminApi/linein/lineInAdminHandlers';
import type { LineInApiHandler } from '../src/adapters/http/lineInApi/lineInApiHandler';

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

const log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, spam: () => {} } as any;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const fake = res as unknown as FakeResponse;
  fake.statusCode = status;
  fake.end(JSON.stringify(body));
}

const KNOWN_INPUT = '1000001';
const fakeLineInApi = {
  listBridgesForAdmin: () => [{ bridge_id: 'b1', assigned_input_id: KNOWN_INPUT }],
  getBridgeStatusForAdmin: (inputId: string) =>
    inputId === KNOWN_INPUT
      ? { linein_id: inputId, bridge_id: 'b1', connected: true, state: 'playing', received_at: null, device: null }
      : null,
} as unknown as LineInApiHandler;

const routes = buildLineInRoutes({ log, lineInApi: fakeLineInApi, sendJson });

async function dispatch(method: string, pathname: string): Promise<FakeResponse> {
  const route = routes.find((r) => (!r.method || r.method === method) && r.pattern.test(pathname));
  assert.ok(route, `no route for ${method} ${pathname}`);
  const match = pathname.match(route!.pattern)!;
  const res = new FakeResponse();
  await route!.handler({} as IncomingMessage, res as unknown as ServerResponse, match, pathname);
  return res;
}

test('GET /linein/bridges returns the admin bridge list', async () => {
  const res = await dispatch('GET', '/linein/bridges');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), [{ bridge_id: 'b1', assigned_input_id: KNOWN_INPUT }]);
});

test('GET /linein/:id/bridge-status returns status for a known input', async () => {
  const res = await dispatch('GET', `/linein/${KNOWN_INPUT}/bridge-status`);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).state, 'playing');
});

test('GET /linein/:id/bridge-status answers 404 for an unknown input', async () => {
  const res = await dispatch('GET', '/linein/9999999/bridge-status');
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, 'linein-not-found');
});
