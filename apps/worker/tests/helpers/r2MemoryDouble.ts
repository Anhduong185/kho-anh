import crypto from 'node:crypto';
import type {
  R2Bucket,
  R2HTTPMetadata,
  R2MultipartUpload,
  R2Object,
  R2ObjectBody,
  R2Range,
  R2UploadedPart
} from '../../src/env.js';

interface StoredObject {
  bytes: Uint8Array;
  etag: string;
  httpMetadata?: R2HTTPMetadata;
}

interface MultipartSession {
  key: string;
  uploadId: string;
  httpMetadata?: R2HTTPMetadata;
  parts: Map<number, { bytes: Uint8Array; etag: string }>;
}

async function toUint8Array(
  value: ArrayBuffer | ArrayBufferView | ReadableStream | string
): Promise<Uint8Array> {
  if (typeof value === 'string') {
    return new TextEncoder().encode(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    );
  }
  const reader = (value as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    if (chunk) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

function toReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) {
        controller.enqueue(bytes.slice(0));
      }
      controller.close();
    }
  });
}

export class R2MemoryDouble implements R2Bucket {
  private readonly objects = new Map<string, StoredObject>();
  private readonly multiparts = new Map<string, MultipartSession>();

  hasKey(key: string): boolean {
    return this.objects.has(key);
  }

  listAllKeys(prefix = ''): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  corruptForTest(key: string, bytes: Uint8Array): void {
    const existing = this.objects.get(key);
    this.objects.set(key, {
      bytes: bytes.slice(0),
      etag: crypto.createHash('md5').update(bytes).digest('hex'),
      httpMetadata: existing?.httpMetadata
    });
  }

  async head(key: string): Promise<R2Object | null> {
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      key,
      size: item.bytes.byteLength,
      etag: item.etag,
      httpEtag: `"${item.etag}"`,
      httpMetadata: item.httpMetadata
    };
  }

  async get(key: string, options?: { range?: R2Range }): Promise<R2ObjectBody | null> {
    const item = this.objects.get(key);
    if (!item) return null;

    let slice = item.bytes;
    let rangeMeta: { offset: number; length: number } | undefined;

    if (options?.range) {
      const total = item.bytes.byteLength;
      if (typeof options.range.suffix === 'number') {
        const len = Math.min(total, options.range.suffix);
        const offset = total - len;
        slice = item.bytes.subarray(offset, total);
        rangeMeta = { offset, length: len };
      } else {
        const offset = Math.max(0, options.range.offset ?? 0);
        const length = Math.min(total - offset, options.range.length ?? total - offset);
        slice = item.bytes.subarray(offset, offset + Math.max(0, length));
        rangeMeta = { offset, length: slice.byteLength };
      }
    }

    const copy = slice.slice(0);
    return {
      key,
      size: copy.byteLength,
      etag: item.etag,
      httpEtag: `"${item.etag}"`,
      httpMetadata: item.httpMetadata,
      range: rangeMeta,
      body: toReadableStream(copy),
      async arrayBuffer() {
        return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
      }
    };
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: { httpMetadata?: R2HTTPMetadata; sha256?: string | ArrayBuffer }
  ): Promise<R2Object | null> {
    const bytes = await toUint8Array(value);
    if (options?.sha256) {
      const expected =
        typeof options.sha256 === 'string'
          ? options.sha256.toLowerCase()
          : Buffer.from(options.sha256).toString('hex');
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actual !== expected) {
        throw new Error(`R2 SHA-256 mismatch on put(${key}): expected ${expected}, got ${actual}`);
      }
    }
    const etag = crypto.createHash('md5').update(bytes).digest('hex');
    this.objects.set(key, { bytes, etag, httpMetadata: options?.httpMetadata });
    return {
      key,
      size: bytes.byteLength,
      etag,
      httpEtag: `"${etag}"`,
      httpMetadata: options?.httpMetadata
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      this.objects.delete(k);
    }
  }

  async createMultipartUpload(
    key: string,
    options?: { httpMetadata?: R2HTTPMetadata }
  ): Promise<R2MultipartUpload> {
    const uploadId = crypto.randomUUID();
    this.multiparts.set(uploadId, {
      key,
      uploadId,
      httpMetadata: options?.httpMetadata,
      parts: new Map()
    });
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    const self = this;
    return {
      key,
      uploadId,
      async uploadPart(partNumber, value): Promise<R2UploadedPart> {
        const sess = self.multiparts.get(uploadId);
        if (!sess || sess.key !== key) {
          throw new Error(`Multipart upload not found: ${uploadId}`);
        }
        const bytes = await toUint8Array(value);
        const etag = crypto.createHash('md5').update(bytes).digest('hex');
        sess.parts.set(partNumber, { bytes, etag });
        return { partNumber, etag };
      },
      async abort(): Promise<void> {
        self.multiparts.delete(uploadId);
      },
      async complete(uploadedParts: R2UploadedPart[]): Promise<R2Object> {
        const sess = self.multiparts.get(uploadId);
        if (!sess || sess.key !== key) {
          throw new Error(`Multipart upload not found: ${uploadId}`);
        }
        const sorted = [...uploadedParts].sort((a, b) => a.partNumber - b.partNumber);
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (const p of sorted) {
          const part = sess.parts.get(p.partNumber);
          if (!part || part.etag.replace(/"/g, '') !== p.etag.replace(/"/g, '')) {
            throw new Error(`Invalid part ${p.partNumber} in completeMultipartUpload`);
          }
          chunks.push(part.bytes);
          total += part.bytes.byteLength;
        }
        const merged = new Uint8Array(total);
        let pos = 0;
        for (const c of chunks) {
          merged.set(c, pos);
          pos += c.byteLength;
        }
        const etag = crypto.createHash('md5').update(merged).digest('hex');
        self.objects.set(key, { bytes: merged, etag, httpMetadata: sess.httpMetadata });
        self.multiparts.delete(uploadId);
        return {
          key,
          size: merged.byteLength,
          etag,
          httpEtag: `"${etag}"`,
          httpMetadata: sess.httpMetadata
        };
      }
    };
  }

  async list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }> {
    const prefix = options?.prefix ?? '';
    const keys = this.listAllKeys(prefix).slice(0, options?.limit ?? 1000);
    return {
      objects: keys.map((key) => ({ key })),
      truncated: false
    };
  }
}
