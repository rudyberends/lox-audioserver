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
