import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  DeviceInfo,
  DevicePlatform,
  EncryptionMode,
  LoginResponse,
  RecoverAccountResponse,
  RegisterResponse,
  RoleName,
  UserProfile
} from '@smb/shared';
import type { AppConfig } from '../../config/env.js';
import type { DbClient, DbQueryable } from '../../db/client.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import {
  generateRecoveryCodes,
  generateRefreshToken,
  hashPassword,
  hashRecoveryCode,
  sha256Hex,
  signAccessToken,
  verifyPassword,
  verifyRecoveryCode
} from '../../utils/crypto.js';
import { Errors } from '../../utils/errors.js';
import { getSystemSettings } from '../settings/service.js';

const PlatformEnum = z.enum(['ios', 'android', 'windows', 'web']);
const EncryptionModeEnum = z.enum(['server_side', 'e2ee']);

const RegisterBodySchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  displayName: z.string().trim().min(1).max(100),
  encryptionMode: EncryptionModeEnum,
  deviceName: z.string().trim().min(1).max(100).optional(),
  platform: PlatformEnum.optional(),
  e2eeKeySalt: z.string().max(512).optional(),
  e2eeEncryptedMasterKey: z.string().max(4096).optional(),
  e2eeKdfParams: z.record(z.unknown()).optional()
});

const LoginBodySchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(128),
  deviceName: z.string().trim().min(1).max(100).optional(),
  platform: PlatformEnum.optional()
});

const RefreshBodySchema = z.object({
  refreshToken: z.string().min(16).max(512)
});

const RecoverBodySchema = z.object({
  email: z.string().trim().email().max(255),
  recoveryCode: z.string().trim().min(8).max(64),
  newPassword: z.string().min(8, 'New password must be at least 8 characters').max(128)
});

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  encryption_mode: EncryptionMode;
  e2ee_key_salt: string | null;
  e2ee_encrypted_master_key: string | null;
  e2ee_kdf_params: Record<string, unknown> | null;
  quota_bytes: string | number;
  used_bytes: string | number;
  is_active: boolean;
  created_at: string | Date;
}

interface DeviceRow {
  id: string;
  device_name: string;
  platform: DevicePlatform;
  is_trusted: boolean;
  last_seen_at: string | Date | null;
  revoked_at: string | Date | null;
  created_at: string | Date;
}

function toIso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapUserProfile(row: UserRow, roles: RoleName[]): UserProfile {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    roles,
    encryptionMode: row.encryption_mode,
    e2eeConfigured: Boolean(row.e2ee_encrypted_master_key && row.e2ee_key_salt),
    quotaBytes: Number(row.quota_bytes),
    usedBytes: Number(row.used_bytes),
    isActive: row.is_active,
    createdAt: toIso(row.created_at) ?? new Date().toISOString()
  };
}

function mapDeviceInfo(row: DeviceRow, isCurrent = false): DeviceInfo {
  return {
    id: row.id,
    deviceName: row.device_name,
    platform: row.platform,
    isTrusted: row.is_trusted,
    lastSeenAt: toIso(row.last_seen_at),
    revokedAt: toIso(row.revoked_at),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    isCurrent
  };
}

async function fetchUserRoles(db: DbQueryable, userId: string): Promise<RoleName[]> {
  const res = await db.query<{ name: RoleName }>(
    `
    SELECT r.name
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = $1
    ORDER BY r.name ASC
    `,
    [userId]
  );
  return res.rows.map((r) => r.name);
}

async function issueSessionTokens(
  db: DbQueryable,
  config: AppConfig,
  user: { id: string; encryption_mode: EncryptionMode },
  roles: RoleName[],
  deviceId: string,
  tokenFamily: string = crypto.randomUUID()
) {
  const accessToken = signAccessToken(
    {
      sub: user.id,
      did: deviceId,
      roles,
      enc: user.encryption_mode
    },
    config.JWT_ACCESS_SECRET,
    config.JWT_ACCESS_TTL_SECONDS
  );

  const refreshToken = generateRefreshToken();
  const tokenHash = sha256Hex(refreshToken);
  const expiresAt = new Date(Date.now() + config.JWT_REFRESH_TTL_DAYS * 86_400_000).toISOString();

  const insertRes = await db.query<{ id: string }>(
    `
    INSERT INTO refresh_tokens (user_id, device_id, token_family, token_hash, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
    `,
    [user.id, deviceId, tokenFamily, tokenHash, expiresAt]
  );

  return {
    refreshTokenId: insertRes.rows[0]!.id,
    tokens: {
      accessToken,
      refreshToken,
      accessTokenExpiresIn: config.JWT_ACCESS_TTL_SECONDS
    }
  };
}

export function registerAuthRoutes(app: FastifyInstance, db: DbClient, config: AppConfig) {
  const authenticate = createAuthMiddleware(db, config);

  app.post('/api/v1/auth/register', async (request, reply) => {
    const parsed = RegisterBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.badRequest('Invalid registration payload', parsed.error.flatten());
    }

    const body = parsed.data;
    const normalizedEmail = body.email.toLowerCase();

    const result = await db.transaction<RegisterResponse>(async (tx) => {
      const countRes = await tx.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
      const isFirstUser = Number(countRes.rows[0]?.count ?? '0') === 0;

      if (!isFirstUser) {
        const settings = await getSystemSettings(tx);
        if (!settings.registration_enabled) {
          throw Errors.forbidden('Public registration is currently disabled by administrator');
        }
      }

      const existing = await tx.query<{ id: string }>('SELECT id FROM users WHERE LOWER(email) = $1', [
        normalizedEmail
      ]);
      if (existing.rowCount > 0) {
        throw Errors.conflict('An account with this email already exists');
      }

      const passwordHash = await hashPassword(body.password);

      const userRes = await tx.query<UserRow>(
        `
        INSERT INTO users (
          email, display_name, password_hash, encryption_mode,
          e2ee_key_salt, e2ee_encrypted_master_key, e2ee_kdf_params, quota_bytes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
        `,
        [
          normalizedEmail,
          body.displayName,
          passwordHash,
          body.encryptionMode,
          body.e2eeKeySalt ?? null,
          body.e2eeEncryptedMasterKey ?? null,
          body.e2eeKdfParams ? JSON.stringify(body.e2eeKdfParams) : null,
          config.DEFAULT_USER_QUOTA_BYTES
        ]
      );

      const user = userRes.rows[0]!;

      await tx.query(
        `
        INSERT INTO auth_identities (user_id, provider, provider_subject)
        VALUES ($1, 'password', $2)
        `,
        [user.id, normalizedEmail]
      );

      const assignedRoles: RoleName[] = isFirstUser ? ['admin', 'user'] : ['user'];
      for (const roleName of assignedRoles) {
        await tx.query(
          `
          INSERT INTO user_roles (user_id, role_id)
          SELECT $1, id FROM roles WHERE name = $2
          `,
          [user.id, roleName]
        );
      }

      const deviceRes = await tx.query<DeviceRow>(
        `
        INSERT INTO devices (user_id, device_name, platform, is_trusted)
        VALUES ($1, $2, $3, TRUE)
        RETURNING *
        `,
        [user.id, body.deviceName ?? 'Primary Device', body.platform ?? 'web']
      );
      const device = deviceRes.rows[0]!;

      const recoveryCodes = generateRecoveryCodes(10);
      for (const code of recoveryCodes) {
        const hashed = hashRecoveryCode(code);
        await tx.query(
          `
          INSERT INTO recovery_codes (user_id, code_salt, code_hash)
          VALUES ($1, $2, $3)
          `,
          [user.id, hashed.salt, hashed.hash]
        );
      }

      const { tokens } = await issueSessionTokens(tx, config, user, assignedRoles, device.id);

      await tx.query(
        `
        INSERT INTO security_events (user_id, event_type, detail)
        VALUES ($1, 'account_registered', $2::jsonb)
        `,
        [
          user.id,
          JSON.stringify({
            encryptionMode: user.encryption_mode,
            platform: device.platform,
            bootstrapAdmin: isFirstUser
          })
        ]
      );

      return {
        user: mapUserProfile(user, assignedRoles),
        device: mapDeviceInfo(device, true),
        tokens,
        recoveryCodes
      };
    });

    return reply.code(201).send(result);
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = LoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.badRequest('Invalid login payload', parsed.error.flatten());
    }

    const { email, password, deviceName, platform } = parsed.data;
    const normalizedEmail = email.toLowerCase();

    const userRes = await db.query<UserRow>('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    const user = userRes.rows[0];

    if (!user) {
      throw Errors.unauthorized('Invalid email or password');
    }

    const validPassword = await verifyPassword(password, user.password_hash);
    if (!validPassword) {
      await db.query(
        `INSERT INTO security_events (user_id, event_type, detail) VALUES ($1, 'login_failed', '{}'::jsonb)`,
        [user.id]
      );
      throw Errors.unauthorized('Invalid email or password');
    }

    if (!user.is_active) {
      throw Errors.forbidden('This account has been disabled by an administrator');
    }

    const result = await db.transaction<LoginResponse>(async (tx) => {
      const roles = await fetchUserRoles(tx, user.id);

      const deviceRes = await tx.query<DeviceRow>(
        `
        INSERT INTO devices (user_id, device_name, platform, is_trusted)
        VALUES ($1, $2, $3, TRUE)
        RETURNING *
        `,
        [user.id, deviceName ?? 'Web Browser', platform ?? 'web']
      );
      const device = deviceRes.rows[0]!;

      const { tokens } = await issueSessionTokens(tx, config, user, roles, device.id);

      await tx.query(
        `
        INSERT INTO security_events (user_id, event_type, detail)
        VALUES ($1, 'login_success', $2::jsonb)
        `,
        [user.id, JSON.stringify({ deviceId: device.id, platform: device.platform })]
      );

      return {
        user: mapUserProfile(user, roles),
        device: mapDeviceInfo(device, true),
        tokens,
        e2eeKeyBundle:
          user.encryption_mode === 'e2ee' && user.e2ee_key_salt && user.e2ee_encrypted_master_key
            ? {
                keySalt: user.e2ee_key_salt,
                encryptedMasterKey: user.e2ee_encrypted_master_key,
                kdfParams: user.e2ee_kdf_params ?? {}
              }
            : null
      };
    });

    return reply.code(200).send(result);
  });

  app.post('/api/v1/auth/refresh', async (request, reply) => {
    const parsed = RefreshBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.badRequest('Invalid refresh payload', parsed.error.flatten());
    }

    const incomingHash = sha256Hex(parsed.data.refreshToken);

    const tokenRes = await db.query<{
      id: string;
      user_id: string;
      device_id: string;
      token_family: string;
      expires_at: string | Date;
      revoked_at: string | Date | null;
    }>('SELECT * FROM refresh_tokens WHERE token_hash = $1', [incomingHash]);

    const existing = tokenRes.rows[0];
    if (!existing) {
      throw Errors.unauthorized('Invalid refresh token');
    }

    if (existing.revoked_at !== null) {
      // Refresh token reuse detected -> revoke entire token family immediately!
      await db.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_family = $1 AND revoked_at IS NULL',
        [existing.token_family]
      );
      await db.query(
        `INSERT INTO security_events (user_id, event_type, detail) VALUES ($1, 'refresh_token_reuse_detected', $2::jsonb)`,
        [existing.user_id, JSON.stringify({ deviceId: existing.device_id })]
      );
      throw Errors.unauthorized('Refresh token reuse detected; session family revoked');
    }

    if (new Date(existing.expires_at).getTime() <= Date.now()) {
      throw Errors.unauthorized('Refresh token expired');
    }

    const rotated = await db.transaction(async (tx) => {
      const userRes = await tx.query<UserRow>('SELECT * FROM users WHERE id = $1', [existing.user_id]);
      const user = userRes.rows[0];
      if (!user || !user.is_active) {
        throw Errors.unauthorized('Account inactive');
      }

      const devRes = await tx.query<DeviceRow>(
        'SELECT * FROM devices WHERE id = $1 AND user_id = $2',
        [existing.device_id, existing.user_id]
      );
      const device = devRes.rows[0];
      if (!device || device.revoked_at !== null) {
        throw Errors.unauthorized('Device revoked');
      }

      const roles = await fetchUserRoles(tx, user.id);
      const { refreshTokenId, tokens } = await issueSessionTokens(
        tx,
        config,
        user,
        roles,
        device.id,
        existing.token_family
      );

      await tx.query(
        'UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $2 WHERE id = $1',
        [existing.id, refreshTokenId]
      );
      await tx.query('UPDATE devices SET last_seen_at = NOW() WHERE id = $1', [device.id]);

      return { tokens };
    });

    return reply.code(200).send(rotated);
  });

  app.post('/api/v1/auth/logout', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    await db.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL',
      [auth.userId, auth.deviceId]
    );
    await db.query(
      `INSERT INTO security_events (user_id, event_type, detail) VALUES ($1, 'logout', $2::jsonb)`,
      [auth.userId, JSON.stringify({ deviceId: auth.deviceId })]
    );
    return reply.code(200).send({ loggedOut: true });
  });

  app.post('/api/v1/auth/recover', async (request, reply) => {
    const parsed = RecoverBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.badRequest('Invalid recovery payload', parsed.error.flatten());
    }

    const { email, recoveryCode, newPassword } = parsed.data;
    const normalizedEmail = email.toLowerCase();

    const userRes = await db.query<UserRow>('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    const user = userRes.rows[0];
    if (!user || !user.is_active) {
      throw Errors.unauthorized('Invalid email or recovery code');
    }

    const codesRes = await db.query<{ id: string; code_salt: string; code_hash: string }>(
      'SELECT id, code_salt, code_hash FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
      [user.id]
    );

    const matched = codesRes.rows.find((row) => verifyRecoveryCode(recoveryCode, row.code_salt, row.code_hash));
    if (!matched) {
      await db.query(
        `INSERT INTO security_events (user_id, event_type, detail) VALUES ($1, 'recovery_failed', '{}'::jsonb)`,
        [user.id]
      );
      throw Errors.unauthorized('Invalid email or recovery code');
    }

    const newHash = await hashPassword(newPassword);

    const remaining = await db.transaction(async (tx) => {
      await tx.query('UPDATE recovery_codes SET used_at = NOW() WHERE id = $1', [matched.id]);
      await tx.query('UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [
        user.id,
        newHash
      ]);
      await tx.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
        [user.id]
      );
      await tx.query(
        `INSERT INTO security_events (user_id, event_type, detail) VALUES ($1, 'account_recovered', $2::jsonb)`,
        [user.id, JSON.stringify({ encryptionMode: user.encryption_mode })]
      );

      const remRes = await tx.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
        [user.id]
      );
      return Number(remRes.rows[0]?.count ?? '0');
    });

    const isE2ee = user.encryption_mode === 'e2ee';
    const response: RecoverAccountResponse = {
      recovered: true,
      remainingRecoveryCodes: remaining,
      e2eeVaultUnlockRequired: isE2ee,
      message: isE2ee
        ? 'Login password reset. Because this account uses E2EE, you still need your E2EE vault key or trusted device to decrypt existing media.'
        : 'Login password reset successfully. You can now sign in with your new password.'
    };

    return reply.code(200).send(response);
  });
}
