/**
 * Apple Music endpoint probe.
 *
 * Exists because the provider swallows a failed request: `fetchJson` returns null
 * on any non-ok status and the caller maps that to an empty list, so a wrong URL
 * looks exactly like an empty section. This asks Apple directly and prints the
 * status, so "empty" and "broken" can be told apart.
 *
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/apple-probe.ts
 *   … scripts/apple-probe.ts 'catalog/{sf}/new-releases?limit=5'
 */

import { readFileSync } from 'node:fs';
import { buildBaseHeaders, scrapeBearerToken } from '@/adapters/content/providers/applemusic/appleMusicAuth';

async function main(): Promise<void> {
  const API = 'https://amp-api.music.apple.com/v1';

  const config = JSON.parse(readFileSync('data/config.json', 'utf8'));
  const bridge = (config.content?.streamingServices ?? []).find(
    (b: any) => b?.provider === 'applemusic' && b?.enabled !== false,
  );
  if (!bridge?.userToken) {
    console.error('no enabled Apple Music account with a userToken in data/config.json');
      process.exit(1);
  }

  const headers = buildBaseHeaders(bridge.userToken);
  const bearer = await scrapeBearerToken(headers);
  if (!bearer) {
    console.error('could not scrape a developer token');
      process.exit(1);
  }
  const auth = { ...headers, authorization: `Bearer ${bearer}` };

  /** The storefront the account belongs to — every catalog path is scoped to it. */
  async function storefront(): Promise<string> {
    const res = await fetch(`${API}/me/storefront`, { headers: auth });
    const body: any = await res.json().catch(() => null);
    return body?.data?.[0]?.id ?? 'us';
  }

  const sf = await storefront();
  console.log(`storefront=${sf}  bearer=${bearer.slice(0, 12)}…\n`);

  const candidates = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [
        // What the provider asks for today.
        'catalog/{sf}/new-releases?limit=5',
        // Plausible alternatives, cheapest first.
        'catalog/{sf}/charts?types=albums&limit=5',
        'editorial/{sf}/groupings?platform=web&name=music-new-releases',
        'catalog/{sf}/groupings?platform=web&limit=5',
        // Controls: one route known to work, one known not to exist.
        'me/recent/played?limit=2',
        'catalog/{sf}/nonsense-route',
      ];

  for (const raw of candidates) {
    const path = raw.replace('{sf}', sf);
    try {
      const res = await fetch(`${API}/${path}`, { headers: auth });
      const text = await res.text();
      let shape = '';
      if (res.ok) {
        const body: any = JSON.parse(text);
        const data = body?.data;
        shape = Array.isArray(data)
          ? `data[${data.length}]` + (data[0]?.type ? ` first.type=${data[0].type}` : '')
          : `keys=${Object.keys(body ?? {}).join(',')}`;
      } else {
        const err = (() => {
          try {
            return JSON.parse(text)?.errors?.[0]?.title ?? '';
          } catch {
            return text.slice(0, 60);
          }
        })();
        shape = err;
      }
      const kb = (text.length / 1024).toFixed(0);
      console.log(`  ${String(res.status).padEnd(4)} ${path.padEnd(58)} ${String(kb).padStart(5)}KB  ${shape}`);
      // DUMP=1 walks the response and prints every titled node, so an editorial
      // grouping can be searched for the section one is actually after.
      if (process.env.RAW && res.ok) {
        console.log(text.slice(0, Number(process.env.RAW) || 1200));
      }
      if (process.env.DUMP && res.ok) {
        const seen = new Set<string>();
        const walk = (node: any, depth: number): void => {
          if (!node || typeof node !== 'object' || depth > 6) return;
          const title = node?.attributes?.title ?? node?.attributes?.name;
          const key = `${depth}:${title}:${node?.id ?? ''}`;
          if (title && !seen.has(key)) {
            seen.add(key);
            console.log(`${' '.repeat(depth * 2 + 6)}${node.type ?? '?'} :: ${title}`);
          }
          for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach((v) => walk(v, depth + 1));
            else if (value && typeof value === 'object') walk(value, depth + 1);
          }
        };
        walk(JSON.parse(text), 0);
      }
    } catch (err) {
      console.log(`  ERR  ${path.padEnd(58)} ${(err as Error).message}`);
    }
  }
}

void main();
