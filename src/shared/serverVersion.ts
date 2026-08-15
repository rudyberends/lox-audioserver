/**
 * The running server's version, as reported on every outward surface.
 *
 * Shared so the admin API's `/info` and the public API's `/api/health` can never
 * disagree about what is running.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export function readPackageVersion(): string {
  try {
    const json = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(json) as { version?: string };
    return parsed.version ?? 'dev';
  } catch {
    return 'dev';
  }
}

/**
 * Which release channel this build came off.
 *
 * Consumers use it to say out loud that a build is not meant for a real system —
 * `dev` rebuilds on every push to the branch, so it is the one people end up
 * running by accident.
 *
 * The default is deliberately `dev`, not `stable`: a build that does not claim to
 * be a release is not one. Getting this wrong in that direction shows a warning on
 * a release; the other direction hides it on exactly the build that needs it.
 */
export type BuildChannel = 'dev' | 'testing' | 'beta' | 'stable';

const BUILD_CHANNELS: readonly BuildChannel[] = ['dev', 'testing', 'beta', 'stable'];

/** Branches that stand for a channel. Anything else is somebody's working branch. */
const BRANCH_CHANNELS: Readonly<Record<string, BuildChannel>> = {
  main: 'stable',
  beta: 'beta',
  test: 'testing',
  testing: 'testing',
  dev: 'dev',
};

/**
 * The checked-out branch, when the server runs from a working copy.
 *
 * Read straight off `.git/HEAD` rather than by shelling out to git: this is on
 * the path of an API request, and a detached HEAD or a missing repository has to
 * be an ordinary `null`, not a thrown error or a spawned process.
 */
export function readGitBranch(cwd: string = process.cwd()): string | null {
  try {
    let gitDir = resolve(cwd, '.git');
    const stat = statSync(gitDir);
    if (stat.isFile()) {
      // A worktree or submodule: `.git` is a file pointing at the real directory.
      const pointer = readFileSync(gitDir, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!match?.[1]) {
        return null;
      }
      gitDir = resolve(cwd, match[1]);
    }
    const head = readFileSync(resolve(gitDir, 'HEAD'), 'utf8').trim();
    // Detached HEAD holds a bare commit id and belongs to no branch.
    return /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function readBuildChannel(): BuildChannel {
  const declared = process.env.BUILD_CHANNEL?.trim().toLowerCase();
  if (declared && (BUILD_CHANNELS as readonly string[]).includes(declared)) {
    return declared as BuildChannel;
  }
  // Older images predate BUILD_CHANNEL but stamp the channel into the build id.
  const stamp = process.env.BUILD_TIMESTAMP?.trim().toLowerCase() ?? '';
  if (stamp.startsWith('testing-')) {
    return 'testing';
  }
  // Running from a working copy: the branch is what this checkout is tracking, and
  // it is the only honest answer available. An image carries no repository, so this
  // never applies there — it stays on the default below.
  const branch = readGitBranch()?.trim().toLowerCase();
  if (branch && BRANCH_CHANNELS[branch]) {
    return BRANCH_CHANNELS[branch];
  }
  return 'dev';
}

/** Appends the CI build stamp when present, so nightly builds are distinguishable. */
export function readBuildVersion(pkgVersion: string = readPackageVersion()): string {
  const tsRaw = process.env.BUILD_TIMESTAMP?.trim();
  if (!tsRaw) {
    return pkgVersion;
  }
  const normalizedTs = tsRaw.replace(/[^0-9A-Za-z._-]/g, '');
  if (!normalizedTs) {
    return pkgVersion;
  }
  return `${pkgVersion}+${normalizedTs}`;
}
