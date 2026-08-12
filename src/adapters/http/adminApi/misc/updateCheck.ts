import { UpstreamHttpError } from '@/adapters/http/adminApi/misc/upstreamJson';

/**
 * "What is the newest version out there" for the parts an installation can update:
 * the server core and the two web bundles (GitHub releases), plus the addon packages
 * (npm). Null means "we do not know right now", never "there is no such version" —
 * the admin UI renders it as `unknown` rather than as up-to-date.
 */
export type UpdateCheckLatest = {
  core: string | null;
  corePrerelease: string | null;
  ui: string | null;
  player: string | null;
  /** Newest published build of the client the speakers run. */
  sonnClient: string | null;
  components: Record<string, string>;
  componentDescriptions: Record<string, string>;
};

export type UpdateCheckResult = { latest: UpdateCheckLatest; checkedAt: string };

export type GithubPart = {
  core: string | null;
  corePrerelease: string | null;
  ui: string | null;
  player: string | null;
  sonnClient: string | null;
};
export type NpmPart = {
  components: Record<string, string>;
  componentDescriptions: Record<string, string>;
};

const EMPTY_GITHUB: GithubPart = {
  core: null,
  corePrerelease: null,
  ui: null,
  player: null,
  sonnClient: null,
};
const EMPTY_NPM: NpmPart = { components: {}, componentDescriptions: {} };

/** How long to leave an upstream alone after it refused, when it did not say itself. */
const DEFAULT_BACKOFF_MS = 60_000;
/** A stated reset far in the future is more likely a clock skew than a real wait. */
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export type UpdateCheckerDeps = {
  fetchJson: (url: string) => Promise<unknown>;
  /** Declared addon packages to look up on npm, as name → range. */
  declaredPackages: () => Record<string, string>;
  now?: () => number;
  githubTtlMs?: number;
  npmTtlMs?: number;
  coreRepo?: string;
  uiRepo?: string;
  playerRepo?: string;
  sonnClientRepo?: string;
};

export type UpdateChecker = { check(force: boolean): Promise<UpdateCheckResult> };

function stripV(tag: string | null | undefined): string | null {
  const trimmed = (tag ?? '').trim().replace(/^v/i, '');
  return trimmed || null;
}

/**
 * How long to stay off an upstream that just refused us.
 *
 * Prefers the reset the upstream stated, so the budget comes back exactly when GitHub
 * says it does instead of on a guess.
 */
export function backoffMsFor(err: unknown, now: number): number {
  const stated = err instanceof UpstreamHttpError ? err.rateLimitResetAtMs : null;
  if (stated === null) return DEFAULT_BACKOFF_MS;
  const wait = stated - now;
  if (wait <= 0) return DEFAULT_BACKOFF_MS;
  return Math.min(wait, MAX_BACKOFF_MS);
}

/** A refusal cannot be answered by asking a sibling endpoint on the same host. */
function isRefusal(err: unknown): boolean {
  return err instanceof UpstreamHttpError && err.isRefusal;
}

/**
 * One cached upstream half: fresh values are reused, a refusal keeps whatever was
 * known before, and nothing that came out of a failure is ever stored as an answer.
 *
 * That last rule is the one that matters. The lookups below turn every failure into
 * `null`, so caching the result of a failed refresh would pin "unknown" for a whole
 * TTL — and overwrite good values that were already there, which reads to the user as
 * a server that suddenly knows less than it did a minute ago.
 */
class CachedPart<T> {
  private cache: { data: T; at: number } | null = null;
  private inFlight: Promise<T> | null = null;
  private backoffUntil = 0;

  public constructor(
    private readonly load: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  /**
   * `force` skips the TTL — it is what the admin UI's refresh button sends — but it
   * does not skip a backoff. A user pressing refresh against a spent quota would
   * otherwise keep it spent.
   */
  public async get(force: boolean): Promise<T> {
    const now = this.now();
    if (!force && this.cache && now - this.cache.at < this.ttlMs) {
      return this.cache.data;
    }
    if (now < this.backoffUntil) {
      if (this.cache) return this.cache.data;
      throw new Error('upstream unavailable and nothing cached yet');
    }
    if (!this.inFlight) {
      this.inFlight = this.load()
        .then((data) => {
          this.cache = { data, at: this.now() };
          return data;
        })
        .catch((err: unknown) => {
          this.backoffUntil = this.now() + backoffMsFor(err, this.now());
          if (this.cache) return this.cache.data;
          throw err;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }
}

export function createUpdateChecker(deps: UpdateCheckerDeps): UpdateChecker {
  const now = deps.now ?? (() => Date.now());
  const coreRepo = deps.coreRepo ?? 'sonn-audio/core';
  const uiRepo = deps.uiRepo ?? 'sonn-audio/adminui';
  const playerRepo = deps.playerRepo ?? 'sonn-audio/player';
  const sonnClientRepo = deps.sonnClientRepo ?? 'sonn-audio/sonn-client';

  /**
   * Newest release tag for a repo, tried three ways: a repo with no non-prerelease
   * release 404s on `releases/latest`, and one with no releases at all still has tags.
   * A refusal stops the walk — the other two URLs would refuse too, and each costs a
   * request from the same small budget.
   */
  async function fetchRepoLatestTag(repo: string): Promise<string | null> {
    const base = `https://api.github.com/repos/${repo}`;
    const attempts: Array<{ url: string; pick: (data: unknown) => string | null }> = [
      { url: `${base}/releases/latest`, pick: (d) => (d as { tag_name?: string })?.tag_name ?? null },
      {
        url: `${base}/releases?per_page=1`,
        pick: (d) => (Array.isArray(d) ? ((d[0] as { tag_name?: string })?.tag_name ?? null) : null),
      },
      {
        url: `${base}/tags?per_page=1`,
        pick: (d) => (Array.isArray(d) ? ((d[0] as { name?: string })?.name ?? null) : null),
      },
    ];
    for (const attempt of attempts) {
      try {
        const found = attempt.pick(await deps.fetchJson(attempt.url));
        if (found) return found;
      } catch (err) {
        if (isRefusal(err)) throw err;
        // Answered, but not with what we asked for: the next endpoint may still know.
      }
    }
    return null;
  }

  async function fetchRepoLatestPrerelease(repo: string): Promise<string | null> {
    const data = await deps.fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=20`);
    if (!Array.isArray(data)) return null;
    const found = data.find(
      (r) =>
        r &&
        typeof r === 'object' &&
        (r as { prerelease?: boolean }).prerelease &&
        !(r as { draft?: boolean }).draft,
    );
    return found ? ((found as { tag_name?: string }).tag_name ?? null) : null;
  }

  /** Release tags for core/UI/player. Rejects when the API refused, so the caller
   *  keeps what it knew instead of storing four nulls as an answer. */
  async function fetchGithubPart(): Promise<GithubPart> {
    const [coreTag, corePrereleaseTag, uiTag, playerTag, sonnClientTag] = await Promise.all([
      fetchRepoLatestTag(coreRepo),
      fetchRepoLatestPrerelease(coreRepo),
      fetchRepoLatestTag(uiRepo),
      fetchRepoLatestTag(playerRepo),
      fetchRepoLatestTag(sonnClientRepo),
    ]);
    return {
      core: stripV(coreTag),
      corePrerelease: stripV(corePrereleaseTag),
      ui: stripV(uiTag),
      player: stripV(playerTag),
      sonnClient: stripV(sonnClientTag),
    };
  }

  async function fetchNpmLatest(
    name: string,
  ): Promise<{ version: string | null; description: string | null }> {
    const data = (await deps.fetchJson(`https://registry.npmjs.org/${name}`)) as {
      'dist-tags'?: { latest?: string };
      description?: string;
    };
    return { version: data['dist-tags']?.latest ?? null, description: data.description ?? null };
  }

  /** Latest npm versions for the declared component packages. Rejects when every
   *  lookup failed, which is a registry problem rather than an empty answer. */
  async function fetchNpmPart(): Promise<NpmPart> {
    const names = Object.keys(deps.declaredPackages());
    const components: Record<string, string> = {};
    const componentDescriptions: Record<string, string> = {};
    let failures = 0;
    await Promise.all(
      names.map(async (name) => {
        try {
          const { version, description } = await fetchNpmLatest(name);
          if (version) components[name] = version;
          if (description) componentDescriptions[name] = description;
        } catch {
          failures += 1;
        }
      }),
    );
    if (names.length > 0 && failures === names.length) {
      throw new Error('every npm lookup failed');
    }
    return { components, componentDescriptions };
  }

  const github = new CachedPart(
    fetchGithubPart,
    deps.githubTtlMs ?? 15 * 60 * 1000,
    now,
  );
  const npm = new CachedPart(fetchNpmPart, deps.npmTtlMs ?? 60 * 1000, now);

  return {
    /**
     * The two halves fail independently: a spent GitHub budget must not also hide the
     * component versions, which come from npm and have no such limit. An unavailable
     * half reports nulls for this response only — the cache keeps whatever it knew.
     */
    async check(force: boolean): Promise<UpdateCheckResult> {
      const [githubPart, npmPart] = await Promise.all([
        github.get(force).catch(() => EMPTY_GITHUB),
        npm.get(force).catch(() => EMPTY_NPM),
      ]);
      return {
        latest: {
          core: githubPart.core,
          corePrerelease: githubPart.corePrerelease,
          ui: githubPart.ui,
          player: githubPart.player,
          sonnClient: githubPart.sonnClient,
          components: npmPart.components,
          componentDescriptions: npmPart.componentDescriptions,
        },
        checkedAt: new Date(now()).toISOString(),
      };
    },
  };
}
