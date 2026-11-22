import type { CloudStorageProvider, TestStorageTargetResponse } from '@smb/shared';
import type { R2Bucket } from '../env.js';
import { sha256Hex } from '../utils/crypto.js';
import {
  computeStreamSha256,
  type CompletedUploadPart,
  type StorageGetRangeResult,
  type StorageGetResult,
  type StorageHeadResult,
  type WorkerStorageAdapter
} from './types.js';

export interface WebDavWorkerAdapterOptions {
  providerLabel: CloudStorageProvider | string;
  endpoint: string;
  basePath: string;
  username: string;
  password: string;
  stagingBucket?: R2Bucket;
}

const encoder = new TextEncoder();

function toBase64Utf8(str: string): string {
  const bytes = encoder.encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function sliceStreamRange(
  source: ReadableStream<Uint8Array>,
  start: number,
  end: number
): ReadableStream<Uint8Array> {
  let offset = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const chunkStart = offset;
        const chunkEnd = offset + chunk.byteLength - 1;
        offset += chunk.byteLength;
        if (chunkEnd < start || chunkStart > end) return;
        const sliceStart = Math.max(0, start - chunkStart);
        const sliceEnd = Math.min(chunk.byteLength, end - chunkStart + 1);
        if (sliceEnd > sliceStart) {
          controller.enqueue(chunk.subarray(sliceStart, sliceEnd));
        }
      }
    })
  );
}

export class WebDavStorageAdapter implements WorkerStorageAdapter {
  readonly provider: string;
  readonly bucket: string;
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly stagingBucket?: R2Bucket;

  constructor(options: WebDavWorkerAdapterOptions) {
    this.provider = options.providerLabel;
    this.bucket = options.basePath.replace(/^\/+|\/+$/g, '') || 'vault-photos';
    const cleanEndpoint = options.endpoint.replace(/\/+$/, '');
    this.baseUrl = `${cleanEndpoint}/${this.bucket}`;
    this.authHeader = `Basic ${toBase64Utf8(`${options.username}:${options.password}`)}`;
    this.stagingBucket = options.stagingBucket;
  }

  private buildObjectUrl(key: string): string {
    const cleanKey = key
      .split('/')
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    return `${this.baseUrl}/${cleanKey}`;
  }

  private async mkcol(url: string): Promise<void> {
    const res = await fetch(url, {
      method: 'MKCOL',
      headers: { Authorization: this.authHeader }
    });
    await res.body?.cancel();
    if (!res.ok && res.status !== 405 && res.status !== 301 && res.status !== 409) {
      throw new Error(`WebDAV MKCOL failed (${res.status}) at ${url}`);
    }
  }

  private async ensureParentDirs(key: string): Promise<void> {
    const segments = key
      .split('/')
      .filter((seg) => seg && seg !== '.' && seg !== '..');
    const dirSegments = segments.slice(0, -1);

    await this.mkcol(this.baseUrl);
    let current = this.baseUrl;
    for (const seg of dirSegments) {
      current = `${current}/${encodeURIComponent(seg)}`;
      await this.mkcol(current);
    }
  }

  private stagingPartKey(uploadId: string, partNumber: number): string {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(uploadId)) {
      throw new Error('Invalid WebDAV multipart uploadId');
    }
    return `_staging/webdav/${uploadId}/part-${String(partNumber).padStart(5, '0')}`;
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    contentType?: string,
    sha256?: string
  ): Promise<{ key: string; sizeBytes?: number; etag?: string }> {
    let actualSha: string | undefined;
    let fetchBody: BodyInit;
    if (body instanceof Uint8Array) {
      actualSha = await sha256Hex(body);
      if (sha256 && sha256.toLowerCase() !== actualSha) {
        throw new Error(`SHA-256 mismatch before WebDAV upload for ${key}`);
      }
      fetchBody = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    } else {
      fetchBody = body;
    }

    await this.ensureParentDirs(key);
    const url = this.buildObjectUrl(key);
    const init: RequestInit & { duplex?: 'half' } = {
      method: 'PUT',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': contentType ?? 'application/octet-stream',
        ...(body instanceof Uint8Array ? { 'Content-Length': String(body.length) } : {})
      },
      body: fetchBody,
      ...(body instanceof ReadableStream ? { duplex: 'half' as const } : {})
    };
    const res = await fetch(url, init);
    const txt = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`WebDAV PUT failed (${res.status} ${res.statusText}): ${txt.slice(0, 200)}`);
    }

    return {
      key,
      sizeBytes: body instanceof Uint8Array ? body.length : undefined,
      etag: res.headers.get('etag')?.replace(/"/g, '') ?? actualSha
    };
  }

  async get(key: string): Promise<StorageGetResult | null> {
    const res = await fetch(this.buildObjectUrl(key), {
      method: 'GET',
      headers: { Authorization: this.authHeader }
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => '');
      throw new Error(`WebDAV GET failed (${res.status}) for ${key}: ${txt.slice(0, 200)}`);
    }
    const len = res.headers.get('content-length');
    return {
      body: res.body,
      size: len ? Number(len) : undefined,
      etag: res.headers.get('etag')?.replace(/"/g, ''),
      contentType: res.headers.get('content-type') ?? undefined
    };
  }

  async getRange(key: string, start: number, end: number): Promise<StorageGetRangeResult | null> {
    const res = await fetch(this.buildObjectUrl(key), {
      method: 'GET',
      headers: {
        Authorization: this.authHeader,
        Range: `bytes=${start}-${end}`
      }
    });
    if (res.status === 404 || res.status === 416) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => '');
      throw new Error(`WebDAV Range GET failed (${res.status}) for ${key}: ${txt.slice(0, 200)}`);
    }
    if (res.status === 206) {
      const len = res.headers.get('content-length');
      return {
        body: res.body,
        size: len ? Number(len) : end - start + 1,
        contentRange: res.headers.get('content-range') ?? undefined,
        contentType: res.headers.get('content-type') ?? undefined
      };
    }
    // Fallback if WebDAV server ignores Range header and returns 200
    return {
      body: sliceStreamRange(res.body, start, end),
      size: end - start + 1,
      contentRange: `bytes ${start}-${end}/*`,
      contentType: res.headers.get('content-type') ?? undefined
    };
  }

  async head(key: string): Promise<StorageHeadResult | null> {
    const res = await fetch(this.buildObjectUrl(key), {
      method: 'HEAD',
      headers: { Authorization: this.authHeader }
    });
    await res.body?.cancel();
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

  async delete(key: string): Promise<void> {
    const res = await fetch(this.buildObjectUrl(key), {
      method: 'DELETE',
      headers: { Authorization: this.authHeader }
    });
    await res.body?.cancel();
    if (!res.ok && res.status !== 404) {
      throw new Error(`WebDAV DELETE failed (${res.status}) for ${key}`);
    }
  }

  async createMultipart(_key: string): Promise<{ uploadId: string }> {
    if (!this.stagingBucket) {
      throw new Error('R2 staging bucket is required for multipart WebDAV uploads');
    }
    const uploadId = crypto.randomUUID().replace(/-/g, '');
    return { uploadId };
  }

  async uploadPart(
    _key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array
  ): Promise<{ partNumber: number; etag: string }> {
    if (!this.stagingBucket) {
      throw new Error('R2 staging bucket is required for multipart WebDAV uploads');
    }
    const partKey = this.stagingPartKey(uploadId, partNumber);
    const partSha = await sha256Hex(body);
    const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    await this.stagingBucket.put(partKey, buf, {
      httpMetadata: { contentType: 'application/octet-stream' },
      sha256: partSha
    });
    return { partNumber, etag: partSha };
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: CompletedUploadPart[]
  ): Promise<{ key: string; sizeBytes?: number; etag?: string }> {
    if (!this.stagingBucket) {
      throw new Error('R2 staging bucket is required for multipart WebDAV uploads');
    }
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const stagedKeys = sorted.map((p) => this.stagingPartKey(uploadId, p.partNumber));

    let totalBytes = 0;
    for (const partKey of stagedKeys) {
      const h = await this.stagingBucket.head(partKey);
      if (!h) {
        throw new Error(`Missing WebDAV staged part: ${partKey}`);
      }
      totalBytes += h.size;
    }

    await this.ensureParentDirs(key);
    const url = this.buildObjectUrl(key);

    const FixedLenCtor = (
      globalThis as unknown as {
        FixedLengthStream?: new (expectedLength: number) => TransformStream<Uint8Array, Uint8Array>;
      }
    ).FixedLengthStream;

    const stream =
      typeof FixedLenCtor === 'function'
        ? new FixedLenCtor(totalBytes)
        : new TransformStream<Uint8Array, Uint8Array>();

    const pump = (async () => {
      try {
        for (const partKey of stagedKeys) {
          const partObj = await this.stagingBucket!.get(partKey);
          if (!partObj) {
            throw new Error(`Missing WebDAV staged part during assembly: ${partKey}`);
          }
          await partObj.body.pipeTo(stream.writable, { preventClose: true });
        }
        await stream.writable.close();
      } catch (err) {
        await stream.writable.abort(err).catch(() => {});
        throw err;
      }
    })();

    const putInit: RequestInit & { duplex: 'half' } = {
      method: 'PUT',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(totalBytes)
      },
      body: stream.readable,
      duplex: 'half'
    };

    try {
      const [, res] = await Promise.all([pump, fetch(url, putInit)]);
      const txt = await res.text().catch(() => '');
      if (!res.ok) {
        throw new Error(`WebDAV multipart assembly PUT failed (${res.status}): ${txt.slice(0, 200)}`);
      }
      return {
        key,
        sizeBytes: totalBytes,
        etag: res.headers.get('etag')?.replace(/"/g, '')
      };
    } finally {
      await this.stagingBucket.delete(stagedKeys).catch(() => {});
    }
  }

  async abortMultipart(_key: string, uploadId: string): Promise<void> {
    if (!this.stagingBucket) return;
    if (typeof this.stagingBucket.list === 'function') {
      const prefix = `_staging/webdav/${uploadId}/`;
      const listed = await this.stagingBucket.list({ prefix });
      const keys = listed.objects.map((o) => o.key);
      if (keys.length > 0) {
        await this.stagingBucket.delete(keys).catch(() => {});
      }
    }
  }

  async computeSha256(key: string): Promise<{ sha256: string; sizeBytes: number }> {
    const res = await this.get(key);
    if (!res) {
      throw new Error(`Object missing on WebDAV: ${key}`);
    }
    return computeStreamSha256(res.body);
  }

  async probe(): Promise<TestStorageTargetResponse> {
    const t0 = Date.now();
    const probeKey = `.smb-probe/${crypto.randomUUID()}.bin`;
    const probeBytes = encoder.encode(`kho-anh-webdav-probe:${Date.now()}:${crypto.randomUUID()}`);
    const probeSha = await sha256Hex(probeBytes);
    const checks = { write: false, readVerify: false, delete: false };

    try {
      await this.put(probeKey, probeBytes, 'application/octet-stream', probeSha);
      checks.write = true;

      const digest = await this.computeSha256(probeKey);
      if (digest.sha256 !== probeSha || digest.sizeBytes !== probeBytes.length) {
        throw new Error('WebDAV probe SHA-256 mismatch');
      }
      checks.readVerify = true;

      await this.delete(probeKey);
      checks.delete = true;

      const latencyMs = Date.now() - t0;
      return {
        ok: true,
        provider: this.provider as CloudStorageProvider,
        latencyMs,
        checks,
        message: `WebDAV ${this.provider} (${this.bucket}) write/read/SHA-256/delete verified (${latencyMs}ms)`
      };
    } catch (err) {
      await this.delete(probeKey).catch(() => {});
      return {
        ok: false,
        provider: this.provider as CloudStorageProvider,
        latencyMs: Date.now() - t0,
        checks,
        message: (err as Error).message
      };
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      const res = await fetch(this.baseUrl, {
        method: 'PROPFIND',
        headers: {
          Authorization: this.authHeader,
          Depth: '0'
        }
      });
      await res.body?.cancel();
      if (res.ok || res.status === 207 || res.status === 404) {
        return { healthy: true, message: `WebDAV reachable at ${this.baseUrl}` };
      }
      return { healthy: false, message: `WebDAV returned HTTP ${res.status}` };
    } catch (err) {
      return { healthy: false, message: (err as Error).message };
    }
  }
}
