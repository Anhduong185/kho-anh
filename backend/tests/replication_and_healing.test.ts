import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { LocalDiskStorageAdapter } from '../src/storage/local-adapter.js';
import { sha256Hex } from '../src/utils/crypto.js';

describe('Phase 6: Two-Replica Replication, Bit-Rot Detection & Automatic Self-Healing', () => {
  let ctx: BuiltApp;
  let root1: string;
  let root2: string;
  let root3: string;
  let copy2Adapter: LocalDiskStorageAdapter;
  let copy3Adapter: LocalDiskStorageAdapter;
  let adminToken: string;

  beforeAll(async () => {
    root1 = await fs.mkdtemp(path.join(os.tmpdir(), 'smb-copy1-'));
    root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'smb-copy2-'));
    root3 = await fs.mkdtemp(path.join(os.tmpdir(), 'smb-copy3-'));

    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      STORAGE_PRIMARY_TYPE: 'local',
      STORAGE_LOCAL_ROOT: root1,
      JWT_ACCESS_SECRET: 'test-access-secret-must-be-at-least-32-chars',
      JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-at-least-32-chars'
    });
    ctx = await buildApp({ config, enableLogger: false });

    // Keep a legacy Copy 3 adapter configured to verify new uploads leave it untouched.
    copy2Adapter = new LocalDiskStorageAdapter(root2, 'copy2-secondary');
    copy3Adapter = new LocalDiskStorageAdapter(root3, 'copy3-offsite');
    ctx.storageRegistry.registerAdapter('copy2_secondary', copy2Adapter);
    ctx.storageRegistry.registerAdapter('copy3_offsite', copy3Adapter);

    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'admin-ops@vault.local',
        password: 'AdminPassword!123',
        displayName: 'Ops Admin',
        encryptionMode: 'server_side'
      }
    });
    adminToken = reg.json().tokens.accessToken;
  });

  afterAll(async () => {
    await ctx.app.close();
    await Promise.all([
      fs.rm(root1, { recursive: true, force: true }),
      fs.rm(root2, { recursive: true, force: true }),
      fs.rm(root3, { recursive: true, force: true })
    ]);
  });

  it('writes only Copy 1 and Copy 2, then repairs either from the other', async () => {
    const originalBytes = crypto.randomBytes(45_000);
    const originalSha = sha256Hex(originalBytes);

    // Upload file -> Copy 1 verified, Copy 2 pending.
    const init = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads/init',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        originalFilename: 'family_heirloom.dng',
        mimeType: 'image/x-adobe-dng',
        sizeBytes: originalBytes.length,
        sha256: originalSha,
        networkType: 'wifi',
        chunkSizeBytes: 64 * 1024
      }
    });
    const { sessionId } = init.json();
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${sessionId}/parts/1`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/octet-stream' },
      payload: originalBytes
    });
    const complete = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${sessionId}/complete`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(complete.json().media.uploadState).toBe('insufficient_replicas');
    expect(complete.json().media.verifiedReplicaCount).toBe(1);

    // Replicate only to Copy 2 even when a legacy Copy 3 adapter is configured.
    const repRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/replication/run',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(repRes.statusCode).toBe(200);
    expect(repRes.json().result.replicatedCopies).toBe(1);
    expect(repRes.json().result.promotedToVerified).toBe(1);
    expect(repRes.json().result.failures).toEqual([]);

    const mediaAfterRep = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/media',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(mediaAfterRep.json().items[0].uploadState).toBe('verified');
    expect(mediaAfterRep.json().items[0].verifiedReplicaCount).toBe(2);

    const objRes = await ctx.db.query<{ object_key: string }>(
      "SELECT object_key FROM storage_objects WHERE object_kind = 'original' LIMIT 1"
    );
    const objectKey = objRes.rows[0]!.object_key;
    const primary = ctx.storageRegistry.getPrimary();

    for (const damaged of [copy2Adapter, primary]) {
      await damaged.putObject({ key: objectKey, body: Buffer.from('CORRUPTED-BYTES') });
      const scanRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/integrity/scan',
        headers: { authorization: `Bearer ${adminToken}` }
      });
      expect(scanRes.statusCode).toBe(200);
      expect(scanRes.json().result).toMatchObject({
        scannedReplicas: 2,
        healthyReplicas: 1,
        corruptedDetected: 1,
        missingDetected: 0,
        healedReplicas: 1,
        unrecoverable: []
      });
      expect(await damaged.getObject(objectKey)).toEqual(originalBytes);
    }
    expect(await copy3Adapter.headObject(objectKey)).toBeNull();
  });
});
