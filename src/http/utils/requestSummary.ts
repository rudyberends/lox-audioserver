const AUDIO_CFG_PREFIX_LABELS: Record<string, string> = {
  'audio/cfg/speakertype/': 'speakertype payload',
  'audio/cfg/volumes/': 'volume payload',
  'audio/cfg/playername/': 'player name payload',
  'audio/cfg/groupopts/': 'group options payload',
  'audio/cfg/playeropts/': 'player options payload',
};

/**
 * Produces a logging-safe summary of incoming Loxone command URLs, trimming secrets or large payloads.
 */
export function summariseLoxoneCommand(raw: string | undefined): string {
  if (!raw) return '';

  const SECURE_INIT_PREFIX = 'secure/init/';
  if (raw.startsWith(SECURE_INIT_PREFIX)) {
    const tokenLength = Math.max(0, raw.length - SECURE_INIT_PREFIX.length);
    return `${SECURE_INIT_PREFIX}[token redacted, ${tokenLength} chars]`;
  }

  const SECURE_HELLO_PREFIX = 'secure/hello/';
  if (raw.startsWith(SECURE_HELLO_PREFIX)) {
    const remainder = raw.slice(SECURE_HELLO_PREFIX.length);
    const [sessionToken = '', certificate = ''] = remainder.split('/', 2);
    return `${SECURE_HELLO_PREFIX}${sessionToken}/[certificate trimmed, ${certificate.length} chars]`;
  }

  const SECURE_AUTH_PREFIX = 'secure/authenticate/';
  if (raw.startsWith(SECURE_AUTH_PREFIX)) {
    const remainder = raw.slice(SECURE_AUTH_PREFIX.length);
    const [identity = '', token = ''] = remainder.split('/', 2);
    return `${SECURE_AUTH_PREFIX}${identity}/[token redacted, ${token.length} chars]`;
  }

  const SETCONFIG_PREFIX = 'audio/cfg/setconfig/';
  if (raw.startsWith(SETCONFIG_PREFIX)) {
    const payloadLength = Math.max(0, raw.length - SETCONFIG_PREFIX.length);
    return `${SETCONFIG_PREFIX}[payload trimmed, ${payloadLength} chars]`;
  }

  for (const [prefix, label] of Object.entries(AUDIO_CFG_PREFIX_LABELS)) {
    if (raw.startsWith(prefix)) {
      const payloadLength = Math.max(0, raw.length - prefix.length);
      return `${prefix}[${label} trimmed, ${payloadLength} chars]`;
    }
  }

  const MAX_LENGTH = 320;
  if (raw.length > MAX_LENGTH) {
    return `${raw.slice(0, MAX_LENGTH)}… (truncated ${raw.length - MAX_LENGTH} chars)`;
  }

  return raw;
}
