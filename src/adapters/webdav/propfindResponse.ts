import { encodeDavHref } from '@/adapters/webdav/davPaths';

/**
 * Minimal DAV multistatus generation.
 *
 * Hand-rolled rather than pulled from a library: the response shape is a handful
 * of always-present properties, and the project already builds its protocol XML
 * in-house (DIDL-Lite for DLNA). A generic WebDAV package would bring a virtual
 * filesystem abstraction we would only have to fight.
 */

export type DavResource = {
  /** Path relative to the share root; '' is the root collection itself. */
  relative: string;
  name: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  contentType?: string;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** RFC 1123 date, the format `getlastmodified` is defined to use. */
function httpDate(mtimeMs: number): string {
  return new Date(mtimeMs).toUTCString();
}

/** ISO 8601, the format `creationdate` is defined to use. */
function isoDate(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString();
}

function responseFor(resource: DavResource): string {
  const href = resource.isDirectory
    ? `${encodeDavHref(resource.relative)}${resource.relative ? '/' : ''}`
    : encodeDavHref(resource.relative);

  // A collection advertises no length or content type; a file must carry both or
  // clients show it as a zero-byte item.
  const typeProps = resource.isDirectory
    ? '<D:resourcetype><D:collection/></D:resourcetype>'
    : [
      '<D:resourcetype/>',
      `<D:getcontentlength>${resource.size}</D:getcontentlength>`,
      `<D:getcontenttype>${escapeXml(resource.contentType ?? 'application/octet-stream')}</D:getcontenttype>`,
    ].join('');

  return [
    '<D:response>',
    `<D:href>${escapeXml(href)}</D:href>`,
    '<D:propstat>',
    '<D:prop>',
    `<D:displayname>${escapeXml(resource.name)}</D:displayname>`,
    typeProps,
    `<D:getlastmodified>${httpDate(resource.mtimeMs)}</D:getlastmodified>`,
    `<D:creationdate>${isoDate(resource.mtimeMs)}</D:creationdate>`,
    '<D:supportedlock>',
    '<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>',
    '</D:supportedlock>',
    '</D:prop>',
    '<D:status>HTTP/1.1 200 OK</D:status>',
    '</D:propstat>',
    '</D:response>',
  ].join('');
}

/** Builds a complete `207 Multi-Status` body for the given resources. */
export function buildMultiStatus(resources: DavResource[]): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<D:multistatus xmlns:D="DAV:">',
    ...resources.map(responseFor),
    '</D:multistatus>',
  ].join('');
}

/**
 * Body for a LOCK response.
 *
 * The share does not implement real locking — see the note in webdavServer on why
 * a token is still issued.
 */
export function buildLockResponse(token: string, href: string, timeoutSeconds: number): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<D:prop xmlns:D="DAV:">',
    '<D:lockdiscovery>',
    '<D:activelock>',
    '<D:locktype><D:write/></D:locktype>',
    '<D:lockscope><D:exclusive/></D:lockscope>',
    '<D:depth>infinity</D:depth>',
    `<D:timeout>Second-${timeoutSeconds}</D:timeout>`,
    `<D:locktoken><D:href>${escapeXml(token)}</D:href></D:locktoken>`,
    `<D:lockroot><D:href>${escapeXml(href)}</D:href></D:lockroot>`,
    '</D:activelock>',
    '</D:lockdiscovery>',
    '</D:prop>',
  ].join('');
}
