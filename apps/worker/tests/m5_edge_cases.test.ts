import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startTestS3Server,
  type TestS3ServerHandle
} from './helpers/mockCloudServers.js';
import { createWorkerTestHarness } from './helpers/workerClient.js';

function sha256(buf: Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('Worker M5 Edge-Case Fixes', () => {
  let s3Copy2: TestS3ServerHandle;

  beforeAll(async () => {
    s3Copy2 = await startTestS3Server({ bucket: 'm5-s3-copy2', region: 'us-east-1' });
  });

  afterAll(async () => {
    await s3Copy2.close();
  });

  it('does not double-count used_bytes when re-migrating a damaged replica to the same node', async () => {
    const h = createWorkerTestHarness();
    const reg = await h.json<{ tokens: { accessToken: string } }>('/api/v1/auth/register', {
      method: 'POST',
      bodyJson: {
        email: 'migrate-admin@example.com',
        password: 'AdminPassword!123',
        displayName: 'Migrate Admin',
        encryptionMode: 'server_side'
      }
    });
    const token = reg.data.tokens.accessToken;

    const addNode = await h.json<{ node: { id: string } }>('/api/v1/admin/storage/pool/nodes', {
      method: 'POST',
      token,
      bodyJson: {
        name: 'Copy 2 S3',
        slot: 'copy2_secondary',
        provider: 'backblaze_b2',
        capacityBytes: 50 * 1024 * 1024 * 1024,
        endpoint: s3Copy2.endpoint,
        region: s3Copy2.region,
        bucket: s3Copy2.bucket,
        accessKeyId: s3Copy2.accessKeyId,
        secretAccessKey: s3Copy2.secretAccessKey,
        forcePathStyle: true
      }
    });
    expect(addNode.status).toBe(201);
    const nodeId = addNode.data.node.id;

    const payload = crypto.randomBytes(512);
    const fileSha = sha256(payload);
    const init = await h.json<{ sessionId: string }>('/api/v1/uploads/init', {
      method: 'POST',
      token,
      bodyJson: {
        originalFilename: 'migrate-test.jpg',
        mimeType: 'image/jpeg',
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
    const comp = await h.json<{ media: { id: string } }>(
      `/api/v1/uploads/${init.data.sessionId}/complete`,
      { method: 'POST', token }
    );
    expect(comp.status).toBe(200);

    // First replication populates copy2_secondary on nodeId
    const rep = await h.json<{ result: { replicatedCopies: number } }>('/api/v1/admin/replication/run', {
      method: 'POST',
      token
    });
    expect(rep.data.result.replicatedCopies).toBe(1);

    const nodeBefore = h.db.sqlite
      .prepare('SELECT used_bytes FROM storage_nodes WHERE id = ?')
      .get(nodeId) as { used_bytes: number };
    expect(nodeBefore.used_bytes).toBe(payload.length);

    // Corrupt copy2_secondary object on S3 so migrate must re-upload to the same nodeId
    const keyRow = h.db.sqlite
      .prepare('SELECT object_key FROM media_files WHERE id = ?')
      .get(comp.data.media.id) as { object_key: string };
    s3Copy2.corruptObject(keyRow.object_key, Buffer.from('corrupt-data'));

    const mig = await h.json<{
      result: { migratedCount: number; skippedAlreadyVerified: number; failedCount: number };
    }>('/api/v1/admin/storage/migrate', {
      method: 'POST',
      token,
      bodyJson: { sourceSlot: 'copy1_primary', targetSlot: 'copy2_secondary' }
    });
    expect(mig.status).toBe(200);
    expect(mig.data.result.migratedCount).toBe(1);
    expect(mig.data.result.failedCount).toBe(0);

    const nodeAfter = h.db.sqlite
      .prepare('SELECT used_bytes FROM storage_nodes WHERE id = ?')
      .get(nodeId) as { used_bytes: number };
    expect(nodeAfter.used_bytes).toBe(payload.length);
  });

  it('leaves replica_status.storage_node_id unset when replication fails so the node can still be deleted', async () => {
    const h = createWorkerTestHarness();
    const reg = await h.json<{ tokens: { accessToken: string } }>('/api/v1/auth/register', {
      method: 'POST',
      bodyJson: {
        email: 'repfail-admin@example.com',
        password: 'AdminPassword!123',
        displayName: 'RepFail Admin',
        encryptionMode: 'server_side'
      }
    });
    const token = reg.data.tokens.accessToken;

    // Upload a file to primary R2
    const payload = crypto.randomBytes(256);
    const fileSha = sha256(payload);
    const init = await h.json<{ sessionId: string }>('/api/v1/uploads/init', {
      method: 'POST',
      token,
      bodyJson: {
        originalFilename: 'fail-rep.jpg',
        mimeType: 'image/jpeg',
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
    const comp = await h.json<{ media: { id: string } }>(
      `/api/v1/uploads/${init.data.sessionId}/complete`,
      { method: 'POST', token }
    );
    expect(comp.status).toBe(200);

    // Add a Copy 2 node with invalid credentials so replication fails on put()
    const badNode = await h.json<{ node: { id: string } }>('/api/v1/admin/storage/pool/nodes', {
      method: 'POST',
      token,
      bodyJson: {
        name: 'Broken Copy 2 S3',
        slot: 'copy2_secondary',
        provider: 'backblaze_b2',
        capacityBytes: 50 * 1024 * 1024 * 1024,
        endpoint: s3Copy2.endpoint,
        region: s3Copy2.region,
        bucket: s3Copy2.bucket,
        accessKeyId: s3Copy2.accessKeyId,
        secretAccessKey: 'WRONG_SECRET_FOR_FAIL_TEST',
        forcePathStyle: true
      }
    });
    expect(badNode.status).toBe(201);
    const badNodeId = badNode.data.node.id;

    const rep = await h.json<{
      result: { replicatedCopies: number; failures: Array<{ slot: string }> };
    }>('/api/v1/admin/replication/run', { method: 'POST', token });
    expect(rep.status).toBe(200);
    expect(rep.data.result.replicatedCopies).toBe(0);
    expect(rep.data.result.failures).toHaveLength(1);

    const rsRow = h.db.sqlite
      .prepare("SELECT state, storage_node_id FROM replica_status WHERE replica_slot = 'copy2_secondary'")
      .get() as { state: string; storage_node_id: string | null };
    expect(rsRow.state).toBe('missing');
    expect(rsRow.storage_node_id).toBeNull();

    // Because storage_node_id was not orphaned on failure, deleting the empty node succeeds (not 409)
    const delNode = await h.json<{ removed: boolean }>(
      `/api/v1/admin/storage/pool/nodes/${badNodeId}`,
      { method: 'DELETE', token }
    );
    expect(delNode.status).toBe(200);
    expect(delNode.data.removed).toBe(true);
  });

  it('skips used_bytes decrement on trash delete for missing replicas', async () => {
    const h = createWorkerTestHarness();
    const reg = await h.json<{ tokens: { accessToken: string } }>('/api/v1/auth/register', {
      method: 'POST',
      bodyJson: {
        email: 'trash-user@example.com',
        password: 'AdminPassword!123',
        displayName: 'Trash User',
        encryptionMode: 'server_side'
      }
    });
    const token = reg.data.tokens.accessToken;

    const addNode = await h.json<{ node: { id: string } }>('/api/v1/admin/storage/pool/nodes', {
      method: 'POST',
      token,
      bodyJson: {
        name: 'Copy 2 S3',
        slot: 'copy2_secondary',
        provider: 'backblaze_b2',
        capacityBytes: 50 * 1024 * 1024 * 1024,
        endpoint: s3Copy2.endpoint,
        region: s3Copy2.region,
        bucket: s3Copy2.bucket,
        accessKeyId: s3Copy2.accessKeyId,
        secretAccessKey: s3Copy2.secretAccessKey,
        forcePathStyle: true
      }
    });
    const copy2NodeId = addNode.data.node.id;

    // Seed an independent used_bytes baseline on copy2NodeId (e.g. from another file = 1000)
    h.db.sqlite
      .prepare('UPDATE storage_nodes SET used_bytes = 1000 WHERE id = ?')
      .run(copy2NodeId);

    const payload = crypto.randomBytes(300);
    const fileSha = sha256(payload);
    const init = await h.json<{ sessionId: string }>('/api/v1/uploads/init', {
      method: 'POST',
      token,
      bodyJson: {
        originalFilename: 'trash-missing-replica.jpg',
        mimeType: 'image/jpeg',
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
    const comp = await h.json<{ media: { id: string } }>(
      `/api/v1/uploads/${init.data.sessionId}/complete`,
      { method: 'POST', token }
    );

    // Attach copy2NodeId to replica_status with state='missing' (simulating unstored/missing replica)
    h.db.sqlite
      .prepare(
        `UPDATE replica_status
         SET storage_node_id = ?, state = 'missing'
         WHERE replica_slot = 'copy2_secondary'`
      )
      .run(copy2NodeId);

    // Soft-delete to trash then permanently delete
    const softDel = await h.json(`/api/v1/media/${comp.data.media.id}/trash`, {
      method: 'POST',
      token
    });
    expect(softDel.status).toBe(200);

    const permDel = await h.json<{ permanentlyDeleted: boolean }>(
      `/api/v1/trash/${comp.data.media.id}`,
      { method: 'DELETE', token }
    );
    expect(permDel.status).toBe(200);
    expect(permDel.data.permanentlyDeleted).toBe(true);

    // copy2NodeId used_bytes must remain 1000 (not decremented by 300 for missing replica)
    const nodeRow = h.db.sqlite
      .prepare('SELECT used_bytes FROM storage_nodes WHERE id = ?')
      .get(copy2NodeId) as { used_bytes: number };
    expect(nodeRow.used_bytes).toBe(1000);
  });

  it("returns 416 for malformed Range headers (bytes=- and bytes=0-1-2) and encodes !'()* in Content-Disposition", async () => {
    const h = createWorkerTestHarness();
    const reg = await h.json<{ tokens: { accessToken: string } }>('/api/v1/auth/register', {
      method: 'POST',
      bodyJson: {
        email: 'media-user@example.com',
        password: 'AdminPassword!123',
        displayName: 'Media User',
        encryptionMode: 'server_side'
      }
    });
    const token = reg.data.tokens.accessToken;

    const payload = Buffer.from('0123456789abcdef');
    const fileSha = sha256(payload);
    const filename = "Ảnh (test)!*'1.jpg";
    const init = await h.json<{ sessionId: string }>('/api/v1/uploads/init', {
      method: 'POST',
      token,
      bodyJson: {
        originalFilename: filename,
        mimeType: 'image/jpeg',
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
    const comp = await h.json<{ media: { id: string } }>(
      `/api/v1/uploads/${init.data.sessionId}/complete`,
      { method: 'POST', token }
    );
    const mediaId = comp.data.media.id;

    // Malformed Range: bytes=- -> 416
    const badRangeDash = await h.request(`/api/v1/media/${mediaId}/stream`, {
      token,
      headers: { Range: 'bytes=-' }
    });
    expect(badRangeDash.status).toBe(416);

    // Malformed Range: bytes=0-1-2 -> 416
    const badRangeMulti = await h.request(`/api/v1/media/${mediaId}/stream`, {
      token,
      headers: { Range: 'bytes=0-1-2' }
    });
    expect(badRangeMulti.status).toBe(416);

    // Valid Range: bytes=0-3 -> 206
    const okRange = await h.request(`/api/v1/media/${mediaId}/stream`, {
      token,
      headers: { Range: 'bytes=0-3' }
    });
    expect(okRange.status).toBe(206);
    expect(await okRange.text()).toBe('0123');

    // RFC 5987 encoding of !'()* in Content-Disposition filename*
    const dl = await h.request(`/api/v1/media/${mediaId}/download`, { token });
    expect(dl.status).toBe(200);
    const cd = dl.headers.get('Content-Disposition') ?? '';
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toContain('%28test%29%21%2A%271.jpg');
  });
});
