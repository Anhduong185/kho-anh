import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { sha256Hex } from '../src/utils/crypto.js';

describe('Cloud Storage Integration: Dynamic Multi-Cloud Config, Encrypted Secrets, Probe & Migration', () => {
  let ctx: BuiltApp;
  let root1: string;
  let root2: string;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    root1 = await fs.mkdtemp(path.join(os.tmpdir(), 'smb-cloud-c1-'));
    root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'smb-cloud-c2-'));

    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      STORAGE_PRIMARY_TYPE: 'local',
      STORAGE_LOCAL_ROOT: root1,
      STORAGE_CONFIG_KEY: 'test-storage-secret-encryption-key-32chars',
      JWT_ACCESS_SECRET: 'test-access-secret-must-be-at-least-32-chars',
      JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-at-least-32-chars'
    });
    ctx = await buildApp({ config, enableLogger: false });

    const adminReg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'cloud-admin@vault.local',
        password: 'AdminPassword!123',
        displayName: 'Cloud Admin',
        encryptionMode: 'server_side'
      }
    });
    adminToken = adminReg.json().tokens.accessToken;

    const userReg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'regular@vault.local',
        password: 'UserPassword!123',
        displayName: 'Regular User',
        encryptionMode: 'server_side'
      }
    });
    userToken = userReg.json().tokens.accessToken;
  });

  afterAll(async () => {
    await ctx.app.close();
    await Promise.all([
      fs.rm(root1, { recursive: true, force: true }),
      fs.rm(root2, { recursive: true, force: true })
    ]);
  });

  it('blocks non-admin access, encrypts S3 secret at rest, hot-reloads targets, runs live probe & migrates objects with SHA-256 verification', async () => {
    // Non-admin cannot view or edit cloud storage targets
    const userBlocked = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/storage/targets',
      headers: { authorization: `Bearer ${userToken}` }
    });
    expect(userBlocked.statusCode).toBe(403);

    // Admin fetches presets & current targets
    const list1 = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/storage/targets',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(list1.statusCode).toBe(200);
    expect(list1.json().presets.some((p: { provider: string }) => p.provider === 'cloudflare_r2')).toBe(true);
    expect(list1.json().presets.some((p: { provider: string }) => p.provider === 'backblaze_b2')).toBe(true);
    expect(list1.json().presets.some((p: { provider: string }) => p.provider === 'oracle_oci')).toBe(true);

    // Save an S3 cloud config (Backblaze B2) to copy3_offsite -> verify secret is AES-256-GCM encrypted in DB & NEVER leaked in API!
    const rawSecret = 'B2_SUPER_SECRET_APP_KEY_XYZ987654321';
    const saveB2 = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/storage/targets/copy3_offsite',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        provider: 'backblaze_b2',
        enabled: true,
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        region: 'us-west-004',
        bucket: 'vault-copy3-demo',
        accessKeyId: '004a1b2c3d4e5f60000000001',
        secretAccessKey: rawSecret,
        forcePathStyle: true
      }
    });
    expect(saveB2.statusCode).toBe(200);
    expect(JSON.stringify(saveB2.json())).not.toContain(rawSecret);
    expect(saveB2.json().target.hasSecretKey).toBe(true);
    expect(saveB2.json().target.accessKeyIdPreview).toBe('004a••••0001');

    // Verify encrypted column in DB does NOT contain plaintext secret
    const dbRow = await ctx.db.query<{ encrypted_secret_access_key: string }>(
      "SELECT encrypted_secret_access_key FROM storage_targets WHERE slot = 'copy3_offsite'"
    );
    expect(dbRow.rows[0]!.encrypted_secret_access_key.startsWith('v1:')).toBe(true);
    expect(dbRow.rows[0]!.encrypted_secret_access_key).not.toContain(rawSecret);

    // Test & hot-reload Copy 2 with independent disk root2 (simulating live storage target)
    const preProbe = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/storage/targets/copy2_secondary/test',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        provider: 'local',
        enabled: true,
        bucket: 'copy2-backup',
        localRoot: root2
      }
    });
    expect(preProbe.statusCode).toBe(200);
    expect(preProbe.json().result.ok).toBe(true);
    expect(preProbe.json().result.checks).toEqual({ write: true, readVerify: true, delete: true });

    const saveCopy2 = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/storage/targets/copy2_secondary',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        provider: 'local',
        enabled: true,
        bucket: 'copy2-backup',
        localRoot: root2
      }
    });
    expect(saveCopy2.statusCode).toBe(200);
    expect(saveCopy2.json().target.configured).toBe(true);

    // Upload a file to Copy 1, check presign + download-url, then run Provider Migration Copy 1 -> Copy 2!
    const bytes = crypto.randomBytes(24_000);
    const sha = sha256Hex(bytes);

    const init = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads/init',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        originalFilename: 'cloud_migration_test.heic',
        mimeType: 'image/heic',
        sizeBytes: bytes.length,
        sha256: sha,
        networkType: 'wifi',
        chunkSizeBytes: 64 * 1024
      }
    });
    const { sessionId } = init.json();

    // Presign endpoint responds cleanly with api_chunk when primary is local disk
    const presignRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${sessionId}/parts/1/presign`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(presignRes.statusCode).toBe(200);
    expect(presignRes.json().mode).toBe('api_chunk');

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${sessionId}/parts/1`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/octet-stream' },
      payload: bytes
    });
    const completed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${sessionId}/complete`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    const mediaId = completed.json().media.id as string;

    const dlUrlRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaId}/download-url`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(dlUrlRes.statusCode).toBe(200);
    expect(dlUrlRes.json().expectedSha256).toBe(sha);

    // Run Provider Migration from copy1_primary -> copy2_secondary
    const migrateRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/storage/migrate',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        sourceSlot: 'copy1_primary',
        targetSlot: 'copy2_secondary'
      }
    });
    expect(migrateRes.statusCode).toBe(200);
    expect(migrateRes.json().result.migratedCount).toBe(1);
    expect(migrateRes.json().result.failedCount).toBe(0);

    // Re-running migration skips already-verified copy cleanly
    const migrateAgain = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/storage/migrate',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        sourceSlot: 'copy1_primary',
        targetSlot: 'copy2_secondary'
      }
    });
    expect(migrateAgain.json().result.skippedAlreadyVerified).toBe(1);
    expect(migrateAgain.json().result.migratedCount).toBe(0);

    // Cleanly remove copy3_offsite
    const delOffsite = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/storage/targets/copy3_offsite',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(delOffsite.statusCode).toBe(200);
  });
});
