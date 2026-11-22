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

export interface GoogleDriveAdapterOptions {
  providerLabel?: CloudStorageProvider | string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderName: string; // e.g. 'kho-anh-vault'
  stagingBucket?: R2Bucket;
}

export interface GoogleDriveQuotaInfo {
  email: string;
  displayName: string;
  limitBytes: number;
  usageBytes: number;
  freeBytes: number;
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024; // 4 MiB

// Per-isolate short-lived access token cache keyed by refreshToken prefix + clientId
const tokenCache = new Map<string, { accessToken: string; expiresAtMs: number }>();
const folderIdCache = new Map<string, string>();

function escapeDriveQuery(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export async function exchangeGoogleRefreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<string> {
  const cacheKey = `${clientId}:${refreshToken.slice(0, 24)}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Google OAuth token refresh failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error('Google OAuth response missing access_token');
  }
  const expiresInSec = Number(data.expires_in ?? 3500);
  tokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAtMs: Date.now() + Math.max(60, expiresInSec - 60) * 1000
  });
  return data.access_token;
}

export async function fetchGoogleDriveAbout(accessToken: string): Promise<GoogleDriveQuotaInfo> {
  const res = await fetch(
    `${GOOGLE_DRIVE_API}/about?fields=${encodeURIComponent('user(emailAddress,displayName),storageQuota(limit,usage,usageInDrive)')}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Google Drive about failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    user?: { emailAddress?: string; displayName?: string };
    storageQuota?: { limit?: string; usage?: string; usageInDrive?: string };
  };
  const limitBytes = Number(data.storageQuota?.limit ?? 0);
  const usageBytes = Number(data.storageQuota?.usage ?? data.storageQuota?.usageInDrive ?? 0);
  // Google Workspace unlimited accounts omit `limit`; default to 10 TiB if omitted
  const effectiveLimit =
    Number.isFinite(limitBytes) && limitBytes > 0 ? limitBytes : 10 * 1024 * 1024 * 1024 * 1024;
  const effectiveUsage = Number.isFinite(usageBytes) && usageBytes >= 0 ? usageBytes : 0;

  return {
    email: data.user?.emailAddress ?? 'unknown@gmail.com',
    displayName: data.user?.displayName ?? data.user?.emailAddress ?? 'Google Drive',
    limitBytes: effectiveLimit,
    usageBytes: effectiveUsage,
    freeBytes: Math.max(0, effectiveLimit - effectiveUsage)
  };
}

export class GoogleDriveStorageAdapter implements WorkerStorageAdapter {
  readonly provider: string;
  readonly bucket: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly stagingBucket?: R2Bucket;

  constructor(options: GoogleDriveAdapterOptions) {
    this.provider = options.providerLabel ?? 'google_drive';
    this.bucket = options.folderName.replace(/^\/+|\/+$/g, '') || 'kho-anh-vault';
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.refreshToken = options.refreshToken;
    this.stagingBucket = options.stagingBucket;
  }

  private async getAccessToken(): Promise<string> {
    return exchangeGoogleRefreshToken(this.clientId, this.clientSecret, this.refreshToken);
  }

  private folderCacheKey(): string {
    return `${this.clientId}:${this.refreshToken.slice(0, 16)}:${this.bucket}`;
  }

  private async ensureRootFolder(accessToken: string): Promise<string> {
    const cacheKey = this.folderCacheKey();
    const cached = folderIdCache.get(cacheKey);
    if (cached) return cached;

    const q = `mimeType = '${FOLDER_MIME}' and name = '${escapeDriveQuery(this.bucket)}' and trashed = false`;
    const listUrl = `${GOOGLE_DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!listRes.ok) {
      const errText = await listRes.text().catch(() => '');
      throw new Error(`Google Drive folder lookup failed (${listRes.status}): ${errText.slice(0, 200)}`);
    }
    const listData = (await listRes.json()) as { files?: Array<{ id: string }> };
    if (listData.files?.[0]?.id) {
      folderIdCache.set(cacheKey, listData.files[0].id);
      return listData.files[0].id;
    }

    const createRes = await fetch(`${GOOGLE_DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: this.bucket,
        mimeType: FOLDER_MIME
      })
    });
    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => '');
      throw new Error(`Google Drive folder create failed (${createRes.status}): ${errText.slice(0, 200)}`);
    }
    const created = (await createRes.json()) as { id: string };
    folderIdCache.set(cacheKey, created.id);
    return created.id;
  }

  private async findFileByKey(
    accessToken: string,
    key: string
  ): Promise<{ id: string; sizeBytes: number; md5Checksum?: string; mimeType?: string } | null> {
    const folderId = await this.ensureRootFolder(accessToken);
    const q = `'${escapeDriveQuery(folderId)}' in parents and name = '${escapeDriveQuery(key)}' and trashed = false`;
    const url = `${GOOGLE_DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,size,md5Checksum,mimeType)&pageSize=1`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      if (res.status === 404) return null;
      const errText = await res.text().catch(() => '');
      throw new Error(`Google Drive findFile failed (${res.status}): ${errText.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      files?: Array<{ id: string; size?: string; md5Checksum?: string; mimeType?: string }>;
    };
    const file = data.files?.[0];
    if (!file) return null;
    return {
      id: file.id,
      sizeBytes: Number(file.size ?? 0),
      md5Checksum: file.md5Checksum,
      mimeType: file.mimeType
    };
  }

  async fetchQuotaInfo(): Promise<GoogleDriveQuotaInfo> {
    const token = await this.getAccessToken();
    return fetchGoogleDriveAbout(token);
  }

  private stagingPartKey(uploadId: string, partNumber: number): string {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(uploadId)) {
      throw new Error('Invalid Google Drive multipart uploadId');
    }
    return `_staging/gdrive/${uploadId}/part-${String(partNumber).padStart(5, '0')}`;
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    contentType = 'application/octet-stream',
    sha256?: string
  ): Promise<{ key: string; sizeBytes?: number; etag?: string }> {
    const token = await this.getAccessToken();
    const folderId = await this.ensureRootFolder(token);

    let bytes: Uint8Array;
    if (body instanceof Uint8Array) {
      bytes = body;
    } else {
      bytes = new Uint8Array(await new Response(body).arrayBuffer());
    }

    if (sha256) {
      const actualSha = await sha256Hex(bytes);
      if (actualSha !== sha256.toLowerCase()) {
        throw new Error(`SHA-256 mismatch before Google Drive upload for ${key}`);
      }
    }

    const existing = await this.findFileByKey(token, key);

    if (bytes.byteLength <= SIMPLE_UPLOAD_LIMIT) {
      const boundary = `khoanh_${crypto.randomUUID().replace(/-/g, '')}`;
      const metadata = existing
        ? { name: key }
        : { name: key, parents: [folderId] };
      const enc = new TextEncoder();
      const preamble = enc.encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`
      );
      const epilogue = enc.encode(`\r\n--${boundary}--`);
      const multipartBody = concatBytes([preamble, bytes, epilogue]);

      const uploadUrl = existing
        ? `${GOOGLE_DRIVE_UPLOAD_API}/files/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=id,size,md5Checksum`
        : `${GOOGLE_DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,size,md5Checksum`;

      const res = await fetch(uploadUrl, {
        method: existing ? 'PATCH' : 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartBody.buffer.slice(
          multipartBody.byteOffset,
          multipartBody.byteOffset + multipartBody.byteLength
        ) as ArrayBuffer
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Google Drive multipart upload failed (${res.status}): ${errText.slice(0, 300)}`);
      }
      const uploaded = (await res.json()) as { id: string; size?: string; md5Checksum?: string };
      return {
        key,
        sizeBytes: Number(uploaded.size ?? bytes.byteLength),
        etag: uploaded.md5Checksum ?? uploaded.id
      };
    }

    // Resumable upload for files > 4 MiB
    const initUrl = existing
      ? `${GOOGLE_DRIVE_UPLOAD_API}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&fields=id,size,md5Checksum`
      : `${GOOGLE_DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,size,md5Checksum`;

    const initRes = await fetch(initUrl, {
      method: existing ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': String(bytes.byteLength)
      },
      body: JSON.stringify(existing ? { name: key } : { name: key, parents: [folderId] })
    });
    if (!initRes.ok) {
      const errText = await initRes.text().catch(() => '');
      throw new Error(`Google Drive resumable init failed (${initRes.status}): ${errText.slice(0, 300)}`);
    }
    const sessionUri = initRes.headers.get('location');
    if (!sessionUri) {
      throw new Error('Google Drive resumable upload missing Location header');
    }

    const putRes = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(bytes.byteLength)
      },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    });
    if (!putRes.ok) {
      const errText = await putRes.text().catch(() => '');
      throw new Error(`Google Drive resumable PUT failed (${putRes.status}): ${errText.slice(0, 300)}`);
    }
    const uploaded = (await putRes.json()) as { id: string; size?: string; md5Checksum?: string };
    return {
      key,
      sizeBytes: Number(uploaded.size ?? bytes.byteLength),
      etag: uploaded.md5Checksum ?? uploaded.id
    };
  }

  async get(key: string): Promise<StorageGetResult | null> {
    const token = await this.getAccessToken();
    const file = await this.findFileByKey(token, key);
    if (!file) return null;

    const res = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.status === 404) return null;
    if (!res.ok || !res.body) {
      throw new Error(`Google Drive GET failed (${res.status}) for ${key}`);
    }
    return {
      body: res.body,
      size: file.sizeBytes || Number(res.headers.get('content-length') ?? 0) || undefined,
      etag: file.md5Checksum ?? file.id,
      contentType: file.mimeType ?? res.headers.get('content-type') ?? undefined
    };
  }

  async getRange(key: string, start: number, end: number): Promise<StorageGetRangeResult | null> {
    const token = await this.getAccessToken();
    const file = await this.findFileByKey(token, key);
    if (!file) return null;

    const res = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Range: `bytes=${start}-${end}`
      }
    });
    if (res.status === 404) return null;
    if (!res.ok || !res.body) {
      throw new Error(`Google Drive GET range failed (${res.status}) for ${key}`);
    }
    return {
      body: res.body,
      size: Number(res.headers.get('content-length') ?? end - start + 1),
      contentRange: res.headers.get('content-range') ?? `bytes ${start}-${end}/${file.sizeBytes}`,
      contentType: file.mimeType ?? res.headers.get('content-type') ?? undefined
    };
  }

  async head(key: string): Promise<StorageHeadResult | null> {
    const token = await this.getAccessToken();
    const file = await this.findFileByKey(token, key);
    if (!file) return null;
    return {
      key,
      sizeBytes: file.sizeBytes,
      etag: file.md5Checksum ?? file.id
    };
  }

  async delete(key: string): Promise<void> {
    const token = await this.getAccessToken();
    const file = await this.findFileByKey(token, key);
    if (!file) return;
    const res = await fetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(file.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    await res.body?.cancel();
    if (!res.ok && res.status !== 404) {
      throw new Error(`Google Drive DELETE failed (${res.status}) for ${key}`);
    }
  }

  async createMultipart(_key: string, _contentType?: string): Promise<{ uploadId: string }> {
    if (!this.stagingBucket) {
      throw new Error('Google Drive multipart upload requires R2 staging bucket');
    }
    return { uploadId: `gd_${crypto.randomUUID().replace(/-/g, '')}` };
  }

  async uploadPart(
    _key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array
  ): Promise<{ partNumber: number; etag: string }> {
    if (!this.stagingBucket) {
      throw new Error('Google Drive multipart upload requires R2 staging bucket');
    }
    const stagingKey = this.stagingPartKey(uploadId, partNumber);
    const sha = await sha256Hex(body);
    await this.stagingBucket.put(
      stagingKey,
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
    );
    return { partNumber, etag: sha };
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: CompletedUploadPart[]
  ): Promise<{ key: string; sizeBytes?: number; etag?: string }> {
    if (!this.stagingBucket) {
      throw new Error('Google Drive multipart upload requires R2 staging bucket');
    }
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const chunks: Uint8Array[] = [];
    const stagingKeys: string[] = [];

    for (const p of sorted) {
      const sk = this.stagingPartKey(uploadId, p.partNumber);
      stagingKeys.push(sk);
      const obj = await this.stagingBucket.get(sk);
      if (!obj) {
        throw new Error(`Missing staged part ${p.partNumber} for Google Drive upload ${uploadId}`);
      }
      chunks.push(new Uint8Array(await obj.arrayBuffer()));
    }

    const assembled = concatBytes(chunks);
    const result = await this.put(key, assembled, 'application/octet-stream');
    await Promise.all(stagingKeys.map((k) => this.stagingBucket!.delete(k).catch(() => undefined)));
    return result;
  }

  async abortMultipart(_key: string, uploadId: string): Promise<void> {
    if (!this.stagingBucket?.list) return;
    const prefix = `_staging/gdrive/${uploadId}/`;
    const listed = await this.stagingBucket.list({ prefix, limit: 1000 });
    await Promise.all(
      listed.objects.map((o) => this.stagingBucket!.delete(o.key).catch(() => undefined))
    );
  }

  async computeSha256(key: string): Promise<{ sha256: string; sizeBytes: number }> {
    const obj = await this.get(key);
    if (!obj) {
      throw new Error(`Google Drive object not found: ${key}`);
    }
    return computeStreamSha256(obj.body);
  }

  async probe(): Promise<TestStorageTargetResponse> {
    const start = Date.now();
    const checks = { write: false, readVerify: false, delete: false };
    const probeKey = `_vault_probe_${crypto.randomUUID()}.txt`;
    const probePayload = new TextEncoder().encode(`kho-anh-gdrive-probe:${new Date().toISOString()}`);
    const expectedSha = await sha256Hex(probePayload);

    try {
      const quota = await this.fetchQuotaInfo();
      await this.put(probeKey, probePayload, 'text/plain', expectedSha);
      checks.write = true;

      const verified = await this.computeSha256(probeKey);
      if (verified.sha256 !== expectedSha || verified.sizeBytes !== probePayload.byteLength) {
        throw new Error('Google Drive probe SHA-256 mismatch');
      }
      checks.readVerify = true;

      await this.delete(probeKey);
      checks.delete = true;

      const freeGb = Math.round((quota.freeBytes / (1024 * 1024 * 1024)) * 10) / 10;
      const limitGb = Math.round((quota.limitBytes / (1024 * 1024 * 1024)) * 10) / 10;
      return {
        ok: true,
        provider: 'google_drive',
        latencyMs: Date.now() - start,
        checks,
        message: `Google Drive (${quota.email}) hoạt động tốt — còn trống ${freeGb} GB / ${limitGb} GB (ghi/đọc SHA-256/xóa OK).`
      };
    } catch (err) {
      try {
        await this.delete(probeKey);
      } catch {
        // ignore cleanup errors
      }
      return {
        ok: false,
        provider: 'google_drive',
        latencyMs: Date.now() - start,
        checks,
        message: err instanceof Error ? err.message : 'Google Drive probe failed'
      };
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      const quota = await this.fetchQuotaInfo();
      return {
        healthy: true,
        message: `Google Drive (${quota.email}) online`
      };
    } catch (err) {
      return {
        healthy: false,
        message: err instanceof Error ? err.message : 'Google Drive unreachable'
      };
    }
  }
}
