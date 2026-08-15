/**
 * The running server's version, as reported on every outward surface.
 *
 * Shared so the admin API's `/info` and the public API's `/api/health` can never
 * disagree about what is running.
 */
import { readFileSync } from 'node:fs';
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
