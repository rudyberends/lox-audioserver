import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { buildSubsonicRoutes } from '../src/adapters/http/adminApi/subsonic/subsonicHandlers';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { AudioServerConfig } from '../src/domain/config/types';

const BRIDGE_ID = 'bridge-applemusic-p0gngd';

/** A ConfigPort over a mutable plain object, as updateConfig really behaves. */
function makeConfigPort(
  subsonic?: Record<string, unknown>,
  deployment: {
    mode?: 'loxone' | 'standalone';
    paired?: boolean;
    users?: Array<{ username: string; password: string; admin?: boolean }>;
  } = {},
) {
  const cfg = {
    system: {
      audioserver: {
        ip: '192.168.1.209',
        mode: deployment.mode ?? 'standalone',
        paired: deployment.paired ?? false,
      },
      miniserver: { ip: '192.168.1.200', port: 80, protocol: 'http' },
      users: deployment.users ?? [],
    },
    content: {
      spotify: {
        bridges: [
          { id: BRIDGE_ID, provider: 'applemusic', label: 'Apple Music', enabled: true },
          { id: 'bridge-sc', provider: 'soundcloud', enabled: true },
        ],
      },
      ...(subsonic ? { subsonic } : {}),
    },
  } as unknown as AudioServerConfig;

  const port = {
    getConfig: () => cfg,
    updateConfig: async (mutator: (c: AudioServerConfig) => void) => {
      mutator(cfg);
    },
  } as unknown as ConfigPort;
  return { port, cfg };
}

type Captured = { status: number; body: any };

function makeRoutes(
  subsonic?: Record<string, unknown>,
  deployment: {
    mode?: 'loxone' | 'standalone';
    paired?: boolean;
    users?: Array<{ username: string; password: string; admin?: boolean }>;
  } = {},
) {
  const { port, cfg } = makeConfigPort(subsonic, deployment);
  const captured: Captured = { status: 0, body: null };
  let jsonBody: unknown = null;
  const routes = buildSubsonicRoutes({
    log: { debug() {}, info() {}, warn() {}, error() {}, spam() {} } as never,
    configPort: port,
    httpPort: 7090,
    readJsonBody: async () => jsonBody,
    sendJson: (_res, status, body) => {
      captured.status = status;
      captured.body = body;
    },
  });
  const call = async (method: string, path: string, body?: unknown): Promise<Captured> => {
    jsonBody = body ?? null;
    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    assert.ok(route, `no route for ${method} ${path}`);
    const match = route.pattern.exec(path) as RegExpExecArray;
    await route.handler({} as IncomingMessage, {} as ServerResponse, match);
    return { ...captured };
  };
  return { call, cfg };
}

test('subsonic admin: an unknown provider in the allowlist is rejected', async () => {
  const { call, cfg } = makeRoutes({ enabled: true });
  const { status, body } = await call('POST', '/subsonic/config', {
    providers: ['library', 'napster'],
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'unknown-provider');
  assert.deepEqual(body.providers, ['napster']);
  assert.equal(cfg.content.subsonic?.providers, undefined);
});

test('subsonic admin: an empty allowlist is stored as "no restriction"', async () => {
  // parseProviderAllowlist treats [] as unrestricted, so persisting [] would be a
  // config that reads as "expose nothing" but behaves as "expose everything".
  const { call, cfg } = makeRoutes({ enabled: true, providers: ['library'] });
  await call('POST', '/subsonic/config', { providers: [] });
  assert.equal(cfg.content.subsonic?.providers, undefined);
});

test('subsonic admin: the allowlist is deduplicated and lowercased', async () => {
  const { call, cfg } = makeRoutes({ enabled: true });
  await call('POST', '/subsonic/config', { providers: ['Library', 'library', 'RADIO'] });
  assert.deepEqual(cfg.content.subsonic?.providers, ['library', 'radio']);
});

test('subsonic admin: an out-of-range directory limit is rejected', async () => {
  const { call } = makeRoutes({ enabled: true });
  for (const value of [10, 99999, 'lots']) {
    const { status, body } = await call('POST', '/subsonic/config', { directoryLimit: value });
    assert.equal(status, 400, `${value} must be rejected`);
    assert.equal(body.error, 'invalid-directory-limit');
  }
});

test('subsonic admin: a valid directory limit is stored and null clears it', async () => {
  const { call, cfg } = makeRoutes({ enabled: true });
  await call('POST', '/subsonic/config', { directoryLimit: 2500 });
  assert.equal(cfg.content.subsonic?.directoryLimit, 2500);
  await call('POST', '/subsonic/config', { directoryLimit: null });
  assert.equal(cfg.content.subsonic?.directoryLimit, undefined);
});

test('subsonic admin: a non-object payload is rejected', async () => {
  const { call } = makeRoutes({ enabled: true });
  for (const payload of [null, ['a'], 'text']) {
    const { status, body } = await call('POST', '/subsonic/config', payload);
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid-subsonic-payload');
  }
});

// ── Status: the shared user store, not Subsonic's own accounts ──────────────

const INTEGRATED = { mode: 'loxone' as const, paired: true };
const LOCAL_USER = { username: 'gast', password: 'pw' };

test('subsonic admin: status reports the client URL and the resolved catalogue', async () => {
  const { call } = makeRoutes({ enabled: true }, { users: [LOCAL_USER] });
  const { status, body } = await call('GET', '/subsonic/status');
  assert.equal(status, 200);
  assert.equal(body.enabled, true);
  assert.equal(body.configured, true);
  // Clients append /rest themselves.
  assert.equal(body.url, 'http://192.168.1.209:7090');
  assert.deepEqual(
    body.services.map((s: any) => s.title),
    ['Library', 'Radio', 'Apple Music', 'SoundCloud'],
  );
  assert.equal(body.services.find((s: any) => s.title === 'Radio').searchable, false);
});

test('subsonic admin: status lists the shared users and never their passwords', async () => {
  const { call } = makeRoutes({ enabled: true }, { users: [LOCAL_USER] });
  const { body } = await call('GET', '/subsonic/status');
  assert.deepEqual(body.users, [{ username: 'gast', admin: false, source: 'local' }]);
  assert.ok(!JSON.stringify(body).includes('pw'), 'no password may appear anywhere');
  // Accounts are managed via /users, so these must be gone from the status shape.
  assert.ok(!('username' in body));
  assert.ok(!('hasPassword' in body));
});

test('subsonic admin: the allowlist is reflected per service and per provider', async () => {
  const { call } = makeRoutes(
    { enabled: true, providers: ['library', 'applemusic'] },
    { users: [LOCAL_USER] },
  );
  const { body } = await call('GET', '/subsonic/status');
  assert.deepEqual(
    body.services.filter((s: any) => s.exposed).map((s: any) => s.title),
    ['Library', 'Apple Music'],
  );
  assert.deepEqual(
    Object.fromEntries(body.providerOptions.map((o: any) => [o.provider, o.enabled])),
    { library: true, radio: false, applemusic: true, soundcloud: false },
  );
});

test('subsonic admin: integrated mode is usable with no local users at all', async () => {
  // A Miniserver account suffices there, so nothing local is required.
  const { call } = makeRoutes({ enabled: true }, INTEGRATED);
  const { body } = await call('GET', '/subsonic/status');
  assert.equal(body.configured, true);
  assert.equal(body.auth.loxone, true);
  assert.equal(body.auth.localUsers, false);
  assert.equal(body.auth.localUsersRequired, false);
  // Token auth is the client default and only local accounts can answer it.
  assert.equal(body.auth.tokenAuthSupported, false);
});

test('subsonic admin: a local user restores token authentication', async () => {
  const { call } = makeRoutes({ enabled: true }, { ...INTEGRATED, users: [LOCAL_USER] });
  const { body } = await call('GET', '/subsonic/status');
  assert.equal(body.auth.tokenAuthSupported, true);
  assert.equal(body.auth.localUsers, true);
});

test('subsonic admin: standalone without users reports why Loxone auth is off', async () => {
  const { call } = makeRoutes({ enabled: true }, { mode: 'standalone' });
  const { body } = await call('GET', '/subsonic/status');
  assert.equal(body.configured, false);
  assert.equal(body.auth.loxoneUnavailableReason, 'standalone');
  assert.equal(body.auth.localUsersRequired, true);
});

test('subsonic admin: enabling with nobody able to log in is refused', async () => {
  const { call, cfg } = makeRoutes(undefined, { mode: 'standalone' });
  const { status, body } = await call('POST', '/subsonic/config', { enabled: true });
  assert.equal(status, 400);
  assert.equal(body.error, 'no-usable-credentials');
  assert.match(body.message, /POST \/users/);
  assert.equal(cfg.content.subsonic, undefined, 'nothing may be written');
});

test('subsonic admin: enabling succeeds once a user exists', async () => {
  const { call, cfg } = makeRoutes(undefined, { mode: 'standalone', users: [LOCAL_USER] });
  const { status } = await call('POST', '/subsonic/config', { enabled: true });
  assert.equal(status, 200);
  assert.equal(cfg.content.subsonic?.enabled, true);
});

test('subsonic admin: a config write answers with the fresh status', async () => {
  const { call } = makeRoutes({ enabled: true }, { users: [LOCAL_USER] });
  const { body } = await call('POST', '/subsonic/config', { providers: ['library'] });
  assert.ok(Array.isArray(body.services));
  assert.deepEqual(
    body.services.filter((s: any) => s.exposed).map((s: any) => s.title),
    ['Library'],
  );
});
