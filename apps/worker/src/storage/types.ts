import type { TestStorageTargetResponse } from '@smb/shared';

export interface StorageGetResult {
  body: ReadableStream<Uint8Array>;
  size?: number;
  etag?: string;
  contentType?: string;
}

export interface StorageGetRangeResult {
  body: ReadableStream<Uint8Array>;
  size?: number;
  contentRange?: string;
  contentType?: string;
}

export interface StorageHeadResult {
  key: string;
  sizeBytes: number;
  etag?: string;
  sha256?: string;
}

export interface CompletedUploadPart {
  partNumber: number;
  etag: string;
}

export interface WorkerStorageAdapter {
  readonly provider: string;
  readonly bucket: string;

  put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    contentType?: string,
    sha256?: string
  ): Promise<{ key: string; sizeBytes?: number; etag?: string }>;

  get(key: string): Promise<StorageGetResult | null>;

  getRange(key: string, start: number, end: number): Promise<StorageGetRangeResult | null>;

  head(key: string): Promise<StorageHeadResult | null>;

  delete(key: string): Promise<void>;

  createMultipart(key: string, contentType?: string): Promise<{ uploadId: string }>;

  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array
  ): Promise<{ partNumber: number; etag: string }>;

  completeMultipart(
    key: string,
    uploadId: string,
    parts: CompletedUploadPart[]
  ): Promise<{ key: string; sizeBytes?: number; etag?: string }>;

  abortMultipart(key: string, uploadId: string): Promise<void>;

  probe(): Promise<TestStorageTargetResponse>;

  computeSha256(key: string): Promise<{ sha256: string; sizeBytes: number }>;

  healthCheck(): Promise<{ healthy: boolean; message: string }>;
}

// Pure-TS incremental FIPS 180-4 SHA-256 fallback for runtimes without crypto.DigestStream
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

class IncrementalSha256 {
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  private totalBytes = 0;
  private readonly w = new Uint32Array(64);

  update(chunk: Uint8Array): void {
    this.totalBytes += chunk.length;
    let offset = 0;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, chunk.length);
      this.block.set(chunk.subarray(0, take), this.blockLen);
      this.blockLen += take;
      offset += take;
      if (this.blockLen === 64) {
        this.compress(this.block, 0);
        this.blockLen = 0;
      }
    }
    while (offset + 64 <= chunk.length) {
      this.compress(chunk, offset);
      offset += 64;
    }
    if (offset < chunk.length) {
      const rem = chunk.length - offset;
      this.block.set(chunk.subarray(offset), 0);
      this.blockLen = rem;
    }
  }

  private compress(buf: Uint8Array, off: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((buf[j]! << 24) | (buf[j + 1]! << 16) | (buf[j + 2]! << 8) | buf[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15]! >>> 7) | (w[i - 15]! << 25)) ^ ((w[i - 15]! >>> 18) | (w[i - 15]! << 14)) ^ (w[i - 15]! >>> 3);
      const s1 = ((w[i - 2]! >>> 17) | (w[i - 2]! << 15)) ^ ((w[i - 2]! >>> 19) | (w[i - 2]! << 13)) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = this.h0, b = this.h1, c = this.h2, d = this.h3;
    let e = this.h4, f = this.h5, g = this.h6, h = this.h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K256[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
    this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0;
    this.h7 = (this.h7 + h) >>> 0;
  }

  digestHex(): { sha256: string; sizeBytes: number } {
    const bitLen = this.totalBytes * 8;
    const padBuf = new Uint8Array(this.blockLen < 56 ? 64 - this.blockLen : 128 - this.blockLen);
    padBuf[0] = 0x80;
    const view = new DataView(padBuf.buffer);
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    view.setUint32(padBuf.length - 8, hi, false);
    view.setUint32(padBuf.length - 4, lo, false);

    const savedTotal = this.totalBytes;
    this.update(padBuf);
    this.totalBytes = savedTotal;

    const words = [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7];
    let hex = '';
    for (const word of words) {
      hex += word.toString(16).padStart(8, '0');
    }
    return { sha256: hex, sizeBytes: savedTotal };
  }
}

interface CfDigestStream extends WritableStream<Uint8Array> {
  digest: Promise<ArrayBuffer>;
}

export async function computeStreamSha256(
  stream: ReadableStream<Uint8Array>
): Promise<{ sha256: string; sizeBytes: number }> {
  const DigestCtor = (crypto as unknown as { DigestStream?: new (alg: string) => CfDigestStream }).DigestStream;
  if (typeof DigestCtor === 'function') {
    let sizeBytes = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        sizeBytes += chunk.byteLength;
        controller.enqueue(chunk);
      }
    });
    const digestStream = new DigestCtor('SHA-256');
    await stream.pipeThrough(counter).pipeTo(digestStream);
    const buf = await digestStream.digest;
    const bytes = new Uint8Array(buf);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
    return { sha256: hex, sizeBytes };
  }

  const hasher = new IncrementalSha256();
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        hasher.update(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return hasher.digestHex();
}
