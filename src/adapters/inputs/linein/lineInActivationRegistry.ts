import { createLogger } from '@/shared/logging/logger';

/**
 * Tracks which line-in inputs are *wanted* on, as opposed to which are currently streaming.
 *
 * A sendspin source can be told to activate the moment a client selects it, because the server
 * holds an open connection to it. A polling device -- a Sonn Client asking for its desired state --
 * cannot be told anything, so the want has to sit somewhere until its next poll picks it up.
 * Without that, the chain runs backwards: the server waits for audio before it starts playback,
 * while the device waits for audio before it streams, and an amplifier that has to be switched on
 * never gets asked.
 *
 * This is desired state only. Whether the device actually came up is reported separately by its own
 * status, so a device that fails to power on shows as wanted-but-silent rather than silently
 * flipping this back.
 */
export type QueuedSourceCommand = {
  command: string;
  args: string[];
};

/**
 * How many commands to hold per input. A device polls every few seconds, so a burst of button
 * presses can queue several -- but a device that is offline must not accumulate an unbounded
 * backlog that all fires at once when it returns.
 */
const MAX_QUEUED_COMMANDS = 16;

export class LineInActivationRegistry {
  private readonly log = createLogger('Audio', 'LineInActivation');
  private readonly active = new Set<string>();
  private readonly commands = new Map<string, QueuedSourceCommand[]>();

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
    // Anything queued was meant for the source we just switched away from; delivering it after the
    // fact would drive hardware that is no longer the active source.
    this.commands.delete(id);
    this.log.info('line-in deactivation requested', { inputId: id });
  }

  public isActive(inputId: string): boolean {
    return this.active.has(inputId.trim());
  }

  /**
   * Queue a transport command for the device serving this input.
   *
   * The server is the only thing that knows which source a zone is on, so it decides that a
   * transport command belongs to the line-in rather than the local queue. The device stays dumb: it
   * hands whatever arrives to its own hook, which is where the hardware knowledge lives.
   */
  public enqueueCommand(inputId: string, command: string, args: string[] = []): void {
    const id = inputId.trim();
    const verb = command.trim();
    if (!id || !verb) {
      return;
    }
    const queue = this.commands.get(id) ?? [];
    queue.push({ command: verb, args });
    // Oldest first out: a stale `play` matters less than the `next` the user just pressed.
    while (queue.length > MAX_QUEUED_COMMANDS) {
      queue.shift();
    }
    this.commands.set(id, queue);
    this.log.info('line-in command queued', { inputId: id, command: verb, args });
  }

  /** Take every queued command for this input. Draining is what acknowledges delivery. */
  public takeCommands(inputId: string): QueuedSourceCommand[] {
    const id = inputId.trim();
    const queue = this.commands.get(id);
    if (!queue?.length) {
      return [];
    }
    this.commands.delete(id);
    return queue;
  }
}
