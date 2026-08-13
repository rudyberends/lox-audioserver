/**
 * Device-facing HTTP API for a Beoremote One bridge.
 *
 * The remote is Bluetooth HID and never speaks to us. A bridge process pairs with
 * it, speaks the B&O product protocol on one side, and mirrors the menu we publish
 * on the other. This handler is that second side.
 *
 * Stateless by design: a bridge names the zone it drives in its own config and says
 * so in the URL. There is nothing to register and no bridge identity kept here —
 * none of it would earn its keep, since the settings that matter belong to the zone,
 * and however many remotes a room has they all read the same menu.
 *
 * What the bridge never receives is an audiopath. It reports a position and we
 * resolve it here, so a bridge — or anything that can reach this port — cannot ask
 * the server to play arbitrary content. See `beoremoteMenu.ts` for the three
 * firmware limits that shape the menu itself.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import { readJsonBody, sendJson } from '@/adapters/http/adminApi/helpers/httpUtils';
import {
  activeSourceToIndex,
  resolveBeoremoteSelection,
  type BeoremoteAction,
  type BeoremoteSelectList,
} from '@/application/beoremote/beoremoteMenu';
import {
  ASSIGNABLE_BUTTONS,
  codeForAssignableButton,
  defaultFavoriteSlot,
  formatKeyCode,
  parseKeyCode,
  resolveKeyAction,
  type BeoremoteKeyAction,
} from '@/application/beoremote/beoremoteKeys';
import type { BeoremoteKeyBinding } from '@/domain/config/types';
import {
  buildBeoremoteZoneMenu,
  isBeoremoteEnabled,
  isZoneBeoremoteEnabled,
  radioCandidates,
  zoneBeoremoteConfig,
  type BeoremoteMenuSourceDeps,
} from '@/adapters/http/beoremote/beoremoteMenuSource';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';

const API_PREFIX = '/api/beoremote';
/**
 * How long a step key stays deaf to repeats. Long enough to swallow the remote's
 * burst, short enough that pressing next twice on purpose still skips twice.
 */
const STEP_BURST_WINDOW_MS = 600;
/** Bodies here are a handful of small fields; anything larger is not ours. */
const MAX_BODY_BYTES = 16 * 1024;

export type BeoremoteApiDeps = BeoremoteMenuSourceDeps & {
  zoneManager: ZoneManagerFacade;
};

export class BeoremoteApiHandler {
  private readonly log = createLogger('Http', 'BeoremoteApi');
  private readonly deps: BeoremoteApiDeps;
  /** When each zone last took a step, per direction. See {@link isStepBurst}. */
  private readonly lastStepAt = new Map<string, number>();

  constructor(deps: BeoremoteApiDeps) {
    this.deps = deps;
  }

  public matches(pathname: string): boolean {
    return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
  }

  /**
   * Everything a key on this zone can be bound to, with names, so the admin UI can
   * offer real choices instead of asking for slot numbers and audiopaths. Also
   * returns the current bindings and the default each button falls back to.
   */
  public async getKeyOptionsForAdmin(zoneId: number): Promise<{
    buttons: Array<{ button: string; code: string; defaultSlot: number }>;
    bindings: Record<string, BeoremoteKeyBinding>;
    favorites: Array<{ slot: number; name: string }>;
    lineIns: Array<{ id: string; name: string }>;
    radios: Array<{ audiopath: string; name: string }>;
  } | null> {
    const zones = this.deps.configPort.getConfig().zones;
    if (!Array.isArray(zones) || !zones.some((zone) => zone?.id === zoneId)) {
      return null;
    }

    const favResponse = await this.deps.favorites.get(zoneId, 0, 0).catch(() => null);
    const favorites = (favResponse?.items ?? [])
      .filter((item) => item && typeof item.slot === 'number')
      .map((item) => ({ slot: item.slot, name: item.name || item.title || `Favorite ${item.slot}` }));

    const lineIns = this.deps.lineIn
      .listLineInInputs()
      .map((input) => ({ id: input.id, name: input.name }));

    // Same flattening the remote's submenu uses, so the picker offers exactly the
    // stations a key could actually start.
    const radios = (await radioCandidates(this.deps).catch(() => []))
      .map((candidate) =>
        candidate.action.kind === 'radio'
          ? { audiopath: candidate.action.audiopath, name: candidate.name }
          : null,
      )
      .filter((entry): entry is { audiopath: string; name: string } => entry !== null);

    return {
      buttons: ASSIGNABLE_BUTTONS.map((button) => ({
        button,
        code: formatKeyCode(codeForAssignableButton(button)),
        defaultSlot: defaultFavoriteSlot(button),
      })),
      bindings: zoneBeoremoteConfig(this.deps.configPort, zoneId)?.keys ?? {},
      favorites,
      lineIns,
      radios,
    };
  }

  public async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const normalized = (pathname.split('?')[0] ?? '').replace(/\/+$/, '') || API_PREFIX;

    // A disabled integration must not answer with a menu; 404 keeps the surface
    // closed rather than merely empty.
    if (!isBeoremoteEnabled(this.deps.configPort)) {
      sendJson(res, 404, { error: 'beoremote-disabled' });
      return;
    }

    const menuMatch = normalized.match(/^\/api\/beoremote\/zones\/(\d+)\/menu$/);
    if (menuMatch) {
      await this.handleMenu(req, res, Number(menuMatch[1]));
      return;
    }

    const selectMatch = normalized.match(/^\/api\/beoremote\/zones\/(\d+)\/select$/);
    if (selectMatch) {
      await this.handleSelect(req, res, Number(selectMatch[1]));
      return;
    }

    const keyMatch = normalized.match(/^\/api\/beoremote\/zones\/(\d+)\/key$/);
    if (keyMatch) {
      await this.handleKey(req, res, Number(keyMatch[1]));
      return;
    }

    sendJson(res, 404, { error: 'not-found' });
  }

  private async handleMenu(req: IncomingMessage, res: ServerResponse, zoneId: number): Promise<void> {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    if (!this.isKnownZone(zoneId)) {
      sendJson(res, 404, { error: 'zone-not-found' });
      return;
    }
    const plan = await buildBeoremoteZoneMenu(this.deps, zoneId);
    sendJson(res, 200, plan.menu);
  }

  /**
   * Resolve a pick against a freshly built menu.
   *
   * The menu is rebuilt rather than cached on purpose: it is cheap, and a cache
   * would have to be invalidated by every favorite edit and every radio refresh to
   * stay correct. The revision check below is what makes rebuilding safe — if the
   * list moved since the bridge read it, the pick is rejected instead of silently
   * resolving to a different source.
   */
  private async handleSelect(req: IncomingMessage, res: ServerResponse, zoneId: number): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    if (!this.isKnownZone(zoneId)) {
      sendJson(res, 404, { error: 'zone-not-found' });
      return;
    }
    const body = (await readJsonBody(req, res, MAX_BODY_BYTES)) as Record<string, unknown> | null;
    if (body === null) {
      return;
    }

    const revision = String(body.revision ?? '').trim();
    if (!revision) {
      sendJson(res, 400, { error: 'missing-revision' });
      return;
    }
    const list: BeoremoteSelectList = body.list === 'submenu' ? 'submenu' : 'source';
    const index = this.readIndex(body);
    if (index === null) {
      sendJson(res, 400, { error: 'missing-index' });
      return;
    }

    const plan = await buildBeoremoteZoneMenu(this.deps, zoneId);
    const resolved = resolveBeoremoteSelection(plan, { list, index, revision });
    if (!resolved.ok) {
      // A stale revision is the expected, recoverable case: the bridge re-reads the
      // menu and the user picks again against the list that is actually current.
      const status = resolved.reason === 'stale-revision' ? 409 : 400;
      sendJson(res, status, { error: resolved.reason, revision: plan.menu.revision });
      return;
    }

    try {
      await this.performAction(zoneId, resolved.action);
    } catch (error) {
      this.log.warn('beoremote selection failed to start', {
        zoneId,
        name: resolved.name,
        message: error instanceof Error ? error.message : String(error),
      });
      sendJson(res, 500, { error: 'playback-failed' });
      return;
    }

    this.log.info('beoremote selection', { zoneId, list, index, name: resolved.name });
    sendJson(res, 200, { ok: true, name: resolved.name, revision: plan.menu.revision });
  }

  /**
   * A raw key code from the remote.
   *
   * The bridge names nothing — it forwards the HID code and we decide. No revision
   * here: a key is not a list position, so nothing can have shifted underneath it.
   * A 404 means the code is not in our table; the bridge logs it and moves on, which
   * is how an unrecognised button gets discovered rather than silently swallowed.
   */
  private async handleKey(req: IncomingMessage, res: ServerResponse, zoneId: number): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    if (!this.isKnownZone(zoneId)) {
      sendJson(res, 404, { error: 'zone-not-found' });
      return;
    }
    const body = (await readJsonBody(req, res, MAX_BODY_BYTES)) as Record<string, unknown> | null;
    if (body === null) {
      return;
    }

    const code = parseKeyCode(body.code);
    if (code === null) {
      sendJson(res, 400, { error: 'invalid-code' });
      return;
    }
    const action = resolveKeyAction(code, zoneBeoremoteConfig(this.deps.configPort, zoneId)?.keys);
    if (!action) {
      sendJson(res, 404, { error: 'key-not-assigned', code: formatKeyCode(code) });
      return;
    }
    if (action.kind === 'unassigned') {
      sendJson(res, 404, { error: 'key-not-assigned', code: formatKeyCode(code), button: action.label });
      return;
    }

    if (this.isStepBurst(zoneId, action)) {
      // Answer 200: the press was received and deliberately folded into the one
      // being handled. A 4xx would read as a failure and invite a retry.
      this.log.debug('beoremote step burst suppressed', { zoneId, code: formatKeyCode(code) });
      sendJson(res, 200, { ok: true, code: formatKeyCode(code), action: action.kind, coalesced: true });
      return;
    }

    try {
      const handled = await this.performKeyAction(zoneId, action);
      if (!handled.ok) {
        sendJson(res, 409, { error: handled.reason, code: formatKeyCode(code) });
        return;
      }
      this.log.info('beoremote key', { zoneId, code: formatKeyCode(code), action: action.kind });
      sendJson(res, 200, { ok: true, code: formatKeyCode(code), action: action.kind });
    } catch (error) {
      this.log.warn('beoremote key failed', {
        zoneId,
        code: formatKeyCode(code),
        message: error instanceof Error ? error.message : String(error),
      });
      sendJson(res, 500, { error: 'key-failed' });
    }
  }

  /**
   * Whether this is a repeat of a step the zone has only just taken.
   *
   * The remote sends step-forward/back as a burst — one press arrives several times
   * — and each one would skip another track, so a single press could land six
   * tracks away. Skipping is destructive in a way the other keys are not: a second
   * `play` or a re-picked favorite is a no-op, but a second `next` is gone.
   *
   * The window is deliberately short. It has to outlast the burst without swallowing
   * a deliberate double-press, and someone skipping through tracks presses far
   * slower than a remote repeats. Held down, the remote keeps sending: each accepted
   * step re-arms the window, so holding still advances at roughly one step per
   * window rather than as fast as the packets arrive.
   *
   * Per zone and per direction: next and previous do not suppress each other, since
   * pressing back right after forward is a correction, not a burst.
   */
  private isStepBurst(
    zoneId: number,
    action: Exclude<BeoremoteKeyAction, { kind: 'unassigned' }>,
  ): boolean {
    if (action.kind !== 'transport' || (action.command !== 'next' && action.command !== 'previous')) {
      return false;
    }
    const key = `${zoneId}:${action.command}`;
    const now = Date.now();
    const last = this.lastStepAt.get(key) ?? 0;
    if (now - last < STEP_BURST_WINDOW_MS) {
      return true;
    }
    this.lastStepAt.set(key, now);
    return false;
  }

  private async performKeyAction(
    zoneId: number,
    action: Exclude<BeoremoteKeyAction, { kind: 'unassigned' }>,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (action.kind === 'standby') {
      if (!this.deps.zoneManager.powerOffImmediately(zoneId)) {
        return { ok: false, reason: 'zone-not-found' };
      }
      return { ok: true };
    }

    if (action.kind === 'transport') {
      // Straight into the existing layer, which already decides between a line-in's
      // bridge and the local queue. That decision must not be duplicated here.
      this.deps.zoneManager.handleCommand(zoneId, action.command);
      return { ok: true };
    }

    if (action.kind === 'disc') {
      // Only a changer behind a line-in understands this; the device's own hook
      // turns it into a Beo4 command on the MasterLink bus.
      const inputId = this.activeLineInId(zoneId);
      if (!inputId) {
        return { ok: false, reason: 'not-a-line-in-source' };
      }
      this.deps.lineIn.sendCommand(inputId, 'disc', [String(action.disc)]);
      return { ok: true };
    }

    if (action.kind === 'lineIn') {
      this.deps.lineIn.activateLineIn(zoneId, action.inputId);
      return { ok: true };
    }

    if (action.kind === 'radio') {
      await this.deps.zoneManager.playContent(zoneId, action.audiopath, 'serviceplay');
      return { ok: true };
    }

    const audiopath = await this.deps.favorites
      .getAudiopathForFavorite(zoneId, action.slot)
      .catch(() => null);
    if (!audiopath) {
      return { ok: false, reason: 'favorite-empty' };
    }
    await this.deps.zoneManager.playContent(zoneId, audiopath, 'favorite');
    return { ok: true };
  }

  /** The line-in this zone is on right now, or null when it is on something else. */
  private activeLineInId(zoneId: number): string | null {
    const audiopath = this.deps.zoneManager.getZoneState(zoneId)?.audiopath ?? '';
    const match = /^linein:(?:\/\/)?(.+)$/.exec(audiopath);
    return match ? match[1]! : null;
  }

  /**
   * Accept either a plain index or the raw protocol value. A bridge that passes
   * ACTIVE_SOURCE through untouched should not have to know about the offset.
   */
  private readIndex(body: Record<string, unknown>): number | null {
    if (body.index !== undefined) {
      const index = Number(body.index);
      return Number.isInteger(index) ? index : null;
    }
    if (body.active_source !== undefined) {
      return activeSourceToIndex(Number(body.active_source));
    }
    return null;
  }

  private async performAction(zoneId: number, action: BeoremoteAction): Promise<void> {
    switch (action.kind) {
      case 'favorite':
        await this.deps.zoneManager.playContent(zoneId, action.audiopath, 'favorite', {
          title: action.title ?? '',
          artist: action.artist ?? '',
          album: action.album ?? '',
          coverurl: action.coverurl ?? '',
        });
        return;
      case 'radio':
      case 'content':
        await this.deps.zoneManager.playContent(zoneId, action.audiopath, 'serviceplay', {
          title: action.title ?? '',
          artist: 'artist' in action ? action.artist ?? '' : '',
          album: 'album' in action ? action.album ?? '' : '',
          coverurl: action.coverurl ?? '',
        });
        return;
      case 'lineIn':
        // Synchronous, and deliberately not awaited into anything: the service
        // parks the zone on "no signal" until audio actually arrives.
        this.deps.lineIn.activateLineIn(zoneId, action.inputId);
        return;
      case 'inert':
        return;
    }
  }

  /**
   * A zone counts as reachable only when it both exists and has its remote turned
   * on. A zone that never opted in behaves as if it were not there, so a misaimed
   * bridge cannot drive it.
   */
  private isKnownZone(zoneId: number): boolean {
    if (!Number.isFinite(zoneId) || zoneId <= 0) {
      return false;
    }
    return isZoneBeoremoteEnabled(this.deps.configPort, zoneId);
  }

}
