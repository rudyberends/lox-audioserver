import type { BaseController } from '@lox-audioserver/node-googlecast';
import { loadGoogleCastModule } from '@/adapters/outputs/googleCast/googlecastLoader';

export type JsonNamespaceController = BaseController<{ message: (payload: Record<string, unknown>) => void }> & {
  sendMessage(payload: Record<string, unknown>): Promise<void>;
};

const normalizePayload = (message: unknown): Record<string, unknown> | null => {
  if (!message) return null;
  if (Buffer.isBuffer(message)) {
    try {
      return JSON.parse(message.toString());
    } catch {
      return null;
    }
  }
  if (typeof message === 'string') {
    try {
      return JSON.parse(message);
    } catch {
      return null;
    }
  }
  if (typeof message === 'object') {
    return message as Record<string, unknown>;
  }
  return null;
};

export const createJsonNamespaceControllerFactory = async (
  namespace: string,
): Promise<(channel: any, destinationId: string) => JsonNamespaceController> => {
  const { BaseController } = await loadGoogleCastModule();

  class JsonNamespaceControllerImpl extends BaseController<{ message: (payload: Record<string, unknown>) => void }> {
    constructor(channel: any, destinationId: string) {
      super(channel, namespace, 'sender-0', destinationId);
    }

    public handleMessage(message: unknown): void {
      const payload = normalizePayload(message);
      if (!payload) return;
      this.emit('message', payload);
    }

    public async sendMessage(payload: Record<string, unknown>): Promise<void> {
      await this.send(payload);
    }
  }

  return (channel: any, destinationId: string): JsonNamespaceController =>
    new JsonNamespaceControllerImpl(channel, destinationId);
};
