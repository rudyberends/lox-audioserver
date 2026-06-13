// Verify the full librespot browse path: third-party playlist -> track URIs ->
// metadata hydration (titles/artists/album/cover), all over the protocol.
import pkg from '@lox-audioserver/node-librespot';
import { readFileSync } from 'node:fs';
const { createSessionWithCredentials, setLogLevel } = pkg;
setLogLevel?.('warn');
const creds = JSON.parse(readFileSync(new URL('../data/config.json', import.meta.url)))
  .content?.spotify?.accounts?.[0]?.librespotCredentials;
const session = await createSessionWithCredentials(JSON.stringify(creds), 'pl-probe', null, null);

async function probe(label, uri) {
  const t0 = Date.now();
  const uris = await session.getPlaylistTracks(uri);
  const tMeta = Date.now();
  const meta = await session.getTracksMetadata(uris.slice(0, 5));
  console.log(`\n[${label}] ${uri}`);
  console.log(`  tracks=${uris.length}  list=${tMeta - t0}ms  meta(5)=${Date.now() - tMeta}ms`);
  for (const m of meta) {
    console.log(`   • ${m.name} — ${m.artists} [${m.album}] ${(m.durationMs/1000).toFixed(0)}s  cover=${m.coverUrl ? 'y' : 'n'}`);
  }
}

await probe('THIRD-PARTY Today\'s Top Hits', 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
await probe('OWN', 'spotify:playlist:2wVjOvhvk4M8CYe6akFwkE');
await session.close();
