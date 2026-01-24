import { SnapcastTcpServer } from '@/adapters/outputs/snapcast/snapcastTcpServer';
import { LineInIngestTcp } from '@/adapters/inputs/linein/lineInIngestTcp';
import type { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import type { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';

export class NetworkService {
  private readonly lineInIngestTcp: LineInIngestTcp;
  private readonly snapcastTcp: SnapcastTcpServer;
  private started = false;

  constructor(
    private readonly options: {
      lineInRegistry: LineInIngestRegistry;
      snapcastCore: SnapcastCore;
    },
  ) {
    this.lineInIngestTcp = new LineInIngestTcp(options.lineInRegistry);
    this.snapcastTcp = new SnapcastTcpServer(options.snapcastCore);
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.lineInIngestTcp.start();
    await this.snapcastTcp.start();
    this.started = true;
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    await this.lineInIngestTcp.stop();
    await this.snapcastTcp.stop();
    this.started = false;
  }

  public getSnapcastAdvertisePort(): number | null {
    return this.snapcastTcp.getAdvertisePort();
  }
}
