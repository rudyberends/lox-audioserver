export function convertCookieToNetscape(rawCookieStr: string, domain: string): string {
  const normalizedDomain = String(domain || '')
    .trim()
    .replace(/^https?:\/\//i, '') || '.youtube.com';
  const pairs = parseCookieHeader(rawCookieStr);
  let out = '# Netscape HTTP Cookie File\n';
  for (const [key, value] of pairs) {
    if (!key) continue;
    out += `${normalizedDomain}\tTRUE\t/\tTRUE\t0\t${key}\t${value}\n`;
  }
  return out;
}

function parseCookieHeader(raw: string): Array<[string, string]> {
  const str = String(raw || '').trim();
  if (!str) return [];
  const parts = str.split(';').map((p) => p.trim()).filter(Boolean);
  const pairs: Array<[string, string]> = [];
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (!key) continue;
    // Best-effort unquote.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    pairs.push([key, value]);
  }
  return pairs;
}

