import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  AUTH_COOKIE_NAME,
  SESSION_TTL_MS,
  type AdminServerSession,
} from '@/adapters/http/adminApi/auth/types';

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const cookies: Record<string, string> = {};
  for (const entry of raw.split(';')) {
    const [key, ...rest] = entry.split('=');
    const name = key?.trim();
    if (!name) continue;
    const value = rest.join('=').trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export class AdminSessionStore {
  private readonly sessions = new Map<string, AdminServerSession>();

  public cleanupExpired(now = Date.now()): void {
    for (const [id, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
      }
    }
  }

  public getFromRequest(req: IncomingMessage): AdminServerSession | null {
    this.cleanupExpired();
    const sessionId = parseCookies(req)[AUTH_COOKIE_NAME];
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  public create(username: string): AdminServerSession {
    this.cleanupExpired();
    const now = Date.now();
    const session: AdminServerSession = {
      id: randomBytes(32).toString('hex'),
      username,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  public clearFromRequest(req: IncomingMessage): void {
    const sessionId = parseCookies(req)[AUTH_COOKIE_NAME];
    if (!sessionId) return;
    this.sessions.delete(sessionId);
  }

  public buildCookie(req: IncomingMessage, session: AdminServerSession): string {
    const parts = [
      `${AUTH_COOKIE_NAME}=${encodeURIComponent(session.id)}`,
      'Path=/admin/api',
      'HttpOnly',
      'SameSite=Lax',
    ];
    if (Boolean((req.socket as { encrypted?: boolean }).encrypted)) {
      parts.push('Secure');
    }
    return parts.join('; ');
  }

  public buildExpiredCookie(req: IncomingMessage): string {
    const parts = [
      `${AUTH_COOKIE_NAME}=`,
      'Path=/admin/api',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
    ];
    if (Boolean((req.socket as { encrypted?: boolean }).encrypted)) {
      parts.push('Secure');
    }
    return parts.join('; ');
  }
}

export function isPublicAdminApiRoute(pathname: string, method: string): boolean {
  if (method === 'OPTIONS') return true;
  if (pathname === '/info' && method === 'GET') return true;
  if (pathname === '/auth/login' && method === 'POST') return true;
  if (pathname === '/auth/logout' && method === 'POST') return true;
  if (pathname === '/auth/me' && method === 'GET') return true;
  if (/^\/spotify\/auth\/callback/.test(pathname)) return true;
  if (/^\/spotify\/librespot\/credentials/.test(pathname)) return true;
  if (/^\/zones\/\d+\/equalizer$/.test(pathname) && (method === 'GET' || method === 'PUT')) return true;
  return false;
}
