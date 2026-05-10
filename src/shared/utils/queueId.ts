export function generateQueueId(): string {
  return Math.random().toString(16).slice(2, 14);
}
