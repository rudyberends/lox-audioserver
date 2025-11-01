import fs from 'fs';
import path from 'path';
import logger from '@/utils/troxorLogger';

/**
 * Dynamisch laden van alle zone-adapters in ./zones/
 * (Zorgt dat registerStateMapper / registerCommandMapper wordt uitgevoerd)
 */
const baseDir = __dirname;
for (const dir of fs.readdirSync(baseDir)) {
  const fullPath = path.join(baseDir, dir);
  const isTs = __filename.endsWith('.ts');
  const indexFile = path.join(fullPath, `index.${isTs ? 'ts' : 'js'}`);

  if (fs.existsSync(indexFile)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(indexFile);
      logger.debug(`[ZoneAdapterLoader] Loaded adapter "${dir}"`);
    } catch (err) {
      logger.warn(`[ZoneAdapterLoader] Failed to load adapter "${dir}": ${err}`);
    }
  }
}