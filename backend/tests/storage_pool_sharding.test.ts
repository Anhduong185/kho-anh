import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { sha256Hex } from '../src/utils/crypto.js';

/** Minimal real HTTP WebDAV server for end-to-end WebDavStorageAdapter verification */
function createMockWebDavServer(expectedAuth: string) {
  const store = new Map<string, Buffer>();
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    const reqPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    if (req.method === 'MKCOL') {
      res.writeHead(201);
      res.end();
      return;
    }
    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end('<multistatus/>');
      return;
    }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const data = Buffer.concat(chunks);
      store.set(reqPath, data);
      res.writeHead(201, { ETag: `"${sha256Hex(data)}"` });
      res.end();
      return;
    }
    if (req.method === 'GET') {
      const data = store.get(reqPath);
      if (!data) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Length': String(data.length), ETag: `"${sha256Hex(data)}"` });
      res.end(data);
      return;
    }
    if (req.method === 'HEAD') {
      const data = store.get(reqPath);
      if (!data) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Length': String(data.length), ETag: `"${sha256Hex(data)}"` });
      res.end();
      return;
    }
    if (req.method === 'DELETE') {
      store.delete(reqPath);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });

  return { server, store };
}

async function uploadOne(ctx: BuiltApp, token: string, filename: string, content: Buffer) {
  const sha = sha256Hex(content);
  const init = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/uploads/init',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      originalFilename: filename,
      mimeType: 'image/jpeg',
      sizeBytes: content.length,
      sha256: sha,
      networkType: 'wifi',
      chunkSizeBytes: 64 * 1024
    }
  });
  expect(init.statusCode).toBe(201);
  const { sessionId } = init.json();

  const up = await ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${sessionId}/parts/1`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    payload: content
  });
  expect(up.statusCode).toBe(200);

  const comp = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${sessionId}/complete`,
    headers: { authorization: `Bearer ${token}` }
  });
  expect(comp.statusCode).toBe(200);
  return comp.json().media as { id: string; sha256: string };
}

describe('Multi-Cloud Storage Pool Auto-Sharding (S3 + WebDAV + Local Pool >= 400 GB Architecture)', () => {
  let ctx: BuiltApp;
  let rootA: string;
  let rootB: string;
  let davServer: http.Server;
  let davBaseUrl: string;
  let davStore: Map<string, Buffer>;
  let adminToken: string;

  beforeAll(async () => {
    rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'smb-pool-a-'));
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'smb-pool-b-'));

    const expectedAuth = `Basic ${Buffer.from('davuser:davsecret123').toString('base64')}`;
    const mockDav = createMockWebDavServer(expectedAuth);
    davServer = mockDav.server;
    davStore = mockDav.store;
    await new Promise<void>((resolve) => davServer.listen(0, '127.0.0.1', resolve));
    const addr = davServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    davBaseUrl = `http://127.0.0.1:${port}/dav`;

    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      STORAGE_PRIMARY_TYPE: 'local',
      STORAGE_LOCAL_ROOT: rootA,
      JWT_ACCESS_SECRET: 'test-access-secret-must-be-at-least-32-chars',
      JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-at-least-32-chars'
    });
    ctx = await buildApp({ config, enableLogger: false });

    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'pool-admin@vault.local',
        password: 'AdminPassword!123',
        displayName: 'Pool Admin',
        encryptionMode: 'server_side'
      }
    });
    adminToken = reg.json().tokens.accessToken;
  });

  afterAll(async () => {
    await ctx.app.close();
    await new Promise<void>((resolve) => davServer.close(() => resolve()));
    await Promise.all([
      fs.rm(rootA, { recursive: true, force: true }),
      fs.rm(rootB, { recursive: true, force: true })
    ]);
  });

  it('automatically shards uploads across Pool Node A -> Node B -> WebDAV Node C as nodes fill up, routes downloads accurately, and blocks deleting non-empty nodes', async () => {
    // 1. Add Node A (priority 1, 25 KB capacity -> fits exactly one 20 KB file)
    const addA = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/storage/pool/nodes',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Pool Node A (Disk 1)',
        slot: 'copy1_primary',
        provider: 'local',
        priority: 1,
        capacityBytes: 25_000,
        localRoot: rootA,
        bucket: 'pool-a'
      }
    });
    expect(addA.statusCode).toBe(201);
    const nodeAId = addA.json().node.id as string;

    // 2. Add Node B (priority 2, 25 KB capacity -> fits the second 20 KB file)
    const addB = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/storage/pool/nodes',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Pool Node B (Disk 2)',
        slot: 'copy1_primary',
        provider: 'local',
        priority: 2,
        capacityBytes: 25_000,
        localRoot: rootB,
        bucket: 'pool-b'
      }
    });
    expect(addB.statusCode).toBe(201);
    const nodeBId = addB.json().node.id as string;

    // 3. Test & Add WebDAV Node C (InfiniCLOUD/Koofr style WebDAV, priority 3, 200 KB capacity)
    const testDav = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/storage/pool/test',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'InfiniCLOUD WebDAV Node C',
        slot: 'copy1_primary',
        provider: 'infinicloud_webdav',
        priority: 3,
        capacityBytes: 200_000,
        endpoint: davBaseUrl,
        bucket: 'vault-photos',
        accessKeyId: 'davuser',
        secretAccessKey: 'davsecret123'
      }
    });
    expect(testDav.statusCode).toBe(200);
    expect(testDav.json().result.ok).toBe(true);
    expect(testDav.json().result.checks).toEqual({ write: true, readVerify: true, delete: true });

    const addC = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/storage/pool/nodes',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'InfiniCLOUD WebDAV Node C',
        slot: 'copy1_primary',
        provider: 'infinicloud_webdav',
        priority: 3,
        capacityBytes: 200_000,
        endpoint: davBaseUrl,
        bucket: 'vault-photos',
        accessKeyId: 'davuser',
        secretAccessKey: 'davsecret123'
      }
    });
    expect(addC.statusCode).toBe(201);
    const nodeCId = addC.json().node.id as string;
    expect(addC.json().summary.bySlot.copy1_primary.totalCapacityBytes).toBe(250_000);

    // 4. Upload 3 separate 20 KB files -> File 1 goes to Node A, File 2 spills to Node B, File 3 spills to WebDAV Node C!
    const bytes1 = crypto.randomBytes(20_000);
    const bytes2 = crypto.randomBytes(20_000);
    const bytes3 = crypto.randomBytes(20_000);

    const media1 = await uploadOne(ctx, adminToken, 'photo_on_node_a.jpg', bytes1);
    const media2 = await uploadOne(ctx, adminToken, 'photo_on_node_b.jpg', bytes2);
    const media3 = await uploadOne(ctx, adminToken, 'photo_on_webdav_c.jpg', bytes3);

    // Verify exact per-object placement in PostgreSQL
    const placements = await ctx.db.query<{ media_id: string; primary_node_id: string }>(
      'SELECT media_id, primary_node_id FROM storage_objects WHERE media_id = ANY($1::uuid[])',
      [[media1.id, media2.id, media3.id]]
    );
    const byMedia = new Map(placements.rows.map((r) => [r.media_id, r.primary_node_id]));
    expect(byMedia.get(media1.id)).toBe(nodeAId);
    expect(byMedia.get(media2.id)).toBe(nodeBId);
    expect(byMedia.get(media3.id)).toBe(nodeCId);
    expect(davStore.size).toBe(1); // File 3 truly stored in WebDAV server!

    // 5. Download ALL 3 files and verify bit-for-bit original parity across all 3 pool nodes!
    for (const [m, expected] of [
      [media1, bytes1],
      [media2, bytes2],
      [media3, bytes3]
    ] as const) {
      const dl = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/media/${m.id}/download`,
        headers: { authorization: `Bearer ${adminToken}` }
      });
      expect(dl.statusCode).toBe(200);
      expect(dl.rawPayload.equals(expected)).toBe(true);
    }

    // 6. Safety guard: deleting a pool node with active files MUST fail with 409 CONFLICT
    const blockDel = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/storage/pool/nodes/${nodeAId}`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(blockDel.statusCode).toBe(409);

    // 7. Trash + permanently delete File 1 -> Node A used_bytes drops back to 0 and can now be removed cleanly!
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/media/${media1.id}/trash`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    const permDel = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/trash/${media1.id}`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(permDel.statusCode).toBe(200);

    const poolAfter = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/storage/pool',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    const nodeAView = poolAfter.json().nodes.find((n: { id: string }) => n.id === nodeAId);
    expect(nodeAView.usedBytes).toBe(0);

    const allowDel = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/storage/pool/nodes/${nodeAId}`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(allowDel.statusCode).toBe(200);
  });
});
