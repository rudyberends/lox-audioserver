import { createLogger } from '@/shared/logging/logger';

/**
 * Tracks which line-in inputs are *wanted* on, as opposed to which are currently streaming.
 *
 * A sendspin source can be told to activate the moment a client selects it, because the server
 * holds an open connection to it. A line-in bridge cannot: it polls, so the desired state has to
 * sit somewhere until its next status post picks it up. Without that, the chain runs backwards --
 * the server waits for audio before it starts playback, while the bridge waits for audio before it
 * streams, and an amplifier that has to be switched on never gets asked.
 *
 * This is desired state only. Whether the device actually came up is reported separately by the
 * bridge's own status, so a device that fails to power on shows as wanted-but-silent rather than
 * silently flipping this back.
 */
export class LineInActivationRegistry {
  private readonly log = createLogger('Audio', 'LineInActivation');
  private readonly active = new Set<string>();

  public activate(inputId: string): void {
    const id = inputId.trim();
    if (!id || this.active.has(id)) {
      return;
    }
    this.active.add(id);
    this.log.info('line-in activation requested', { inputId: id });
  }

  public deactivate(inputId: string): void {
    const id = inputId.trim();
    if (!id || !this.active.delete(id)) {
      return;
    }
    this.log.info('line-in deactivation requested', { inputId: id });
  }

  public isActive(inputId: string): boolean {
    return this.active.has(inputId.trim());
  }
}
