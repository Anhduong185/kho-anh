import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DeviceInfo, DevicePlatform, EncryptionMode, RoleName, UserProfile } from '@smb/shared';
import type { AppConfig } from '../../config/env.js';
import type { DbClient } from '../../db/client.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import {
  generateRecoveryCodes,
  hashPassword,
  hashRecoveryCode,
  verifyPassword
} from '../../utils/crypto.js';
import { Errors } from '../../utils/errors.js';
import { getSystemSettings } from '../settings/service.js';

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128)
});

const RegenerateCodesSchema = z.object({
  currentPassword: z.string().min(1).max(128)
});

const UpdateE2eeKeySchema = z.object({
  e2eeKeySalt: z.string().min(8).max(512),
  e2eeEncryptedMasterKey: z.string().min(16).max(4096),
  e2eeKdfParams: z.record(z.unknown())
});

const DeviceIdParamSchema = z.object({
  deviceId: z.string().uuid()
});

export function registerUserRoutes(app: FastifyInstance, db: DbClient, config: AppConfig) {
  const authenticate = createAuthMiddleware(db, config);

  app.get('/api/v1/users/me', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;

    const res = await db.query<{
      id: string;
      email: string;
      display_name: string;
      encryption_mode: EncryptionMode;
      e2ee_key_salt: string | null;
      e2ee_encrypted_master_key: string | null;
      quota_bytes: string | number;
      used_bytes: string | number;
      is_active: boolean;
      created_at: string | Date;
    }>('SELECT * FROM users WHERE id = $1', [auth.userId]);

    const row = res.rows[0];
    if (!row) {
      throw Errors.notFound('User not found');
    }

    const user: UserProfile = {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      roles: auth.roles as RoleName[],
      encryptionMode: row.encryption_mode,
      e2eeConfigured: Boolean(row.e2ee_key_salt && row.e2ee_encrypted_master_key),
      quotaBytes: Number(row.quota_bytes),
      usedBytes: Number(row.used_bytes),
      isActive: row.is_active,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString()
    };

    const settings = await getSystemSettings(db);

    return {
      user,
      policies: {
        uploadNetworkPolicy: settings.upload_network_policy,
        retentionPolicy: settings.retention_policy,
        trashRetentionDays: settings.trash_retention_days,
        gpsMapEnabled: settings.gps_map_enabled,
        searchEnabled: settings.search_enabled,
        sharingEnabled: settings.sharing_enabled,
        requiredReplicas: settings.required_replicas
      }
    };
  });

  app.patch('/api/v1/users/me/password', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const parsed = ChangePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.badRequest('Invalid password change payload', parsed.error.flatten());
    }

    const userRes = await db.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [auth.userId]
    );
    const currentHash = userRes.rows[0]?.password_hash;
    if (!currentHash || !(await verifyPassword(parsed.data.currentPassword, currentHash))) {
      throw Errors.unauthorized('Current password is incorrect');
    }

    const nextHash = await hashPassword(parsed.data.newPassword);
    await db.transaction(async (tx) => {
      await tx.query('UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [
        auth.userId,
        nextHash
      ]);
      // Revoke refresh tokens on other devices
      await tx.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND device_id <> $2 AND revoked_at IS NULL',
        [auth.userId, auth.deviceId]
      );
      await tx.query(
        `INSERT INTO security_events (user_id, event_type, detail) VALUES ($1, 'password_changed', '{}'::jsonb)`,
        [auth.userId]
      );
    });

    return { updated: true };
  });

  app.post('/api/v1/users/me/recovery-codes/regenerate', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const parsed = RegenerateCodesSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.badRequest('Current password is required', parsed.error.flatten());
    }

    const userRes = await db.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [auth.userId]
    );
    const currentHash = userRes.rows[0]?.password_hash;
    if (!currentHash || !(await verifyPassword(parsed.data.currentPassword, currentHash))) {
      throw Errors.unauthorized('Current password is incorrect');
    }

    const recoveryCodes = generateRecoveryCodes(10);
    await db.transaction(async (tx) => {
      await tx.query('UPDATE recovery_codes SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [
        auth.userId
      ]);
      for (const code of recoveryCodes) {
        const hashed = hashRecoveryCode(code);
        await tx.query(
          'INSERT INTO recovery_codes (user_id, code_salt, code_hash) VALUES ($1, $2, $3)',
          [auth.userId, hashed.salt, hashed.hash]
        );
      }
      await tx.query(
        `INSERT INTO security_events (user_id, event_type, detail) VALUES ($1, 'recovery_codes_regenerated', '{}'::jsonb)`,
        [auth.userId]
      );
    });

    return { recoveryCodes };
  });

  app.put('/api/v1/users/me/e2ee-key', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    if (auth.encryptionMode !== 'e2ee') {
      throw Errors.badRequest('E2EE key bundle can only be configured for accounts in "e2ee" mode');
    }

    const parsed = UpdateE2eeKeySchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.badRequest('Invalid E2EE key bundle', parsed.error.flatten());
    }

    await db.query(
      `
      UPDATE users
      SET e2ee_key_salt = $2,
          e2ee_encrypted_master_key = $3,
          e2ee_kdf_params = $4::jsonb,
          updated_at = NOW()
      WHERE id = $1
      `,
      [
        auth.userId,
        parsed.data.e2eeKeySalt,
        parsed.data.e2eeEncryptedMasterKey,
        JSON.stringify(parsed.data.e2eeKdfParams)
      ]
    );

    await db.query(
      `INSERT INTO security_events (user_id, event_type, detail) VALUES ($1, 'e2ee_key_bundle_updated', '{}'::jsonb)`,
      [auth.userId]
    );

    return { configured: true };
  });

  // Strict tenant-scoped device listing
  app.get('/api/v1/devices', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const res = await db.query<{
      id: string;
      device_name: string;
      platform: DevicePlatform;
      is_trusted: boolean;
      last_seen_at: string | Date | null;
      revoked_at: string | Date | null;
      created_at: string | Date;
    }>(
      `
      SELECT id, device_name, platform, is_trusted, last_seen_at, revoked_at, created_at
      FROM devices
      WHERE user_id = $1
      ORDER BY created_at DESC
      `,
      [auth.userId]
    );

    const devices: DeviceInfo[] = res.rows.map((d) => ({
      id: d.id,
      deviceName: d.device_name,
      platform: d.platform,
      isTrusted: d.is_trusted,
      lastSeenAt: d.last_seen_at ? new Date(d.last_seen_at).toISOString() : null,
      revokedAt: d.revoked_at ? new Date(d.revoked_at).toISOString() : null,
      createdAt: new Date(d.created_at).toISOString(),
      isCurrent: d.id === auth.deviceId
    }));

    return { devices };
  });

  // Strict tenant-scoped device revocation (returns 404 if device belongs to another account)
  app.delete('/api/v1/devices/:deviceId', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const paramParsed = DeviceIdParamSchema.safeParse(request.params);
    if (!paramParsed.success) {
      throw Errors.badRequest('Invalid deviceId');
    }

    const { deviceId } = paramParsed.data;

    const updated = await db.transaction(async (tx) => {
      const res = await tx.query<{ id: string }>(
        `
        UPDATE devices
        SET revoked_at = NOW(), is_trusted = FALSE
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id
        `,
        [deviceId, auth.userId]
      );

      if (res.rowCount === 0) {
        return false;
      }

      await tx.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL',
        [auth.userId, deviceId]
      );
      await tx.query(
        `INSERT INTO security_events (user_id, event_type, detail) VALUES ($1, 'device_revoked', $2::jsonb)`,
        [auth.userId, JSON.stringify({ deviceId })]
      );
      return true;
    });

    if (!updated) {
      throw Errors.notFound('Device not found');
    }

    return { revoked: true, deviceId };
  });

  // Toggle device trust status (PRD 4.2 Trusted Devices)
  app.patch('/api/v1/devices/:deviceId/trust', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = DeviceIdParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid deviceId');
    const body = z.object({ isTrusted: z.boolean() }).safeParse(request.body);
    if (!body.success) throw Errors.badRequest('Invalid trust payload');

    const res = await db.query(
      'UPDATE devices SET is_trusted = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
      [params.data.deviceId, auth.userId, body.data.isTrusted]
    );
    if (res.rowCount === 0) throw Errors.notFound('Device not found');

    await db.query(
      `INSERT INTO security_events (user_id, event_type, detail) VALUES ($1, 'device_trust_updated', $2::jsonb)`,
      [auth.userId, JSON.stringify({ deviceId: params.data.deviceId, isTrusted: body.data.isTrusted })]
    );
    return { updated: true, deviceId: params.data.deviceId, isTrusted: body.data.isTrusted };
  });

  app.get('/api/v1/security/events', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const res = await db.query<{
      id: string;
      event_type: string;
      detail: Record<string, unknown>;
      created_at: string | Date;
    }>(
      `
      SELECT id, event_type, detail, created_at
      FROM security_events
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [auth.userId]
    );

    return {
      events: res.rows.map((e) => ({
        id: e.id,
        eventType: e.event_type,
        detail: e.detail,
        createdAt: new Date(e.created_at).toISOString()
      }))
    };
  });
}
