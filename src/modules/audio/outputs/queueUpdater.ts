import type { QueueItem } from '@/modules/zones/zoneManager';

type QueueUpdateHandler = (zoneId: number, items: QueueItem[], currentIndex: number) => void;
type TransportErrorHandler = (zoneId: number, reason?: string) => void;
type TransportStateHandler = (
  zoneId: number,
  state: {
    status?: 'playing' | 'paused' | 'stopped';
    position?: number;
    duration?: number;
    uri?: string;
  },
) => void;

let handler: QueueUpdateHandler | null = null;
let errorHandler: TransportErrorHandler | null = null;
let stateHandler: TransportStateHandler | null = null;

export function setQueueUpdateHandler(fn: QueueUpdateHandler): void {
  handler = fn;
}

export function setTransportErrorHandler(fn: TransportErrorHandler): void {
  errorHandler = fn;
}

export function setTransportStateHandler(fn: TransportStateHandler): void {
  stateHandler = fn;
}

export function updateQueueFromTransport(
  zoneId: number,
  items: QueueItem[],
  currentIndex: number,
): void {
  if (!handler) {
    return;
  }
  handler(zoneId, items, currentIndex);
}

export function notifyTransportError(zoneId: number, reason?: string): void {
  if (!errorHandler) {
    return;
  }
  errorHandler(zoneId, reason);
}

export function notifyTransportState(
  zoneId: number,
  state: {
    status?: 'playing' | 'paused' | 'stopped';
    position?: number;
    duration?: number;
    uri?: string;
  },
): void {
  if (!stateHandler) {
    return;
  }
  stateHandler(zoneId, state);
}
