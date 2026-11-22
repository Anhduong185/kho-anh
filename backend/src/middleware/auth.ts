import type { FastifyReply, FastifyRequest } from 'fastify';
import type { EncryptionMode, RoleName } from '@smb/shared';
import type { DbClient } from '../db/client.js';
import type { AppConfig } from '../config/env.js';
import { verifyAccessToken } from '../utils/crypto.js';
import { Errors } from '../utils/errors.js';

export interface AuthContext {
  userId: string;
  deviceId: string;
  roles: RoleName[];
  encryptionMode: EncryptionMode;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function createAuthMiddleware(db: DbClient, config: AppConfig) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw Errors.unauthorized('Missing Bearer token');
    }

    const token = authHeader.slice('Bearer '.length).trim();
    const payload = verifyAccessToken(token, config.JWT_ACCESS_SECRET);
    if (!payload) {
      throw Errors.unauthorized('Invalid or expired access token');
    }

    // Re-check live account & device revocation state on every request so revoked devices/accounts are blocked immediately.
    const stateRes = await db.query<{
      is_active: boolean;
      encryption_mode: EncryptionMode;
      revoked_at: string | null;
      roles: RoleName[] | null;
    }>(
      `
      SELECT
        u.is_active,
        u.encryption_mode,
        d.revoked_at,
        ARRAY(
          SELECT r.name
          FROM user_roles ur
          JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = u.id
        ) AS roles
      FROM users u
      LEFT JOIN devices d ON d.id = $2 AND d.user_id = u.id
      WHERE u.id = $1
      `,
      [payload.sub, payload.did]
    );

    const row = stateRes.rows[0];
    if (!row || !row.is_active) {
      throw Errors.unauthorized('Account is inactive or no longer exists');
    }
    if (row.revoked_at !== null) {
      throw Errors.unauthorized('This device session has been revoked');
    }

    request.auth = {
      userId: payload.sub,
      deviceId: payload.did,
      roles: row.roles ?? [],
      encryptionMode: row.encryption_mode
    };
  };
}

export function requireRole(role: RoleName) {
  return async function checkRole(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.auth) {
      throw Errors.unauthorized();
    }
    if (!request.auth.roles.includes(role)) {
      throw Errors.forbidden(`Role "${role}" is required for this endpoint`);
    }
  };
}
