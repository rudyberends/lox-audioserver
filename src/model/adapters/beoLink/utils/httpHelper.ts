import logger from '@/utils/troxorLogger';

/**
 * -----------------------------------------------------------------------------
 * BeoLink HTTP Helper (fetch-based)
 * -----------------------------------------------------------------------------
 */

interface BeoLinkRequestOptions {
  zoneId?: number;
  zoneName?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

function buildHeaders(extra?: Record<string, string>): Headers {
  return new Headers({
    'Content-Type': 'application/json',
    Accept: '*/*',
    ...(extra ?? {}),
  });
}

async function handleResponse(
  url: string,
  res: Response,
): Promise<Response> {
  logger.debug(`[BeoLinkHTTP] ${res.status} ${res.statusText} from ${url}`);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }

  return res;
}

function logError(method: string, url: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error(`[BeoLinkHTTP] ${method} failed (${url}): ${msg}`);
}

/* -------------------------------------------------------------------------- */
/* POST                                                                        */
/* -------------------------------------------------------------------------- */
export async function postBeoLinkCommand(
  url: string,
  body?: Record<string, unknown>,
  options?: BeoLinkRequestOptions,
): Promise<Response | void> {
  try {
    logger.debug(`[BeoLinkHTTP] POST → ${url}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(options?.headers),
      body: JSON.stringify(body ?? {}),
      signal: options?.signal,
    });

    return await handleResponse(url, res);
  } catch (err) {
    logError('POST', url, err);
  }
}

/* -------------------------------------------------------------------------- */
/* PUT                                                                         */
/* -------------------------------------------------------------------------- */
export async function putBeoLinkCommand(
  url: string,
  body: Record<string, unknown>,
  options?: BeoLinkRequestOptions,
): Promise<Response | void> {
  try {
    logger.debug(`[BeoLinkHTTP] PUT → ${url}`);

    const res = await fetch(url, {
      method: 'PUT',
      headers: buildHeaders(options?.headers),
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    return await handleResponse(url, res);
  } catch (err) {
    logError('PUT', url, err);
  }
}

/* -------------------------------------------------------------------------- */
/* DELETE                                                                      */
/* -------------------------------------------------------------------------- */
export async function deleteBeoLinkCommand(
  url: string,
  options?: BeoLinkRequestOptions,
): Promise<void> {
  try {
    logger.debug(`[BeoLinkHTTP] DELETE → ${url}`);

    const res = await fetch(url, {
      method: 'DELETE',
      headers: buildHeaders(options?.headers),
      signal: options?.signal,
    });

    await handleResponse(url, res);
  } catch (err) {
    logError('DELETE', url, err);
  }
}