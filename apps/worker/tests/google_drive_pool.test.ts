import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_R2_FREE_CAPACITY_BYTES } from '@smb/shared';
import { createWorkerTestHarness } from './helpers/workerClient.js';

const FIVE_TIB = 5 * 1024 * 1024 * 1024 * 1024;
const originalFetch = globalThis.fetch;

interface MockDriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  data: Uint8Array;
}

function installMockGoogleDriveFetch(options?: {
  email?: string;
  limitBytes?: number;
  usageBytes?: number;
}) {
  const email = options?.email ?? 'vault5tb@gmail.com';
  const limitBytes = options?.limitBytes ?? FIVE_TIB;
  const usageBytes = options?.usageBytes ?? 10 * 1024 * 1024 * 1024; // 10 GiB already used
  const files = new Map<string, MockDriveFile>();
  let nextId = 1;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();

    if (urlStr.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'mock_access_token_123',
          refresh_token: 'mock_refresh_token_xyz',
          expires_in: 3600
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr.startsWith('https://www.googleapis.com/drive/v3/about')) {
      return new Response(
        JSON.stringify({
          user: { emailAddress: email, displayName: 'Vault 5TB Owner' },
          storageQuota: {
            limit: String(limitBytes),
            usage: String(usageBytes)
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr.startsWith('https://www.googleapis.com/drive/v3/files') && method === 'GET') {
      const parsed = new URL(urlStr);
      const fileMatch = parsed.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
      if (fileMatch && parsed.searchParams.get('alt') === 'media') {
        const f = files.get(decodeURIComponent(fileMatch[1]!));
        if (!f) return new Response('Not Found', { status: 404 });
        const rangeHeader = new Headers(init?.headers).get('range');
        if (rangeHeader) {
          const m = rangeHeader.match(/bytes=(\d+)-(\d+)/);
          if (m) {
            const start = Number(m[1]);
            const end = Math.min(f.data.byteLength - 1, Number(m[2]));
            const slice = f.data.slice(start, end + 1);
            return new Response(slice, {
              status: 206,
              headers: {
                'Content-Type': f.mimeType,
                'Content-Range': `bytes ${start}-${end}/${f.data.byteLength}`,
                'Content-Length': String(slice.byteLength)
              }
            });
          }
        }
        return new Response(new Uint8Array(f.data), {
          status: 200,
          headers: {
            'Content-Type': f.mimeType,
            'Content-Length': String(f.data.byteLength)
          }
        });
      }

      const q = parsed.searchParams.get('q') ?? '';
      const nameMatch = q.match(/name = '([^']+)'/);
      const isFolderQuery = q.includes('application/vnd.google-apps.folder');
      const matched = [...files.values()].filter((f) => {
        if (isFolderQuery && f.mimeType !== 'application/vnd.google-apps.folder') return false;
        if (nameMatch && f.name !== nameMatch[1]) return false;
        return true;
      });
      return new Response(
        JSON.stringify({
          files: matched.map((f) => ({
            id: f.id,
            name: f.name,
            size: String(f.data.byteLength),
            mimeType: f.mimeType,
            md5Checksum: createHash('md5').update(f.data).digest('hex')
          }))
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr.startsWith('https://www.googleapis.com/drive/v3/files') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name: string; mimeType: string };
      const id = `gd_folder_${nextId++}`;
      files.set(id, { id, name: body.name, mimeType: body.mimeType, parents: [], data: new Uint8Array(0) });
      return new Response(JSON.stringify({ id }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (urlStr.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
      const parsed = new URL(urlStr);
      const rawBuf = new Uint8Array(
        init?.body instanceof ArrayBuffer
          ? init.body
          : ArrayBuffer.isView(init?.body)
            ? init.body.buffer.slice(init.body.byteOffset, init.body.byteOffset + init.body.byteLength)
            : new Uint8Array(0)
      );
      const ct = new Headers(init?.headers).get('content-type') ?? '';
      const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
      let fileName = 'unknown';
      let fileBytes = rawBuf;
      if (boundaryMatch) {
        const boundary = `--${boundaryMatch[1]}`;
        const rawText = new TextDecoder('latin1').decode(rawBuf);
        const parts = rawText.split(boundary);
        if (parts[1]) {
          const jsonStart = parts[1].indexOf('\r\n\r\n') + 4;
          const meta = JSON.parse(parts[1].slice(jsonStart).trim()) as { name: string };
          fileName = meta.name;
        }
        if (parts[2]) {
          const headerEnd = parts[2].indexOf('\r\n\r\n') + 4;
          const bodyLatin1 = parts[2].slice(headerEnd).replace(/\r\n$/, '');
          fileBytes = new Uint8Array(bodyLatin1.length);
          for (let i = 0; i < bodyLatin1.length; i++) fileBytes[i] = bodyLatin1.charCodeAt(i);
        }
      }

      const patchMatch = parsed.pathname.match(/\/files\/([^/]+)$/);
      const id = patchMatch ? decodeURIComponent(patchMatch[1]!) : `gd_file_${nextId++}`;
      files.set(id, {
        id,
        name: fileName,
        mimeType: 'application/octet-stream',
        parents: [],
        data: fileBytes
      });
      return new Response(
        JSON.stringify({
          id,
          size: String(fileBytes.byteLength),
          md5Checksum: createHash('md5').update(fileBytes).digest('hex')
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr.startsWith('https://www.googleapis.com/drive/v3/files/') && method === 'DELETE') {
      const id = decodeURIComponent(new URL(urlStr).pathname.split('/').pop()!);
      files.delete(id);
      return new Response(null, { status: 204 });
    }

    return originalFetch(input, init);
  }) as typeof fetch;

  return { files };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Google Drive 5 TB OAuth Pool & Auto-Sharding', () => {
  it('connects a 5 TB Google Drive account via OAuth, syncs pool quota, and auto-shards uploads past 10 GiB R2', async () => {
    const mockDrive = installMockGoogleDriveFetch({
      email: 'owner5tb@gmail.com',
      limitBytes: FIVE_TIB,
      usageBytes: 0
    });
    const h = createWorkerTestHarness();
    const adminReg = await h.json<{ tokens: { accessToken: string } }>('/api/v1/auth/register', {
      method: 'POST',
      bodyJson: {
        email: 'admin-gd@example.com',
        password: 'AdminPass123!',
        displayName: 'Admin GD',
        encryptionMode: 'server_side'
      }
    });
    const adminToken = adminReg.data.tokens.accessToken;

    // 1. Configure Google OAuth Client ID & Secret
    const saveCfg = await h.json<{ configured: boolean; redirectUri: string }>(
      '/api/v1/admin/storage/pool/google-drive/config',
      {
        method: 'PUT',
        token: adminToken,
        bodyJson: {
          clientId: '123456-test.apps.googleusercontent.com',
          clientSecret: 'GOCSPX-test-secret'
        }
      }
    );
    expect(saveCfg.status).toBe(200);
    expect(saveCfg.data.configured).toBe(true);

    // 2. Start OAuth & invoke callback with signed state
    const startRes = await h.json<{ authUrl: string }>(
      '/api/v1/admin/storage/pool/google-drive/oauth/start',
      {
        method: 'POST',
        token: adminToken,
        bodyJson: { slot: 'copy1_primary', folderName: 'kho-anh-vault', priority: 1 }
      }
    );
    expect(startRes.status).toBe(200);
    const authUrl = new URL(startRes.data.authUrl);
    const state = authUrl.searchParams.get('state')!;
    expect(authUrl.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');

    const cbRes = await h.request(
      `/api/v1/admin/storage/pool/google-drive/oauth/callback?code=mock_code&state=${encodeURIComponent(state)}`
    );
    expect(cbRes.status).toBe(200);
    const cbHtml = await cbRes.text();
    expect(cbHtml).toContain('owner5tb@gmail.com');

    // 3. Verify 5 TB Google Drive node is in Pool & probe succeeds
    const pool = await h.json<{
      nodes: Array<{ id: string; provider: string; capacityBytes: number; priority: number }>;
      summary: { grandTotalCapacityBytes: number };
    }>('/api/v1/admin/storage/pool', { token: adminToken });
    const gdNode = pool.data.nodes.find((n: { provider: string }) => n.provider === 'google_drive')!;
    expect(gdNode).toBeTruthy();
    expect(gdNode.capacityBytes).toBe(FIVE_TIB);
    expect(pool.data.summary.grandTotalCapacityBytes).toBe(DEFAULT_R2_FREE_CAPACITY_BYTES + FIVE_TIB);

    const probeRes = await h.json<{ result: { ok: boolean; checks: { write: boolean; readVerify: boolean; delete: boolean } } }>(
      `/api/v1/admin/storage/pool/nodes/${gdNode.id}/test`,
      { method: 'POST', token: adminToken }
    );
    expect(probeRes.status).toBe(200);
    expect(probeRes.data.result.ok).toBe(true);
    expect(probeRes.data.result.checks).toEqual({ write: true, readVerify: true, delete: true });

    // 4. Sync user quota to real Pool capacity (10 GiB R2 + 5 TiB Google Drive)
    const syncRes = await h.json<{ updatedUsers: number; quotaBytes: number }>(
      '/api/v1/admin/users/sync-pool-quota',
      { method: 'POST', token: adminToken, bodyJson: {} }
    );
    expect(syncRes.status).toBe(200);
    expect(syncRes.data.updatedUsers).toBeGreaterThanOrEqual(1);
    expect(syncRes.data.quotaBytes).toBe(DEFAULT_R2_FREE_CAPACITY_BYTES + FIVE_TIB);

    // Set R2 priority to 10 so priority #1 Google Drive 5 TB receives uploads first
    const r2Prio = await h.json('/api/v1/admin/storage/pool/nodes/cf-r2-native', {
      method: 'PATCH',
      token: adminToken,
      bodyJson: { priority: 10 }
    });
    expect(r2Prio.status).toBe(200);

    // 5. Upload a file as regular User -> lands directly on priority #1 Google Drive 5 TB node!
    const userReg = await h.json<{ tokens: { accessToken: string } }>('/api/v1/auth/register', {
      method: 'POST',
      bodyJson: {
        email: 'user-gd@example.com',
        password: 'UserPass123!',
        displayName: 'User GD',
        encryptionMode: 'server_side'
      }
    });
    const userToken = userReg.data.tokens.accessToken;
    const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const sha256 = createHash('sha256').update(payload).digest('hex');

    const initUp = await h.json<{ sessionId: string; chunkSizeBytes: number }>(
      '/api/v1/uploads/init',
      {
        method: 'POST',
        token: userToken,
        bodyJson: {
          originalFilename: 'photo-5tb.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: payload.byteLength,
          sha256,
          networkType: 'wifi'
        }
      }
    );
    expect(initUp.status).toBe(201);

    const putPart = await h.request(`/api/v1/uploads/${initUp.data.sessionId}/parts/1`, {
      method: 'PUT',
      token: userToken,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Part-SHA256': sha256
      },
      body: payload
    });
    expect(putPart.status).toBe(200);

    const complete = await h.json<{ media: { id: string; replicas: Array<{ provider: string }> } }>(
      `/api/v1/uploads/${initUp.data.sessionId}/complete`,
      { method: 'POST', token: userToken, bodyJson: {} }
    );
    expect(complete.status).toBe(200);
    expect(complete.data.media.replicas[0]?.provider).toBe('google_drive');

    // Confirm file is physically stored in mock Google Drive
    const storedFiles = [...mockDrive.files.values()].filter(
      (f) => f.mimeType !== 'application/vnd.google-apps.folder'
    );
    expect(storedFiles.length).toBe(1);
    expect(Buffer.from(storedFiles[0]!.data).equals(Buffer.from(payload))).toBe(true);

    // Download back through Worker and verify exact bytes
    const dl = await h.request(`/api/v1/media/${complete.data.media.id}/download`, {
      token: userToken
    });
    expect(dl.status).toBe(200);
    const downloaded = new Uint8Array(await dl.arrayBuffer());
    expect(Buffer.from(downloaded).equals(Buffer.from(payload))).toBe(true);
  });
});
