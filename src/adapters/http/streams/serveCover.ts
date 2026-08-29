/**
 * Serving a cover image over HTTP, for whichever route asked.
 *
 * Extracted so the session-scoped `/streams/{zone}/{session}/cover` and the public
 * `/api/v1/zones/{id}/cover` behave identically: same data-uri handling, same upstream
 * proxying, same 404 body. A cover that renders on one and not the other would be worse
 * than one that renders on neither.
 */
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ComponentLogger } from '@/shared/logging/logger';
import { isHttpUrl } from '@/shared/coverArt';

export function coverUnavailable(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('cover-not-found');
}

/**
 * True when a client's `If-None-Match` covers `etag`.
 *
 * Handles the list form and `*`, and ignores a `W/` weak prefix: nothing here
 * distinguishes weak from strong, and a byte-identical cover is what both mean.
 */
function matchesEtag(ifNoneMatch: string, etag: string): boolean {
  const normalise = (value: string) => value.trim().replace(/^W\//, '');
  const wanted = normalise(etag);
  return ifNoneMatch
    .split(',')
    .some((candidate) => candidate.trim() === '*' || normalise(candidate) === wanted);
}

function serveDataUri(
  res: ServerResponse,
  dataUri: string,
  cacheControl: string,
  headers: Record<string, string>,
): void {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUri);
  if (!match) {
    coverUnavailable(res);
    return;
  }
  const [, mime, payload] = match;
  const bytes = Buffer.from(payload ?? '', 'base64');
  res.writeHead(200, {
    ...headers,
    'Content-Type': mime || 'image/jpeg',
    'Content-Length': bytes.length,
    'Cache-Control': cacheControl,
  });
  res.end(bytes);
}

async function proxyFromHttp(
  res: ServerResponse,
  source: string,
  log: ComponentLogger,
  cacheControl: string,
  headers: Record<string, string>,
): Promise<void> {
  try {
    const response = await fetch(source);
    if (!response.ok || !response.body) {
      coverUnavailable(res);
      return;
    }
    const upstreamLength = response.headers.get('content-length');
    res.writeHead(200, {
      ...headers,
      'Content-Type': response.headers.get('content-type') ?? 'image/jpeg',
      ...(upstreamLength ? { 'Content-Length': upstreamLength } : {}),
      'Cache-Control': cacheControl,
    });
    const stream = Readable.fromWeb(
      response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
    );
    stream.on('error', (error) => {
      log.warn('cover proxy stream failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        coverUnavailable(res);
      } else {
        res.destroy(error as Error);
      }
    });
    stream.pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('cover proxy failed', { source, message });
    coverUnavailable(res);
  }
}

export type ServeCoverOptions = {
  /**
   * Differs per caller: a session cover is only valid while that session lives, while a
   * zone's current cover is worth holding briefly — a wall panel polling it should not
   * re-fetch the same artwork every second.
   */
  cacheControl?: string;
  /**
   * Identifies *which* cover this is, so a client can revalidate instead of re-downloading.
   *
   * This is what makes a zone-addressed url safe to cache at all: the url cannot change
   * when the track does, so without an ETag a client's only options are re-fetching the
   * bytes every time or showing a stale image. With one, a conditional request costs a
   * `304` and no body, and the picture still changes the moment the music does.
   */
  etag?: string;
  /** The request's `If-None-Match`, answered with `304` when it matches `etag`. */
  ifNoneMatch?: string | undefined;
};

/**
 * Writes `source` to `res`, whether it is inline bytes, a data uri or a remote url.
 */
export async function serveCover(
  res: ServerResponse,
  source: { data: Buffer; mime?: string } | string | null,
  log: ComponentLogger,
  options: ServeCoverOptions = {},
): Promise<void> {
  const { cacheControl = 'no-cache', etag, ifNoneMatch } = options;
  if (!source) {
    coverUnavailable(res);
    return;
  }
  // Revalidation before any upstream work: the whole point of the ETag is that an
  // unchanged cover costs neither a proxied download nor a response body.
  if (etag && ifNoneMatch && matchesEtag(ifNoneMatch, etag)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl }).end();
    return;
  }
  const headers: Record<string, string> = etag ? { ETag: etag } : {};
  if (typeof source !== 'string') {
    // Content-Length matters beyond politeness here. Without it the response is
    // chunked, and a client that stores the image rather than just showing it --
    // the Loxone app caches covers in IndexedDB -- gets a Blob of unknown size,
    // which Safari refuses to write ("Error preparing Blob/File data"). Opening
    // the same url in a tab looks fine, because nothing is stored.
    res.writeHead(200, {
      ...headers,
      'Content-Type': source.mime || 'image/jpeg',
      'Content-Length': source.data.length,
      'Cache-Control': cacheControl,
    });
    res.end(source.data);
    return;
  }
  if (source.startsWith('data:')) {
    serveDataUri(res, source, cacheControl, headers);
    return;
  }
  if (isHttpUrl(source)) {
    await proxyFromHttp(res, source, log, cacheControl, headers);
    return;
  }
  coverUnavailable(res);
}
