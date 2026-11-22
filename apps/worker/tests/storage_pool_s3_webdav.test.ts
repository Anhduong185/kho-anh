import crypto from 'node:crypto';
import { DEFAULT_R2_FREE_CAPACITY_BYTES, DEFAULT_USER_QUOTA_BYTES } from '@smb/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptStorageSecret, encryptStorageSecret } from '../src/storage/crypto.js';
import {
  startTestS3Server,
  startTestWebDavServer,
  type TestS3ServerHandle,
  type TestWebDavServerHandle
} from './helpers/mockCloudServers.js';
import { applyMigrationFile } from './helpers/d1SqliteDouble.js';
import { createWorkerTestHarness } from './helpers/workerClient.js';

function sha256(buf: Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('Worker Multi-Cloud Storage Pool (R2 + Real SigV4 S3 + Real WebDAV)', () => {
  let s3Primary: TestS3ServerHandle;
  let s3Secondary: TestS3ServerHandle;
  let webdavPrimary: TestWebDavServerHandle;
  let webdavOffsite: TestWebDavServerHandle;

  beforeAll(async () => {
    [s3Primary, s3Secondary, webdavPrimary, webdavOffsite] = await Promise.all([
      startTestS3Server({ bucket: 'pool-s3-primary', region: 'us-east-1' }),
      startTestS3Server({ bucket: 'pool-s3-secondary', region: 'us-west-004' }),
      startTestWebDavServer({ basePath: 'pool-dav-primary', password: 'dav-pass-utf8-€1!' }),
      startTestWebDavServer({ basePath: 'pool-dav-offsite', password: 'dav-offsite-pass!' })
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      s3Primary.close(),
      s3Secondary.close(),
      webdavPrimary.close(),
      webdavOffsite.close()
    ]);
  });

  it('encrypts secrets with backend-compatible AES-256-GCM and falls back on legacy plaintext', async () => {
    const seed = 'worker-test-storage-config-key-32-chars!!';
    const encrypted = await encryptStorageSecret('my-super-secret-s3-key', seed);
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted.split(':')).toHaveLength(4);
    expect(await decryptStorageSecret(encrypted, seed)).toBe('my-super-secret-s3-key');
    expect(await decryptStorageSecret('legacy-plaintext-secret', seed)).toBe(
      'legacy-plaintext-secret'
    );

    // Cross-check compatibility with Node crypto AES-256-GCM (backend format)
    const key = crypto.createHash('sha256').update(`smb-storage-secret-v1:${seed}`).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update('backend-encrypted-secret', 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const backendWire = `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
    expect(await decryptStorageSecret(backendWire, seed)).toBe('backend-encrypted-secret');
  });

  it('tests real S3/WebDAV probes, rejects bad credentials & local provider, and aggregates >10 GiB pool capacity', async () => {
    const h = createWorkerTestHarness();
    const adminReg = await h.json<{ tokens: { accessToken: string } }>('/api/v1/auth/register', {
      method: 'POST',
      bodyJson: {
        email: 'pool-admin@example.com',
        password: 'AdminPassword!123',
        displayName: 'Pool Admin',
        encryptionMode: 'server_side'
      }
    });
    const adminToken = adminReg.data.tokens.accessToken;

    // 1. Default R2 node capacity is 10 GiB (real free tier), 10 presets returned (including google_drive)
    const initialPool = await h.json<{
      nodes: Array<{ id: string; capacityBytes: number; usedBytes: number }>;
      summary: { grandTotalCapacityBytes: number };
      presets: Array<{ provider: string }>;
    }>('/api/v1/admin/storage/pool', { token: adminToken });
    expect(initialPool.status).toBe(200);
    const r2Node = initialPool.data.nodes.find((n) => n.id === 'cf-r2-native')!;
    expect(r2Node.capacityBytes).toBe(DEFAULT_R2_FREE_CAPACITY_BYTES);
    expect(initialPool.data.presets.length).toBe(10);
    expect(initialPool.data.presets.some((p) => p.provider === 'google_drive')).toBe(true);
    expect(initialPool.data.presets.some((p) => p.provider === 'oracle_vm_minio')).toBe(true);

    // 2. Reject 'local' provider on Worker
    const localReject = await h.json('/api/v1/admin/storage/pool/nodes', {
      method: 'POST',
      token: adminToken,
      bodyJson: {
        name: 'Local Disk',
        slot: 'copy1_primary',
        provider: 'local',
        capacityBytes: 100 * 1024 * 1024 * 1024,
        localRoot: '/tmp/storage'
      }
    });
    expect(localReject.status).toBe(400);

    // 3. Draft probe fails on bad S3 secret (403 SignatureDoesNotMatch) & bad WebDAV password (401)
    const badS3Probe = await h.json<{ result: { ok: boolean; checks: { write: boolean } } }>(
      '/api/v1/admin/storage/pool/test',
      {
        method: 'POST',
        token: adminToken,
        bodyJson: {
          name: 'Bad S3',
          slot: 'copy1_primary',
          provider: 'minio',
          capacityBytes: 50 * 1024 * 1024 * 1024,
          endpoint: s3Primary.endpoint,
          region: s3Primary.region,
          bucket: s3Primary.bucket,
          accessKeyId: s3Primary.accessKeyId,
          secretAccessKey: 'WRONG_SECRET',
          forcePathStyle: true
        }
      }
    );
    expect(badS3Probe.status).toBe(200);
    expect(badS3Probe.data.result.ok).toBe(false);
    expect(badS3Probe.data.result.checks.write).toBe(false);

    const badDavProbe = await h.json<{ result: { ok: boolean } }>('/api/v1/admin/storage/pool/test', {
      method: 'POST',
      token: adminToken,
      bodyJson: {
        name: 'Bad WebDAV',
        slot: 'copy1_primary',
        provider: 'infinicloud_webdav',
        capacityBytes: 20 * 1024 * 1024 * 1024,
        endpoint: webdavPrimary.endpoint,
        bucket: webdavPrimary.basePath,
        accessKeyId: webdavPrimary.username,
        secretAccessKey: 'WRONG_DAV_PASS'
      }
    });
    expect(badDavProbe.status).toBe(200);
    expect(badDavProbe.data.result.ok).toBe(false);

    // 4. Draft probes PASS with real write/read-SHA256/delete against S3 & WebDAV
    const goodS3Probe = await h.json<{
      result: { ok: boolean; checks: { write: boolean; readVerify: boolean; delete: boolean } };
    }>('/api/v1/admin/storage/pool/test', {
      method: 'POST',
      token: adminToken,
      bodyJson: {
        name: 'Good S3',
        slot: 'copy1_primary',
        provider: 'minio',
        capacityBytes: 180 * 1024 * 1024 * 1024,
        endpoint: s3Primary.endpoint,
        region: s3Primary.region,
        bucket: s3Primary.bucket,
        accessKeyId: s3Primary.accessKeyId,
        secretAccessKey: s3Primary.secretAccessKey,
        forcePathStyle: true
      }
    });
    expect(goodS3Probe.data.result.ok).toBe(true);
    expect(goodS3Probe.data.result.checks).toEqual({ write: true, readVerify: true, delete: true });

    const goodDavProbe = await h.json<{
      result: { ok: boolean; checks: { write: boolean; readVerify: boolean; delete: boolean } };
    }>('/api/v1/admin/storage/pool/test', {
      method: 'POST',
      token: adminToken,
      bodyJson: {
        name: 'Good WebDAV',
        slot: 'copy1_primary',
        provider: 'infinicloud_webdav',
        capacityBytes: 20 * 1024 * 1024 * 1024,
        endpoint: webdavPrimary.endpoint,
        bucket: webdavPrimary.basePath,
        accessKeyId: webdavPrimary.username,
        secretAccessKey: webdavPrimary.password
      }
    });
    expect(goodDavProbe.data.result.ok).toBe(true);
    expect(goodDavProbe.data.result.checks).toEqual({ write: true, readVerify: true, delete: true });

    // 5. Create S3 node -> response must NOT leak secretAccessKey & D1 stores v1: encrypted secret
    const createS3 = await h.json<{
      node: { id: string; capacityBytes: number };
      summary: { grandTotalCapacityBytes: number };
    }>('/api/v1/admin/storage/pool/nodes', {
      method: 'POST',
      token: adminToken,
      bodyJson: {
        name: 'OCI MinIO 180G',
        slot: 'copy1_primary',
        provider: 'oracle_vm_minio',
        priority: 10,
        capacityBytes: 180 * 1024 * 1024 * 1024,
        endpoint: s3Primary.endpoint,
        region: s3Primary.region,
        bucket: s3Primary.bucket,
        accessKeyId: s3Primary.accessKeyId,
        secretAccessKey: s3Primary.secretAccessKey,
        forcePathStyle: true
      }
    });
    expect(createS3.status).toBe(201);
    expect(JSON.stringify(createS3.data)).not.toContain(s3Primary.secretAccessKey);
    expect(createS3.data.summary.grandTotalCapacityBytes).toBe(
      DEFAULT_R2_FREE_CAPACITY_BYTES + 180 * 1024 * 1024 * 1024
    );

    const dbSecretRow = h.db.sqlite
      .prepare('SELECT encrypted_secret_access_key FROM storage_nodes WHERE id = ?')
      .get(createS3.data.node.id) as { encrypted_secret_access_key: string };
    expect(dbSecretRow.encrypted_secret_access_key.startsWith('v1:')).toBe(true);

    // 6. Test saved node probe & disabled node excluded from active capacity
    const savedNodeTest = await h.json<{ result: { ok: boolean } }>(
      `/api/v1/admin/storage/pool/nodes/${createS3.data.node.id}/test`,
      { method: 'POST', token: adminToken }
    );
    expect(savedNodeTest.status).toBe(200);
    expect(savedNodeTest.data.result.ok).toBe(true);

    const disablePatch = await h.json<{
      node: { enabled: boolean };
      summary: { grandTotalCapacityBytes: number };
    }>(`/api/v1/admin/storage/pool/nodes/${createS3.data.node.id}`, {
      method: 'PATCH',
      token: adminToken,
      bodyJson: { enabled: false }
    });
    expect(disablePatch.status).toBe(200);
    expect(disablePatch.data.node.enabled).toBe(false);
    expect(disablePatch.data.summary.grandTotalCapacityBytes).toBe(DEFAULT_R2_FREE_CAPACITY_BYTES);

    // Admin overview reflects dynamic pool targets
    const overview = await h.json<{
      storageTargets: Array<{ slot: string; configured: boolean; healthy: boolean }>;
    }>('/api/v1/admin/overview', { token: adminToken });
    expect(overview.status).toBe(200);
    expect(overview.data.storageTargets[0]?.configured).toBe(true);
    expect(overview.data.storageTargets[0]?.healthy).toBe(true);
  });

  it('performs capacity-aware sharding across R2 -> S3 -> WebDAV (>5 MiB multipart), enforces 409 delete guard, and cleans up on trash delete', async () => {
    const h = createWorkerTestHarness();
    const reg = await h.json<{ tokens: { accessToken: string } }>('/api/v1/auth/register', {
      method: 'POST',
      bodyJson: {
        email: 'shard-admin@example.com',
        password: 'AdminPassword!123',
        displayName: 'Shard Admin',
        encryptionMode: 'server_side'
      }
    });
    const token = reg.data.tokens.accessToken;

    // Limit R2 native to 100 bytes so first 60-byte file goes to R2, second 60-byte file spills to S3
    await h.json('/api/v1/admin/storage/pool/nodes/cf-r2-native', {
      method: 'PATCH',
      token,
      bodyJson: { capacityBytes: 100 }
    });

    // Add S3 node with 100 bytes capacity (priority 10)
    const s3NodeRes = await h.json<{ node: { id: string } }>('/api/v1/admin/storage/pool/nodes', {
      method: 'POST',
      token,
      bodyJson: {
        name: 'S3 Spill Node',
        slot: 'copy1_primary',
        provider: 'backblaze_b2',
        priority: 10,
        capacityBytes: 100,
        endpoint: s3Primary.endpoint,
        region: s3Primary.region,
        bucket: s3Primary.bucket,
        accessKeyId: s3Primary.accessKeyId,
        secretAccessKey: s3Primary.secretAccessKey,
        forcePathStyle: true
      }
    });
    const s3NodeId = s3NodeRes.data.node.id;

    // Add WebDAV node with 50 MiB capacity (priority 20)
    const davNodeRes = await h.json<{ node: { id: string } }>('/api/v1/admin/storage/pool/nodes', {
      method: 'POST',
      token,
      bodyJson: {
        name: 'WebDAV Spill Node',
        slot: 'copy1_primary',
        provider: 'infinicloud_webdav',
        priority: 20,
        capacityBytes: 50 * 1024 * 1024,
        endpoint: webdavPrimary.endpoint,
        bucket: webdavPrimary.basePath,
        accessKeyId: webdavPrimary.username,
        secretAccessKey: webdavPrimary.password
      }
    });
    const davNodeId = davNodeRes.data.node.id;

    async function uploadFile(filename: string, bytes: Uint8Array, mimeType = 'image/jpeg') {
      const fileSha = sha256(bytes);
      const init = await h.json<{
        sessionId: string;
        chunkSizeBytes: number;
        totalParts: number;
      }>('/api/v1/uploads/init', {
        method: 'POST',
        token,
        bodyJson: {
          originalFilename: filename,
          mimeType,
          sizeBytes: bytes.length,
          sha256: fileSha,
          networkType: 'wifi'
        }
      });
      expect(init.status).toBe(201);
      const { sessionId, chunkSizeBytes, totalParts } = init.data;

      for (let part = 1; part <= totalParts; part++) {
        const start = (part - 1) * chunkSizeBytes;
        const end = Math.min(bytes.length, start + chunkSizeBytes);
        const slice = bytes.subarray(start, end);
        const bodyBuf = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer;
        const putRes = await h.request(`/api/v1/uploads/${sessionId}/parts/${part}`, {
          method: 'PUT',
          token,
          headers: { 'X-Part-SHA256': sha256(slice) },
          body: bodyBuf
        });
        expect(putRes.status).toBe(200);
      }

      const comp = await h.json<{
        media: {
          id: string;
          replicas: Array<{ provider: string; state: string }>;
        };
      }>(`/api/v1/uploads/${sessionId}/complete`, {
        method: 'POST',
        token
      });
      expect(comp.status).toBe(200);
      return comp.data.media;
    }

    // File 1 (60 bytes) -> R2
    const file1Bytes = crypto.randomBytes(60);
    const media1 = await uploadFile('r2-photo.jpg', file1Bytes);
    expect(media1.replicas[0]?.provider).toBe('cloudflare_r2');

    // File 2 (60 bytes) -> spills over to S3!
    const file2Bytes = crypto.randomBytes(60);
    const media2 = await uploadFile('ảnh tiếng việt.jpg', file2Bytes);
    expect(media2.replicas[0]?.provider).toBe('backblaze_b2');
    const media2KeyRow = h.db.sqlite
      .prepare('SELECT object_key, storage_node_id FROM media_files WHERE id = ?')
      .get(media2.id) as { object_key: string; storage_node_id: string };
    expect(media2KeyRow.storage_node_id).toBe(s3NodeId);
    expect(s3Primary.hasObject(media2KeyRow.object_key)).toBe(true);

    // File 3 (> 5 MiB multipart: 5 MiB + 128 KiB) -> spills over to WebDAV via R2 _staging/webdav/!
    const videoSize = 5 * 1024 * 1024 + 128 * 1024;
    const videoBytes = crypto.randomBytes(videoSize);
    const media3 = await uploadFile('big-video.mp4', videoBytes, 'video/mp4');
    expect(media3.replicas[0]?.provider).toBe('infinicloud_webdav');
    const media3KeyRow = h.db.sqlite
      .prepare('SELECT object_key, storage_node_id FROM media_files WHERE id = ?')
      .get(media3.id) as { object_key: string; storage_node_id: string };
    expect(media3KeyRow.storage_node_id).toBe(davNodeId);
    expect(webdavPrimary.hasObject(media3KeyRow.object_key)).toBe(true);
    // Staging parts cleaned up
    expect(h.r2.listAllKeys('_staging/webdav/')).toEqual([]);

    // Verify RFC 5987 download & SHA-256 on S3 file (with Vietnamese UTF-8 filename)
    const dl2 = await h.request(`/api/v1/media/${media2.id}/download`, { token });
    expect(dl2.status).toBe(200);
    expect(dl2.headers.get('content-disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent('ảnh tiếng việt.jpg')}`
    );
    const dl2Bytes = new Uint8Array(await dl2.arrayBuffer());
    expect(sha256(dl2Bytes)).toBe(sha256(file2Bytes));

    // Verify Range 206 & invalid Range 416 on WebDAV multipart video
    const rangeOk = await h.request(`/api/v1/media/${media3.id}/stream`, {
      token,
      headers: { Range: 'bytes=100-199' }
    });
    expect(rangeOk.status).toBe(206);
    expect(rangeOk.headers.get('content-range')).toBe(`bytes 100-199/${videoSize}`);
    const rangeBytes = new Uint8Array(await rangeOk.arrayBuffer());
    expect(Buffer.from(rangeBytes).equals(videoBytes.subarray(100, 200))).toBe(true);

    const rangeBad = await h.request(`/api/v1/media/${media3.id}/stream`, {
      token,
      headers: { Range: `bytes=${videoSize + 100}-${videoSize + 200}` }
    });
    expect(rangeBad.status).toBe(416);

    // Verify disabled node can STILL be read!
    await h.json(`/api/v1/admin/storage/pool/nodes/${s3NodeId}`, {
      method: 'PATCH',
      token,
      bodyJson: { enabled: false }
    });
    const dl2Disabled = await h.request(`/api/v1/media/${media2.id}/download`, { token });
    expect(dl2Disabled.status).toBe(200);
    expect(sha256(new Uint8Array(await dl2Disabled.arrayBuffer()))).toBe(sha256(file2Bytes));

    // Verify GET /media pagination, deviceId/state filters & real total
    const listPage = await h.json<{ items: Array<{ id: string }>; total: number; limit: number; offset: number }>(
      '/api/v1/media?limit=2&offset=0',
      { token }
    );
    expect(listPage.status).toBe(200);
    expect(listPage.data.total).toBe(3);
    expect(listPage.data.items).toHaveLength(2);

    const listStateFilter = await h.json<{ total: number }>(
      '/api/v1/media?state=insufficient_replicas',
      { token }
    );
    expect(listStateFilter.status).toBe(200);
    expect(listStateFilter.data.total).toBe(3);

    // Verify lossless export-zip across R2 + S3 + WebDAV + descendant folders
    const rootFolder = await h.json<{ folder: { id: string } }>('/api/v1/folders', {
      method: 'POST',
      token,
      bodyJson: { name: 'Root' }
    });
    const childFolder = await h.json<{ folder: { id: string } }>('/api/v1/folders', {
      method: 'POST',
      token,
      bodyJson: { name: 'Child', parentId: rootFolder.data.folder.id }
    });
    await h.json(`/api/v1/media/${media1.id}`, {
      method: 'PATCH',
      token,
      bodyJson: { folderId: rootFolder.data.folder.id }
    });
    await h.json(`/api/v1/media/${media2.id}`, {
      method: 'PATCH',
      token,
      bodyJson: { folderId: childFolder.data.folder.id }
    });
    const zipRes = await h.request('/api/v1/restore/export-zip', {
      method: 'POST',
      token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'folder', folderId: rootFolder.data.folder.id })
    });
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get('x-export-file-count')).toBe('2');
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    expect(zipBuf.includes(Buffer.from('Folders/Root/r2-photo.jpg'))).toBe(true);
    expect(zipBuf.includes(Buffer.from('Folders/Root/Child/'))).toBe(true);

    // 409 non-empty node delete guard while media2 lives on s3NodeId
    const delOccupied = await h.json(`/api/v1/admin/storage/pool/nodes/${s3NodeId}`, {
      method: 'DELETE',
      token
    });
    expect(delOccupied.status).toBe(409);

    // Trash + permanent delete media2 -> removes from S3, decrements storage_nodes.used_bytes -> allows node delete!
    expect(
      (await h.json(`/api/v1/media/${media2.id}/trash`, { method: 'POST', token })).status
    ).toBe(200);
    const permDel = await h.json<{ permanentlyDeleted: boolean; freedBytes: number }>(
      `/api/v1/trash/${media2.id}`,
      { method: 'DELETE', token }
    );
    expect(permDel.status).toBe(200);
    expect(permDel.data.freedBytes).toBe(60);
    expect(s3Primary.hasObject(media2KeyRow.object_key)).toBe(false);

    const s3AfterDel = h.db.sqlite
      .prepare('SELECT used_bytes FROM storage_nodes WHERE id = ?')
      .get(s3NodeId) as { used_bytes: number };
    expect(s3AfterDel.used_bytes).toBe(0);

    const delEmpty = await h.json<{ removed: boolean }>(
      `/api/v1/admin/storage/pool/nodes/${s3NodeId}`,
      { method: 'DELETE', token }
    );
    expect(delEmpty.status).toBe(200);
    expect(delEmpty.data.removed).toBe(true);
  });

  it('replicates from R2 to S3, rejects new Copy 3 nodes, heals bit-rot, and migrates slots', async () => {
    const h = createWorkerTestHarness();
    const reg = await h.json<{ tokens: { accessToken: string } }>('/api/v1/auth/register', {
      method: 'POST',
      bodyJson: {
        email: 'rep-admin@example.com',
        password: 'AdminPassword!123',
        displayName: 'Rep Admin',
        encryptionMode: 'server_side'
      }
    });
    const token = reg.data.tokens.accessToken;

    for (const count of [1, 3]) {
      const setRes = await h.json('/api/v1/admin/settings', {
        method: 'PATCH',
        token,
        bodyJson: { required_replicas: count }
      });
      expect(setRes.status).toBe(400);
    }

    // Add S3 secondary (Copy 2).
    const s3SecNode = await h.json<{ node: { id: string } }>('/api/v1/admin/storage/pool/nodes', {
      method: 'POST',
      token,
      bodyJson: {
        name: 'Copy 2 S3',
        slot: 'copy2_secondary',
        provider: 'backblaze_b2',
        capacityBytes: 100 * 1024 * 1024 * 1024,
        endpoint: s3Secondary.endpoint,
        region: s3Secondary.region,
        bucket: s3Secondary.bucket,
        accessKeyId: s3Secondary.accessKeyId,
        secretAccessKey: s3Secondary.secretAccessKey,
        forcePathStyle: true
      }
    });
    expect(s3SecNode.status).toBe(201);

    const davOffNode = await h.json<{ node: { id: string } }>('/api/v1/admin/storage/pool/nodes', {
      method: 'POST',
      token,
      bodyJson: {
        name: 'Copy 3 WebDAV',
        slot: 'copy3_offsite',
        provider: 'koofr_webdav',
        capacityBytes: 100 * 1024 * 1024 * 1024,
        endpoint: webdavOffsite.endpoint,
        bucket: webdavOffsite.basePath,
        accessKeyId: webdavOffsite.username,
        secretAccessKey: webdavOffsite.password
      }
    });
    expect(davOffNode.status).toBe(400);

    // Upload file to Copy 1 (R2) -> initially insufficient_replicas
    const payload = crypto.randomBytes(1024);
    const fileSha = sha256(payload);
    const init = await h.json<{ sessionId: string }>('/api/v1/uploads/init', {
      method: 'POST',
      token,
      bodyJson: {
        originalFilename: 'important.dng',
        mimeType: 'application/octet-stream',
        sizeBytes: payload.length,
        sha256: fileSha,
        networkType: 'wifi'
      }
    });
    await h.request(`/api/v1/uploads/${init.data.sessionId}/parts/1`, {
      method: 'PUT',
      token,
      headers: { 'X-Part-SHA256': fileSha },
      body: payload
    });
    const comp = await h.json<{
      media: { id: string; uploadState: string; verifiedReplicaCount: number };
    }>(`/api/v1/uploads/${init.data.sessionId}/complete`, { method: 'POST', token });
    expect(comp.data.media.uploadState).toBe('insufficient_replicas');
    expect(comp.data.media.verifiedReplicaCount).toBe(1);

    // Simulate a pre-upgrade upload marked safe with only Copy 1 and no Copy 2 row.
    h.db.sqlite.prepare("DELETE FROM replica_status WHERE replica_slot = 'copy2_secondary'").run();
    h.db.sqlite.prepare("UPDATE media_files SET upload_state = 'verified' WHERE id = ?").run(comp.data.media.id);
    applyMigrationFile(h.db, '0003_two_active_replicas.sql');
    expect(h.db.sqlite.prepare('SELECT upload_state FROM media_files WHERE id = ?').get(comp.data.media.id))
      .toMatchObject({ upload_state: 'insufficient_replicas' });

    const keyRow = h.db.sqlite
      .prepare('SELECT object_key FROM media_files WHERE id = ?')
      .get(comp.data.media.id) as { object_key: string };

    // Replicate to S3 (Copy 2) and promote uploadState to 'verified'.
    const repRun = await h.json<{
      result: { replicatedCopies: number; promotedToVerified: number; failures: unknown[] };
    }>('/api/v1/admin/replication/run', { method: 'POST', token });
    expect(repRun.status).toBe(200);
    expect(repRun.data.result.replicatedCopies).toBe(1);
    expect(repRun.data.result.promotedToVerified).toBe(1);
    expect(repRun.data.result.failures).toEqual([]);

    expect(s3Secondary.hasObject(keyRow.object_key)).toBe(true);
    expect(webdavOffsite.hasObject(keyRow.object_key)).toBe(false);

    const summary = await h.json<{
      replicaBreakdown: Array<{ slot: string; state: string; count: number }>;
    }>('/api/v1/admin/integrity/summary', { token });
    expect(summary.data.replicaBreakdown).toEqual([
      { slot: 'copy1_primary', state: 'verified', count: 1 },
      { slot: 'copy2_secondary', state: 'verified', count: 1 }
    ]);

    // Simulate silent bit-rot on Copy 2 S3!
    s3Secondary.corruptObject(keyRow.object_key, Buffer.from('CORRUPTED_BIT_ROT_BYTES'));

    const scanRes = await h.json<{
      result: {
        scannedReplicas: number;
        corruptedDetected: number;
        healedReplicas: number;
        unrecoverable: unknown[];
      };
    }>('/api/v1/admin/integrity/scan', { method: 'POST', token });
    expect(scanRes.status).toBe(200);
    expect(scanRes.data.result.scannedReplicas).toBe(2);
    expect(scanRes.data.result.corruptedDetected).toBe(1);
    expect(scanRes.data.result.healedReplicas).toBe(1);
    expect(scanRes.data.result.unrecoverable).toEqual([]);
    expect(sha256(s3Secondary.getObjectBytes(keyRow.object_key)!)).toBe(fileSha);

    // Storage migration endpoint: migrate copy1_primary -> copy2_secondary (already verified -> skippedAlreadyVerified)
    const migRes = await h.json<{
      result: { skippedAlreadyVerified: number; failedCount: number };
    }>('/api/v1/admin/storage/migrate', {
      method: 'POST',
      token,
      bodyJson: { sourceSlot: 'copy1_primary', targetSlot: 'copy2_secondary' }
    });
    expect(migRes.status).toBe(200);
    expect(migRes.data.result.skippedAlreadyVerified).toBe(1);
    expect(migRes.data.result.failedCount).toBe(0);
  });
});
