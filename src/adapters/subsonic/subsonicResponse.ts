import type { ServerResponse } from 'node:http';

/**
 * Response envelope + serialisation for the Subsonic API.
 *
 * Every response — success or failure — is a `subsonic-response` wrapper carrying
 * a status, the API version and (for OpenSubsonic clients) the server identity.
 * Three wire formats exist, selected by the `f` parameter: `xml` (the spec
 * default), `json`, and `jsonp` (JSON wrapped in a callback).
 *
 * The payload is a plain object shaped like the XML: scalars become attributes,
 * nested objects and arrays become child elements. That one convention serialises
 * to both formats, so endpoints build their result once and never think about
 * the wire format.
 */

/** The API level we claim. 1.16.1 is the last Subsonic release and the de-facto baseline. */
export const SUBSONIC_API_VERSION = '1.16.1';
export const SUBSONIC_SERVER_TYPE = 'sonn-audio';

/** Standard Subsonic error codes (subsonic.org/pages/api.jsp). */
export const SubsonicErrorCode = {
  Generic: 0,
  MissingParameter: 10,
  ClientTooOld: 20,
  ServerTooOld: 30,
  WrongCredentials: 40,
  TokenAuthNotSupported: 41,
  NotAuthorized: 50,
  TrialOver: 60,
  NotFound: 70,
} as const;

export type SubsonicErrorCodeValue =
  (typeof SubsonicErrorCode)[keyof typeof SubsonicErrorCode];

/** An error that maps onto a Subsonic fault rather than an HTTP error status. */
export class SubsonicError extends Error {
  constructor(
    public readonly code: SubsonicErrorCodeValue,
    message: string,
  ) {
    super(message);
    this.name = 'SubsonicError';
  }
}

export type SubsonicFormat = 'xml' | 'json' | 'jsonp';

/** Anything serialisable into the envelope. */
export type SubsonicValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SubsonicNode
  | SubsonicValue[];

export interface SubsonicNode {
  /** Element text content, for the few entities that carry a value (e.g. lyrics). */
  _text?: string;
  [key: string]: SubsonicValue;
}

export interface SubsonicRequestFormat {
  format: SubsonicFormat;
  callback: string | null;
}

/** Read the response format from the request parameters. XML is the spec default. */
export function resolveFormat(params: URLSearchParams): SubsonicRequestFormat {
  const raw = (params.get('f') ?? '').trim().toLowerCase();
  const callback = params.get('callback');
  if (raw === 'json') {
    return { format: 'json', callback: null };
  }
  if (raw === 'jsonp') {
    // A jsonp request without a usable callback would produce unparseable
    // output; fall back to plain JSON rather than emitting broken script.
    return callback && /^[A-Za-z_$][\w$.]*$/.test(callback)
      ? { format: 'jsonp', callback }
      : { format: 'json', callback: null };
  }
  return { format: 'xml', callback: null };
}

/**
 * Control characters other than tab/LF/CR are illegal in XML 1.0 at any level of
 * escaping — `&#x1;` is not valid either — so they are dropped rather than
 * encoded. Provider metadata does occasionally carry them, and one stray byte
 * would make the whole response unparseable for the client.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

function xmlEscapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(ILLEGAL_XML_CHARS, '');
}

function xmlEscapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(ILLEGAL_XML_CHARS, '');
}

function isScalar(value: SubsonicValue): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Serialise one node: scalar properties become attributes, object/array
 * properties become nested elements. Undefined and null are omitted entirely so
 * endpoints can build results with optional fields inline.
 */
function nodeToXml(name: string, node: SubsonicNode): string {
  const attrs: string[] = [];
  const children: string[] = [];
  let text = '';

  for (const [key, value] of Object.entries(node)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (key === '_text') {
      text = xmlEscapeText(String(value));
      continue;
    }
    if (isScalar(value)) {
      attrs.push(`${key}="${xmlEscapeAttr(String(value))}"`);
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry === undefined || entry === null) {
          continue;
        }
        children.push(
          isScalar(entry)
            ? `<${key}>${xmlEscapeText(String(entry))}</${key}>`
            : nodeToXml(key, entry as SubsonicNode),
        );
      }
      continue;
    }
    children.push(nodeToXml(key, value as SubsonicNode));
  }

  const open = attrs.length ? `<${name} ${attrs.join(' ')}` : `<${name}`;
  if (!children.length && !text) {
    return `${open}/>`;
  }
  return `${open}>${text}${children.join('')}</${name}>`;
}

function envelope(status: 'ok' | 'failed', payload: SubsonicNode): SubsonicNode {
  return {
    status,
    version: SUBSONIC_API_VERSION,
    type: SUBSONIC_SERVER_TYPE,
    serverVersion: SUBSONIC_API_VERSION,
    // Signals the OpenSubsonic extensions handshake to clients that look for it.
    openSubsonic: true,
    ...payload,
  };
}

function serialise(
  body: SubsonicNode,
  { format, callback }: SubsonicRequestFormat,
): { contentType: string; text: string } {
  if (format === 'xml') {
    const xml = nodeToXml('subsonic-response', {
      xmlns: 'http://subsonic.org/restapi',
      ...body,
    });
    return {
      contentType: 'application/xml; charset=utf-8',
      text: `<?xml version="1.0" encoding="UTF-8"?>${xml}`,
    };
  }
  const json = JSON.stringify({ 'subsonic-response': body });
  if (format === 'jsonp') {
    return {
      contentType: 'application/javascript; charset=utf-8',
      text: `${callback}(${json});`,
    };
  }
  return { contentType: 'application/json; charset=utf-8', text: json };
}

/** Send a successful response carrying `payload` (e.g. `{ musicFolders: {...} }`). */
export function sendSubsonic(
  res: ServerResponse,
  fmt: SubsonicRequestFormat,
  payload: SubsonicNode = {},
): void {
  const { contentType, text } = serialise(envelope('ok', payload), fmt);
  writeBody(res, contentType, text);
}

/**
 * Send a Subsonic fault. The HTTP status stays 200: clients read the fault from
 * the envelope, and several of them treat a non-200 as a transport failure and
 * never surface the actual error code.
 */
export function sendSubsonicError(
  res: ServerResponse,
  fmt: SubsonicRequestFormat,
  code: SubsonicErrorCodeValue,
  message: string,
): void {
  const { contentType, text } = serialise(
    envelope('failed', { error: { code, message } }),
    fmt,
  );
  writeBody(res, contentType, text);
}

function writeBody(res: ServerResponse, contentType: string, text: string): void {
  if (res.headersSent) {
    return;
  }
  const buffer = Buffer.from(text, 'utf8');
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-cache',
    // Browser-based clients (Subplayer, Airsonic-refix) call the API cross-origin.
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buffer);
}
