export type AdminServerSession = {
  id: string;
  username: string;
  createdAt: number;
  expiresAt: number;
};

export type HashAlgorithm = 'SHA1' | 'SHA256';

export const AUTH_COOKIE_NAME = 'lox_admin_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
export const MINISERVER_ADMIN_PERMISSION = 1;

export type MiniserverAuthErrorCode =
  | 'invalid-credentials'
  | 'insufficient-permissions'
  | 'miniserver-unreachable'
  | 'miniserver-protocol'
  | 'miniserver-not-configured';

export class MiniserverAuthError extends Error {
  constructor(
    public readonly code: MiniserverAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MiniserverAuthError';
  }
}
