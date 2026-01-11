import { networkInterfaces } from 'node:os';

const EMPTY_MAC = '00:00:00:00:00:00';
export const DEFAULT_MAC_ID = '504F94FF1BB3';

export function normalizeMacId(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = trimmed.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  return cleaned || null;
}

export function resolveLocalMacId(): string | null {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (!net || net.internal) {
        continue;
      }
      if (!net.mac || net.mac === EMPTY_MAC) {
        continue;
      }
      const normalized = normalizeMacId(net.mac);
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

export function defaultMacId(): string {
  return resolveLocalMacId() ?? DEFAULT_MAC_ID;
}
