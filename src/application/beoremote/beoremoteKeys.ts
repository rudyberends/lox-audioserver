/**
 * What each Beoremote One key code means.
 *
 * The bridge forwards raw HID codes and names nothing, because naming there would be
 * a filter: a key it had not seen would be dropped before reaching a server that may
 * well know it. Which code is which button is a property of the remote's hardware, so
 * the table lives here, once, rather than in every bridge.
 *
 * The codes were measured one by one and are NOT regular — do not derive them.
 * Yellow and blue are the reverse of the order you would expect, and the dot keys are
 * not contiguous (0x12, 0x14, 0x0f, 0x11).
 *
 * Volume is deliberately absent. It stays on the player: it arrives in bursts, so it
 * would be six HTTP calls where one D-Bus property set does, and it has to keep
 * working while the server is briefly away.
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
  red: 0x01,
  green: 0x02,
  // Not a typo and not a mistake in the remote: yellow is 0x03, blue is 0x04,
  // the reverse of the order the buttons are printed in.
  yellow: 0x03,
  blue: 0x04,
  dot1: 0x12,
  dot2: 0x14,
  dot3: 0x0f,
  dot4: 0x11,
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
 * button rather than a 404, which keeps the bridge's log about genuinely new keys.
 * 0x41–0x45 is almost certainly the navigation ring.
 */
const OBSERVED_UNASSIGNED: Record<number, string> = {
  0x41: 'nav-41',
  0x42: 'nav-42',
  0x43: 'nav-43',
  0x44: 'nav-44',
  0x45: 'nav-45',
};

/**
 * Keys whose meaning is fixed. The colour and dot keys are deliberately absent:
 * they are per-zone configurable and resolved through {@link resolveKeyAction}.
 */
const KEY_ACTIONS: Record<number, BeoremoteKeyAction> = {
  // Standby / power off
  0x30: { kind: 'standby' },

  // Transport
  0xb0: { kind: 'transport', command: 'play' },
  0xb1: { kind: 'transport', command: 'pause' },
  0xb5: { kind: 'transport', command: 'next' },
  0xb6: { kind: 'transport', command: 'previous' },
  // The remote emits a second pair for step-forward/back — a different physical
  // control reporting the same intent. Aliases rather than replacements: both pairs
  // are live, because a remote may send either.
  0x9c: { kind: 'transport', command: 'next' },
  0x9d: { kind: 'transport', command: 'previous' },

  // Digits 1-6 → disc select on a changer.
  0x06: { kind: 'disc', disc: 1 },
  0x07: { kind: 'disc', disc: 2 },
  0x08: { kind: 'disc', disc: 3 },
  0x09: { kind: 'disc', disc: 4 },
  0x0a: { kind: 'disc', disc: 5 },
  0x0b: { kind: 'disc', disc: 6 },

  0x10: { kind: 'unassigned', label: 'menu' },
};

/**
 * Parse a code as sent by the bridge. Accepts `"0xb5"`, `"b5"` or a plain number, so
 * a bridge does not have to agree with us on formatting.
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
  return `0x${code.toString(16).padStart(2, '0')}`;
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
