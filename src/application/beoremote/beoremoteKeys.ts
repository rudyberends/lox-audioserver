/**
 * What each Beoremote One key code means.
 *
 * These are Linux input codes, as the kernel reports them: the remote is an ordinary
 * HID peripheral, and the client forwards what it reads from `/dev/input/event*`
 * without naming or filtering anything. A key it had not seen would otherwise be
 * dropped before reaching a server that may well know it. Which code is which button
 * is a property of the remote's hardware, so the table lives here, once.
 *
 * The codes were measured one by one on a real remote and are NOT regular — do not
 * derive them. Yellow has the *lowest* of the four colour codes, and the dots run
 * 273, 275, 270, 272.
 *
 * Volume is deliberately absent. It stays on the player: it arrives in bursts of six
 * presses, so it would be six HTTP calls where one local step does, and it has to
 * keep working while the server is briefly away.
 */

import type { BeoremoteKeyBinding } from '@/domain/config/types';

/** What the server should do with a key, before it knows what the zone is playing. */
export type BeoremoteKeyAction =
  /** Transport, routed by the existing layer: to a line-in's bridge, else the queue. */
  | { kind: 'transport'; command: 'play' | 'pause' | 'next' | 'previous' }
  /** Pick a disc. Only meaningful on a line-in that fronts a changer. */
  | { kind: 'disc'; disc: number }
  /** Start one of the zone's favorites, 1-based. Works on any source. */
  | { kind: 'favorite'; slot: number }
  /** Switch the zone to a line-in input. */
  | { kind: 'lineIn'; inputId: string }
  /** Start a radio station by audiopath. */
  | { kind: 'radio'; audiopath: string }
  /** Put the zone into standby, including an immediate configured power-off action. */
  | { kind: 'standby' }
  /** Known key with nothing bound to it yet — reported apart from an unknown code. */
  | { kind: 'unassigned'; label: string };

/**
 * The buttons a zone may reassign, in the order they sit on the remote. Their
 * default meaning is the favorite in the matching slot, which is why the order
 * matters: red is slot 1, the fourth dot is slot 8.
 */
export const ASSIGNABLE_BUTTONS = [
  'red',
  'green',
  'yellow',
  'blue',
  'dot1',
  'dot2',
  'dot3',
  'dot4',
] as const;

export type AssignableButton = (typeof ASSIGNABLE_BUTTONS)[number];

/**
 * Which code is which button. This is hardware, not preference, so it is not
 * configurable — only what a button *does* is.
 */
const BUTTON_CODES: Record<AssignableButton, number> = {
  // BTN_1, BTN_2, BTN_0, BTN_3 — measured in that order by pressing red, green,
  // yellow, blue. Yellow really is the lowest; the remote does not number its
  // colours the way it prints them.
  red: 257,
  green: 258,
  yellow: 256,
  blue: 259,
  dot1: 273,
  dot2: 275,
  dot3: 270,
  dot4: 272,
};

const BUTTON_BY_CODE = new Map<number, AssignableButton>(
  ASSIGNABLE_BUTTONS.map((button) => [BUTTON_CODES[button], button]),
);

/** The button this code belongs to, when it is one a zone can reassign. */
export function assignableButtonForCode(code: number): AssignableButton | null {
  return BUTTON_BY_CODE.get(code) ?? null;
}

export function codeForAssignableButton(button: AssignableButton): number {
  return BUTTON_CODES[button];
}

/** Where a button sits, which is the favorite slot it defaults to. */
export function defaultFavoriteSlot(button: AssignableButton): number {
  return ASSIGNABLE_BUTTONS.indexOf(button) + 1;
}

/**
 * Codes seen in the wild but not yet identified. Listed so they answer as a known
 * button rather than a 404, which keeps the client's log about genuinely new keys.
 */
const OBSERVED_UNASSIGNED: Record<number, string> = {
  402: 'step-up',
  403: 'step-down',
  // The navigation ring, by the names the kernel gives them.
  103: 'nav-up',
  108: 'nav-down',
  105: 'nav-left',
  106: 'nav-right',
  353: 'nav-select',
};

/**
 * Keys whose meaning is fixed. The colour and dot keys are deliberately absent:
 * they are per-zone configurable and resolved through {@link resolveKeyAction}.
 */
const KEY_ACTIONS: Record<number, BeoremoteKeyAction> = {
  // KEY_POWER. The client grabs the input devices precisely so this one does not also
  // reach logind, which would switch the machine off.
  116: { kind: 'standby' },

  // Transport: KEY_PLAY, KEY_PAUSE, KEY_NEXTSONG, KEY_PREVIOUSSONG.
  207: { kind: 'transport', command: 'play' },
  119: { kind: 'transport', command: 'pause' },
  163: { kind: 'transport', command: 'next' },
  165: { kind: 'transport', command: 'previous' },

  // Digits 1-6 → disc select on a changer. BTN_5 upwards, not KEY_1.
  261: { kind: 'disc', disc: 1 },
  262: { kind: 'disc', disc: 2 },
  263: { kind: 'disc', disc: 3 },
  264: { kind: 'disc', disc: 4 },
  265: { kind: 'disc', disc: 5 },
  266: { kind: 'disc', disc: 6 },
};

/**
 * Parse a code as sent by the client: a plain kernel key code. A hex string is still
 * accepted so a code copied out of a log or a bug report can be pasted in as-is.
 */
export function parseKeyCode(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 && raw <= 0xffff ? raw : null;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim().toLowerCase();
  if (!text) {
    return null;
  }
  const parsed = text.startsWith('0x') ? Number.parseInt(text.slice(2), 16) : Number.parseInt(text, 16);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffff ? parsed : null;
}

/** Format a code the way the table and the logs spell it. */
export function formatKeyCode(code: number): string {
  return String(code);
}

/**
 * What this key means.
 *
 * `bindings` is the zone's own key configuration. A button it does not mention keeps
 * its default — the favorite in the slot it sits at — so an unconfigured zone
 * behaves exactly as it did before any of this was configurable.
 *
 * Returns null when the code is not a key we know at all.
 */
export function resolveKeyAction(
  code: number,
  bindings?: Record<string, BeoremoteKeyBinding> | null,
): BeoremoteKeyAction | null {
  const button = assignableButtonForCode(code);
  if (button) {
    const bound = bindings?.[button];
    if (bound) {
      return bindingToAction(bound, button);
    }
    return { kind: 'favorite', slot: defaultFavoriteSlot(button) };
  }

  const action = KEY_ACTIONS[code];
  if (action) {
    return action;
  }
  const observed = OBSERVED_UNASSIGNED[code];
  return observed ? { kind: 'unassigned', label: observed } : null;
}

function bindingToAction(
  binding: BeoremoteKeyBinding,
  button: AssignableButton,
): BeoremoteKeyAction {
  switch (binding.kind) {
    case 'none':
      // Deliberately dead, which is different from unconfigured.
      return { kind: 'unassigned', label: button };
    case 'favorite':
      return { kind: 'favorite', slot: binding.slot };
    case 'lineIn':
      return { kind: 'lineIn', inputId: binding.inputId };
    case 'radio':
      return { kind: 'radio', audiopath: binding.audiopath };
    default:
      return { kind: 'unassigned', label: button };
  }
}
