import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminOverview, AdminUserSummary, EncryptionMode, RoleName } from '@smb/shared';
import type { AppConfig } from '../../config/env.js';
import type { DbClient } from '../../db/client.js';
import { createAuthMiddleware, requireRole } from '../../middleware/auth.js';
import type { StorageRegistry } from '../../storage/registry.js';
import { Errors } from '../../utils/errors.js';
import { getSystemSettings, updateSystemSetting } from '../settings/service.js';

const UserIdParamSchema = z.object({
  userId: z.string().uuid()
});

const PatchAdminUserSchema = z.object({
  isActive: z.boolean().optional(),
  quotaBytes: z.number().int().positive().max(100 * 1024 * 1024 * 1024 * 1024).optional(),
  isAdmin: z.boolean().optional()
});

const PatchSettingsSchema = z.object({
  registration_enabled: z.boolean().optional(),
  trash_retention_days: z.number().int().min(1).max(3650).optional(),
  required_replicas: z.literal(2).optional()
});

/**
 * Admin Routes (PRD 1.2, 4.3):
 * Manages infrastructure, accounts, quotas, storage health, and system settings.
 * PRIVACY BOUNDARY: Intentionally provides ZERO access to user media files,
 * thumbnails, albums, tags, or E2EE keys.
 */
export function registerAdminRoutes(
  app: FastifyInstance,
  db: DbClient,
  config: AppConfig,
  storageRegistry: StorageRegistry
) {
  const authenticate = createAuthMiddleware(db, config);
  const adminGuards = [authenticate, requireRole('admin')];

  app.get('/api/v1/admin/overview', { preHandler: adminGuards }, async (): Promise<AdminOverview> => {
    const [userStats, deviceStats, mediaStats, storageTargets, settings] = await Promise.all([
      db.query<{
        total_users: string;
        active_users: string;
        total_used_bytes: string;
        total_quota_bytes: string;
      }>(`
        SELECT
          COUNT(*)::text AS total_users,
          COUNT(*) FILTER (WHERE is_active)::text AS active_users,
          COALESCE(SUM(used_bytes), 0)::text AS total_used_bytes,
          COALESCE(SUM(quota_bytes), 0)::text AS total_quota_bytes
        FROM users
      `),
      db.query<{ total_devices: string }>(
        'SELECT COUNT(*)::text AS total_devices FROM devices WHERE revoked_at IS NULL'
      ),
      db.query<{ total_media_files: string }>(
        'SELECT COUNT(*)::text AS total_media_files FROM media_files WHERE deleted_at IS NULL'
      ),
      storageRegistry.getHealthSummary(),
      getSystemSettings(db)
    ]);

    const u = userStats.rows[0]!;
    return {
      totalUsers: Number(u.total_users),
      activeUsers: Number(u.active_users),
      totalDevices: Number(deviceStats.rows[0]?.total_devices ?? '0'),
      totalMediaFiles: Number(mediaStats.rows[0]?.total_media_files ?? '0'),
      totalUsedBytes: Number(u.total_used_bytes),
      totalQuotaBytes: Number(u.total_quota_bytes),
      storageTargets,
      settings
    };
  });

  app.get('/api/v1/admin/users', { preHandler: adminGuards }, async () => {
    const res = await db.query<{
      id: string;
      email: string;
      display_name: string;
      encryption_mode: EncryptionMode;
      quota_bytes: string | number;
      used_bytes: string | number;
      is_active: boolean;
      created_at: string | Date;
      roles: RoleName[] | null;
      device_count: string;
      media_count: string;
    }>(`
      SELECT
        u.id,
        u.email,
        u.display_name,
        u.encryption_mode,
        u.quota_bytes,
        u.used_bytes,
        u.is_active,
        u.created_at,
        ARRAY(
          SELECT r.name
          FROM user_roles ur
          JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = u.id
          ORDER BY r.name ASC
        ) AS roles,
        (SELECT COUNT(*)::text FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS device_count,
        (SELECT COUNT(*)::text FROM media_files m WHERE m.user_id = u.id AND m.deleted_at IS NULL) AS media_count
      FROM users u
      ORDER BY u.created_at ASC
    `);

    const users: AdminUserSummary[] = res.rows.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      roles: row.roles ?? [],
      encryptionMode: row.encryption_mode,
      quotaBytes: Number(row.quota_bytes),
      usedBytes: Number(row.used_bytes),
      isActive: row.is_active,
      deviceCount: Number(row.device_count),
      mediaCount: Number(row.media_count),
      createdAt: new Date(row.created_at).toISOString()
    }));

    return { users };
  });

  app.patch('/api/v1/admin/users/:userId', { preHandler: adminGuards }, async (request) => {
    const auth = request.auth!;
    const params = UserIdParamSchema.safeParse(request.params);
    if (!params.success) {
      throw Errors.badRequest('Invalid userId');
    }
    const body = PatchAdminUserSchema.safeParse(request.body);
    if (!body.success) {
      throw Errors.badRequest('Invalid user update payload', body.error.flatten());
    }

    const { userId } = params.data;
    const { isActive, quotaBytes, isAdmin } = body.data;

    if (userId === auth.userId && isActive === false) {
      throw Errors.badRequest('Administrators cannot deactivate their own account');
    }

    await db.transaction(async (tx) => {
      const targetRes = await tx.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [userId]);
      if (targetRes.rowCount === 0) {
        throw Errors.notFound('User not found');
      }

      if (typeof isActive === 'boolean') {
        await tx.query('UPDATE users SET is_active = $2, updated_at = NOW() WHERE id = $1', [
          userId,
          isActive
        ]);
        if (!isActive) {
          await tx.query(
            'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
            [userId]
          );
        }
      }

      if (typeof quotaBytes === 'number') {
        await tx.query('UPDATE users SET quota_bytes = $2, updated_at = NOW() WHERE id = $1', [
          userId,
          quotaBytes
        ]);
      }

      if (typeof isAdmin === 'boolean') {
        if (!isAdmin) {
          const adminCountRes = await tx.query<{ count: string }>(`
            SELECT COUNT(*)::text AS count
            FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id
            JOIN users u ON u.id = ur.user_id
            WHERE r.name = 'admin' AND u.is_active = TRUE
          `);
          const activeAdmins = Number(adminCountRes.rows[0]?.count ?? '0');
          if (activeAdmins <= 1 && userId === auth.userId) {
            throw Errors.badRequest('Cannot remove admin role from the last active administrator');
          }
          await tx.query(
            `
            DELETE FROM user_roles
            WHERE user_id = $1 AND role_id = (SELECT id FROM roles WHERE name = 'admin')
            `,
            [userId]
          );
        } else {
          await tx.query(
            `
            INSERT INTO user_roles (user_id, role_id)
            SELECT $1, id FROM roles WHERE name = 'admin'
            ON CONFLICT DO NOTHING
            `,
            [userId]
          );
        }
      }
    });

    return { updated: true, userId };
  });

  app.get('/api/v1/admin/settings', { preHandler: adminGuards }, async () => {
    const settings = await getSystemSettings(db);
    return { settings };
  });

  app.patch('/api/v1/admin/settings', { preHandler: adminGuards }, async (request) => {
    const auth = request.auth!;
    const parsed = PatchSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.badRequest('Invalid settings payload', parsed.error.flatten());
    }

    await db.transaction(async (tx) => {
      for (const [key, value] of Object.entries(parsed.data)) {
        if (value !== undefined) {
          await updateSystemSetting(tx, key, value, auth.userId);
        }
      }
    });

    const settings = await getSystemSettings(db);
    return { settings };
  });
}
