import type { PassThrough } from 'node:stream';
import type { LineInControlCommand } from '@/ports/InputsPort';

/** PCM shape an ingest session negotiated with its source. */
export type LineInSessionFormat = {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  pcmFormat: 's16le' | 's24le' | 's32le';
};

export type LineInSession = {
  id: string;
  stream: PassThrough;
  format?: LineInSessionFormat;
};

/**
 * The line-in transports as the application layer needs them: an ingest side that
 * reports when audio appears and disappears, and a control side that asks a source
 * to switch on. A sendspin client and a polling Sonn Client both sit behind this.
 *
 * The split between "wanted" and "start" is deliberate and load-bearing. Marking an
 * input wanted parks desired state that a polling device reads on its next status
 * post — that is how gear which does not power up by itself gets switched on.
 * Requesting a start commands a sendspin client directly. An input served by
 * neither is a no-op on both, and collapsing the two would break one of them.
 */
export interface LineInSourcePort {
  getSession(inputId: string): LineInSession | null;
  onStart(inputId: string, listener: () => void): () => void;
  onStop(inputId: string, listener: () => void): () => void;

  /** Mark the input as wanted (polling device: park desired state for its next poll). */
  markWanted(inputId: string): void;
  /** Withdraw the want. */
  clearWanted(inputId: string): void;

  requestStart(inputId: string): void;
  requestStop(inputId: string): void;

  /**
   * Send a transport command to whatever serves this input — pushed over an open
   * connection when there is one, queued for the next poll otherwise. The device
   * hands it to its own hook, which is where the knowledge of how to drive the
   * attached hardware lives.
   */
  sendCommand(inputId: string, command: string, args?: string[]): void;

  /** Non-null when the source advertises transport controls (→ File audiotype). */
  getControlSupport(inputId: string): LineInControlCommand[] | null;
}
