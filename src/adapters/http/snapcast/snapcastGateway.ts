import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';

/**
 * WebSocket gateway for the Snapcast-compatible stream.
 */
export class SnapcastGateway {
  constructor(private readonly core: SnapcastCore) {}

  public handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean {
    // Allow snapclient URIs with or without explicit /snapcast path.
    return this.core.handleUpgrade(request, socket as any, head);
  }

  public close(): void {
    this.core.close();
  }
}
