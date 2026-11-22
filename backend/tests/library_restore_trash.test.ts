import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { sha256Hex } from '../src/utils/crypto.js';

async function uploadMediaHelper(
  ctx: BuiltApp,
  token: string,
  filename: string,
  mimeType: string,
  content: Buffer,
  allowDuplicate = false
) {
  const sha = sha256Hex(content);
  const init = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/uploads/init',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      originalFilename: filename,
      mimeType,
      sizeBytes: content.length,
      sha256: sha,
      networkType: 'wifi',
      chunkSizeBytes: 64 * 1024,
      allowDuplicate
    }
  });
  expect(init.statusCode).toBe(201);
  const { sessionId } = init.json();

  const put = await ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${sessionId}/parts/1`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'x-part-sha256': sha
    },
    payload: content
  });
  expect(put.statusCode).toBe(200);

  const comp = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${sessionId}/complete`,
    headers: { authorization: `Bearer ${token}` }
  });
  expect(comp.statusCode).toBe(200);
  return comp.json().media as { id: string; sha256: string; sizeBytes: number };
}

/** Minimal ZIP STORE reader to verify exported paths and exact bytes in tests */
function readZipStoreEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compression = zip.readUInt16LE(offset + 8);
    expect(compression).toBe(0); // Must be lossless STORE
    const size = zip.readUInt32LE(offset + 18);
    const nameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = zip.subarray(nameStart, nameStart + nameLen).toString('utf8');
    const data = Buffer.from(zip.subarray(dataStart, dataStart + size));
    entries.set(name, data);
    offset = dataStart + size;
  }
  return entries;
}

describe('Phase 3 & 4: Folders, Albums, Tags, Streaming, Lossless ZIP Restore, Duplicates, Trash & Versions', () => {
  let ctx: BuiltApp;
  let tempRoot: string;
  let token: string;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'smb-phase34-test-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      STORAGE_PRIMARY_TYPE: 'local',
      STORAGE_LOCAL_ROOT: tempRoot,
      JWT_ACCESS_SECRET: 'test-access-secret-must-be-at-least-32-chars',
      JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-at-least-32-chars'
    });
    ctx = await buildApp({ config, enableLogger: false });

    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'organizer@vault.local',
        password: 'StrongPassword!123',
        displayName: 'Organizer',
        encryptionMode: 'server_side'
      }
    });
    token = reg.json().tokens.accessToken;
  });

  afterAll(async () => {
    await ctx.app.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('organizes media with nested folders, albums, tags, favorites, range streaming, and lossless ZIP restore', async () => {
    const photoBytes = crypto.randomBytes(12_000);
    const videoBytes = crypto.randomBytes(20_000);

    const photo = await uploadMediaHelper(ctx, token, 'dalat_sunset.jpg', 'image/jpeg', photoBytes);
    const video = await uploadMediaHelper(ctx, token, 'clip_4k.mp4', 'video/mp4', videoBytes);
    // Deliberate duplicate copy kept by user
    const dupPhoto = await uploadMediaHelper(
      ctx,
      token,
      'dalat_sunset_copy.jpg',
      'image/jpeg',
      photoBytes,
      true
    );

    // Multi-level folders: 2026 -> DaLat
    const fParent = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: '2026' }
    });
    expect(fParent.statusCode).toBe(201);
    const parentId = fParent.json().folder.id as string;

    const fChild = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'DaLat', parentId }
    });
    expect(fChild.statusCode).toBe(201);
    const childId = fChild.json().folder.id as string;

    // Cycle protection: cannot move parent inside child
    const badMove = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/folders/${parentId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { parentId: childId }
    });
    expect(badMove.statusCode).toBe(400);

    // Move photo to nested folder & mark favorite
    const patchMedia = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/media/${photo.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { isFavorite: true, folderId: childId }
    });
    expect(patchMedia.statusCode).toBe(200);

    // Create album & attach video
    const albumRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/albums',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Ky Niem' }
    });
    const albumId = albumRes.json().album.id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/albums/${albumId}/media`,
      headers: { authorization: `Bearer ${token}` },
      payload: { mediaIds: [video.id] }
    });

    // Create tag & attach to photo
    const tagRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tags',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'travel' }
    });
    const tagId = tagRes.json().tag.id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/media/${photo.id}/tags`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tagId }
    });

    // Filter by favorite + tag
    const filtered = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/media?favoriteOnly=true&tagId=${tagId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items.map((i: { id: string }) => i.id)).toEqual([photo.id]);

    // HTTP 206 Partial Content byte-range streaming for video
    const rangeStream = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/media/${video.id}/stream`,
      headers: {
        authorization: `Bearer ${token}`,
        range: 'bytes=100-599'
      }
    });
    expect(rangeStream.statusCode).toBe(206);
    expect(rangeStream.headers['content-range']).toBe(`bytes 100-599/${videoBytes.length}`);
    expect(rangeStream.rawPayload.equals(videoBytes.subarray(100, 600))).toBe(true);

    // Lossless Full-Vault ZIP STORE Export preserving exact Folder & Album structure + SHA-256
    const exportRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/restore/export-zip',
      headers: { authorization: `Bearer ${token}` },
      payload: { scope: 'all' }
    });
    expect(exportRes.statusCode).toBe(200);
    const extracted = readZipStoreEntries(exportRes.rawPayload);

    expect(extracted.get('Folders/2026/DaLat/dalat_sunset.jpg')?.equals(photoBytes)).toBe(true);
    expect(extracted.get('Albums/Ky Niem/clip_4k.mp4')?.equals(videoBytes)).toBe(true);
    expect(extracted.has('restore-manifest.json')).toBe(true);

    // Duplicate Center detects identical photo pair without auto-deleting
    const dupsRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/storage/duplicates',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(dupsRes.statusCode).toBe(200);
    expect(dupsRes.json().groups).toHaveLength(1);
    expect(dupsRes.json().groups[0].count).toBe(2);

    // File Versions: sole remaining version CANNOT be deleted (PRD 3.6)
    const versionsRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/media/${photo.id}/versions`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(versionsRes.json().versions).toHaveLength(1);

    const blockDeleteSoleVersion = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${photo.id}/versions/1`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(blockDeleteSoleVersion.statusCode).toBe(400);

    // Trash soft-delete -> Restore -> Re-trash -> Manual Permanent Delete reclaims quota
    const trashRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/media/${dupPhoto.id}/trash`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(trashRes.statusCode).toBe(200);

    const trashList = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/trash',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(trashList.json().items.map((t: { mediaId: string }) => t.mediaId)).toEqual([dupPhoto.id]);

    const restoreRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/trash/${dupPhoto.id}/restore`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(restoreRes.statusCode).toBe(200);

    // Re-trash and permanently delete manually
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/media/${dupPhoto.id}/trash`,
      headers: { authorization: `Bearer ${token}` }
    });
    const permDel = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/trash/${dupPhoto.id}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(permDel.statusCode).toBe(200);
    expect(permDel.json().freedBytes).toBe(photoBytes.length);

    // Deleting a folder NEVER deletes media inside it
    const delFolder = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/folders/${childId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(delFolder.statusCode).toBe(200);

    const stillDownloadable = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/media/${photo.id}/download`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(stillDownloadable.statusCode).toBe(200);
    expect(stillDownloadable.rawPayload.equals(photoBytes)).toBe(true);
  });
});
