import type {
  LineInSession,
  LineInSourcePort,
} from '@/ports/LineInSourcePort';
import type { LineInControlCommand } from '@/ports/InputsPort';
import type { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { LineInActivationRegistry } from '@/adapters/inputs/linein/lineInActivationRegistry';

export type LineInSourceAdapterDeps = {
  ingest: LineInIngestRegistry;
  sendspin: SendspinLineInService;
  activation: LineInActivationRegistry;
};

/**
 * Fans {@link LineInSourcePort} out over the three registries that actually own
 * line-in transports. Pure delegation and no state of its own — it exists so the
 * activation logic can live in the application layer, which may not import these.
 */
export class LineInSourceAdapter implements LineInSourcePort {
  private readonly ingest: LineInIngestRegistry;
  private readonly sendspin: SendspinLineInService;
  private readonly activation: LineInActivationRegistry;

  constructor(deps: LineInSourceAdapterDeps) {
    this.ingest = deps.ingest;
    this.sendspin = deps.sendspin;
    this.activation = deps.activation;
  }

  public getSession(inputId: string): LineInSession | null {
    return this.ingest.getSession(inputId);
  }

  // The registry hands listeners a session/reason; no caller here uses them, so the
  // port keeps the simpler signature.
  public onStart(inputId: string, listener: () => void): () => void {
    return this.ingest.onStart(inputId, () => listener());
  }

  public onStop(inputId: string, listener: () => void): () => void {
    return this.ingest.onStop(inputId, () => listener());
  }

  public markWanted(inputId: string): void {
    this.activation.activate(inputId);
  }

  public clearWanted(inputId: string): void {
    this.activation.deactivate(inputId);
  }

  public requestStart(inputId: string): void {
    this.sendspin.requestStart(inputId);
  }

  /**
   * Stop the sendspin source only — deliberately NOT paired with clearWanted.
   * Switching a zone between line-ins stops the old stream while the want must
   * survive; only dropping the watch withdraws it.
   */
  public requestStop(inputId: string): void {
    this.sendspin.requestStop(inputId);
  }

  public sendCommand(inputId: string, command: string, args: string[] = []): void {
    this.activation.enqueueCommand(inputId, command, args);
  }

  public getControlSupport(inputId: string): LineInControlCommand[] | null {
    return this.sendspin.getControlSupport(inputId);
  }
}

export function createLineInSourceAdapter(deps: LineInSourceAdapterDeps): LineInSourceAdapter {
  return new LineInSourceAdapter(deps);
}
