import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { snapcastCore } from '@/modules/http/snapcast/snapcastCore';

/**
 * WebSocket gateway for the Snapcast-compatible stream.
 */
export class SnapcastGateway {
  public handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean {
    // Allow snapclient URIs with or without explicit /snapcast path.
    return snapcastCore.handleUpgrade(request, socket as any, head);
  }

  public close(): void {
    snapcastCore.close();
  }
}
