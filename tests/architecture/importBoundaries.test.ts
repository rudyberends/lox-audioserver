import fs from 'node:fs';
import path from 'node:path';
import { test } from '../testHarness';

type Violation = {
  file: string;
  specifier: string;
  reason: string;
};

const repoRoot = path.resolve(__dirname, '..', '..');
const applicationRoot = path.join(repoRoot, 'src', 'application');
const domainRoot = path.join(repoRoot, 'src', 'domain');
const portsRoot = path.join(repoRoot, 'src', 'ports');

const importPatterns = [
  /(?:import|export)\s+[^;]*from\s+['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectImports(content: string): string[] {
  const specs: string[] = [];
  for (const pattern of importPatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(content);
    while (match) {
      specs.push(match[1]);
      match = pattern.exec(content);
    }
  }
  return specs;
}

function checkBoundaries(
  root: string,
  bannedPrefixes: string[],
  label: string,
): Violation[] {
  const violations: Violation[] = [];
  const files = listTsFiles(root);
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const imports = collectImports(content);
    for (const specifier of imports) {
      const banned = bannedPrefixes.find((prefix) => specifier.startsWith(prefix));
      if (!banned) {
        continue;
      }
      violations.push({
        file: path.relative(repoRoot, file),
        specifier,
        reason: `${label} must not import from ${banned}`,
      });
    }
  }
  return violations;
}

test('architecture boundaries', () => {
  const violations: Violation[] = [];
  violations.push(
    ...checkBoundaries(applicationRoot, ['@/adapters', '@/modules', '@/infrastructure'], 'application'),
  );
  violations.push(
    ...checkBoundaries(domainRoot, ['@/application', '@/adapters', '@/runtime'], 'domain'),
  );
  violations.push(
    ...checkBoundaries(portsRoot, ['@/adapters', '@/runtime'], 'ports'),
  );

  if (!violations.length) {
    return;
  }

  const details = violations
    .map((entry) => `- ${entry.file}: ${entry.reason} (${entry.specifier})`)
    .join('\n');
  throw new Error(`Import boundary violations:\n${details}`);
});
