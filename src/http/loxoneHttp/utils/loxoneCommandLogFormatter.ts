/**
 * Maps known Loxone audio configuration prefixes to human-readable payload labels.
 */
const audioCfgPrefixLabels: Record<string, string> = {
  'audio/cfg/speakertype/': 'speakertype payload',
  'audio/cfg/volumes/': 'volume payload',
  'audio/cfg/playername/': 'player name payload',
  'audio/cfg/groupopts/': 'group options payload',
  'audio/cfg/playeropts/': 'player options payload',
};

/**
 * Formats incoming Loxone command URLs into a log-safe, compact representation.
 * Sensitive data (tokens, certificates, payloads) are trimmed or redacted.
 *
 * Examples:
 *   secure/init/ABC123...     → secure/init/[token redacted, 60 chars]
 *   audio/cfg/playeropts/...  → audio/cfg/playeropts/[player options payload trimmed, 440 chars]
 *   audio/cfg/setconfig/...   → audio/cfg/setconfig/[payload trimmed, 987 chars]
 *   (very long URL)           → /audio/... [truncated N chars]
 */
export function formatLoxoneCommandForLog(raw?: string): string {
  if (!raw) {
    return '';
  }

  const secureInitPrefix = 'secure/init/';
  if (raw.startsWith(secureInitPrefix)) {
    const tokenLength = Math.max(0, raw.length - secureInitPrefix.length);
    return `${secureInitPrefix}[token redacted, ${tokenLength} chars]`;
  }

  const secureHelloPrefix = 'secure/hello/';
  if (raw.startsWith(secureHelloPrefix)) {
    const remainder = raw.slice(secureHelloPrefix.length);
    const [sessionToken = '', certificate = ''] = remainder.split('/', 2);
    return `${secureHelloPrefix}${sessionToken}/[certificate trimmed, ${certificate.length} chars]`;
  }

  const secureAuthPrefix = 'secure/authenticate/';
  if (raw.startsWith(secureAuthPrefix)) {
    const remainder = raw.slice(secureAuthPrefix.length);
    const [identity = '', token = ''] = remainder.split('/', 2);
    return `${secureAuthPrefix}${identity}/[token redacted, ${token.length} chars]`;
  }

  const setConfigPrefix = 'audio/cfg/setconfig/';
  if (raw.startsWith(setConfigPrefix)) {
    const payloadLength = Math.max(0, raw.length - setConfigPrefix.length);
    return `${setConfigPrefix}[payload trimmed, ${payloadLength} chars]`;
  }

  for (const [prefix, label] of Object.entries(audioCfgPrefixLabels)) {
    if (raw.startsWith(prefix)) {
      const payloadLength = Math.max(0, raw.length - prefix.length);
      return `${prefix}[${label} trimmed, ${payloadLength} chars]`;
    }
  }

  const maxLength = 320;
  if (raw.length > maxLength) {
    return `${raw.slice(0, maxLength)}… [truncated ${raw.length - maxLength} chars]`;
  }

  return raw;
}