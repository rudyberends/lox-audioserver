import type { ZoneStateController } from '@/application/zones/state/StateController';

/**
 * Default zone state controller.
 * Intentionally does nothing and preserves existing internal playback behavior.
 */
export class InternalStateController implements ZoneStateController {
  public start(): void {}
  public stop(): void {}
}
