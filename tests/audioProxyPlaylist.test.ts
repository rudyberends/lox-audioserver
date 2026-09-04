import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from './testHarness';
import { AudioProxyHandler } from '../src/adapters/http/streams/audioProxyHandler';

// Issue #368: a TuneIn station whose url is a `.m3u` naming the real stream. ffmpeg has
// no demuxer for a pointer playlist — its only m3u reader is the hls one, which wants a
// manifest — so handing the list on gave "Invalid data found when processing input". The
// proxy follows the pointer itself now; a genuine HLS manifest still goes to the client.

interface Upstream {
  base: string;
  hits: string[];
  close: () => Promise<void>;
}

/** Serves whatever the routes map says, and records what was asked for. */
async function startUpstream(
  routes: (base: string) => Record<string, { type: string; body: string; status?: number }>,
): Promise<Upstream> {
  const hits: string[] = [];
  let table: Record<string, { type: string; body: string; status?: number }> = {};
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    hits.push(path);
    const route = table[path];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('nope');
      return;
    }
    res.writeHead(route.status ?? 200, {
      'Content-Type': route.type,
      'Content-Length': String(Buffer.byteLength(route.body)),
    });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  table = routes(base);
  return {
    base,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startProxy(): Promise<{ port: number; close: () => Promise<void> }> {
  const zoneManager = { inputs: { updateRadioMetadata: () => undefined } };
  const handler = new AudioProxyHandler(zoneManager as never);
  const server = http.createServer((req, res) => {
    void handler.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function fetchThroughProxy(
  port: number,
  target: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const path = `/streams/proxy?u=${encodeURIComponent(target)}`;
    const req = http.request({ host: '127.0.0.1', port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('audio proxy: a pointer m3u is followed to the stream it names', async () => {
  // Exactly the shape that broke: no `#EXTM3U`, one absolute url, served as x-mpegurl.
  const upstream = await startUpstream((base) => ({
    '/station.m3u': { type: 'audio/x-mpegurl', body: `${base}/live.aac\n` },
    '/live.aac': { type: 'audio/aac', body: 'AUDIO-BYTES' },
  }));
  const proxy = await startProxy();
  try {
    const res = await fetchThroughProxy(proxy.port, `${upstream.base}/station.m3u`);
    assert.equal(res.status, 200);
    assert.equal(res.body, 'AUDIO-BYTES');
    assert.equal(res.headers['content-type'], 'audio/aac');
    assert.deepEqual(upstream.hits, ['/station.m3u', '/live.aac']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('audio proxy: an extended m3u without hls tags is a pointer too', async () => {
  // `#EXTM3U` alone is not a manifest — ffmpeg's hls probe wants an `#EXT-X-` tag with it.
  const upstream = await startUpstream((base) => ({
    '/station.m3u': {
      type: 'audio/x-mpegurl',
      body: `#EXTM3U\n#EXTINF:-1,Some Station\n${base}/live.mp3\n`,
    },
    '/live.mp3': { type: 'audio/mpeg', body: 'MP3-BYTES' },
  }));
  const proxy = await startProxy();
  try {
    const res = await fetchThroughProxy(proxy.port, `${upstream.base}/station.m3u`);
    assert.equal(res.body, 'MP3-BYTES');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('audio proxy: a pls falls past a dead mirror to a live one', async () => {
  const upstream = await startUpstream((base) => ({
    '/station.pls': {
      type: 'audio/x-scpls',
      body: `[playlist]\nNumberOfEntries=2\nFile1=${base}/dead\nFile2=${base}/live.mp3\n`,
    },
    '/live.mp3': { type: 'audio/mpeg', body: 'MIRROR-TWO' },
  }));
  const proxy = await startProxy();
  try {
    const res = await fetchThroughProxy(proxy.port, `${upstream.base}/station.pls`);
    assert.equal(res.status, 200);
    assert.equal(res.body, 'MIRROR-TWO');
    // `/dead` twice: a refusal to the windowed probe is always re-asked unwindowed,
    // the same retry that keeps range-hostile hosts working.
    assert.deepEqual(upstream.hits, ['/station.pls', '/dead', '/dead', '/live.mp3']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('audio proxy: a real hls manifest is still handed to the client, proxied', async () => {
  const manifest = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.0,', 'seg1.aac', ''].join('\n');
  const upstream = await startUpstream(() => ({
    '/live.m3u8': { type: 'application/vnd.apple.mpegurl', body: manifest },
  }));
  const proxy = await startProxy();
  try {
    const res = await fetchThroughProxy(proxy.port, `${upstream.base}/live.m3u8`);
    assert.equal(res.status, 200);
    assert.ok(res.body.startsWith('#EXTM3U'), 'manifest must reach ffmpeg intact');
    // The segment is rewritten back through the proxy, absolute against the manifest url.
    assert.ok(
      res.body.includes(`/streams/proxy?u=${encodeURIComponent(`${upstream.base}/seg1.aac`)}`),
      `segment not proxied: ${res.body}`,
    );
    // Only the manifest was fetched — nothing followed it.
    assert.deepEqual(upstream.hits, ['/live.m3u8']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('audio proxy: a playlist naming only playlists gives up instead of looping', async () => {
  const upstream = await startUpstream((base) => ({
    '/a.m3u': { type: 'audio/x-mpegurl', body: `${base}/b.m3u\n` },
    '/b.m3u': { type: 'audio/x-mpegurl', body: `${base}/c.m3u\n` },
    '/c.m3u': { type: 'audio/x-mpegurl', body: `${base}/d.m3u\n` },
    '/d.m3u': { type: 'audio/x-mpegurl', body: `${base}/a.m3u\n` },
  }));
  const proxy = await startProxy();
  try {
    const res = await fetchThroughProxy(proxy.port, `${upstream.base}/a.m3u`);
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.body).error, 'playlist-too-deep');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('audio proxy: an html error page under an m3u content type is not chased', async () => {
  // A dead CDN url answered with a landing page and `application/x-mpegURL` on it. Every
  // line of that html resolves against the base into a fetchable url; none is an entry.
  const upstream = await startUpstream(() => ({
    '/gone.m3u8': {
      type: 'application/x-mpegURL',
      body: '<!doctype html>\n<html>\n<body>Not here</body>\n</html>\n',
    },
  }));
  const proxy = await startProxy();
  try {
    const res = await fetchThroughProxy(proxy.port, `${upstream.base}/gone.m3u8`);
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.body).error, 'playlist-unplayable');
    assert.deepEqual(upstream.hits, ['/gone.m3u8']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('audio proxy: a playlist with no usable entry is reported, not served as audio', async () => {
  const upstream = await startUpstream(() => ({
    '/empty.m3u': { type: 'audio/x-mpegurl', body: '#EXTM3U\n#EXTINF:-1,Nothing\n' },
  }));
  const proxy = await startProxy();
  try {
    const res = await fetchThroughProxy(proxy.port, `${upstream.base}/empty.m3u`);
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.body).error, 'playlist-unplayable');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
