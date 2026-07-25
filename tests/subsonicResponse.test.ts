import assert from 'node:assert/strict';
import { ServerResponse } from 'node:http';
import { test } from './testHarness';
import {
  SubsonicErrorCode,
  resolveFormat,
  sendSubsonic,
  sendSubsonicError,
} from '../src/adapters/subsonic/subsonicResponse';

/** Minimal ServerResponse capture: enough for the envelope, no socket needed. */
function captureResponse(): {
  res: ServerResponse;
  body(): string;
  status(): number;
  headers(): Record<string, unknown>;
} {
  const chunks: Buffer[] = [];
  let status = 0;
  let headers: Record<string, unknown> = {};
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(code: number, hdrs: Record<string, unknown>) {
      status = code;
      headers = hdrs ?? {};
      (this as { headersSent: boolean }).headersSent = true;
      return this;
    },
    end(chunk?: Buffer) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      (this as { writableEnded: boolean }).writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    body: () => Buffer.concat(chunks).toString('utf8'),
    status: () => status,
    headers: () => headers,
  };
}

test('subsonic response: xml is the default format', () => {
  const fmt = resolveFormat(new URLSearchParams(''));
  assert.equal(fmt.format, 'xml');
  const cap = captureResponse();
  sendSubsonic(cap.res, fmt, { license: { valid: true } });
  const body = cap.body();
  assert.match(body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(body, /<subsonic-response [^>]*xmlns="http:\/\/subsonic\.org\/restapi"/);
  assert.match(body, /status="ok"/);
  assert.match(body, /version="1\.16\.1"/);
  assert.match(body, /<license valid="true"\/>/);
});

test('subsonic response: scalars become attributes and collections become elements', () => {
  const cap = captureResponse();
  sendSubsonic(cap.res, { format: 'xml', callback: null }, {
    musicFolders: {
      musicFolder: [
        { id: 1, name: 'Library' },
        { id: 2, name: 'Tidal' },
      ],
    },
  });
  const body = cap.body();
  assert.match(body, /<musicFolders><musicFolder id="1" name="Library"\/>/);
  assert.match(body, /<musicFolder id="2" name="Tidal"\/><\/musicFolders>/);
});

test('subsonic response: undefined and null fields are omitted, not emitted empty', () => {
  const cap = captureResponse();
  sendSubsonic(cap.res, { format: 'xml', callback: null }, {
    song: { id: 'a', bitRate: undefined, coverArt: null, title: 'x' },
  });
  const body = cap.body();
  assert.ok(!body.includes('bitRate'), 'undefined attribute must be dropped');
  assert.ok(!body.includes('coverArt'), 'null attribute must be dropped');
  assert.match(body, /<song id="a" title="x"\/>/);
});

test('subsonic response: xml escapes attribute values', () => {
  const cap = captureResponse();
  sendSubsonic(cap.res, { format: 'xml', callback: null }, {
    song: { title: 'Rock & "Roll" <hi>' },
  });
  assert.match(cap.body(), /title="Rock &amp; &quot;Roll&quot; &lt;hi&gt;"/);
});

test('subsonic response: xml strips control characters that no escaping can legalise', () => {
  const cap = captureResponse();
  sendSubsonic(cap.res, { format: 'xml', callback: null }, {
    song: { title: `bad\u0000name\u0007here` },
  });
  const body = cap.body();
  assert.match(body, /title="badnamehere"/);
  assert.ok(!body.includes('\u0000') && !body.includes('\u0007'));
});

test('subsonic response: json mirrors the xml shape under the wrapper key', () => {
  const fmt = resolveFormat(new URLSearchParams('f=json'));
  assert.equal(fmt.format, 'json');
  const cap = captureResponse();
  sendSubsonic(cap.res, fmt, { musicFolders: { musicFolder: [{ id: 1, name: 'Library' }] } });
  const parsed = JSON.parse(cap.body());
  assert.equal(parsed['subsonic-response'].status, 'ok');
  assert.equal(parsed['subsonic-response'].openSubsonic, true);
  assert.deepEqual(parsed['subsonic-response'].musicFolders.musicFolder, [
    { id: 1, name: 'Library' },
  ]);
});

test('subsonic response: jsonp wraps json in the requested callback', () => {
  const fmt = resolveFormat(new URLSearchParams('f=jsonp&callback=cb42'));
  assert.equal(fmt.format, 'jsonp');
  const cap = captureResponse();
  sendSubsonic(cap.res, fmt, {});
  assert.match(cap.body(), /^cb42\(\{"subsonic-response":/);
  assert.match(cap.body(), /\);$/);
});

test('subsonic response: jsonp without a safe callback degrades to json', () => {
  // An unusable callback would otherwise emit unparseable script.
  assert.equal(resolveFormat(new URLSearchParams('f=jsonp')).format, 'json');
  assert.equal(
    resolveFormat(new URLSearchParams('f=jsonp&callback=alert(1);x')).format,
    'json',
  );
});

test('subsonic response: faults carry the code in the envelope at HTTP 200', () => {
  const cap = captureResponse();
  sendSubsonicError(
    cap.res,
    { format: 'json', callback: null },
    SubsonicErrorCode.WrongCredentials,
    'Wrong username or password',
  );
  // Clients read the fault from the body; a non-200 reads as a transport failure.
  assert.equal(cap.status(), 200);
  const parsed = JSON.parse(cap.body());
  assert.equal(parsed['subsonic-response'].status, 'failed');
  assert.equal(parsed['subsonic-response'].error.code, 40);
  assert.equal(parsed['subsonic-response'].error.message, 'Wrong username or password');
});

test('subsonic response: content-length matches the encoded body', () => {
  const cap = captureResponse();
  sendSubsonic(cap.res, { format: 'json', callback: null }, { song: { title: 'ü — ✓' } });
  assert.equal(cap.headers()['Content-Length'], Buffer.byteLength(cap.body(), 'utf8'));
});
