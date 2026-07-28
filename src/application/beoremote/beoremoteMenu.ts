/**
 * Projection of a zone's playable sources onto what a Beoremote One can render.
 *
 * The remote is not a general client. Its firmware imposes three limits that shape
 * this whole module, and all three are enforced here rather than trusted to config
 * or to the bridge:
 *
 *  1. One submenu, ever. The remote reads only SOURCE_CONTENT_1 and never reports
 *     which submenu it opened, so a second flagged source silently shows the first
 *     one's contents. {@link buildBeoremoteMenu} flags at most one source.
 *  2. Position is identity. The remote answers with ACTIVE_SOURCE = 20 + index, not
 *     with an id. If the list changes between publish and pick, it selects the wrong
 *     thing. So the order is deterministic, and every menu carries a {@link BeoremoteMenu.revision}
 *     that a selection must echo back — a stale pick is rejected, not misresolved.
 *  3. ~512 bytes per list. The display is narrow and the remote cuts mid-word, so
 *     names are truncated on a word boundary here and the list is capped to fit.
 *
 * Nothing in this file does I/O; callers gather the raw sources and hand them in.
 */

import { createHash } from 'node:crypto';

/** What a selected entry means. The bridge never sees this — it is resolved server-side. */
export type BeoremoteAction =
  | { kind: 'favorite'; favoriteId: number; audiopath: string; title?: string; artist?: string; album?: string; coverurl?: string }
  | { kind: 'lineIn'; inputId: string }
  | { kind: 'radio'; audiopath: string; title?: string; coverurl?: string }
  | { kind: 'content'; audiopath: string; title?: string; artist?: string; album?: string; coverurl?: string }
  /** Visible but not selectable — a heading, or the submenu's own parent row. */
  | { kind: 'inert' };

/** An entry as the builder receives it, before truncation and capping. */
export type BeoremoteCandidate = {
  name: string;
  action: BeoremoteAction;
  /** Debug/diagnostic id. Never the selection key — see limit 2. */
  id?: string;
};

/** An entry as published. `index` is what the remote turns into ACTIVE_SOURCE. */
export type BeoremoteEntry = {
  index: number;
  name: string;
  /** Present only on the single source that owns the submenu. */
  submenu?: true;
  /** Echoed from the candidate for diagnostics; not accepted on select. */
  id?: string;
};

export type BeoremoteMenu = {
  zoneId: number;
  /** Changes whenever the published order or naming changes. Selections must echo it. */
  revision: string;
  sources: BeoremoteEntry[];
  submenu: BeoremoteEntry[];
};

/** The menu plus the server-side resolution table the published form deliberately omits. */
export type BeoremoteMenuPlan = {
  menu: BeoremoteMenu;
  sourceActions: BeoremoteAction[];
  submenuActions: BeoremoteAction[];
  /** Names that were shortened or dropped, so callers can log rather than silently cap. */
  truncatedNames: number;
  droppedSources: number;
  droppedSubmenu: number;
};

export type BeoremoteMenuInput = {
  zoneId: number;
  sources: BeoremoteCandidate[];
  submenu?: BeoremoteCandidate[];
  /**
   * Index into `sources` that owns the submenu, applied after ordering. Ignored when
   * `submenu` is empty or the index is out of range.
   */
  submenuOwnerIndex?: number | null;
};

/**
 * Byte budget per list. Measured limit is 512; the margin absorbs the JSON framing
 * the bridge adds around the names when it builds the protocol payload.
 */
export const BEOREMOTE_LIST_BUDGET_BYTES = 480;
/** Hard cap independent of the byte budget — the remote scrolls poorly beyond this. */
export const BEOREMOTE_MAX_ENTRIES = 30;
/** Longest name the narrow display renders without the remote cutting it itself. */
export const BEOREMOTE_MAX_NAME_CHARS = 24;

/**
 * Shorten to fit the display, preferring a word boundary. The remote truncates
 * mid-word when we do not, which reads as a typo rather than an abbreviation.
 */
export function truncateName(raw: string, maxChars = BEOREMOTE_MAX_NAME_CHARS): string {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (name.length <= maxChars) {
    return name;
  }
  const clipped = name.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(' ');
  // Only honour the word boundary when it keeps most of the budget; otherwise a
  // long first word would collapse the name to almost nothing.
  if (lastSpace >= Math.floor(maxChars * 0.6)) {
    return clipped.slice(0, lastSpace).trim();
  }
  return clipped.trim();
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Fill a list up to both the entry cap and the byte budget, in the order given.
 * Order is never rearranged here — see limit 2.
 */
function fitList(
  candidates: BeoremoteCandidate[],
  budgetBytes: number,
): { entries: BeoremoteEntry[]; actions: BeoremoteAction[]; truncated: number; dropped: number } {
  const entries: BeoremoteEntry[] = [];
  const actions: BeoremoteAction[] = [];
  let used = 0;
  let truncated = 0;

  for (const candidate of candidates) {
    if (entries.length >= BEOREMOTE_MAX_ENTRIES) {
      break;
    }
    const original = String(candidate.name ?? '').replace(/\s+/g, ' ').trim();
    if (!original) {
      continue;
    }
    const name = truncateName(original);
    if (name !== original) {
      truncated += 1;
    }
    const cost = byteLength(name) + 1;
    if (used + cost > budgetBytes) {
      break;
    }
    used += cost;
    entries.push({ index: entries.length, name, ...(candidate.id ? { id: candidate.id } : {}) });
    actions.push(candidate.action);
  }

  return { entries, actions, truncated, dropped: candidates.length - entries.length };
}

/**
 * Derive the revision from exactly what the remote depends on: the ordered names
 * and which entry carries the submenu. Anything else changing (cover art, a
 * favorite's audiopath) does not invalidate a pick the user already made.
 */
function computeRevision(zoneId: number, sources: BeoremoteEntry[], submenu: BeoremoteEntry[]): string {
  const shape = JSON.stringify({
    z: zoneId,
    s: sources.map((entry) => [entry.name, entry.submenu === true ? 1 : 0]),
    m: submenu.map((entry) => entry.name),
  });
  return createHash('sha1').update(shape).digest('hex').slice(0, 8);
}

/**
 * Build the published menu and its resolution table.
 *
 * Candidates are consumed in the order given — the caller owns ordering, because
 * only the caller knows which sources are stable across rebuilds.
 */
export function buildBeoremoteMenu(input: BeoremoteMenuInput): BeoremoteMenuPlan {
  const submenuCandidates = input.submenu ?? [];
  const fittedSources = fitList(input.sources, BEOREMOTE_LIST_BUDGET_BYTES);
  const fittedSubmenu = submenuCandidates.length
    ? fitList(submenuCandidates, BEOREMOTE_LIST_BUDGET_BYTES)
    : { entries: [], actions: [], truncated: 0, dropped: 0 };

  // Limit 1: at most one source may carry the flag, and only when there is
  // something behind it. A submenu owner that fell outside the cap loses the flag
  // rather than moving position — moving it would break limit 2.
  const ownerIndex = input.submenuOwnerIndex;
  if (
    fittedSubmenu.entries.length > 0 &&
    typeof ownerIndex === 'number' &&
    ownerIndex >= 0 &&
    ownerIndex < fittedSources.entries.length
  ) {
    fittedSources.entries[ownerIndex]!.submenu = true;
  }

  const revision = computeRevision(input.zoneId, fittedSources.entries, fittedSubmenu.entries);

  return {
    menu: {
      zoneId: input.zoneId,
      revision,
      sources: fittedSources.entries,
      submenu: fittedSubmenu.entries,
    },
    sourceActions: fittedSources.actions,
    submenuActions: fittedSubmenu.actions,
    truncatedNames: fittedSources.truncated + fittedSubmenu.truncated,
    droppedSources: fittedSources.dropped,
    droppedSubmenu: fittedSubmenu.dropped,
  };
}

/** Which list a selection refers to. The remote reports these separately. */
export type BeoremoteSelectList = 'source' | 'submenu';

export type BeoremoteSelection = {
  list: BeoremoteSelectList;
  index: number;
  revision: string;
};

export type BeoremoteResolveResult =
  | { ok: true; action: BeoremoteAction; name: string }
  | { ok: false; reason: 'stale-revision' | 'out-of-range' | 'not-selectable' };

/**
 * Resolve a selection against a freshly built plan.
 *
 * The revision check is what turns limit 2 from a silent mis-selection into a
 * detectable error: if the list moved since publishing, the caller gets to answer
 * 409 and let the bridge re-read, instead of starting the wrong source.
 */
export function resolveBeoremoteSelection(
  plan: BeoremoteMenuPlan,
  selection: BeoremoteSelection,
): BeoremoteResolveResult {
  if (selection.revision !== plan.menu.revision) {
    return { ok: false, reason: 'stale-revision' };
  }
  const entries = selection.list === 'submenu' ? plan.menu.submenu : plan.menu.sources;
  const actions = selection.list === 'submenu' ? plan.submenuActions : plan.sourceActions;
  const index = Number(selection.index);
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    return { ok: false, reason: 'out-of-range' };
  }
  const action = actions[index];
  if (!action || action.kind === 'inert') {
    return { ok: false, reason: 'not-selectable' };
  }
  return { ok: true, action, name: entries[index]!.name };
}

/**
 * ACTIVE_SOURCE arrives as 20 + index. Bridges that pass the raw protocol value
 * through can normalise it here rather than each reinventing the offset.
 */
export const BEOREMOTE_ACTIVE_SOURCE_OFFSET = 20;

export function activeSourceToIndex(activeSource: number): number | null {
  const index = Number(activeSource) - BEOREMOTE_ACTIVE_SOURCE_OFFSET;
  return Number.isInteger(index) && index >= 0 ? index : null;
}
