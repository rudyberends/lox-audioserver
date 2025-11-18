// @ts-nocheck
export function formatBytes(bytes = 0) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const formatted = size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

export function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

export function normalizeLogContent(value = '') {
  return String(value ?? '').replace(/\r\n/g, '\n');
}

export function trimLogContent(content, limit) {
  if (!limit || content.length <= limit) return content;
  const start = content.length - limit;
  const boundary = content.indexOf('\n', start);
  return content.slice(boundary >= 0 ? boundary + 1 : start);
}

