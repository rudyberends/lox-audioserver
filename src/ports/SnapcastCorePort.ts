import type { AudioOutputSettings } from '@/ports/types/audioFormat';

export interface SnapcastCorePort {
  setStream: (
    streamId: string,
    zoneId: number,
    output: AudioOutputSettings,
    stream: NodeJS.ReadableStream,
    clientIds: string[],
  ) => void;
  clearStream: (zoneId: number) => void;
  setClientStream: (clientId: string, streamId: string) => void;
  setClientVolumes: (clientIds: string[], volume: number) => void;
}
