export type StreamReadinessOptions = {
  timeoutMs?: number;
};

export async function waitForReadableStream(
  stream: NodeJS.ReadableStream | null | undefined,
  options: StreamReadinessOptions = {},
): Promise<boolean> {
  if (!stream) {
    return false;
  }
  const timeoutMs = options.timeoutMs ?? 2000;
  const readable = stream as NodeJS.ReadableStream & { readableLength?: number };
  if (typeof readable.readableLength === 'number' && readable.readableLength > 0) {
    return true;
  }
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      stream.off('readable', onReadable);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onEnd);
      clearTimeout(timer);
    };
    const onReadable = () => {
      if (typeof readable.readableLength === 'number' && readable.readableLength === 0) {
        return;
      }
      cleanup();
      resolve(true);
    };
    const onData = (chunk: Buffer) => {
      if (!chunk?.length) return;
      cleanup();
      resolve(true);
    };
    const onEnd = () => {
      cleanup();
      resolve(false);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, Math.max(0, timeoutMs));

    stream.on('readable', onReadable);
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
    stream.once('error', onEnd);
  });
}
