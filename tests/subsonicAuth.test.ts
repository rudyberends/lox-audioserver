import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from './testHarness';
import { SubsonicAuthenticator } from '../src/adapters/subsonic/subsonicAuthenticator';
import { SubsonicError } from '../src/adapters/subsonic/subsonicResponse';
import { MiniserverAuthError } from '../src/adapters/http/adminApi/auth/types';
import type { MiniserverAuthClient } from '../src/adapters/http/adminApi/auth/miniserverAuthClient';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { AudioServerConfig } from '../src/domain/config/types';

type Mode = 'loxone' | 'standalone';

function makeAuth(options: {
  mode?: Mode;
  paired?: boolean;
  miniserverIp?: string | null;
  local?: { username: string; password: string } | null;
  /** Miniserver accounts the fake will accept. */
  loxoneUsers?: Record<string, string>;
  /** Make every Miniserver call fail with this error instead. */
  miniserverError?: Error;
}) {
  const cfg = {
    system: {
      audioserver: {
        mode: options.mode ?? 'loxone',
        paired: options.paired ?? true,
        ip: '192.168.1.209',
      },
      miniserver:
        options.miniserverIp === null
          ? {}
          : { ip: options.miniserverIp ?? '192.168.1.200', port: 80, protocol: 'http' },
      // Server-local accounts live in the shared user store, not under content.subsonic.
      users: options.local ? [{ username: options.local.username, password: options.local.password }] : [],
    },
    content: {
      spotify: { bridges: [] },
      subsonic: { enabled: true },
    },
  } as unknown as AudioServerConfig;

  const calls: Array<{ username: string; password: string }> = [];
  const miniserver = {
    verifyCredentials: async (_baseUrl: string, username: string, password: string) => {
      calls.push({ username, password });
      if (options.miniserverError) {
        throw options.miniserverError;
      }
      if ((options.loxoneUsers ?? {})[username] === password) {
        return { tokenRights: 0 };
      }
      throw new MiniserverAuthError('invalid-credentials', 'bad credentials');
    },
  } as unknown as MiniserverAuthClient;

  const configPort = { getConfig: () => cfg } as unknown as ConfigPort;
  return { auth: new SubsonicAuthenticator(configPort, miniserver), calls, cfg };
}

function passwordParams(username: string, password: string): URLSearchParams {
  return new URLSearchParams({ u: username, p: password });
}

function tokenParams(username: string, password: string, salt = 'abc'): URLSearchParams {
  const token = createHash('md5').update(`${password}${salt}`).digest('hex');
  return new URLSearchParams({ u: username, t: token, s: salt });
}

async function expectError(promise: Promise<unknown>, code: number, label: string): Promise<void> {
  try {
    await promise;
    assert.fail(`${label}: expected error ${code}, got success`);
  } catch (error) {
    assert.ok(error instanceof SubsonicError, `${label}: ${String(error)}`);
    assert.equal(error.code, code, label);
  }
}

// ── Availability ────────────────────────────────────────────────────────────

test('subsonic auth: integrated mode needs no local credentials', async () => {
  const { auth } = makeAuth({ mode: 'loxone', local: null });
  const availability = auth.availability();
  assert.equal(availability.loxone, true);
  assert.equal(availability.local, false);
  assert.equal(availability.loxoneUnavailableReason, null);
});

test('subsonic auth: standalone mode has no Miniserver to fall back on', async () => {
  const { auth } = makeAuth({ mode: 'standalone', local: null });
  const availability = auth.availability();
  assert.equal(availability.loxone, false);
  assert.equal(availability.loxoneUnavailableReason, 'standalone');
});

test('subsonic auth: an unpaired or unconfigured server reports why', async () => {
  assert.equal(
    makeAuth({ paired: false }).auth.availability().loxoneUnavailableReason,
    'not-paired',
  );
  assert.equal(
    makeAuth({ miniserverIp: null }).auth.availability().loxoneUnavailableReason,
    'no-miniserver',
  );
});

// ── Loxone-integrated ───────────────────────────────────────────────────────

test('subsonic auth: a Miniserver account is accepted with no local credentials', async () => {
  const { auth, calls } = makeAuth({ local: null, loxoneUsers: { anna: 'huis123' } });
  await auth.authenticate(passwordParams('anna', 'huis123'));
  assert.deepEqual(calls, [{ username: 'anna', password: 'huis123' }]);
});

test('subsonic auth: a wrong Miniserver password is rejected', async () => {
  const { auth } = makeAuth({ local: null, loxoneUsers: { anna: 'huis123' } });
  await expectError(auth.authenticate(passwordParams('anna', 'nope')), 40, 'wrong password');
});

test('subsonic auth: hex-encoded passwords reach the Miniserver decoded', async () => {
  const { auth, calls } = makeAuth({ local: null, loxoneUsers: { anna: 'huis123' } });
  const hex = Buffer.from('huis123', 'utf8').toString('hex');
  await auth.authenticate(new URLSearchParams({ u: 'anna', p: `enc:${hex}` }));
  assert.equal(calls[0]?.password, 'huis123');
});

test('subsonic auth: token login without local credentials returns code 41', async () => {
  // The Miniserver needs the plaintext to build its own auth hash; a token login
  // never carries it. 41 is the protocol's own code for exactly this.
  const { auth, calls } = makeAuth({ local: null, loxoneUsers: { anna: 'huis123' } });
  await expectError(auth.authenticate(tokenParams('anna', 'huis123')), 41, 'token via loxone');
  assert.equal(calls.length, 0, 'must not bother the Miniserver with an unusable digest');
});

test('subsonic auth: the code 41 message tells the user what to change', async () => {
  const { auth } = makeAuth({ local: null, loxoneUsers: { anna: 'x' } });
  try {
    await auth.authenticate(tokenParams('anna', 'x'));
    assert.fail('expected a fault');
  } catch (error) {
    assert.ok(error instanceof SubsonicError);
    assert.match(error.message, /plaintext|legacy/i);
    assert.match(error.message, /local Subsonic password/i);
  }
});

// ── Local fallback alongside Loxone ─────────────────────────────────────────

test('subsonic auth: local credentials work alongside Miniserver accounts', async () => {
  const { auth, calls } = makeAuth({
    local: { username: 'gast', password: 'muziek' },
    loxoneUsers: { anna: 'huis123' },
  });
  await auth.authenticate(passwordParams('gast', 'muziek'));
  assert.equal(calls.length, 0, 'local must not hit the Miniserver');
  await auth.authenticate(passwordParams('anna', 'huis123'));
  assert.equal(calls.length, 1);
});

test('subsonic auth: a local password restores token authentication', async () => {
  const { auth } = makeAuth({
    local: { username: 'gast', password: 'muziek' },
    loxoneUsers: { anna: 'huis123' },
  });
  await auth.authenticate(tokenParams('gast', 'muziek'));
});

test('subsonic auth: a local-name mismatch still falls through to the Miniserver', async () => {
  // A Loxone account may legitimately share the local username.
  const { auth, calls } = makeAuth({
    local: { username: 'anna', password: 'lokaal' },
    loxoneUsers: { anna: 'huis123' },
  });
  await auth.authenticate(passwordParams('anna', 'huis123'));
  assert.equal(calls.length, 1, 'must retry against the Miniserver');
});

// ── Standalone ──────────────────────────────────────────────────────────────

test('subsonic auth: standalone accepts local credentials in every form', async () => {
  const { auth, calls } = makeAuth({
    mode: 'standalone',
    local: { username: 'rudy', password: 'pw' },
  });
  await auth.authenticate(passwordParams('rudy', 'pw'));
  await auth.authenticate(tokenParams('rudy', 'pw'));
  assert.equal(calls.length, 0, 'standalone must never call a Miniserver');
});

test('subsonic auth: standalone without local credentials admits nobody', async () => {
  const { auth } = makeAuth({ mode: 'standalone', local: null });
  await expectError(auth.authenticate(passwordParams('rudy', 'pw')), 50, 'no credentials at all');
});

test('subsonic auth: standalone does not fall through on a bad password', async () => {
  const { auth, calls } = makeAuth({
    mode: 'standalone',
    local: { username: 'rudy', password: 'pw' },
  });
  await expectError(auth.authenticate(passwordParams('rudy', 'wrong')), 40, 'wrong local');
  assert.equal(calls.length, 0);
});

// ── Caching and resilience ──────────────────────────────────────────────────

test('subsonic auth: a verified Miniserver login is cached', async () => {
  // Subsonic is sessionless: every request carries credentials, so a library
  // scan would otherwise be hundreds of three-call Miniserver verifications.
  const { auth, calls } = makeAuth({ local: null, loxoneUsers: { anna: 'huis123' } });
  for (let i = 0; i < 25; i += 1) {
    await auth.authenticate(passwordParams('anna', 'huis123'));
  }
  assert.equal(calls.length, 1, `expected one verification, got ${calls.length}`);
});

test('subsonic auth: rejections are cached too, so a stale client cannot hammer', async () => {
  const { auth, calls } = makeAuth({ local: null, loxoneUsers: { anna: 'huis123' } });
  for (let i = 0; i < 10; i += 1) {
    await expectError(auth.authenticate(passwordParams('anna', 'oud')), 40, 'stale password');
  }
  assert.equal(calls.length, 1);
});

test('subsonic auth: invalidate clears cached verifications', async () => {
  const { auth, calls } = makeAuth({ local: null, loxoneUsers: { anna: 'huis123' } });
  await auth.authenticate(passwordParams('anna', 'huis123'));
  auth.invalidate();
  await auth.authenticate(passwordParams('anna', 'huis123'));
  assert.equal(calls.length, 2);
});

test('subsonic auth: an unreachable Miniserver denies but is not cached', async () => {
  // A transient outage must not lock a user out for the whole positive TTL.
  const { auth, calls } = makeAuth({
    local: null,
    loxoneUsers: { anna: 'huis123' },
    miniserverError: new MiniserverAuthError('miniserver-unreachable', 'down'),
  });
  await expectError(auth.authenticate(passwordParams('anna', 'huis123')), 40, 'outage');
  await expectError(auth.authenticate(passwordParams('anna', 'huis123')), 40, 'outage again');
  assert.equal(calls.length, 2, 'must retry rather than serve a cached denial');
});

test('subsonic auth: different passwords get separate cache entries', async () => {
  const { auth, calls } = makeAuth({ local: null, loxoneUsers: { anna: 'huis123' } });
  await expectError(auth.authenticate(passwordParams('anna', 'wrong')), 40, 'first');
  await auth.authenticate(passwordParams('anna', 'huis123'));
  assert.equal(calls.length, 2);
});

// ── Parameter handling ──────────────────────────────────────────────────────

test('subsonic auth: missing parameters fault with code 10', async () => {
  const { auth } = makeAuth({ local: { username: 'r', password: 'p' } });
  await expectError(auth.authenticate(new URLSearchParams({ p: 'x' })), 10, 'no username');
  await expectError(auth.authenticate(new URLSearchParams({ u: 'r' })), 10, 'no password');
});
