import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '../utils/crypto.js';
import type {
  CompletedPart,
  ObjectMetadata,
  PutObjectInput,
  StorageAdapter,
  StorageHealth,
  StorageProbeResult
} from './types.js';

export class LocalDiskStorageAdapter implements StorageAdapter {
  readonly provider = 'local-disk';
  readonly bucket: string;
  private readonly rootDir: string;
  private readonly objectsDir: string;
  private readonly multipartDir: string;

  constructor(rootDir: string, bucket = 'local-primary') {
    this.rootDir = path.resolve(rootDir);
    this.bucket = bucket;
    this.objectsDir = path.join(this.rootDir, 'objects');
    this.multipartDir = path.join(this.rootDir, 'multipart');
  }

  private resolveSafeKeyPath(key: string): string {
    if (!key || key.includes('\0') || key.startsWith('/') || key.startsWith('\\') || key.includes('..')) {
      throw new Error(`Invalid object key: ${key}`);
    }
    const normalized = key.split('/').filter(Boolean);
    if (normalized.length === 0) {
      throw new Error(`Empty object key`);
    }
    const target = path.resolve(this.objectsDir, ...normalized);
    const prefix = this.objectsDir + path.sep;
    if (!target.startsWith(prefix)) {
      throw new Error(`Path traversal rejected for object key: ${key}`);
    }
    return target;
  }

  private resolveSafeUploadDir(uploadId: string): string {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(uploadId)) {
      throw new Error('Invalid multipart uploadId');
    }
    return path.join(this.multipartDir, uploadId);
  }

  async putObject(input: PutObjectInput): Promise<ObjectMetadata> {
    const actualSha256 = sha256Hex(input.body);
    if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== actualSha256) {
      throw new Error(
        `SHA-256 mismatch for ${input.key}: expected ${input.expectedSha256}, got ${actualSha256}`
      );
    }

    const targetPath = this.resolveSafeKeyPath(input.key);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tempPath, input.body);
    await fs.rename(tempPath, targetPath);

    return {
      key: input.key,
      sizeBytes: input.body.length,
      sha256: actualSha256,
      etag: actualSha256
    };
  }

  async getObject(key: string): Promise<Buffer> {
    const targetPath = this.resolveSafeKeyPath(key);
    return fs.readFile(targetPath);
  }

  async headObject(key: string): Promise<ObjectMetadata | null> {
    const targetPath = this.resolveSafeKeyPath(key);
    try {
      const stat = await fs.stat(targetPath);
      const data = await fs.readFile(targetPath);
      const digest = sha256Hex(data);
      return {
        key,
        sizeBytes: stat.size,
        sha256: digest,
        etag: digest
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    const targetPath = this.resolveSafeKeyPath(key);
    try {
      await fs.unlink(targetPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    this.resolveSafeKeyPath(key);
    const uploadId = crypto.randomUUID().replace(/-/g, '');
    const dir = this.resolveSafeUploadDir(uploadId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ key, createdAt: new Date().toISOString() }));
    return { uploadId };
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<CompletedPart> {
    this.resolveSafeKeyPath(key);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      throw new Error('Invalid multipart partNumber');
    }
    const dir = this.resolveSafeUploadDir(uploadId);
    const partPath = path.join(dir, `part-${String(partNumber).padStart(5, '0')}`);
    await fs.writeFile(partPath, body);
    return {
      partNumber,
      etag: sha256Hex(body)
    };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[]
  ): Promise<ObjectMetadata> {
    const dir = this.resolveSafeUploadDir(uploadId);
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const buffers: Buffer[] = [];

    for (const part of sorted) {
      const partPath = path.join(dir, `part-${String(part.partNumber).padStart(5, '0')}`);
      const chunk = await fs.readFile(partPath);
      if (sha256Hex(chunk) !== part.etag) {
        throw new Error(`Part ${part.partNumber} integrity check failed`);
      }
      buffers.push(chunk);
    }

    const combined = Buffer.concat(buffers);
    const metadata = await this.putObject({ key, body: combined });
    await fs.rm(dir, { recursive: true, force: true });
    return metadata;
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    const dir = this.resolveSafeUploadDir(uploadId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  async getPresignedUploadUrl(): Promise<string | null> {
    // Local disk adapter uses backend upload route instead of external presigned URL.
    return null;
  }

  async getPresignedUploadPartUrl(): Promise<string | null> {
    return null;
  }

  async getPresignedDownloadUrl(): Promise<string | null> {
    return null;
  }

  async computeObjectSha256(key: string): Promise<{ sha256: string; sizeBytes: number }> {
    const data = await this.getObject(key);
    return {
      sha256: sha256Hex(data),
      sizeBytes: data.length
    };
  }

  async runWriteReadDeleteProbe(): Promise<StorageProbeResult> {
    const started = Date.now();
    const probeKey = `.smb-probe/${crypto.randomUUID()}.bin`;
    const probeData = crypto.randomBytes(64);
    const probeSha = sha256Hex(probeData);
    const checks = { write: false, readVerify: false, delete: false };

    try {
      await this.putObject({ key: probeKey, body: probeData, expectedSha256: probeSha });
      checks.write = true;

      const readBack = await this.getObject(probeKey);
      if (sha256Hex(readBack) !== probeSha) {
        throw new Error('Probe SHA-256 verification failed');
      }
      checks.readVerify = true;

      await this.deleteObject(probeKey);
      checks.delete = true;

      return {
        ok: true,
        latencyMs: Date.now() - started,
        checks,
        message: `Local storage read/write/delete probe succeeded (${this.objectsDir})`
      };
    } catch (err) {
      await this.deleteObject(probeKey).catch(() => {});
      return {
        ok: false,
        latencyMs: Date.now() - started,
        checks,
        message: (err as Error).message
      };
    }
  }

  async healthCheck(): Promise<StorageHealth> {
    try {
      await fs.mkdir(this.objectsDir, { recursive: true });
      await fs.access(this.objectsDir);
      return { healthy: true, message: `Local storage ready at ${this.objectsDir}` };
    } catch (err) {
      return { healthy: false, message: (err as Error).message };
    }
  }
}
