import type { SystemSettingsMap } from '@smb/shared';
import type { AuthContext, D1Database, WorkerEnv } from '../env.js';
import { verifyAccessJwt } from './crypto.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return jsonResponse(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.status
    );
  }
  const msg = err instanceof Error ? err.message : 'Internal server error';
  console.error(JSON.stringify({ message: 'worker_unhandled_error', error: msg }));
  return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: msg } }, 500);
}

export function applyCorsHeaders(request: Request, response: Response, env: WorkerEnv): Response {
  const origin = request.headers.get('Origin');
  if (!origin) return response;

  const allowedExtras = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const isAllowed =
    origin === new URL(request.url).origin ||
    origin === 'https://localhost' ||
    origin === 'capacitor://localhost' ||
    origin === 'ionic://localhost' ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
    allowedExtras.includes(origin) ||
    allowedExtras.includes('*');

  if (!isAllowed) return response;

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, X-Part-SHA256, Range, Accept'
  );
  headers.set(
    'Access-Control-Expose-Headers',
    'X-Content-SHA256, X-Export-File-Count, Content-Range, Accept-Ranges, Content-Length, ETag'
  );
  if (request.headers.get('Access-Control-Request-Private-Network') === 'true') {
    headers.set('Access-Control-Allow-Private-Network', 'true');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

export async function requireAuth(request: Request, env: WorkerEnv): Promise<AuthContext> {
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Missing bearer token');
  }
  const token = header.slice(7).trim();
  const claims = await verifyAccessJwt(token, env.JWT_ACCESS_SECRET);
  if (!claims) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
  }

  const user = await env.DB.prepare(
    'SELECT id, email, is_active, is_admin, encryption_mode FROM users WHERE id = ?'
  )
    .bind(claims.sub)
    .first<{
      id: string;
      email: string;
      is_active: number;
      is_admin: number;
      encryption_mode: 'server_side' | 'e2ee';
    }>();

  if (!user || !user.is_active) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Account is disabled or not found');
  }

  const dev = await env.DB.prepare('SELECT id, revoked_at FROM devices WHERE id = ? AND user_id = ?')
    .bind(claims.deviceId, user.id)
    .first<{ id: string; revoked_at: string | null }>();

  if (!dev || dev.revoked_at) {
    throw new HttpError(401, 'DEVICE_REVOKED', 'This device session has been revoked');
  }

  return {
    userId: user.id,
    email: user.email,
    deviceId: dev.id,
    roles: user.is_admin ? ['admin', 'user'] : ['user'],
    encryptionMode: user.encryption_mode
  };
}

export function requireAdmin(auth: AuthContext): void {
  if (!auth.roles.includes('admin')) {
    throw new HttpError(403, 'FORBIDDEN', 'Admin role required');
  }
}

export async function getSystemSettings(db: D1Database): Promise<SystemSettingsMap> {
  const rows = await db.prepare('SELECT key, value FROM system_settings').all<{
    key: string;
    value: string;
  }>();
  const map: Record<string, unknown> = {};
  for (const r of rows.results) {
    try {
      map[r.key] = JSON.parse(r.value);
    } catch {
      map[r.key] = r.value;
    }
  }
  return {
    upload_network_policy: 'wifi_only',
    retention_policy: 'indefinite_manual_delete',
    trash_retention_days: Number(map.trash_retention_days ?? 30),
    gps_map_enabled: false,
    search_enabled: false,
    sharing_enabled: false,
    registration_enabled: Boolean(map.registration_enabled ?? true),
    required_replicas: 2
  };
}

export async function addSecurityEvent(
  db: D1Database,
  userId: string | null,
  eventType: string,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO security_events (id, user_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(crypto.randomUUID(), userId, eventType, JSON.stringify(detail), new Date().toISOString())
    .run();
}

export async function addNotification(
  db: D1Database,
  userId: string,
  category: string,
  title: string,
  body: string
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO notifications (id, user_id, category, title, body, is_read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
    )
    .bind(crypto.randomUUID(), userId, category, title, body, new Date().toISOString())
    .run();
}
