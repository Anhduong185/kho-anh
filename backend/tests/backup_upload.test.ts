import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { sha256Hex } from '../src/utils/crypto.js';

describe('Phase 2: Resumable Original Backup, Checksum Verification, Wi-Fi Policy & Isolation', () => {
  let ctx: BuiltApp;
  let tempStorageRoot: string;
  let adminToken: string;
  let userAToken: string;
  let userBToken: string;

  beforeAll(async () => {
    tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'smb-phase2-test-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      STORAGE_PRIMARY_TYPE: 'local',
      STORAGE_LOCAL_ROOT: tempStorageRoot,
      JWT_ACCESS_SECRET: 'test-access-secret-must-be-at-least-32-chars',
      JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-at-least-32-chars',
      DEFAULT_USER_QUOTA_BYTES: String(2 * 1024 * 1024) // 2 MiB quota for quota tests
    });
    ctx = await buildApp({ config, enableLogger: false });

    const adminReg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'admin@vault.local',
        password: 'AdminPassword!123',
        displayName: 'Admin',
        encryptionMode: 'server_side'
      }
    });
    adminToken = adminReg.json().tokens.accessToken;

    const regA = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'alice@vault.local',
        password: 'AlicePassword!123',
        displayName: 'Alice',
        encryptionMode: 'server_side',
        deviceName: 'Alice iPhone',
        platform: 'ios'
      }
    });
    userAToken = regA.json().tokens.accessToken;

    const regB = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'bob@vault.local',
        password: 'BobPassword!123',
        displayName: 'Bob',
        encryptionMode: 'server_side'
      }
    });
    userBToken = regB.json().tokens.accessToken;
  });

  afterAll(async () => {
    await ctx.app.close();
    await fs.rm(tempStorageRoot, { recursive: true, force: true });
  });

  it('rejects non-Wi-Fi uploads and rejects non-photo/video documents', async () => {
    const sample = crypto.randomBytes(1024);
    const cellularAttempt = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads/init',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        originalFilename: 'IMG_0001.HEIC',
        mimeType: 'image/heic',
        sizeBytes: sample.length,
        sha256: sha256Hex(sample),
        networkType: 'cellular'
      }
    });
    expect(cellularAttempt.statusCode).toBe(403);
    expect(cellularAttempt.json().error.code).toBe('WIFI_REQUIRED');

    const docAttempt = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads/init',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        originalFilename: 'secret-contract.pdf',
        mimeType: 'application/pdf',
        sizeBytes: sample.length,
        sha256: sha256Hex(sample),
        networkType: 'wifi'
      }
    });
    expect(docAttempt.statusCode).toBe(400);
    expect(docAttempt.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('supports resumable multipart upload after disconnect, verifies SHA-256, and restores 100% original bytes', async () => {
    // 180 KiB RAW DNG image split into 3 chunks of 64 KiB (64K + 64K + 52K)
    const originalFile = crypto.randomBytes(180 * 1024);
    const originalSha = sha256Hex(originalFile);
    const chunkSize = 64 * 1024;

    const init1 = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads/init',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        originalFilename: 'IMG_ProRAW_Ảnh_Gốc.DNG',
        mimeType: 'application/octet-stream', // Browser often sends generic MIME for DNG
        sizeBytes: originalFile.length,
        sha256: originalSha,
        networkType: 'wifi',
        chunkSizeBytes: chunkSize
      }
    });
    expect(init1.statusCode).toBe(201);
    const session1 = init1.json();
    expect(session1.status).toBe('ready');
    expect(session1.resumed).toBe(false);
    expect(session1.totalParts).toBe(3);

    // Upload part 1 only, then simulate network disconnect / app restart!
    const chunk1 = originalFile.subarray(0, chunkSize);
    const up1 = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${session1.sessionId}/parts/1`,
      headers: {
        authorization: `Bearer ${userAToken}`,
        'content-type': 'application/octet-stream',
        'x-part-sha256': sha256Hex(chunk1)
      },
      payload: chunk1
    });
    expect(up1.statusCode).toBe(200);
    expect(up1.json().uploadedPartCount).toBe(1);

    // Completing early while parts 2 & 3 are missing must fail cleanly
    const earlyComplete = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${session1.sessionId}/complete`,
      headers: { authorization: `Bearer ${userAToken}` }
    });
    expect(earlyComplete.statusCode).toBe(400);
    expect(earlyComplete.json().error.details.missingPartNumbers).toEqual([2, 3]);

    // Client restarts and calls /uploads/init for the same file -> RESUMES existing session!
    const initResume = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads/init',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        originalFilename: 'IMG_ProRAW_Ảnh_Gốc.DNG',
        mimeType: 'application/octet-stream',
        sizeBytes: originalFile.length,
        sha256: originalSha,
        networkType: 'wifi',
        chunkSizeBytes: chunkSize
      }
    });
    expect(initResume.statusCode).toBe(200);
    expect(initResume.json().resumed).toBe(true);
    expect(initResume.json().sessionId).toBe(session1.sessionId);
    expect(initResume.json().uploadedPartNumbers).toEqual([1]);

    // Upload remaining parts 2 and 3
    const chunk2 = originalFile.subarray(chunkSize, chunkSize * 2);
    const chunk3 = originalFile.subarray(chunkSize * 2);

    const up2 = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${session1.sessionId}/parts/2`,
      headers: {
        authorization: `Bearer ${userAToken}`,
        'content-type': 'application/octet-stream',
        'x-part-sha256': sha256Hex(chunk2)
      },
      payload: chunk2
    });
    expect(up2.statusCode).toBe(200);

    const up3 = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${session1.sessionId}/parts/3`,
      headers: {
        authorization: `Bearer ${userAToken}`,
        'content-type': 'application/octet-stream',
        'x-part-sha256': sha256Hex(chunk3)
      },
      payload: chunk3
    });
    expect(up3.statusCode).toBe(200);

    // Complete & verify integrity
    const completeRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${session1.sessionId}/complete`,
      headers: { authorization: `Bearer ${userAToken}` }
    });
    expect(completeRes.statusCode).toBe(200);
    const completed = completeRes.json();
    expect(completed.integrityVerified).toBe(true);
    expect(completed.media.sha256).toBe(originalSha);
    expect(completed.media.sizeBytes).toBe(originalFile.length);
    expect(completed.media.mediaKind).toBe('image');
    // Copy 1 is verified; Copy 2 is still pending.
    expect(completed.media.uploadState).toBe('insufficient_replicas');
    expect(completed.media.verifiedReplicaCount).toBe(1);
    expect(completed.media.requiredReplicas).toBe(2);

    // Download original file & verify exact bit-for-bit match
    const downloadRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/media/${completed.media.id}/download`,
      headers: { authorization: `Bearer ${userAToken}` }
    });
    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.headers['x-content-sha256']).toBe(originalSha);
    expect(downloadRes.rawPayload.equals(originalFile)).toBe(true);

    // On-demand server-side integrity verification
    const verifyRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/media/${completed.media.id}/verify`,
      headers: { authorization: `Bearer ${userAToken}` }
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().verified).toBe(true);
    expect(verifyRes.json().actualSha256).toBe(originalSha);

    // Tenant isolation & Admin privacy boundary: neither Bob nor Admin can download Alice's file!
    const bobDownload = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/media/${completed.media.id}/download`,
      headers: { authorization: `Bearer ${userBToken}` }
    });
    expect(bobDownload.statusCode).toBe(404);

    const adminDownload = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/media/${completed.media.id}/download`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(adminDownload.statusCode).toBe(404);

    // Duplicate detection is strictly per-account (Alice sees duplicate, Bob does NOT!)
    const dupCheckAlice = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads/check-duplicates',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        items: [
          {
            clientRef: 'f1',
            sha256: originalSha,
            sizeBytes: originalFile.length,
            originalFilename: 'copy.dng'
          }
        ]
      }
    });
    expect(dupCheckAlice.json().results[0].status).toBe('duplicate');

    const dupCheckBob = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads/check-duplicates',
      headers: { authorization: `Bearer ${userBToken}` },
      payload: {
        items: [
          {
            clientRef: 'f1',
            sha256: originalSha,
            sizeBytes: originalFile.length,
            originalFilename: 'copy.dng'
          }
        ]
      }
    });
    // PRD Section 9: Zero cross-account deduplication leakage!
    expect(dupCheckBob.json().results[0].status).toBe('new');
  });

  it('rejects corrupted final payload when SHA-256 does not match declared checksum', async () => {
    const fileBytes = crypto.randomBytes(70 * 1024);
    const wrongSha = 'a'.repeat(64);

    const init = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads/init',
      headers: { authorization: `Bearer ${userBToken}` },
      payload: {
        originalFilename: 'corrupt-video.mov',
        mimeType: 'video/quicktime',
        sizeBytes: fileBytes.length,
        sha256: wrongSha,
        networkType: 'wifi',
        chunkSizeBytes: 64 * 1024
      }
    });
    expect(init.statusCode).toBe(201);
    const { sessionId } = init.json();

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${sessionId}/parts/1`,
      headers: { authorization: `Bearer ${userBToken}`, 'content-type': 'application/octet-stream' },
      payload: fileBytes.subarray(0, 64 * 1024)
    });
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${sessionId}/parts/2`,
      headers: { authorization: `Bearer ${userBToken}`, 'content-type': 'application/octet-stream' },
      payload: fileBytes.subarray(64 * 1024)
    });

    const complete = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${sessionId}/complete`,
      headers: { authorization: `Bearer ${userBToken}` }
    });
    expect(complete.statusCode).toBe(422);
    expect(complete.json().error.code).toBe('CHECKSUM_MISMATCH');
  });

  it('enforces storage quota limit cleanly with 413 QUOTA_EXCEEDED', async () => {
    const tooLargeRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads/init',
      headers: { authorization: `Bearer ${userBToken}` },
      payload: {
        originalFilename: 'huge-prores.mov',
        mimeType: 'video/quicktime',
        sizeBytes: 5 * 1024 * 1024, // 5 MiB > 2 MiB test quota
        sha256: 'b'.repeat(64),
        networkType: 'wifi'
      }
    });
    expect(tooLargeRes.statusCode).toBe(413);
    expect(tooLargeRes.json().error.code).toBe('QUOTA_EXCEEDED');
  });

  it('allows CORS preflight PUT/PATCH/DELETE and X-Part-SHA256 from Capacitor Android origin (https://localhost)', async () => {
    const preflight = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/uploads/00000000-0000-0000-0000-000000000000/parts/1',
      headers: {
        origin: 'https://localhost',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization,content-type,x-part-sha256',
        'access-control-request-private-network': 'true'
      }
    });
    expect(preflight.statusCode).toBe(204);
    expect(String(preflight.headers['access-control-allow-methods'] ?? '')).toContain('PUT');
    expect(String(preflight.headers['access-control-allow-methods'] ?? '')).toContain('PATCH');
    expect(String(preflight.headers['access-control-allow-methods'] ?? '')).toContain('DELETE');
    expect(preflight.headers['access-control-allow-private-network']).toBe('true');
  });
});
