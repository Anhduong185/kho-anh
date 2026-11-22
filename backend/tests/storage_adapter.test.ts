import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskStorageAdapter } from '../src/storage/local-adapter.js';
import { sha256Hex } from '../src/utils/crypto.js';

describe('LocalDiskStorageAdapter Integrity & Multipart Foundation', () => {
  let tempRoot: string;
  let adapter: LocalDiskStorageAdapter;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'smb-storage-test-'));
    adapter = new LocalDiskStorageAdapter(tempRoot, 'test-bucket');
  });

  afterAll(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('stores and retrieves original bytes bit-for-bit with SHA-256 verification', async () => {
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 255]);
    const digest = sha256Hex(original);
    const key = 'user-1/originals/2026/sample.dng';

    const putMeta = await adapter.putObject({
      key,
      body: original,
      expectedSha256: digest
    });

    expect(putMeta.sizeBytes).toBe(original.length);
    expect(putMeta.sha256).toBe(digest);

    const downloaded = await adapter.getObject(key);
    expect(downloaded.equals(original)).toBe(true);

    const head = await adapter.headObject(key);
    expect(head?.sha256).toBe(digest);
  });

  it('rejects upload when expected SHA-256 does not match', async () => {
    await expect(
      adapter.putObject({
        key: 'user-1/originals/bad.jpg',
        body: Buffer.from('corrupted-data'),
        expectedSha256: '0'.repeat(64)
      })
    ).rejects.toThrow(/SHA-256 mismatch/);
  });

  it('rejects path traversal object keys', async () => {
    await expect(
      adapter.putObject({
        key: '../../etc/passwd',
        body: Buffer.from('nope')
      })
    ).rejects.toThrow(/Invalid object key/);
  });

  it('completes multipart upload with exact bit-for-bit reassembly', async () => {
    const part1 = Buffer.from('CHUNK-ONE-RAW-VIDEO-BYTES-');
    const part2 = Buffer.from('CHUNK-TWO-PRORES-STREAM-END');
    const expectedCombined = Buffer.concat([part1, part2]);
    const key = 'user-1/originals/2026/video.mov';

    const { uploadId } = await adapter.createMultipartUpload(key);
    const p2 = await adapter.uploadPart(key, uploadId, 2, part2);
    const p1 = await adapter.uploadPart(key, uploadId, 1, part1);

    // Intentionally pass out of order to verify sorting
    const meta = await adapter.completeMultipartUpload(key, uploadId, [p2, p1]);
    expect(meta.sha256).toBe(sha256Hex(expectedCombined));

    const fetched = await adapter.getObject(key);
    expect(fetched.equals(expectedCombined)).toBe(true);
  });
});
