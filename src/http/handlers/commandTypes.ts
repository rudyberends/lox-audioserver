export interface CommandResult {
  command: string;
  name: string;
  payload: unknown;
  raw?: boolean;
}

export function response(url: string, name: string, result: unknown): CommandResult {
  const sanitizedUrl = url.trim();
  const sanitizedName = name.trim();

  return {
    command: sanitizedUrl,
    name: sanitizedName,
    payload: result,
  };
}

export function emptyCommand(url: string, rsp: unknown): CommandResult {
  const parts = url.split('/');
  for (let i = parts.length; i--;) {
    if (/^[a-z]/.test(parts[i])) {
      return response(url, parts[i], rsp);
    }
  }
  return response(url, 'response', rsp);
}
