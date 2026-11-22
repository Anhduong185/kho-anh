import crypto from 'node:crypto';
import { DEFAULT_USER_QUOTA_BYTES } from '@smb/shared';
import { describe, expect, it } from 'vitest';
import { applyMigrationFile } from './helpers/d1SqliteDouble.js';
import { createWorkerTestHarness } from './helpers/workerClient.js';

function sha256(buf: Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('Worker Auth, >10 GiB Quota, RBAC & PRD Isolation (F2 & F5)', () => {
  it('assigns DEFAULT_USER_QUOTA_BYTES (100 GiB > 10 GiB) and blocks privilege escalation on public register', async () => {
    const h = createWorkerTestHarness();

    // First user is bootstrap admin + user
    const regAdmin = await h.json<{
      user: { id: string; roles: string[]; quotaBytes: number };
      tokens: { accessToken: string; refreshToken: string };
      recoveryCodes: string[];
    }>('/api/v1/auth/register', {
      method: 'POST',
      bodyJson: {
        email: 'admin@example.com',
        password: 'AdminPassword!123',
        displayName: 'Bootstrap Admin',
        encryptionMode: 'server_side'
      }
    });
    expect(regAdmin.status).toBe(201);
    expect(regAdmin.data.user.roles).toEqual(['admin', 'user']);
    expect(regAdmin.data.user.quotaBytes).toBe(DEFAULT_USER_QUOTA_BYTES);
    expect(regAdmin.data.user.quotaBytes).toBeGreaterThan(10 * 1024 * 1024 * 1024);

    // Second user tries to inject role/roles/isAdmin/quotaBytes — strictly ignored!
    const regUser = await h.json<{
      user: { id: string; roles: string[]; quotaBytes: number };
      tokens: { accessToken: string; refreshToken: string };
    }>('/api/v1/auth/register', {
      method: 'POST',
      bodyJson: {
        email: 'attacker@example.com',
        password: 'UserPassword!123',
        displayName: 'Normal User',
        encryptionMode: 'server_side',
        role: 'admin',
        roles: ['admin', 'user'],
        isAdmin: true,
        quotaBytes: 9999999999999
      }
    });
    expect(regUser.status).toBe(201);
    expect(regUser.data.user.roles).toEqual(['user']);
    expect(regUser.data.user.quotaBytes).toBe(DEFAULT_USER_QUOTA_BYTES);
  });

  it('0002_storage_pool_and_quota.sql upgrades legacy 10 GiB users to 100 GiB, preserves custom quotas, and backfills media', async () => {
    const h = createWorkerTestHarness({}, { skipMigrations: true });
    applyMigrationFile(h.db, '0001_init.sql');

    const now = new Date().toISOString();
    // Seed 1 legacy user at 10 GiB and 1 custom-quota user at 50 GiB
    h.db.sqlite
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, encryption_mode, quota_bytes, used_bytes, is_active, is_admin, created_at, updated_at)
         VALUES (?, ?, ?, 'hash', 'server_side', ?, 128, 1, 0, ?, ?)`
      )
      .run('u-legacy', 'legacy@example.com', 'Legacy', 10737418240, now, now);
    h.db.sqlite
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, encryption_mode, quota_bytes, used_bytes, is_active, is_admin, created_at, updated_at)
         VALUES (?, ?, ?, 'hash', 'server_side', ?, 0, 1, 0, ?, ?)`
      )
      .run('u-custom', 'custom@example.com', 'Custom', 50 * 1024 * 1024 * 1024, now, now);
    h.db.sqlite
      .prepare(
        `INSERT INTO media_files (id, user_id, original_filename, mime_type, media_kind, size_bytes, sha256, encryption_mode, object_key, created_at, updated_at)
         VALUES ('m-1', 'u-legacy', 'old.jpg', 'image/jpeg', 'image', 128, 'abcd', 'server_side', 'tenants/u-legacy/originals/m-1.jpg', ?, ?)`
      )
      .run(now, now);

    applyMigrationFile(h.db, '0002_storage_pool_and_quota.sql');

    const legacyAfter = h.db.sqlite
      .prepare('SELECT quota_bytes FROM users WHERE id = ?')
      .get('u-legacy') as { quota_bytes: number };
    const customAfter = h.db.sqlite
      .prepare('SELECT quota_bytes FROM users WHERE id = ?')
      .get('u-custom') as { quota_bytes: number };
    const backfillObj = h.db.sqlite
      .prepare('SELECT id, object_key, primary_node_id FROM storage_objects WHERE media_id = ?')
      .get('m-1') as { id: string; object_key: string; primary_node_id: string | null };
    const backfillRep = h.db.sqlite
      .prepare('SELECT replica_slot, provider, state FROM replica_status WHERE storage_object_id = ?')
      .get(backfillObj.id) as { replica_slot: string; provider: string; state: string };

    expect(legacyAfter.quota_bytes).toBe(107374182400);
    expect(customAfter.quota_bytes).toBe(50 * 1024 * 1024 * 1024);
    expect(backfillObj.object_key).toBe('tenants/u-legacy/originals/m-1.jpg');
    expect(backfillObj.primary_node_id).toBeNull();
    expect(backfillRep).toEqual({
      replica_slot: 'copy1_primary',
      provider: 'cloudflare_r2',
      state: 'verified'
    });
  });

  it('enforces strict RBAC, Admin zero-access to User media/E2EE, and cross-tenant 404 isolation', async () => {
    const h = createWorkerTestHarness();

    const adminReg = await h.json<{
      user: { id: string };
      tokens: { accessToken: string };
    }>('/api/v1/auth/register', {
      method: 'POST',
      bodyJson: {
        email: 'admin@vault.local',
        password: 'AdminPassword!123',
        displayName: 'Admin',
        encryptionMode: 'server_side'
      }
    });
    const adminToken = adminReg.data.tokens.accessToken;
    const adminId = adminReg.data.user.id;

    const aliceReg = await h.json<{
      user: { id: string };
      device: { id: string };
      tokens: { accessToken: string; refreshToken: string };
      recoveryCodes: string[];
    }>('/api/v1/auth/register', {
      method: 'POST',
      bodyJson: {
        email: 'alice@vault.local',
        password: 'AlicePassword!123',
        displayName: 'Alice E2EE',
        encryptionMode: 'e2ee',
        e2eeKeySalt: 'YWxpY2Utc2FsdC12MQ==',
        e2eeEncryptedMasterKey: 'YWxpY2Utc3VwZXItc2VjcmV0LWJ1bmRsZQ==',
        e2eeKdfParams: { algorithm: 'PBKDF2', iterations: 600000 }
      }
    });
    const aliceToken = aliceReg.data.tokens.accessToken;
    const aliceId = aliceReg.data.user.id;
    const aliceDeviceId = aliceReg.data.device.id;

    const bobReg = await h.json<{
      user: { id: string };
      device: { id: string };
      tokens: { accessToken: string; refreshToken: string };
    }>('/api/v1/auth/register', {
      method: 'POST',
      bodyJson: {
        email: 'bob@vault.local',
        password: 'BobPassword!123',
        displayName: 'Bob',
        encryptionMode: 'server_side'
      }
    });
    const bobToken = bobReg.data.tokens.accessToken;
    const bobId = bobReg.data.user.id;
    const bobRefresh = bobReg.data.tokens.refreshToken;

    // 1. User calling Admin endpoints -> 403
    const adminRoutesForUser = [
      { method: 'GET', path: '/api/v1/admin/overview' },
      { method: 'GET', path: '/api/v1/admin/users' },
      { method: 'PATCH', path: `/api/v1/admin/users/${bobId}` },
      { method: 'GET', path: '/api/v1/admin/settings' },
      { method: 'PATCH', path: '/api/v1/admin/settings' },
      { method: 'GET', path: '/api/v1/admin/storage/pool' },
      { method: 'POST', path: '/api/v1/admin/storage/pool/nodes' },
      { method: 'POST', path: '/api/v1/admin/replication/run' },
      { method: 'POST', path: '/api/v1/admin/integrity/scan' },
      { method: 'GET', path: '/api/v1/admin/integrity/summary' }
    ];
    for (const ep of adminRoutesForUser) {
      const r = await h.json(ep.path, {
        method: ep.method,
        token: aliceToken,
        ...(ep.method === 'GET' ? {} : { bodyJson: {} })
      });
      expect(r.status, `${ep.method} ${ep.path}`).toBe(403);
    }

    // 2. Alice uploads a real photo and creates a folder + album
    const photoBytes = new TextEncoder().encode('ALICE_ORIGINAL_EXIF_BYTES_12345');
    const photoSha = sha256(photoBytes);
    const initRes = await h.json<{ sessionId: string }>('/api/v1/uploads/init', {
      method: 'POST',
      token: aliceToken,
      bodyJson: {
        originalFilename: 'alice-secret.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: photoBytes.length,
        sha256: photoSha,
        networkType: 'wifi'
      }
    });
    expect(initRes.status).toBe(201);
    const sessionId = initRes.data.sessionId;

    // Cross-tenant presign attempt by Admin -> 404
    const crossPresign = await h.json(`/api/v1/uploads/${sessionId}/parts/1/presign`, {
      method: 'POST',
      token: adminToken
    });
    expect(crossPresign.status).toBe(404);

    const putPart = await h.request(`/api/v1/uploads/${sessionId}/parts/1`, {
      method: 'PUT',
      token: aliceToken,
      headers: { 'X-Part-SHA256': photoSha },
      body: photoBytes
    });
    expect(putPart.status).toBe(200);

    const comp = await h.json<{ media: { id: string } }>(`/api/v1/uploads/${sessionId}/complete`, {
      method: 'POST',
      token: aliceToken
    });
    expect(comp.status).toBe(200);
    const aliceMediaId = comp.data.media.id;

    const folderRes = await h.json<{ folder: { id: string } }>('/api/v1/folders', {
      method: 'POST',
      token: aliceToken,
      bodyJson: { name: 'Private Folder' }
    });
    expect(folderRes.status).toBe(201);

    const albumRes = await h.json<{ album: { id: string } }>('/api/v1/albums', {
      method: 'POST',
      token: aliceToken,
      bodyJson: { name: 'Private Album', folderId: folderRes.data.folder.id }
    });
    expect(albumRes.status).toBe(201);

    // 3. Admin CANNOT access Alice's personal media, download, stream, verify, trash, folder, or album
    expect(
      (await h.request(`/api/v1/media/${aliceMediaId}/download`, { token: adminToken })).status
    ).toBe(404);
    expect(
      (await h.request(`/api/v1/media/${aliceMediaId}/stream`, { token: adminToken })).status
    ).toBe(404);
    expect(
      (await h.json(`/api/v1/media/${aliceMediaId}/download-url`, { token: adminToken })).status
    ).toBe(404);
    expect(
      (await h.json(`/api/v1/media/${aliceMediaId}/verify`, { token: adminToken })).status
    ).toBe(404);
    expect(
      (
        await h.json(`/api/v1/media/${aliceMediaId}/trash`, {
          method: 'POST',
          token: adminToken
        })
      ).status
    ).toBe(404);
    expect(
      (
        await h.json(`/api/v1/folders/${folderRes.data.folder.id}`, {
          method: 'DELETE',
          token: adminToken
        })
      ).status
    ).toBe(404);
    expect(
      (
        await h.json(`/api/v1/albums/${albumRes.data.album.id}`, {
          method: 'DELETE',
          token: adminToken
        })
      ).status
    ).toBe(404);
    expect(
      (
        await h.json('/api/v1/albums', {
          method: 'POST',
          token: bobToken,
          bodyJson: { name: 'Stolen Folder', folderId: folderRes.data.folder.id }
        })
      ).status
    ).toBe(404);

    // 4. GET /admin/users exposes zero password hashes, zero E2EE key material, zero media rows
    const adminUsers = await h.json<{ users: Array<{ id: string; quotaBytes: number }> }>(
      '/api/v1/admin/users',
      { token: adminToken }
    );
    expect(adminUsers.status).toBe(200);
    const raw = JSON.stringify(adminUsers.data);
    expect(raw).not.toContain('YWxpY2Utc3VwZXItc2VjcmV0LWJ1bmRsZQ==');
    expect(raw).not.toContain('YWxpY2Utc2FsdC12MQ==');
    expect(raw).not.toContain('e2eeKeySalt');
    expect(raw).not.toContain('e2eeKdfParams');
    expect(raw).not.toContain('e2eeEncryptedMasterKey');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('pbkdf2$');
    expect(raw).not.toContain('alice-secret.jpg');

    // 5. Cross-tenant device trust/revoke -> 404
    expect(
      (
        await h.json(`/api/v1/devices/${aliceDeviceId}/trust`, {
          method: 'PATCH',
          token: bobToken,
          bodyJson: { isTrusted: false }
        })
      ).status
    ).toBe(404);
    expect(
      (
        await h.json(`/api/v1/devices/${aliceDeviceId}`, {
          method: 'DELETE',
          token: bobToken
        })
      ).status
    ).toBe(404);

    // 6. PUT /users/me/e2ee-key roundtrip + server_side rejected
    expect(
      (
        await h.json('/api/v1/users/me/e2ee-key', {
          method: 'PUT',
          token: bobToken,
          bodyJson: {
            e2eeKeySalt: 'c2FsdC1iYXNlNjQ=',
            e2eeEncryptedMasterKey: 'bmV3LWVuY3J5cHRlZC1tYXN0ZXIta2V5',
            e2eeKdfParams: { iterations: 600000 }
          }
        })
      ).status
    ).toBe(400);

    const updE2ee = await h.json('/api/v1/users/me/e2ee-key', {
      method: 'PUT',
      token: aliceToken,
      bodyJson: {
        e2eeKeySalt: 'cm90YXRlZC1zYWx0LTE=',
        e2eeEncryptedMasterKey: 'cm90YXRlZC1lbmNyeXB0ZWQtbWFzdGVyLWtleS0x',
        e2eeKdfParams: { algorithm: 'PBKDF2', iterations: 650000 }
      }
    });
    expect(updE2ee.status).toBe(200);

    // Login returns updated e2eeKeyBundle
    const aliceLogin2 = await h.json<{
      tokens: { accessToken: string; refreshToken: string };
      e2eeKeyBundle: { encryptedMasterKey: string; keySalt: string };
    }>('/api/v1/auth/login', {
      method: 'POST',
      bodyJson: { email: 'alice@vault.local', password: 'AlicePassword!123' }
    });
    expect(aliceLogin2.status).toBe(200);
    expect(aliceLogin2.data.e2eeKeyBundle.encryptedMasterKey).toBe(
      'cm90YXRlZC1lbmNyeXB0ZWQtbWFzdGVyLWtleS0x'
    );

    // 7. PATCH /users/me/password revokes OTHER devices' refresh tokens
    const alicePassChange = await h.json('/api/v1/users/me/password', {
      method: 'PATCH',
      token: aliceLogin2.data.tokens.accessToken,
      bodyJson: { currentPassword: 'AlicePassword!123', newPassword: 'AliceNewPassword!999' }
    });
    expect(alicePassChange.status).toBe(200);

    const otherRefreshRes = await h.json('/api/v1/auth/refresh', {
      method: 'POST',
      bodyJson: { refreshToken: aliceReg.data.tokens.refreshToken }
    });
    expect(otherRefreshRes.status).toBe(401);

    const currentRefreshRes = await h.json('/api/v1/auth/refresh', {
      method: 'POST',
      bodyJson: { refreshToken: aliceLogin2.data.tokens.refreshToken }
    });
    expect(currentRefreshRes.status).toBe(200);

    // 8. Admin user PATCH guards (404, self-deactivation 400, last-admin 400, quota bounds 400, valid quota, deactivation revokes tokens & blocks recovery)
    expect(
      (
        await h.json('/api/v1/admin/users/00000000-0000-0000-0000-000000000000', {
          method: 'PATCH',
          token: adminToken,
          bodyJson: { isActive: false }
        })
      ).status
    ).toBe(404);
    expect(
      (
        await h.json(`/api/v1/admin/users/${adminId}`, {
          method: 'PATCH',
          token: adminToken,
          bodyJson: { isActive: false }
        })
      ).status
    ).toBe(400);
    expect(
      (
        await h.json(`/api/v1/admin/users/${adminId}`, {
          method: 'PATCH',
          token: adminToken,
          bodyJson: { isAdmin: false }
        })
      ).status
    ).toBe(400);
    expect(
      (
        await h.json(`/api/v1/admin/users/${aliceId}`, {
          method: 'PATCH',
          token: adminToken,
          bodyJson: { quotaBytes: -5 }
        })
      ).status
    ).toBe(400);

    // Valid quota update to 250 GiB
    const newQuota = 250 * 1024 * 1024 * 1024;
    const updQuota = await h.json(`/api/v1/admin/users/${aliceId}`, {
      method: 'PATCH',
      token: adminToken,
      bodyJson: { quotaBytes: newQuota }
    });
    expect(updQuota.status).toBe(200);
    const aliceMe = await h.json<{ user: { quotaBytes: number } }>('/api/v1/users/me', {
      token: aliceLogin2.data.tokens.accessToken
    });
    expect(aliceMe.data.user.quotaBytes).toBe(newQuota);

    // Deactivate Bob -> revokes Bob's refresh token & blocks /auth/recover
    const deactivateBob = await h.json(`/api/v1/admin/users/${bobId}`, {
      method: 'PATCH',
      token: adminToken,
      bodyJson: { isActive: false }
    });
    expect(deactivateBob.status).toBe(200);
    expect(
      (
        await h.json('/api/v1/auth/refresh', {
          method: 'POST',
          bodyJson: { refreshToken: bobRefresh }
        })
      ).status
    ).toBe(401);
    expect(
      (
        await h.json('/api/v1/auth/recover', {
          method: 'POST',
          bodyJson: {
            email: 'bob@vault.local',
            recoveryCode: 'AAAA-BBBB-CCCC',
            newPassword: 'ResetPassword!123'
          }
        })
      ).status
    ).toBe(401);
  });
});
