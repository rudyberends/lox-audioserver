import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from './testHarness';
import { createRetryStream } from '../src/adapters/content/providers/deezer/deezerStreamService';

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

type FetchCall = { url: string; range?: string };

/**
 * A response body that mirrors what an aborted `fetch` does to its stream: the request's
 * own signal errors the body, which is how the stall timer used to cut a healthy download
 * short. `tail` is what happens once the listed chunks are gone.
 */
function bodyOf(
  chunks: Buffer[],
  signal: AbortSignal,
  tail: 'close' | 'error' | 'silent',
  /**
   * Grace before the tail fires. A body that errors takes its unread buffer down with it —
   * real downloads too — so a break has to land after the consumer has taken the bytes for
   * the resume offset to mean anything.
   */
  tailDelayMs = 0,
  /** Gap between chunks, so a body can still be arriving while we are parked on `drain`. */
  chunkDelayMs = 0,
): ReadableStream {
  let index = 0;
  return new ReadableStream({
    start(controller) {
      signal.addEventListener(
        'abort',
        () => {
          try {
            controller.error(new Error('This operation was aborted'));
          } catch {
            // Already closed — the abort came after the body was fully read.
          }
        },
        { once: true },
      );
    },
    async pull(controller) {
      if (index < chunks.length) {
        if (chunkDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
        }
        controller.enqueue(new Uint8Array(chunks[index]!));
        index += 1;
        return;
      }
      if (tailDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, tailDelayMs));
      }
      if (tail === 'close') {
        controller.close();
        return;
      }
      if (tail === 'error') {
        controller.error(new Error('upstream reset'));
        return;
      }
      // 'silent': never resolves, so the connection stays open without delivering.
      await new Promise<void>(() => {});
    },
  });
}

function stubFetch(
  handler: (call: FetchCall, signal: AbortSignal) => { status: number; body?: ReadableStream },
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const call: FetchCall = { url: String(url), range: init?.headers?.Range };
    calls.push(call);
    const res = handler(call, init.signal as AbortSignal);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      body: res.body ?? null,
    } as any;
  }) as any;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => parts.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(parts)));
    stream.on('error', reject);
  });
}

const file = (bytes: number): Buffer =>
  Buffer.from(Array.from({ length: bytes }, (_, i) => i % 251));

test('an upstream body that breaks off mid-track is resumed, not passed off as the end', async () => {
  const full = file(9000);
  // No estimatedSize: the gw path hands us one URL and often no filesize, so the resume
  // may not lean on either.
  const session = { urls: ['https://cdn.example/track'], headers: {}, estimatedSize: undefined } as any;
  const stub = stubFetch((call, signal) => {
    if (!call.range) {
      return { status: 200, body: bodyOf([full.subarray(0, 5000)], signal, 'error', 20) };
    }
    return { status: 206, body: bodyOf([full.subarray(5000)], signal, 'close') };
  });
  try {
    const out = createRetryStream(session, new AbortController().signal, noopLog, 200);
    assert.deepEqual(await collect(out), full);
    assert.equal(stub.calls.length, 2);
    // 5000 is not a multiple of the 2048-byte block, so this also proves the partial block
    // left in hand is counted once and only once.
    assert.equal(stub.calls[1]!.range, 'bytes=5000-');
  } finally {
    stub.restore();
  }
});

test('a stream that stays short of the advertised filesize resumes for the rest', async () => {
  const full = file(8000);
  const session = { urls: ['https://cdn.example/track'], headers: {}, estimatedSize: 8000 } as any;
  const stub = stubFetch((call, signal) => {
    if (!call.range) {
      return { status: 200, body: bodyOf([full.subarray(0, 5000)], signal, 'close') };
    }
    return { status: 206, body: bodyOf([full.subarray(5000)], signal, 'close') };
  });
  try {
    const out = createRetryStream(session, new AbortController().signal, noopLog, 50);
    assert.deepEqual(await collect(out), full);
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test('the advertised filesize is advisory: a second close at the same byte ends the stream', async () => {
  const partial = file(5000);
  const session = { urls: ['https://cdn.example/track'], headers: {}, estimatedSize: 8000 } as any;
  const stub = stubFetch((call, signal) => {
    if (!call.range) {
      return { status: 200, body: bodyOf([partial], signal, 'close') };
    }
    return { status: 206, body: bodyOf([], signal, 'close') };
  });
  try {
    const out = createRetryStream(session, new AbortController().signal, noopLog, 50);
    assert.deepEqual(await collect(out), partial);
    assert.equal(stub.calls.length, 2, 'one resume attempt, then trust the bytes');
  } finally {
    stub.restore();
  }
});

test('a consumer slower than the stall timeout does not cost us the connection', async () => {
  // 384 KB overruns what an unread PassThrough holds (~128 KB), so the writer parks on
  // `drain` well before the download is done — which is all a paced output like sendspin
  // does. Upstream keeps trickling meanwhile, so the connection is demonstrably alive.
  const full = file(384 * 1024);
  const chunks: Buffer[] = [];
  for (let at = 0; at < full.length; at += 16 * 1024) {
    chunks.push(full.subarray(at, at + 16 * 1024));
  }
  const session = { urls: ['https://cdn.example/track'], headers: {} } as any;
  const stub = stubFetch((_call, signal) => ({
    status: 200,
    body: bodyOf(chunks, signal, 'close', 0, 25),
  }));
  try {
    const out = createRetryStream(session, new AbortController().signal, noopLog, 100);
    // Read nothing for several stall timeouts, then drain.
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.deepEqual(await collect(out), full);
    assert.equal(stub.calls.length, 1, 'our own backpressure must not be read as a stalled download');
  } finally {
    stub.restore();
  }
});

test('an unrecoverable break errors the stream instead of ending it short', async () => {
  const session = { urls: ['https://cdn.example/track'], headers: {} } as any;
  const stub = stubFetch((call, signal) => {
    if (!call.range) {
      return { status: 200, body: bodyOf([file(5000)], signal, 'error', 20) };
    }
    return { status: 503 };
  });
  try {
    const out = createRetryStream(session, new AbortController().signal, noopLog, 200);
    out.resume();
    const [err] = (await once(out, 'error')) as [Error];
    assert.match(err.message, /broke off at \d+ bytes/);
  } finally {
    stub.restore();
  }
});

test('a client that goes away stops the pump instead of leaving it parked on drain', async () => {
  const chunks: Buffer[] = [];
  for (let at = 0; at < 32 * 1024; at += 8 * 1024) {
    chunks.push(file(8 * 1024));
  }
  const session = { urls: ['https://cdn.example/track'], headers: {} } as any;
  const stub = stubFetch((_call, signal) => ({ status: 200, body: bodyOf(chunks, signal, 'silent') }));
  const controller = new AbortController();
  try {
    const out = createRetryStream(session, controller.signal, noopLog, 50);
    // Nothing reads, so the pump is blocked on `drain` when the request is abandoned.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(stub.calls.length, 1, 'an abandoned request is not retried');
    assert.equal(out.writableEnded, false, 'and it is certainly not reported as a finished track');
  } finally {
    stub.restore();
  }
});
