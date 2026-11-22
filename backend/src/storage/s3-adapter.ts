import crypto from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sha256Hex } from '../utils/crypto.js';
import type {
  CompletedPart,
  ObjectMetadata,
  PutObjectInput,
  StorageAdapter,
  StorageHealth,
  StorageProbeResult
} from './types.js';

export interface S3AdapterOptions {
  providerLabel: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export class S3StorageAdapter implements StorageAdapter {
  readonly provider: string;
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(options: S3AdapterOptions) {
    this.provider = options.providerLabel;
    this.bucket = options.bucket;
    // IMPORTANT: requestChecksumCalculation/responseChecksumValidation = 'WHEN_REQUIRED'
    // ensures 100% compatibility with Cloudflare R2, Backblaze B2, Oracle Cloud S3 API, and MinIO.
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region || 'auto',
      forcePathStyle: options.forcePathStyle,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
      }
    });
  }

  async putObject(input: PutObjectInput): Promise<ObjectMetadata> {
    const actualSha256 = sha256Hex(input.body);
    if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== actualSha256) {
      throw new Error(`SHA-256 mismatch before S3 upload for ${input.key}`);
    }

    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType ?? 'application/octet-stream',
        Metadata: { sha256: actualSha256 }
      })
    );

    return {
      key: input.key,
      sizeBytes: input.body.length,
      sha256: actualSha256,
      etag: res.ETag?.replace(/"/g, '')
    };
  }

  async getObject(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      })
    );
    if (!res.Body) {
      throw new Error(`Empty response body for key ${key}`);
    }
    const bytes = await res.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async headObject(key: string): Promise<ObjectMetadata | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key
        })
      );
      return {
        key,
        sizeBytes: Number(res.ContentLength ?? 0),
        sha256: res.Metadata?.sha256,
        etag: res.ETag?.replace(/"/g, '')
      };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) {
        return null;
      }
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key
      })
    );
  }

  async createMultipartUpload(key: string, contentType?: string): Promise<{ uploadId: string }> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType ?? 'application/octet-stream'
      })
    );
    if (!res.UploadId) {
      throw new Error('S3 did not return UploadId');
    }
    return { uploadId: res.UploadId };
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<CompletedPart> {
    const res = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body
      })
    );
    if (!res.ETag) {
      throw new Error(`Missing ETag for part ${partNumber}`);
    }
    return {
      partNumber,
      etag: res.ETag.replace(/"/g, '')
    };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[]
  ): Promise<ObjectMetadata> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const res = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sorted.map((p) => ({
            PartNumber: p.partNumber,
            ETag: `"${p.etag.replace(/"/g, '')}"`
          }))
        }
      })
    );

    const head = await this.headObject(key);
    return {
      key,
      sizeBytes: head?.sizeBytes ?? 0,
      sha256: head?.sha256,
      etag: res.ETag?.replace(/"/g, '') ?? head?.etag
    };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId
      })
    );
  }

  async getPresignedUploadUrl(
    key: string,
    contentType: string,
    expiresInSeconds = 900
  ): Promise<string | null> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType
      }),
      { expiresIn: expiresInSeconds }
    );
  }

  async getPresignedUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds = 900
  ): Promise<string | null> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber
      }),
      { expiresIn: expiresInSeconds }
    );
  }

  async getPresignedDownloadUrl(key: string, expiresInSeconds = 900): Promise<string | null> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      }),
      { expiresIn: expiresInSeconds }
    );
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
      await this.putObject({
        key: probeKey,
        body: probeData,
        contentType: 'application/octet-stream',
        expectedSha256: probeSha
      });
      checks.write = true;

      const readBack = await this.getObject(probeKey);
      if (sha256Hex(readBack) !== probeSha) {
        throw new Error('Cloud S3 probe SHA-256 mismatch');
      }
      checks.readVerify = true;

      await this.deleteObject(probeKey);
      checks.delete = true;

      return {
        ok: true,
        latencyMs: Date.now() - started,
        checks,
        message: `Connected to ${this.provider} bucket "${this.bucket}" (write/read/SHA-256/delete verified)`
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
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { healthy: true, message: `Bucket ${this.bucket} reachable` };
    } catch (err) {
      return { healthy: false, message: (err as Error).message };
    }
  }
}
