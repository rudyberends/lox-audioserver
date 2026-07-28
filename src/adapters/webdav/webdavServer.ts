import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ContentManager } from '@/adapters/content/contentManager';
import { getMimeType } from '@/adapters/http/utils/mimeTypes';
import {
  DAV_ROOT,
  davRelativePath,
  encodeDavHref,
  isJunkName,
  isProtectedPath,
  normalizeIncomingPath,
  resolveDavTarget,
} from '@/adapters/webdav/davPaths';
import { WebdavAuthenticator } from '@/adapters/webdav/webdavAuthenticator';
import { buildLockResponse, buildMultiStatus, type DavResource } from '@/adapters/webdav/propfindResponse';

/** Lock lifetime handed back to clients. Nothing enforces it — see handleLock. */
const LOCK_TIMEOUT_SECONDS = 3600;

/** Cap on a single uploaded file, mirroring the intent of the upload endpoint's limit. */
const MAX_PUT_BYTES = 2 * 1024 * 1024 * 1024;

export type WebdavServerDeps = {
  configPort: ConfigPort;
  contentManager: ContentManager;
  /** Directory the share exposes — the local library folder. */
  baseDir: string;
  /**
   * Where {@link baseDir} sits relative to the music dir, because the library
   * index keys tracks from there ('local'). Paths crossing into the indexer get
   * this put back in front; see {@link toLibraryPath}.
   */
  storagePrefix: string;
};

/**
 * WebDAV share over the music library.
 *
 * Exists because the JSON upload endpoint is a poor fit for real libraries: it
 * base64s a whole file into a request body, handles one file per call, and has no
 * notion of folders. Mounting the library as a network drive lets people drag an
 * album in with the tools they already use.
 *
 * Writes are indexed incrementally (`contentManager.syncLibraryPath`) rather than
 * by full rescan — copying an album is a burst of PUTs, and a rescan per file would
 * both re-read the entire library each time and get dropped by the scan guard.
 *
 * Class 2 (LOCK/UNLOCK) is advertised, but only nominally — see {@link handleLock}.
 */
export class WebdavServer {
  private readonly log = createLogger('WebDAV', 'Server');
  private readonly auth: WebdavAuthenticator;
  private readonly baseDir: string;
  private readonly contentManager: ContentManager;
  private readonly configPort: ConfigPort;
  private readonly storagePrefix: string;

  constructor(deps: WebdavServerDeps) {
    this.auth = new WebdavAuthenticator(deps.configPort);
    this.baseDir = deps.baseDir;
    this.contentManager = deps.contentManager;
    this.configPort = deps.configPort;
    this.storagePrefix = deps.storagePrefix.replace(/^\/+|\/+$/g, '');
  }

  /**
   * Share-relative path → the path the library index uses.
   *
   * The share is rooted at the local library folder so a client lands directly in
   * the music, but the index keys everything from the music dir above it. Every
   * path handed to the indexer goes through here.
   */
  private toLibraryPath(relative: string): string {
    return this.storagePrefix ? `${this.storagePrefix}/${relative}` : relative;
  }

  public matches(pathname: string): boolean {
    return pathname === DAV_ROOT || pathname.startsWith(`${DAV_ROOT}/`);
  }

  /**
   * Streams one file into the library, creating parent folders as needed.
   *
   * Shared with the admin UI's drop zone so both routes write identically: same
   * non-mangling path handling, same streaming write, same incremental index.
   * Previously the drop zone had its own base64-JSON endpoint that rewrote every
   * non-ASCII character to '_', so the same album arrived under a different name
   * depending on how it was added.
   *
   * Callers are responsible for authenticating; this does no auth of its own and
   * works regardless of whether the WebDAV protocol endpoint is enabled.
   */
  public async writeFile(
    req: IncomingMessage,
    res: ServerResponse,
    relativePath: string,
    relocate?: (writtenRelative: string, libraryPath: string) => Promise<string>,
  ): Promise<void> {
    const relative = normalizeIncomingPath(relativePath);
    if (!relative || isProtectedPath(relative)) {
      this.sendStatus(res, 403);
      return;
    }
    const target = resolveDavTarget(this.baseDir, relative);
    if (!target) {
      this.log.warn('blocked upload path traversal', { relativePath });
      this.sendStatus(res, 403);
      return;
    }
    // Unlike a WebDAV client, the browser never issues MKCOL first.
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await this.handlePut(req, res, relative, target, relocate);
  }

  /**
   * Off unless explicitly switched on. This is a writable network share over the
   * music folder, so it stays opt-in rather than appearing by default.
   */
  private get enabled(): boolean {
    return this.configPort.getConfig().content?.webdav?.enabled === true;
  }

  public async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();

    if (!this.enabled) {
      res.writeHead(404, { 'Content-Length': '0' });
      res.end();
      return;
    }

    // OPTIONS must answer unauthenticated: clients probe for DAV support before
    // they have anywhere to put credentials, and a 401 here reads as "not WebDAV".
    if (method === 'OPTIONS') {
      this.handleOptions(res);
      return;
    }

    if (this.auth.unconfigured) {
      // No local account exists yet, so there is no credential that could work.
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('WebDAV unavailable until an admin account exists');
      return;
    }

    const user = this.auth.authenticate(req);
    if (!user) {
      res.writeHead(401, this.auth.challenge());
      res.end();
      return;
    }

    const relative = davRelativePath(pathname);
    if (relative === null) {
      this.sendStatus(res, 403);
      return;
    }
    // The index database lives in this directory; it is not part of the share.
    if (relative && isProtectedPath(relative)) {
      this.sendStatus(res, 403);
      return;
    }
    const target = resolveDavTarget(this.baseDir, relative);
    if (!target) {
      this.log.warn('blocked webdav path traversal', { pathname });
      this.sendStatus(res, 403);
      return;
    }

    try {
      switch (method) {
        case 'PROPFIND':
          await this.handlePropfind(req, res, relative, target);
          return;
        case 'GET':
        case 'HEAD':
          await this.handleGet(req, res, target, method === 'HEAD');
          return;
        case 'PUT':
          await this.handlePut(req, res, relative, target);
          return;
        case 'MKCOL':
          await this.handleMkcol(res, target);
          return;
        case 'DELETE':
          await this.handleDelete(res, relative, target);
          return;
        case 'MOVE':
        case 'COPY':
          await this.handleMoveOrCopy(req, res, relative, target, method === 'COPY');
          return;
        case 'LOCK':
          this.handleLock(res, relative);
          return;
        case 'UNLOCK':
          this.sendStatus(res, 204);
          return;
        case 'PROPPATCH':
          // Property writes are not supported, but failing outright makes Finder
          // abort a copy. Report each requested property as forbidden instead.
          res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
          res.end(buildMultiStatus([]));
          return;
        default:
          this.sendStatus(res, 405);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('webdav request failed', { method, pathname, message });
      if (!res.headersSent) {
        this.sendStatus(res, 500);
      } else {
        res.end();
      }
    }
  }

  private handleOptions(res: ServerResponse): void {
    res.writeHead(200, {
      // '2' claims lock support; Finder mounts class-1 shares read-only.
      DAV: '1, 2',
      Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK',
      'MS-Author-Via': 'DAV',
      'Content-Length': '0',
    });
    res.end();
  }

  private async handlePropfind(
    req: IncomingMessage,
    res: ServerResponse,
    relative: string,
    target: string,
  ): Promise<void> {
    // Body may carry a <prop> selection; we always return the same fixed set, so
    // it only needs draining to free the socket.
    await this.drain(req);

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(target);
    } catch {
      this.sendStatus(res, 404);
      return;
    }

    // Depth: 0 = this resource, 1 = this plus children. 'infinity' is refused
    // because a deep library would generate an enormous response.
    const depthHeader = String(req.headers.depth ?? '1').toLowerCase();
    if (depthHeader === 'infinity') {
      res.writeHead(403, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(
        '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>',
      );
      return;
    }

    const resources: DavResource[] = [this.toResource(relative, path.basename(target) || 'dav', stat)];

    if (depthHeader === '1' && stat.isDirectory()) {
      const entries = await fsp.readdir(target, { withFileTypes: true });
      for (const entry of entries) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (isJunkName(entry.name) || isProtectedPath(childRelative)) {
          continue;
        }
        try {
          const childStat = await fsp.stat(path.join(target, entry.name));
          resources.push(this.toResource(childRelative, entry.name, childStat));
        } catch {
          // Vanished between readdir and stat; just leave it out.
        }
      }
    }

    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(buildMultiStatus(resources));
  }

  private toResource(relative: string, name: string, stat: fs.Stats): DavResource {
    return {
      relative,
      name,
      isDirectory: stat.isDirectory(),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      contentType: stat.isDirectory() ? undefined : getMimeType(name),
    };
  }

  private async handleGet(
    req: IncomingMessage,
    res: ServerResponse,
    target: string,
    headOnly: boolean,
  ): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(target);
    } catch {
      this.sendStatus(res, 404);
      return;
    }
    if (stat.isDirectory()) {
      // A browser hitting a collection gets no body; clients use PROPFIND.
      this.sendStatus(res, 405);
      return;
    }

    const rangeHeader = req.headers.range;
    const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null;

    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': getMimeType(target),
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
      });
      if (headOnly) {
        res.end();
        return;
      }
      fs.createReadStream(target, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Type': getMimeType(target),
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
    });
    if (headOnly) {
      res.end();
      return;
    }
    fs.createReadStream(target).pipe(res);
  }

  private async handlePut(
    req: IncomingMessage,
    res: ServerResponse,
    relative: string,
    target: string,
    /**
     * Optional final placement, applied after the bytes land but before the file
     * is indexed. Used by the admin upload to file a loose track under its tags;
     * WebDAV clients pass nothing and keep the path they chose.
     *
     * Receives and returns *share-relative* paths. The library-relative form the
     * indexer wants is derived here, so callers never juggle both.
     */
    relocate?: (writtenRelative: string, libraryPath: string) => Promise<string>,
  ): Promise<void> {
    if (!relative) {
      this.sendStatus(res, 403);
      return;
    }
    const name = path.basename(target);

    // Desktop clients write sidecar files everywhere. Accept them so the copy
    // doesn't error, but never let them reach the disk or the index.
    if (isJunkName(name)) {
      await this.drain(req);
      this.sendStatus(res, 201);
      return;
    }

    // The parent must already exist — clients MKCOL first, and auto-creating it
    // would turn a typo'd path into a new folder tree.
    try {
      const parentStat = await fsp.stat(path.dirname(target));
      if (!parentStat.isDirectory()) {
        this.sendStatus(res, 409);
        return;
      }
    } catch {
      this.sendStatus(res, 409);
      return;
    }

    const existed = await this.exists(target);

    // Write to a temp file next to the target, then rename. A half-written file
    // under its real name would otherwise be indexed mid-copy.
    const tempPath = `${target}.dav-${randomUUID()}.part`;
    let written = 0;
    let aborted = false;

    try {
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createWriteStream(tempPath);
        req.on('data', (chunk: Buffer) => {
          written += chunk.length;
          if (written > MAX_PUT_BYTES) {
            aborted = true;
            stream.destroy();
            req.destroy();
            reject(new Error('payload-too-large'));
          }
        });
        req.on('error', reject);
        stream.on('error', reject);
        stream.on('finish', resolve);
        req.pipe(stream);
      });

      await fsp.rename(tempPath, target);
    } catch (error) {
      await fsp.rm(tempPath, { force: true }).catch(() => undefined);
      if (aborted) {
        this.sendStatus(res, 413);
        return;
      }
      throw error;
    }

    let finalRelative = relative;
    if (relocate) {
      try {
        const moved = await relocate(relative, this.toLibraryPath(relative));
        if (moved && moved !== relative) {
          const movedTarget = resolveDavTarget(this.baseDir, moved);
          // Never overwrite a track that is already filed there — the upload
          // simply stays where it was written rather than replacing it.
          if (movedTarget && !(await this.exists(movedTarget))) {
            await fsp.mkdir(path.dirname(movedTarget), { recursive: true });
            await fsp.rename(target, movedTarget);
            finalRelative = moved;
          }
        }
      } catch (error) {
        // Filing is a convenience; a failure must not lose the upload.
        const message = error instanceof Error ? error.message : String(error);
        this.log.debug('upload relocation skipped', { relative, message });
      }
    }

    // Index just this path once the write burst settles.
    this.contentManager.syncLibraryPath(this.toLibraryPath(finalRelative));
    this.log.debug('webdav put', { relative: finalRelative, bytes: written });
    this.sendStatus(res, existed ? 204 : 201);
  }

  private async handleMkcol(res: ServerResponse, target: string): Promise<void> {
    if (await this.exists(target)) {
      this.sendStatus(res, 405);
      return;
    }
    try {
      // Non-recursive on purpose: MKCOL against a missing parent is a 409.
      await fsp.mkdir(target);
    } catch {
      this.sendStatus(res, 409);
      return;
    }
    this.sendStatus(res, 201);
  }

  private async handleDelete(
    res: ServerResponse,
    relative: string,
    target: string,
  ): Promise<void> {
    if (!relative) {
      // Never let a client delete the share root itself.
      this.sendStatus(res, 403);
      return;
    }

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(target);
    } catch {
      this.sendStatus(res, 404);
      return;
    }

    // Collect the audio paths first — after the unlink there is nothing to walk,
    // and the index still holds rows for every one of them.
    const removed = stat.isDirectory() ? await this.collectFiles(relative, target) : [relative];

    await fsp.rm(target, { recursive: true, force: true });
    for (const removedPath of removed) {
      this.contentManager.syncLibraryPath(this.toLibraryPath(removedPath));
    }
    this.sendStatus(res, 204);
  }

  private async handleMoveOrCopy(
    req: IncomingMessage,
    res: ServerResponse,
    relative: string,
    target: string,
    isCopy: boolean,
  ): Promise<void> {
    const destinationHeader = req.headers.destination;
    if (typeof destinationHeader !== 'string' || !destinationHeader) {
      this.sendStatus(res, 400);
      return;
    }

    // Destination is an absolute URL; only its path matters to us.
    let destPathname: string;
    try {
      destPathname = new URL(destinationHeader, 'http://localhost').pathname;
    } catch {
      this.sendStatus(res, 400);
      return;
    }

    const destRelative = davRelativePath(destPathname);
    if (destRelative === null || !destRelative || isProtectedPath(destRelative)) {
      this.sendStatus(res, 403);
      return;
    }
    const destTarget = resolveDavTarget(this.baseDir, destRelative);
    if (!destTarget) {
      this.sendStatus(res, 403);
      return;
    }

    if (!(await this.exists(target))) {
      this.sendStatus(res, 404);
      return;
    }

    const destExisted = await this.exists(destTarget);
    // Overwrite defaults to 'T'; an explicit 'F' means don't clobber.
    if (destExisted && String(req.headers.overwrite ?? 'T').toUpperCase() === 'F') {
      this.sendStatus(res, 412);
      return;
    }

    const sourceStat = await fsp.stat(target);
    const sourceFiles = sourceStat.isDirectory()
      ? await this.collectFiles(relative, target)
      : [relative];

    if (isCopy) {
      await fsp.cp(target, destTarget, { recursive: true, force: true });
    } else {
      if (destExisted) {
        await fsp.rm(destTarget, { recursive: true, force: true });
      }
      await fsp.rename(target, destTarget);
    }

    // A move invalidates the old paths; both operations create new ones.
    if (!isCopy) {
      for (const sourcePath of sourceFiles) {
        this.contentManager.syncLibraryPath(this.toLibraryPath(sourcePath));
      }
    }
    const destStat = await fsp.stat(destTarget);
    const destFiles = destStat.isDirectory()
      ? await this.collectFiles(destRelative, destTarget)
      : [destRelative];
    for (const destFile of destFiles) {
      this.contentManager.syncLibraryPath(this.toLibraryPath(destFile));
    }

    this.sendStatus(res, destExisted ? 204 : 201);
  }

  /**
   * Issues a lock token without actually locking anything.
   *
   * macOS Finder mounts a share read-only unless the server advertises class 2,
   * and it takes a lock before every write. Real locking would need shared state
   * with a timeout reaper; for a single-user music share the contention it guards
   * against does not meaningfully exist. So the token is well-formed and always
   * granted — enough for Finder to proceed, honest about enforcing nothing.
   */
  private handleLock(res: ServerResponse, relative: string): void {
    const token = `opaquelocktoken:${randomUUID()}`;
    res.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Lock-Token': `<${token}>`,
    });
    res.end(buildLockResponse(token, encodeDavHref(relative), LOCK_TIMEOUT_SECONDS));
  }

  /** Every file below a directory, as share-relative paths. */
  private async collectFiles(relative: string, absolute: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (rel: string, abs: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(childRel, path.join(abs, entry.name));
        } else if (entry.isFile()) {
          found.push(childRel);
        }
      }
    };
    await walk(relative, absolute);
    return found;
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await fsp.stat(target);
      return true;
    } catch {
      return false;
    }
  }

  /** Consumes a request body we don't need, so the connection can be reused. */
  private async drain(req: IncomingMessage): Promise<void> {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return;
    }
    await new Promise<void>((resolve) => {
      req.on('data', () => undefined);
      req.on('end', resolve);
      req.on('error', () => resolve());
    });
  }

  private sendStatus(res: ServerResponse, status: number): void {
    res.writeHead(status, { 'Content-Length': '0' });
    res.end();
  }
}
