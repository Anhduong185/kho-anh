import type { CloudStorageProvider, TestStorageTargetResponse } from '@smb/shared';
import { sha256Hex, toHex } from '../utils/crypto.js';
import {
  computeStreamSha256,
  type CompletedUploadPart,
  type StorageGetRangeResult,
  type StorageGetResult,
  type StorageHeadResult,
  type WorkerStorageAdapter
} from './types.js';

export interface S3SigV4AdapterOptions {
  providerLabel: CloudStorageProvider | string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

const encoder = new TextEncoder();

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodeObjectPath(path: string): string {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeRfc3986(s))
    .join('/');
}

async function hmacSha256(
  keyBytes: ArrayBuffer | Uint8Array<ArrayBuffer>,
  message: string
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(sig);
}

async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<Uint8Array<ArrayBuffer>> {
  const kSecret = encoder.encode(`AWS4${secretAccessKey}`);
  const kSecretBuf = kSecret.buffer.slice(kSecret.byteOffset, kSecret.byteOffset + kSecret.byteLength) as ArrayBuffer;
  const kDate = await hmacSha256(kSecretBuf, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function formatAmzDates(now = new Date()): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8)
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export class S3SigV4StorageAdapter implements WorkerStorageAdapter {
  readonly provider: string;
  readonly bucket: string;
  private readonly endpointUrl: URL;
  private readonly basePath: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly forcePathStyle: boolean;

  constructor(options: S3SigV4AdapterOptions) {
    this.provider = options.providerLabel;
    this.bucket = options.bucket;
    this.endpointUrl = new URL(options.endpoint.replace(/\/+$/, ''));
    this.basePath = this.endpointUrl.pathname.replace(/\/+$/, '');
    this.region = options.region || 'auto';
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.forcePathStyle = options.forcePathStyle;
  }

  private buildRequestTarget(
    key: string,
    query: Array<[string, string]> = []
  ): { url: string; hostHeader: string; canonicalUri: string; canonicalQuery: string } {
    const cleanKey = encodeObjectPath(key);
    const encodedBucket = encodeRfc3986(this.bucket);
    const cleanBase = this.basePath ? encodeObjectPath(this.basePath) : '';
    const basePrefix = cleanBase ? `/${cleanBase}` : '';

    let hostHeader: string;
    let origin: string;
    let canonicalUri: string;

    if (this.forcePathStyle) {
      hostHeader = this.endpointUrl.host;
      origin = this.endpointUrl.origin;
      canonicalUri = cleanKey
        ? `${basePrefix}/${encodedBucket}/${cleanKey}`
        : `${basePrefix}/${encodedBucket}`;
    } else {
      hostHeader = `${this.bucket}.${this.endpointUrl.host}`;
      origin = `${this.endpointUrl.protocol}//${hostHeader}`;
      canonicalUri = cleanKey ? `${basePrefix}/${cleanKey}` : `${basePrefix || '/'}`;
    }

    const sortedQuery = query
      .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

    const canonicalQuery = sortedQuery.map(([k, v]) => `${k}=${v}`).join('&');
    const urlQuery = sortedQuery
      .map(([k, v]) => (v === '' && k === 'uploads' ? 'uploads' : `${k}=${v}`))
      .join('&');

    const url = urlQuery ? `${origin}${canonicalUri}?${urlQuery}` : `${origin}${canonicalUri}`;
    return { url, hostHeader, canonicalUri, canonicalQuery };
  }

  private async signedFetch(opts: {
    method: string;
    key: string;
    query?: Array<[string, string]>;
    headers?: Record<string, string>;
    body?: Uint8Array | ReadableStream<Uint8Array>;
  }): Promise<Response> {
    const target = this.buildRequestTarget(opts.key, opts.query ?? []);
    const { amzDate, dateStamp } = formatAmzDates();

    let payloadHash: string;
    let fetchBody: BodyInit | undefined;
    if (!opts.body) {
      payloadHash = await sha256Hex(new Uint8Array(0));
    } else if (opts.body instanceof Uint8Array) {
      payloadHash = await sha256Hex(opts.body);
      fetchBody = opts.body.buffer.slice(
        opts.body.byteOffset,
        opts.body.byteOffset + opts.body.byteLength
      ) as ArrayBuffer;
    } else {
      payloadHash = 'UNSIGNED-PAYLOAD';
      fetchBody = opts.body;
    }

    const headerMap = new Map<string, string>();
    headerMap.set('host', target.hostHeader);
    headerMap.set('x-amz-content-sha256', payloadHash);
    headerMap.set('x-amz-date', amzDate);
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      headerMap.set(k.toLowerCase(), v.trim());
    }

    const sortedHeaderNames = [...headerMap.keys()].sort();
    const canonicalHeaders = sortedHeaderNames
      .map((k) => `${k}:${headerMap.get(k)!}\n`)
      .join('');
    const signedHeaders = sortedHeaderNames.join(';');

    const canonicalRequest = [
      opts.method.toUpperCase(),
      target.canonicalUri,
      target.canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');

    const canonicalRequestHash = await sha256Hex(canonicalRequest);
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, canonicalRequestHash].join('\n');
    const signingKey = await deriveSigningKey(this.secretAccessKey, dateStamp, this.region, 's3');
    const signature = toHex(await hmacSha256(signingKey, stringToSign));

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const reqHeaders = new Headers();
    for (const [k, v] of headerMap.entries()) {
      if (k !== 'host') reqHeaders.set(k, v);
    }
    reqHeaders.set('Authorization', authorization);

    const init: RequestInit & { duplex?: 'half' } = {
      method: opts.method.toUpperCase(),
      headers: reqHeaders,
      ...(fetchBody !== undefined ? { body: fetchBody } : {}),
      ...(opts.body instanceof ReadableStream ? { duplex: 'half' as const } : {})
    };

    return fetch(target.url, init);
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    contentType?: string,
    sha256?: string
  ): Promise<{ key: string; sizeBytes?: number; etag?: string }> {
    let actualSha: string | undefined;
    if (body instanceof Uint8Array) {
      actualSha = await sha256Hex(body);
      if (sha256 && sha256.toLowerCase() !== actualSha) {
        throw new Error(`SHA-256 mismatch before S3 upload for ${key}`);
      }
    }

    const headers: Record<string, string> = {
      'content-type': contentType ?? 'application/octet-stream'
    };
    if (sha256 || actualSha) {
      headers['x-amz-meta-sha256'] = (sha256 ?? actualSha)!.toLowerCase();
    }

    const res = await this.signedFetch({ method: 'PUT', key, headers, body });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`S3 PUT failed (${res.status}): ${text.slice(0, 200)}`);
    }

    return {
      key,
      sizeBytes: body instanceof Uint8Array ? body.length : undefined,
      etag: res.headers.get('etag')?.replace(/"/g, '') ?? actualSha
    };
  }

  async get(key: string): Promise<StorageGetResult | null> {
    const res = await this.signedFetch({ method: 'GET', key });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => '');
      throw new Error(`S3 GET failed (${res.status}) for ${key}: ${txt.slice(0, 200)}`);
    }
    const lenHeader = res.headers.get('content-length');
    return {
      body: res.body,
      size: lenHeader ? Number(lenHeader) : undefined,
      etag: res.headers.get('etag')?.replace(/"/g, ''),
      contentType: res.headers.get('content-type') ?? undefined
    };
  }

  async getRange(key: string, start: number, end: number): Promise<StorageGetRangeResult | null> {
    const res = await this.signedFetch({
      method: 'GET',
      key,
      headers: { range: `bytes=${start}-${end}` }
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (res.status === 416) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => '');
      throw new Error(`S3 Range GET failed (${res.status}) for ${key}: ${txt.slice(0, 200)}`);
    }
    const lenHeader = res.headers.get('content-length');
    return {
      body: res.body,
      size: lenHeader ? Number(lenHeader) : end - start + 1,
      contentRange: res.headers.get('content-range') ?? undefined,
      contentType: res.headers.get('content-type') ?? undefined
    };
  }

  async head(key: string): Promise<StorageHeadResult | null> {
    const res = await this.signedFetch({ method: 'HEAD', key });
    await res.body?.cancel();
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`S3 HEAD failed (${res.status}) for ${key}`);
    }
    return {
      key,
      sizeBytes: Number(res.headers.get('content-length') ?? '0'),
      etag: res.headers.get('etag')?.replace(/"/g, ''),
      sha256: res.headers.get('x-amz-meta-sha256') ?? undefined
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.signedFetch({ method: 'DELETE', key });
    const txt = await res.text().catch(() => '');
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 DELETE failed (${res.status}) for ${key}: ${txt.slice(0, 200)}`);
    }
  }

  async createMultipart(key: string, contentType?: string): Promise<{ uploadId: string }> {
    const res = await this.signedFetch({
      method: 'POST',
      key,
      query: [['uploads', '']],
      headers: { 'content-type': contentType ?? 'application/octet-stream' }
    });
    const xml = await res.text();
    if (!res.ok) {
      throw new Error(`S3 CreateMultipartUpload failed (${res.status}): ${xml.slice(0, 200)}`);
    }
    const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
    if (!match?.[1]) {
      throw new Error('S3 CreateMultipartUpload response missing <UploadId>');
    }
    return { uploadId: match[1].trim() };
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array
  ): Promise<{ partNumber: number; etag: string }> {
    const res = await this.signedFetch({
      method: 'PUT',
      key,
      query: [
        ['partNumber', String(partNumber)],
        ['uploadId', uploadId]
      ],
      headers: { 'content-type': 'application/octet-stream' },
      body
    });
    const txt = await res.text();
    if (!res.ok) {
      throw new Error(`S3 UploadPart ${partNumber} failed (${res.status}): ${txt.slice(0, 200)}`);
    }
    const etag = res.headers.get('etag')?.replace(/"/g, '') ?? (await sha256Hex(body));
    return { partNumber, etag };
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: CompletedUploadPart[]
  ): Promise<{ key: string; sizeBytes?: number; etag?: string }> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const xmlBody = [
      '<CompleteMultipartUpload>',
      ...sorted.map(
        (p) =>
          `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${escapeXml(p.etag.replace(/"/g, ''))}"</ETag></Part>`
      ),
      '</CompleteMultipartUpload>'
    ].join('');

    const res = await this.signedFetch({
      method: 'POST',
      key,
      query: [['uploadId', uploadId]],
      headers: { 'content-type': 'application/xml' },
      body: encoder.encode(xmlBody)
    });
    const xml = await res.text();
    if (!res.ok || /<Error[\s>]/.test(xml)) {
      throw new Error(`S3 CompleteMultipartUpload failed (${res.status}): ${xml.slice(0, 240)}`);
    }
    const etagMatch = xml.match(/<ETag>"?([^"<]+)"?<\/ETag>/);
    const head = await this.head(key);
    return {
      key,
      sizeBytes: head?.sizeBytes,
      etag: etagMatch?.[1] ?? head?.etag
    };
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    const res = await this.signedFetch({
      method: 'DELETE',
      key,
      query: [['uploadId', uploadId]]
    });
    await res.body?.cancel();
  }

  async computeSha256(key: string): Promise<{ sha256: string; sizeBytes: number }> {
    const res = await this.get(key);
    if (!res) {
      throw new Error(`Object missing on S3: ${key}`);
    }
    return computeStreamSha256(res.body);
  }

  async probe(): Promise<TestStorageTargetResponse> {
    const t0 = Date.now();
    const probeKey = `.smb-probe/${crypto.randomUUID()}.bin`;
    const probeBytes = encoder.encode(`kho-anh-s3-probe:${Date.now()}:${crypto.randomUUID()}`);
    const probeSha = await sha256Hex(probeBytes);
    const checks = { write: false, readVerify: false, delete: false };

    try {
      await this.put(probeKey, probeBytes, 'application/octet-stream', probeSha);
      checks.write = true;

      const digest = await this.computeSha256(probeKey);
      if (digest.sha256 !== probeSha || digest.sizeBytes !== probeBytes.length) {
        throw new Error('S3 probe SHA-256 mismatch');
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
        message: `Connected to ${this.provider} bucket "${this.bucket}" (${latencyMs}ms · write/read/SHA-256/delete verified)`
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
      const res = await this.signedFetch({ method: 'HEAD', key: '' });
      await res.body?.cancel();
      if (res.ok) {
        return { healthy: true, message: `Bucket ${this.bucket} reachable` };
      }
      return { healthy: false, message: `S3 bucket returned HTTP ${res.status}` };
    } catch (err) {
      return { healthy: false, message: (err as Error).message };
    }
  }
}
