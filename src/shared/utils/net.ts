import { networkInterfaces } from 'node:os';

export function defaultLocalIp(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (!net || net.internal) {
        continue;
      }
      if (net.family === 'IPv4' && net.address) {
        return net.address;
      }
    }
  }
  return '';
}

export function resolveMdnsHost(host?: string): string | undefined {
  const candidate = host && host !== '0.0.0.0' ? host : defaultLocalIp();
  if (!candidate || candidate === '0.0.0.0') {
    return undefined;
  }
  return candidate;
}
