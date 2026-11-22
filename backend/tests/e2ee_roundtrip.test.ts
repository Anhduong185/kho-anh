import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { sha256Hex } from '../src/utils/crypto.js';
import {
  createClientWrappedE2eeBundle,
  decryptBytesFromE2ee,
  encryptFileForE2ee,
  unlockE2eeMasterKey
} from '../../apps/web/src/utils/e2ee.js';

describe('Phase 5: End-to-End Encryption (E2EE) Client-Side Roundtrip & Zero-Knowledge Server Verification', () => {
  let ctx: BuiltApp;
  let tempRoot: string;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'smb-e2ee-test-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      STORAGE_PRIMARY_TYPE: 'local',
      STORAGE_LOCAL_ROOT: tempRoot,
      JWT_ACCESS_SECRET: 'test-access-secret-must-be-at-least-32-chars',
      JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-at-least-32-chars'
    });
    ctx = await buildApp({ config, enableLogger: false });
  });

  afterAll(async () => {
    await ctx.app.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('encrypts original photo locally, stores unreadable ciphertext on server, blocks wrong key, and restores exact original bytes with right key', async () => {
    const vaultPassphrase = 'MySuperSecretVaultPassphrase#2026';
    const bundleInput = await createClientWrappedE2eeBundle(vaultPassphrase);

    // 1. Register E2EE account — server receives ONLY client-wrapped ciphertext key bundle
    const regRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'zero-knowledge@vault.local',
        password: 'LoginPassword!123',
        displayName: 'ZK Owner',
        encryptionMode: 'e2ee',
        ...bundleInput
      }
    });
    expect(regRes.statusCode).toBe(201);
    const token = regRes.json().tokens.accessToken as string;

    // 2. Unlock Master Key locally (wrong passphrase MUST fail!)
    const keyBundle = {
      keySalt: bundleInput.e2eeKeySalt,
      encryptedMasterKey: bundleInput.e2eeEncryptedMasterKey,
      kdfParams: bundleInput.e2eeKdfParams
    };
    await expect(unlockE2eeMasterKey('WrongPassphrase123!', keyBundle)).rejects.toThrow();
    const masterKey = await unlockE2eeMasterKey(vaultPassphrase, keyBundle);

    // 3. Encrypt a sensitive original image locally BEFORE upload
    const secretPlaintext = Buffer.from(
      'PRIVATE-ORIGINAL-PHOTO-HEADER-SENSITIVE-FAMILY-BYTES-' + crypto.randomBytes(8192).toString('hex'),
      'utf8'
    );
    const originalFile = new File([secretPlaintext], 'private_portrait.jpg', { type: 'image/jpeg' });
    const { encryptedFile, encryptedFileKey, encryptionIv } = await encryptFileForE2ee(
      originalFile,
      masterKey
    );

    const ciphertextBytes = Buffer.from(await encryptedFile.arrayBuffer());
    const cipherSha = sha256Hex(ciphertextBytes);

    // Confirm ciphertext does NOT contain plaintext string
    expect(ciphertextBytes.includes(Buffer.from('PRIVATE-ORIGINAL-PHOTO-HEADER'))).toBe(false);

    // 4. Upload ciphertext through standard resumable upload flow
    const initRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads/init',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        originalFilename: 'private_portrait.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: ciphertextBytes.length,
        sha256: cipherSha,
        networkType: 'wifi',
        chunkSizeBytes: 64 * 1024,
        encryptedFileKey,
        encryptionIv
      }
    });
    expect(initRes.statusCode).toBe(201);
    const { sessionId } = initRes.json();

    const upRes = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${sessionId}/parts/1`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'x-part-sha256': cipherSha
      },
      payload: ciphertextBytes
    });
    expect(upRes.statusCode).toBe(200);

    const completeRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${sessionId}/complete`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(completeRes.statusCode).toBe(200);
    const media = completeRes.json().media;
    expect(media.encryptionMode).toBe('e2ee');
    expect(media.encryptedFileKey).toBe(encryptedFileKey);
    expect(media.encryptionIv).toBe(encryptionIv);

    // 5. Inspect raw bytes on server storage disk — prove zero-knowledge (plaintext is NOT on disk!)
    const objRes = await ctx.db.query<{ object_key: string }>(
      'SELECT object_key FROM storage_objects WHERE media_id = $1',
      [media.id]
    );
    const onDiskBytes = await ctx.storageRegistry.getPrimary().getObject(objRes.rows[0]!.object_key);
    expect(onDiskBytes.includes(Buffer.from('PRIVATE-ORIGINAL-PHOTO-HEADER'))).toBe(false);

    // 6. Download ciphertext from API and decrypt locally with unlocked Master Key -> exact 100% original bytes!
    const dlRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/media/${media.id}/download`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(dlRes.statusCode).toBe(200);

    const decrypted = await decryptBytesFromE2ee(
      new Uint8Array(dlRes.rawPayload.buffer, dlRes.rawPayload.byteOffset, dlRes.rawPayload.byteLength),
      media.encryptedFileKey,
      media.encryptionIv,
      masterKey
    );
    expect(Buffer.from(decrypted).equals(secretPlaintext)).toBe(true);
  });
});
