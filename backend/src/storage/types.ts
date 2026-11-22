import type { ReplicaSlot } from '@smb/shared';

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType?: string;
  expectedSha256?: string;
}

export interface ObjectMetadata {
  key: string;
  sizeBytes: number;
  sha256?: string;
  etag?: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface StorageHealth {
  healthy: boolean;
  message?: string;
}

export interface StorageProbeResult {
  ok: boolean;
  latencyMs: number;
  checks: {
    write: boolean;
    readVerify: boolean;
    delete: boolean;
  };
  message: string;
}

export interface StorageAdapter {
  readonly provider: string;
  readonly bucket: string;

  putObject(input: PutObjectInput): Promise<ObjectMetadata>;
  getObject(key: string): Promise<Buffer>;
  headObject(key: string): Promise<ObjectMetadata | null>;
  deleteObject(key: string): Promise<void>;

  createMultipartUpload(key: string, contentType?: string): Promise<{ uploadId: string }>;
  uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<CompletedPart>;
  completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<ObjectMetadata>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  getPresignedUploadUrl(key: string, contentType: string, expiresInSeconds?: number): Promise<string | null>;
  getPresignedUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number
  ): Promise<string | null>;
  getPresignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<string | null>;
  computeObjectSha256(key: string): Promise<{ sha256: string; sizeBytes: number }>;

  runWriteReadDeleteProbe(): Promise<StorageProbeResult>;
  healthCheck(): Promise<StorageHealth>;
}

export interface ConfiguredStorageTarget {
  slot: ReplicaSlot;
  adapter: StorageAdapter | null;
  provider: string;
}
