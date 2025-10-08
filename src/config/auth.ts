/**
 * Produces an HTTP Basic Authorization header for the provided credentials.
 */
export function computeAuthorizationHeader(username?: string, password?: string): string {
  const user = username?.trim() ?? '';
  const pass = password?.trim() ?? '';
  const encodedBase64Token = Buffer.from(`${user}:${pass}`).toString('base64');
  return `Basic ${encodedBase64Token}`;
}
