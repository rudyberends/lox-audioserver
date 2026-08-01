import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createUpdateChecker, backoffMsFor } from '../src/adapters/http/adminApi/misc/updateCheck';
import { UpstreamHttpError } from '../src/adapters/http/adminApi/misc/upstreamJson';

/*
 * The Web apps card read "UNKNOWN" on a server whose GitHub budget was spent, and kept
 * reading it long after the budget came back. Two causes, both pinned here: every
 * lookup turned failure into `null` and that got cached as though it were an answer,
 * and a refused check retried immediately — three URLs per repo, ten per check, from a
 * budget of sixty an hour, so an exhausted server could never climb back out.
 */

const RELEASES = {
  'https://api.github.com/repos/o/core/releases/latest': { tag_name: 'v4.0.0' },
  'https://api.github.com/repos/o/core/releases?per_page=20': [
    { tag_name: 'v4.1.0-beta.1', prerelease: true },
  ],
  'https://api.github.com/repos/o/ui/releases/latest': { tag_name: 'v5.1.0' },
  'https://api.github.com/repos/o/player/releases/latest': { tag_name: 'v0.1.0' },
  'https://registry.npmjs.org/@sonn-audio/node-sendspin': {
    'dist-tags': { latest: '0.3.8' },
    description: 'Sendspin',
  },
} as Record<string, unknown>;

type Harness = {
  checker: ReturnType<typeof createUpdateChecker>;
  urls: string[];
  setClock: (ms: number) => void;
  fail: (err: unknown | null) => void;
};

function harness(overrides: { declared?: Record<string, string> } = {}): Harness {
  const urls: string[] = [];
  let clock = 1_000_000;
  let failure: unknown | null = null;
  const checker = createUpdateChecker({
    fetchJson: async (url: string) => {
      urls.push(url);
      if (failure && url.startsWith('https://api.github.com/')) throw failure;
      if (url in RELEASES) return RELEASES[url];
      throw new UpstreamHttpError(`not found ${url}`, 404, null);
    },
    declaredPackages: () => overrides.declared ?? { '@sonn-audio/node-sendspin': '^0.3.0' },
    now: () => clock,
    coreRepo: 'o/core',
    uiRepo: 'o/ui',
    playerRepo: 'o/player',
  });
  return {
    checker,
    urls,
    setClock: (ms) => {
      clock = ms;
    },
    fail: (err) => {
      failure = err;
    },
  };
}

test('the update check reports the newest tags it found', async () => {
  const h = harness();
  const result = await h.checker.check(false);
  assert.deepEqual(
    { ...result.latest, componentDescriptions: undefined },
    {
      core: '4.0.0',
      corePrerelease: '4.1.0-beta.1',
      ui: '5.1.0',
      player: '0.1.0',
      components: { '@sonn-audio/node-sendspin': '0.3.8' },
      componentDescriptions: undefined,
    },
  );
});

test('a refused lookup keeps the versions the check already knew', async () => {
  const h = harness();
  const good = await h.checker.check(false);
  assert.equal(good.latest.ui, '5.1.0', 'knows the UI version to begin with');

  // The budget runs out, and the admin UI polls again past the TTL.
  h.fail(new UpstreamHttpError('rate limited', 403, null));
  h.setClock(1_000_000 + 20 * 60 * 1000);
  const after = await h.checker.check(false);

  // Reporting null here would have the card claim it knows less than a minute ago,
  // and would then serve that ignorance from cache for a full TTL.
  assert.equal(after.latest.ui, '5.1.0', 'still reports what it knew');
  assert.equal(after.latest.core, '4.0.0');
});

test('a spent budget is left alone until the reset the upstream stated', async () => {
  const h = harness();
  // Only GitHub is rate-limited, so only GitHub's requests are what this counts. npm
  // keeps refreshing on its own faster TTL throughout, which is the point of the split.
  const githubCalls = (): number =>
    h.urls.filter((u) => u.startsWith('https://api.github.com/')).length;

  await h.checker.check(false);
  const beforeRefusal = githubCalls();

  const resetAt = 1_000_000 + 30 * 60 * 1000;
  h.fail(new UpstreamHttpError('rate limited', 403, resetAt));
  h.setClock(1_000_000 + 20 * 60 * 1000);
  await h.checker.check(false);
  const afterRefusal = githubCalls();
  assert.ok(afterRefusal > beforeRefusal, 'it did try once');

  // Every later poll before the reset must cost nothing: retrying is what kept the
  // budget at zero, and a forced check (the refresh button) must not bypass it either.
  h.setClock(resetAt - 1000);
  await h.checker.check(false);
  await h.checker.check(true);
  assert.equal(githubCalls(), afterRefusal, 'no further GitHub requests while backed off');

  // Once the stated reset passes it asks again, and recovers by itself.
  h.fail(null);
  h.setClock(resetAt + 1000);
  const recovered = await h.checker.check(false);
  assert.ok(githubCalls() > afterRefusal, 'asks again after the reset');
  assert.equal(recovered.latest.ui, '5.1.0');
});

test('a refused repo is not walked through its fallback endpoints', async () => {
  const h = harness();
  h.fail(new UpstreamHttpError('rate limited', 403, null));
  await h.checker.check(false);

  // Three URLs per repo used to be tried before giving up, which spends ten of sixty
  // requests on a check that was refused by the first one.
  const perRepo = h.urls.filter((u) => u.startsWith('https://api.github.com/repos/o/ui/'));
  assert.equal(perRepo.length, 1, 'stops at the refusal instead of trying siblings');
});

test('a missing release still falls through to the endpoint that knows', async () => {
  const urls: string[] = [];
  const checker = createUpdateChecker({
    fetchJson: async (url: string) => {
      urls.push(url);
      // A repo whose only release is a prerelease: `releases/latest` genuinely 404s.
      if (url === 'https://api.github.com/repos/o/ui/releases/latest') {
        throw new UpstreamHttpError('no release', 404, null);
      }
      if (url === 'https://api.github.com/repos/o/ui/releases?per_page=1') {
        return [{ tag_name: 'v5.2.0-rc.1' }];
      }
      if (url.startsWith('https://api.github.com/')) return [];
      throw new UpstreamHttpError('not found', 404, null);
    },
    declaredPackages: () => ({}),
    coreRepo: 'o/core',
    uiRepo: 'o/ui',
    playerRepo: 'o/player',
  });

  const result = await checker.check(false);
  assert.equal(result.latest.ui, '5.2.0-rc.1', 'a 404 is an answer, so the walk continues');
  assert.ok(urls.includes('https://api.github.com/repos/o/ui/releases?per_page=1'));
});

test('a spent GitHub budget does not hide the component versions', async () => {
  const h = harness();
  h.fail(new UpstreamHttpError('rate limited', 403, null));
  const result = await h.checker.check(false);

  // The two halves are independent: components come from npm, which has no such limit.
  // Failing the whole check would have taken them down with GitHub.
  assert.equal(result.latest.ui, null, 'GitHub is unknown');
  assert.deepEqual(result.latest.components, { '@sonn-audio/node-sendspin': '0.3.8' });
});

test('the stated reset drives the wait, and nonsense falls back to a fixed one', () => {
  const now = 1_000_000;
  assert.equal(backoffMsFor(new UpstreamHttpError('x', 403, now + 90_000), now), 90_000);
  // No header, a reset already in the past, or a plain error: wait a fixed minute.
  assert.equal(backoffMsFor(new UpstreamHttpError('x', 403, null), now), 60_000);
  assert.equal(backoffMsFor(new UpstreamHttpError('x', 403, now - 5_000), now), 60_000);
  assert.equal(backoffMsFor(new Error('socket hang up'), now), 60_000);
  // A reset an implausible distance out is a clock disagreement, not a real wait.
  assert.equal(backoffMsFor(new UpstreamHttpError('x', 403, now + 5 * 3600_000), now), 3600_000);
});
