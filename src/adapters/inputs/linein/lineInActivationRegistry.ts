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
export type QueuedSourceCommand = {
  command: string;
  args: string[];
};

/**
 * How many commands to hold per input. A bridge polls every few seconds, so a burst of button
 * presses can queue several -- but a bridge that is offline must not accumulate an unbounded
 * backlog that all fires at once when it returns.
 */
const MAX_QUEUED_COMMANDS = 16;

/**
 * Pushes a command straight to a connected bridge, returning false when there is no live socket.
 * Injected rather than imported so this registry stays independent of the HTTP layer.
 */
export type LineInCommandPusher = (inputId: string, command: string, args: string[]) => boolean;

export class LineInActivationRegistry {
  private readonly log = createLogger('Audio', 'LineInActivation');
  private readonly active = new Set<string>();
  private readonly commands = new Map<string, QueuedSourceCommand[]>();
  private pusher: LineInCommandPusher | null = null;

  /**
   * Attach the push transport. Set once the HTTP layer exists, so a command taken while a bridge is
   * connected over the WebSocket ingest goes out immediately instead of waiting for its next poll.
   */
  public setCommandPusher(pusher: LineInCommandPusher | null): void {
    this.pusher = pusher;
  }

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
   * Queue a transport command for the bridge serving this input.
   *
   * The server is the only thing that knows which source a zone is on, so it decides that a
   * transport command belongs to the line-in rather than the local queue. The bridge stays dumb: it
   * hands whatever arrives to its on_command hook, which is where the hardware knowledge lives.
   */
  public enqueueCommand(inputId: string, command: string, args: string[] = []): void {
    const id = inputId.trim();
    const verb = command.trim();
    if (!id || !verb) {
      return;
    }
    // Push when the bridge is on the WebSocket ingest: that turns a button press into a round trip
    // instead of a wait for the next status poll. Queueing is the fallback for a bridge on the
    // upstream-only TCP transport, or one that is momentarily reconnecting.
    if (this.pusher?.(id, verb, args)) {
      this.log.info('line-in command pushed', { inputId: id, command: verb, args });
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
