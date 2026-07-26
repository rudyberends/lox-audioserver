#!/usr/bin/env node
/**
 * DLNA browse probe — acts as a UPnP control point against our own MediaServer.
 *
 * Exists because judging the DLNA server through a phone app conflates two
 * questions: does our DIDL say the right things, and does that particular app
 * render them. This answers only the first, deterministically, so a change can be
 * verified without installing anything.
 *
 *   node scripts/dlna-browse.mjs                     # browse the root
 *   node scripts/dlna-browse.mjs <objectId>           # browse one container
 *   node scripts/dlna-browse.mjs <objectId> --meta    # also BrowseMetadata each child
 *   node scripts/dlna-browse.mjs <objectId> --art     # HEAD every artwork URL
 *   node scripts/dlna-browse.mjs <objectId> --count 5 --host 192.168.1.209:7090
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const objectId = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true) ?? '0';
const host = opt('host', 'localhost:7090');
const count = Number(opt('count', '10'));
const control = `http://${host}/dlna/cds/control`;

const unescape = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

async function soap(oid, browseFlag) {
  const body =
    `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">` +
    `<ObjectID>${oid}</ObjectID><BrowseFlag>${browseFlag}</BrowseFlag><Filter>*</Filter>` +
    `<StartingIndex>0</StartingIndex><RequestedCount>${count}</RequestedCount>` +
    `<SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>`;
  const res = await fetch(control, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"',
    },
    body,
  });
  const xml = await res.text();
  if (!res.ok) throw new Error(`${browseFlag} ${oid} → HTTP ${res.status}\n${xml.slice(0, 400)}`);
  const total = xml.match(/<TotalMatches>(\d+)</)?.[1];
  return { didl: unescape(xml.match(/<Result>([\s\S]*?)<\/Result>/)?.[1] ?? ''), total };
}

/** Pull the fields a control point renders a row from. */
function parseObjects(didl) {
  const out = [];
  for (const m of didl.matchAll(/<(container|item)\s([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const attrs = m[2];
    const inner = m[3];
    const pick = (tag) => inner.match(new RegExp(`<${tag}>([^<]*)`))?.[1] ?? '';
    out.push({
      node: m[1],
      id: attrs.match(/id="([^"]*)"/)?.[1] ?? '',
      childCount: attrs.match(/childCount="(\d+)"/)?.[1],
      title: pick('dc:title'),
      creator: pick('dc:creator'),
      artist: pick('upnp:artist'),
      album: pick('upnp:album'),
      upnpClass: pick('upnp:class'),
      art: inner.match(/<upnp:albumArtURI[^>]*>([^<]*)/)?.[1] ?? '',
      res: inner.match(/<res[^>]*>([^<]*)/)?.[1] ?? '',
    });
  }
  return out;
}

async function headOk(url) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    return `${res.status} ${res.headers.get('content-type') ?? '?'}`;
  } catch (err) {
    return `FAILED ${err.message}`;
  }
}

const short = (c) =>
  c.replace('object.container.', 'container/').replace('object.item.audioItem.', 'item/') || '—';

const { didl, total } = await soap(objectId, 'BrowseDirectChildren');
const objects = parseObjects(didl);
console.log(`\nBrowse ${objectId}  →  ${objects.length} shown / ${total ?? '?'} total\n`);

for (const o of objects) {
  const bits = [
    o.art ? 'art' : '   ',
    o.artist || o.creator ? 'artist' : '      ',
  ].join(' ');
  console.log(`  ${short(o.upnpClass).padEnd(26)} ${bits}  ${o.title}`);
  if (o.artist || o.creator) console.log(`  ${' '.repeat(26)}          artist=${o.artist || o.creator}`);
  console.log(`  ${' '.repeat(26)}          id=${o.id}`);
  if (flag('art') && o.art) console.log(`  ${' '.repeat(26)}          art→ ${await headOk(o.art)}`);
  if (flag('meta')) {
    const meta = parseObjects((await soap(o.id, 'BrowseMetadata')).didl)[0];
    const same = meta && meta.title === o.title ? 'ok' : 'MISMATCH';
    console.log(
      `  ${' '.repeat(26)}          meta: ${same} title="${meta?.title ?? '-'}" ` +
        `class=${short(meta?.upnpClass ?? '')} art=${meta?.art ? 'yes' : 'no'}`,
    );
  }
}

// A container announced as an album but whose own metadata says otherwise is the
// case that breaks album views in real controllers.
const suspects = objects.filter((o) => o.node === 'container' && !o.art);
if (suspects.length) {
  console.log(`\n  note: ${suspects.length}/${objects.length} containers carry no albumArtURI`);
}
console.log();
