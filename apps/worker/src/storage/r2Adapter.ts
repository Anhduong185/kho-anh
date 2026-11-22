import {
  DEFAULT_R2_FREE_CAPACITY_BYTES,
  type CloudStorageProvider,
  type TestStorageTargetResponse
} from '@smb/shared';
import type { R2Bucket, WorkerEnv } from '../env.js';
import { sha256Hex } from '../utils/crypto.js';
import {
  computeStreamSha256,
  type CompletedUploadPart,
  type StorageGetRangeResult,
  type StorageGetResult,
  type StorageHeadResult,
  type WorkerStorageAdapter
} from './types.js';

export function resolveR2CapacityBytes(env: WorkerEnv, overrideBytes?: number | null): number {
  if (typeof overrideBytes === 'number' && Number.isFinite(overrideBytes) && overrideBytes > 0) {
    return Math.floor(overrideBytes);
  }
  const envVal = Number(env.R2_CAPACITY_BYTES ?? 0);
  if (Number.isFinite(envVal) && envVal > 0) {
    return Math.floor(envVal);
  }
  return DEFAULT_R2_FREE_CAPACITY_BYTES;
}

export class R2StorageAdapter implements WorkerStorageAdapter {
  readonly provider: CloudStorageProvider = 'cloudflare_r2';
  readonly bucket: string;
  private readonly r2: R2Bucket;

  constructor(r2: R2Bucket, bucketName = 'kho-anh-vault') {
    this.r2 = r2;
    this.bucket = bucketName;
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    contentType?: string,
    sha256?: string
  ): Promise<{ key: string; sizeBytes?: number; etag?: string }> {
    let value: ArrayBuffer | ReadableStream<Uint8Array>;
    if (body instanceof Uint8Array) {
      if (sha256) {
        const actual = await sha256Hex(body);
        if (actual !== sha256.toLowerCase()) {
          throw new Error(`SHA-256 mismatch before R2 put for ${key}`);
        }
      }
      value = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    } else {
      value = body;
    }
    const obj = await this.r2.put(key, value, {
      httpMetadata: { contentType: contentType ?? 'application/octet-stream' },
      ...(sha256 && body instanceof Uint8Array ? { sha256: sha256.toLowerCase() } : {})
    });
    if (!obj) {
      throw new Error(`R2 put returned null for ${key}`);
    }
    return { key, sizeBytes: obj.size, etag: obj.etag };
  }

  async get(key: string): Promise<StorageGetResult | null> {
    const obj = await this.r2.get(key);
    if (!obj) return null;
    return {
      body: obj.body,
      size: obj.size,
      etag: obj.etag,
      contentType: obj.httpMetadata?.contentType
    };
  }

  async getRange(key: string, start: number, end: number): Promise<StorageGetRangeResult | null> {
    const length = end - start + 1;
    const obj = await this.r2.get(key, { range: { offset: start, length } });
    if (!obj) return null;
    return {
      body: obj.body,
      size: obj.size,
      contentType: obj.httpMetadata?.contentType
    };
  }

  async head(key: string): Promise<StorageHeadResult | null> {
    const obj = await this.r2.head(key);
    if (!obj) return null;
    return {
      key: obj.key,
      sizeBytes: obj.size,
      etag: obj.etag
    };
  }

  async delete(key: string): Promise<void> {
    await this.r2.delete(key);
  }

  async createMultipart(key: string, contentType?: string): Promise<{ uploadId: string }> {
    const mpu = await this.r2.createMultipartUpload(key, {
      httpMetadata: { contentType: contentType ?? 'application/octet-stream' }
    });
    return { uploadId: mpu.uploadId };
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array
  ): Promise<{ partNumber: number; etag: string }> {
    const mpu = this.r2.resumeMultipartUpload(key, uploadId);
    const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    const part = await mpu.uploadPart(partNumber, buf);
    return { partNumber: part.partNumber, etag: part.etag };
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: CompletedUploadPart[]
  ): Promise<{ key: string; sizeBytes?: number; etag?: string }> {
    const mpu = this.r2.resumeMultipartUpload(key, uploadId);
    const sorted = [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({ partNumber: p.partNumber, etag: p.etag }));
    const obj = await mpu.complete(sorted);
    return { key: obj.key, sizeBytes: obj.size, etag: obj.etag };
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    const mpu = this.r2.resumeMultipartUpload(key, uploadId);
    await mpu.abort();
  }

  async computeSha256(key: string): Promise<{ sha256: string; sizeBytes: number }> {
    const res = await this.get(key);
    if (!res) {
      throw new Error(`Object missing on R2: ${key}`);
    }
    return computeStreamSha256(res.body);
  }

  async probe(): Promise<TestStorageTargetResponse> {
    const t0 = Date.now();
    const probeKey = `_healthcheck/probe-${crypto.randomUUID()}.bin`;
    const probeBytes = new TextEncoder().encode(`kho-anh-r2-probe:${Date.now()}:${crypto.randomUUID()}`);
    const expectedSha = await sha256Hex(probeBytes);
    const checks = { write: false, readVerify: false, delete: false };

    try {
      await this.put(probeKey, probeBytes, 'application/octet-stream', expectedSha);
      checks.write = true;

      const digest = await this.computeSha256(probeKey);
      if (digest.sha256 !== expectedSha || digest.sizeBytes !== probeBytes.length) {
        throw new Error('R2 probe SHA-256 verification mismatch');
      }
      checks.readVerify = true;

      await this.delete(probeKey);
      checks.delete = true;

      const latencyMs = Date.now() - t0;
      return {
        ok: true,
        provider: this.provider,
        latencyMs,
        checks,
        message: `Cloudflare R2 hoạt động hoàn hảo (${latencyMs}ms · Ghi/Đọc SHA-256/Xóa đạt 100%).`
      };
    } catch (err) {
      await this.delete(probeKey).catch(() => {});
      return {
        ok: false,
        provider: this.provider,
        latencyMs: Date.now() - t0,
        checks,
        message: `Lỗi kiểm tra R2: ${(err as Error).message}`
      };
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    return {
      healthy: true,
      message: `Cloudflare R2 Native Binding (${this.bucket})`
    };
  }
}
