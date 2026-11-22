import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
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

export interface WebDavAdapterOptions {
  providerLabel: string;
  endpoint: string; // Base WebDAV URL, e.g. https://teracloud.jp/dav/ or https://app.koofr.net/dav/Koofr
  basePath: string; // Folder inside WebDAV, e.g. vault-photos
  username: string;
  password: string;
}

/**
 * Pure HTTP WebDAV StorageAdapter (zero external dependencies).
 * Supports InfiniCLOUD (20+ GB free), Koofr (10 GB free), Nextcloud, OwnCloud,
 * Yandex Disk, pCloud WebDAV, and Synology/QNAP NAS WebDAV.
 */
export class WebDavStorageAdapter implements StorageAdapter {
  readonly provider: string;
  readonly bucket: string;
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly stagingDir: string;

  constructor(options: WebDavAdapterOptions) {
    this.provider = options.providerLabel;
    this.bucket = options.basePath.replace(/^\/+|\/+$/g, '') || 'vault-photos';
    const cleanEndpoint = options.endpoint.replace(/\/+$/, '');
    this.baseUrl = `${cleanEndpoint}/${this.bucket}`;
    const token = Buffer.from(`${options.username}:${options.password}`, 'utf8').toString('base64');
    this.authHeader = `Basic ${token}`;
    this.stagingDir = path.join(os.tmpdir(), 'smb-webdav-staging');
  }

  private buildObjectUrl(key: string): string {
    const cleanKey = key
      .split('/')
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    return `${this.baseUrl}/${cleanKey}`;
  }

  private async ensureParentDirs(key: string): Promise<void> {
    const segments = key
      .split('/')
      .filter((seg) => seg && seg !== '.' && seg !== '..');
    const dirSegments = segments.slice(0, -1);

    // Ensure root bucket folder first
    await this.mkcol(this.baseUrl);
    let current = this.baseUrl;
    for (const seg of dirSegments) {
      current = `${current}/${encodeURIComponent(seg)}`;
      await this.mkcol(current);
    }
  }

  private async mkcol(url: string): Promise<void> {
    const res = await fetch(url, {
      method: 'MKCOL',
      headers: { Authorization: this.authHeader }
    });
    // 201 Created, 405 Method Not Allowed (already exists), 301/409 (already exists on some servers)
    if (!res.ok && res.status !== 405 && res.status !== 301 && res.status !== 409) {
      throw new Error(`WebDAV MKCOL failed (${res.status}) at ${url}`);
    }
  }

  async putObject(input: PutObjectInput): Promise<ObjectMetadata> {
    const actualSha = sha256Hex(input.body);
    if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== actualSha) {
      throw new Error(`SHA-256 mismatch before WebDAV upload for ${input.key}`);
    }

    await this.ensureParentDirs(input.key);
    const url = this.buildObjectUrl(input.key);
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': input.contentType ?? 'application/octet-stream'
      },
      body: new Uint8Array(input.body)
    });

    if (!res.ok) {
      throw new Error(`WebDAV PUT failed (${res.status} ${res.statusText})`);
    }

    return {
      key: input.key,
      sizeBytes: input.body.length,
      sha256: actualSha,
      etag: res.headers.get('etag')?.replace(/"/g, '') ?? actualSha
    };
  }

  async getObject(key: string): Promise<Buffer> {
    const url = this.buildObjectUrl(key);
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: this.authHeader }
    });
    if (!res.ok) {
      throw new Error(`WebDAV GET failed (${res.status}) for ${key}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async headObject(key: string): Promise<ObjectMetadata | null> {
    const url = this.buildObjectUrl(key);
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { Authorization: this.authHeader }
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`WebDAV HEAD failed (${res.status}) for ${key}`);
    }
    return {
      key,
      sizeBytes: Number(res.headers.get('content-length') ?? '0'),
      etag: res.headers.get('etag')?.replace(/"/g, '')
    };
  }

  async deleteObject(key: string): Promise<void> {
    const url = this.buildObjectUrl(key);
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: this.authHeader }
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`WebDAV DELETE failed (${res.status}) for ${key}`);
    }
  }

  // Stage multipart chunks locally before atomic WebDAV PUT (WebDAV doesn't have native S3 multipart)
  private stagingUploadPath(uploadId: string): string {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(uploadId)) {
      throw new Error('Invalid multipart uploadId');
    }
    return path.join(this.stagingDir, uploadId);
  }

  async createMultipartUpload(): Promise<{ uploadId: string }> {
    const uploadId = crypto.randomUUID().replace(/-/g, '');
    await fs.mkdir(this.stagingUploadPath(uploadId), { recursive: true });
    return { uploadId };
  }

  async uploadPart(
    _key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer
  ): Promise<CompletedPart> {
    const dir = this.stagingUploadPath(uploadId);
    const partFile = path.join(dir, `part-${String(partNumber).padStart(5, '0')}`);
    await fs.writeFile(partFile, body);
    return { partNumber, etag: sha256Hex(body) };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[]
  ): Promise<ObjectMetadata> {
    const dir = this.stagingUploadPath(uploadId);
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const chunks: Buffer[] = [];
    for (const p of sorted) {
      const chunk = await fs.readFile(path.join(dir, `part-${String(p.partNumber).padStart(5, '0')}`));
      if (sha256Hex(chunk) !== p.etag) {
        throw new Error(`WebDAV staged part ${p.partNumber} integrity check failed`);
      }
      chunks.push(chunk);
    }
    const combined = Buffer.concat(chunks);
    const meta = await this.putObject({ key, body: combined });
    await fs.rm(dir, { recursive: true, force: true });
    return meta;
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    await fs.rm(this.stagingUploadPath(uploadId), { recursive: true, force: true });
  }

  async getPresignedUploadUrl(): Promise<string | null> {
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
    return { sha256: sha256Hex(data), sizeBytes: data.length };
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
        throw new Error('WebDAV probe SHA-256 mismatch');
      }
      checks.readVerify = true;

      await this.deleteObject(probeKey);
      checks.delete = true;

      return {
        ok: true,
        latencyMs: Date.now() - started,
        checks,
        message: `WebDAV ${this.provider} (${this.bucket}) write/read/SHA-256/delete verified`
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
      const res = await fetch(this.baseUrl, {
        method: 'PROPFIND',
        headers: {
          Authorization: this.authHeader,
          Depth: '0'
        }
      });
      if (res.ok || res.status === 207 || res.status === 404) {
        return { healthy: true, message: `WebDAV reachable at ${this.baseUrl}` };
      }
      return { healthy: false, message: `WebDAV returned HTTP ${res.status}` };
    } catch (err) {
      return { healthy: false, message: (err as Error).message };
    }
  }
}
