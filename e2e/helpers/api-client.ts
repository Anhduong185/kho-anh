import { sha256Hex } from './media-fixtures.js';

export interface RawApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  data: T;
  rawBytes: Buffer;
}

export class VaultApiClient {
  readonly baseUrl: string;
  accessToken: string | null = null;
  refreshToken: string | null = null;

  constructor(baseUrl = process.env.E2E_API_BASE_URL ?? 'http://127.0.0.1:3101', accessToken?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    if (accessToken) {
      this.accessToken = accessToken;
    }
  }

  withToken(accessToken: string): VaultApiClient {
    const c = new VaultApiClient(this.baseUrl, accessToken);
    return c;
  }

  async rawRequest<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<RawApiResponse<T>> {
    const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
    if (this.accessToken && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    let reqBody: BodyInit | undefined;
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
      reqBody = new Uint8Array(body);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/octet-stream';
      }
    } else if (body !== undefined) {
      reqBody = JSON.stringify(body);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: reqBody
    });

    const rawBytes = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? '';
    let data: unknown = null;
    if (rawBytes.length > 0 && (contentType.includes('application/json') || contentType === '')) {
      try {
        data = JSON.parse(rawBytes.toString('utf8'));
      } catch {
        data = rawBytes.toString('utf8');
      }
    }

    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      data: data as T,
      rawBytes
    };
  }

  async health() {
    return this.rawRequest<{ status: string; service: string; dbDriver: string; timestamp: string }>('GET', '/health');
  }

  async register(payload: Record<string, unknown>) {
    const res = await this.rawRequest<{
      user: {
        id: string;
        email: string;
        displayName: string;
        roles: string[];
        encryptionMode: 'server_side' | 'e2ee';
        e2eeConfigured: boolean;
        quotaBytes: number;
        usedBytes: number;
        isActive: boolean;
      };
      device: { id: string; deviceName: string; platform: string };
      tokens: { accessToken: string; refreshToken: string; accessTokenExpiresIn: number };
      recoveryCodes: string[];
    }>('POST', '/api/v1/auth/register', payload);
    if (res.ok && res.data?.tokens?.accessToken) {
      this.accessToken = res.data.tokens.accessToken;
      this.refreshToken = res.data.tokens.refreshToken;
    }
    return res;
  }

  async login(payload: { email: string; password: string; deviceName?: string; platform?: string }) {
    const res = await this.rawRequest<{
      user: {
        id: string;
        email: string;
        displayName: string;
        roles: string[];
        encryptionMode: 'server_side' | 'e2ee';
        e2eeConfigured: boolean;
        quotaBytes: number;
        usedBytes: number;
        isActive: boolean;
      };
      device: { id: string; deviceName: string; platform: string };
      tokens: { accessToken: string; refreshToken: string };
      e2eeKeyBundle?: { keySalt: string; encryptedMasterKey: string; kdfParams: Record<string, unknown> } | null;
    }>('POST', '/api/v1/auth/login', payload);
    if (res.ok && res.data?.tokens?.accessToken) {
      this.accessToken = res.data.tokens.accessToken;
      this.refreshToken = res.data.tokens.refreshToken;
    }
    return res;
  }

  async refresh(refreshToken: string) {
    return this.rawRequest<{ tokens: { accessToken: string; refreshToken: string } }>(
      'POST',
      '/api/v1/auth/refresh',
      { refreshToken }
    );
  }

  async logout() {
    return this.rawRequest<{ loggedOut: boolean }>('POST', '/api/v1/auth/logout');
  }

  async recover(payload: { email: string; recoveryCode: string; newPassword: string }) {
    return this.rawRequest<{
      recovered: boolean;
      remainingRecoveryCodes: number;
      e2eeVaultUnlockRequired: boolean;
      message: string;
    }>('POST', '/api/v1/auth/recover', payload);
  }

  async me() {
    return this.rawRequest<{
      user: {
        id: string;
        email: string;
        displayName: string;
        roles: string[];
        encryptionMode: 'server_side' | 'e2ee';
        e2eeConfigured: boolean;
        quotaBytes: number;
        usedBytes: number;
        isActive: boolean;
      };
      policies: {
        uploadNetworkPolicy: string;
        retentionPolicy: string;
        trashRetentionDays: number;
        gpsMapEnabled: boolean;
        searchEnabled: boolean;
        sharingEnabled: boolean;
        requiredReplicas: number;
      };
    }>('GET', '/api/v1/users/me');
  }

  async changePassword(currentPassword: string, newPassword: string) {
    return this.rawRequest<{ updated: boolean }>('PATCH', '/api/v1/users/me/password', {
      currentPassword,
      newPassword
    });
  }

  async updateE2eeKey(payload: {
    e2eeKeySalt: string;
    e2eeEncryptedMasterKey: string;
    e2eeKdfParams: Record<string, unknown>;
  }) {
    return this.rawRequest<{ configured: boolean }>('PUT', '/api/v1/users/me/e2ee-key', payload);
  }

  async listDevices() {
    return this.rawRequest<{ devices: Array<{ id: string; deviceName: string; platform: string; isTrusted: boolean; revokedAt: string | null }> }>(
      'GET',
      '/api/v1/devices'
    );
  }

  async revokeDevice(deviceId: string) {
    return this.rawRequest<{ revoked: boolean; deviceId: string }>('DELETE', `/api/v1/devices/${deviceId}`);
  }

  async checkDuplicates(items: Array<{ clientRef: string; sha256: string; sizeBytes: number; originalFilename: string }>) {
    return this.rawRequest<{
      results: Array<{
        clientRef: string;
        status: 'new' | 'duplicate' | 'resumable';
        duplicateOf?: { mediaId: string; originalFilename: string; sizeBytes: number };
      }>;
    }>('POST', '/api/v1/uploads/check-duplicates', { items });
  }

  async initUpload(payload: Record<string, unknown>) {
    return this.rawRequest<{
      status: 'ready' | 'duplicate';
      resumed?: boolean;
      sessionId?: string;
      chunkSizeBytes?: number;
      totalParts?: number;
      uploadedPartNumbers?: number[];
      duplicateOf?: { mediaId: string };
    }>('POST', '/api/v1/uploads/init', payload);
  }

  async uploadPart(sessionId: string, partNumber: number, chunk: Buffer | Uint8Array, partSha256?: string) {
    const sha = partSha256 ?? sha256Hex(chunk);
    return this.rawRequest<{
      partNumber: number;
      etag: string;
      partSha256: string;
      uploadedPartCount: number;
      totalParts: number;
      bytesUploaded: number;
    }>('PUT', `/api/v1/uploads/${sessionId}/parts/${partNumber}`, chunk, {
      'Content-Type': 'application/octet-stream',
      'X-Part-SHA256': sha
    });
  }

  async completeUpload(sessionId: string) {
    return this.rawRequest<{
      media: {
        id: string;
        originalFilename: string;
        mimeType: string;
        mediaKind: 'image' | 'video';
        sizeBytes: number;
        sha256: string;
        uploadState: string;
      };
      integrityVerified: boolean;
    }>('POST', `/api/v1/uploads/${sessionId}/complete`);
  }

  async uploadFile(opts: {
    filename: string;
    mimeType: string;
    bytes: Buffer;
    networkType?: 'wifi' | 'cellular' | 'unknown';
    chunkSizeBytes?: number;
    allowDuplicate?: boolean;
    encryptedFileKey?: string | null;
    encryptionIv?: string | null;
    capturedAt?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    const sha256 = sha256Hex(opts.bytes);
    const chunkSize = opts.chunkSizeBytes ?? 64 * 1024;
    const initRes = await this.initUpload({
      originalFilename: opts.filename,
      mimeType: opts.mimeType,
      sizeBytes: opts.bytes.length,
      sha256,
      networkType: opts.networkType ?? 'wifi',
      chunkSizeBytes: chunkSize,
      allowDuplicate: opts.allowDuplicate ?? false,
      encryptedFileKey: opts.encryptedFileKey ?? null,
      encryptionIv: opts.encryptionIv ?? null,
      capturedAt: opts.capturedAt ?? null,
      metadata: opts.metadata
    });

    if (!initRes.ok || initRes.data.status !== 'ready' || !initRes.data.sessionId) {
      return { sha256, initRes, completeRes: null };
    }

    const totalParts = initRes.data.totalParts ?? 1;
    const actualChunkSize = initRes.data.chunkSizeBytes ?? chunkSize;
    for (let part = 1; part <= totalParts; part++) {
      const start = (part - 1) * actualChunkSize;
      const end = Math.min(opts.bytes.length, start + actualChunkSize);
      const slice = opts.bytes.subarray(start, end);
      const partRes = await this.uploadPart(initRes.data.sessionId, part, slice);
      if (!partRes.ok) {
        throw new Error(`uploadPart(${part}) failed (${partRes.status}): ${JSON.stringify(partRes.data)}`);
      }
    }

    const completeRes = await this.completeUpload(initRes.data.sessionId);
    return { sha256, initRes, completeRes };
  }

  async listMedia(params?: Record<string, string | boolean>) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) {
      qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.rawRequest<{ items: Array<{ id: string; originalFilename: string; sha256: string; sizeBytes: number; isFavorite: boolean }>; total: number }>(
      'GET',
      `/api/v1/media${suffix}`
    );
  }

  async updateMedia(mediaId: string, payload: { isFavorite?: boolean; folderId?: string | null }) {
    return this.rawRequest<{ updated: boolean }>('PATCH', `/api/v1/media/${mediaId}`, payload);
  }

  async streamMedia(mediaId: string, rangeHeader?: string) {
    return this.rawRequest<unknown>(
      'GET',
      `/api/v1/media/${mediaId}/stream`,
      undefined,
      rangeHeader ? { Range: rangeHeader } : undefined
    );
  }

  async downloadMedia(mediaId: string) {
    return this.rawRequest<unknown>('GET', `/api/v1/media/${mediaId}/download`);
  }

  async verifyMedia(mediaId: string) {
    return this.rawRequest<{
      mediaId: string;
      verified: boolean;
      expectedSha256: string;
      actualSha256: string;
      sizeBytes: number;
    }>('GET', `/api/v1/media/${mediaId}/verify`);
  }

  async createFolder(name: string, parentId?: string | null) {
    return this.rawRequest<{ folder: { id: string; name: string; parentId: string | null } }>(
      'POST',
      '/api/v1/folders',
      { name, parentId: parentId ?? null }
    );
  }

  async createAlbum(name: string, folderId?: string | null) {
    return this.rawRequest<{ album: { id: string; name: string } }>('POST', '/api/v1/albums', {
      name,
      folderId: folderId ?? null
    });
  }

  async addMediaToAlbum(albumId: string, mediaIds: string[]) {
    return this.rawRequest<{ added: number }>('POST', `/api/v1/albums/${albumId}/media`, { mediaIds });
  }

  async createTag(name: string) {
    return this.rawRequest<{ tag: { id: string; name: string } }>('POST', '/api/v1/tags', { name });
  }

  async attachTag(mediaId: string, tagId: string) {
    return this.rawRequest<{ attached: boolean }>('POST', `/api/v1/media/${mediaId}/tags`, { tagId });
  }

  async storageSummary() {
    return this.rawRequest<{
      quotaBytes: number;
      usedBytes: number;
      totalFiles: number;
      trashCount: number;
    }>('GET', '/api/v1/storage/summary');
  }

  async exportZip(payload: { scope: 'selection' | 'album' | 'folder' | 'all'; mediaIds?: string[]; albumId?: string; folderId?: string }) {
    return this.rawRequest<unknown>('POST', '/api/v1/restore/export-zip', payload);
  }

  async trashMedia(mediaId: string) {
    return this.rawRequest<{ trashed: boolean }>('POST', `/api/v1/media/${mediaId}/trash`);
  }

  async listTrash() {
    return this.rawRequest<{ items: Array<{ mediaId: string; originalFilename: string; sizeBytes: number }> }>(
      'GET',
      '/api/v1/trash'
    );
  }

  async restoreTrash(mediaId: string) {
    return this.rawRequest<{ restored: boolean }>('POST', `/api/v1/trash/${mediaId}/restore`);
  }

  async permanentDeleteTrash(mediaId: string) {
    return this.rawRequest<{ permanentlyDeleted: boolean; freedBytes: number }>('DELETE', `/api/v1/trash/${mediaId}`);
  }

  // Admin endpoints
  async adminOverview() {
    return this.rawRequest<{
      totalUsers: number;
      activeUsers: number;
      totalDevices: number;
      totalMediaFiles: number;
      totalUsedBytes: number;
      totalQuotaBytes: number;
      settings: Record<string, unknown>;
    }>('GET', '/api/v1/admin/overview');
  }

  async adminUsers() {
    return this.rawRequest<{ users: Array<Record<string, unknown>> }>('GET', '/api/v1/admin/users');
  }

  async adminUpdateUser(userId: string, payload: { isActive?: boolean; quotaBytes?: number; isAdmin?: boolean }) {
    return this.rawRequest<{ updated: boolean; userId: string }>('PATCH', `/api/v1/admin/users/${userId}`, payload);
  }

  async adminGetSettings() {
    return this.rawRequest<{ settings: Record<string, unknown> }>('GET', '/api/v1/admin/settings');
  }

  async adminUpdateSettings(payload: Record<string, unknown>) {
    return this.rawRequest<{ settings: Record<string, unknown> }>('PATCH', '/api/v1/admin/settings', payload);
  }

  async adminGetStoragePool() {
    return this.rawRequest<{
      nodes: Array<{
        id: string;
        name: string;
        slot: string;
        provider: string;
        protocol: string;
        enabled: boolean;
        priority: number;
        capacityBytes: number;
        usedBytes: number;
        freeBytes: number;
      }>;
      summary: {
        targetGoalBytes: number;
        grandTotalCapacityBytes: number;
        grandTotalUsedBytes: number;
        bySlot: Record<
          string,
          {
            nodeCount: number;
            activeNodeCount: number;
            totalCapacityBytes: number;
            totalUsedBytes: number;
            totalFreeBytes: number;
          }
        >;
      };
      presets: Array<{ provider: string; protocol: string; label: string }>;
    }>('GET', '/api/v1/admin/storage/pool');
  }

  async adminTestPoolDraft(payload: Record<string, unknown>) {
    return this.rawRequest<{
      result: {
        ok: boolean;
        provider: string;
        latencyMs: number;
        checks: { write: boolean; readVerify: boolean; delete: boolean };
        message: string;
      };
    }>('POST', '/api/v1/admin/storage/pool/test', payload);
  }

  async adminCreatePoolNode(payload: Record<string, unknown>) {
    return this.rawRequest<{
      node: { id: string; name: string; provider: string; protocol: string; capacityBytes: number };
      summary: {
        grandTotalCapacityBytes: number;
        bySlot: Record<string, { totalCapacityBytes: number; activeNodeCount: number }>;
      };
    }>('POST', '/api/v1/admin/storage/pool/nodes', payload);
  }

  async adminUpdatePoolNode(nodeId: string, payload: Record<string, unknown>) {
    return this.rawRequest<{
      node: { id: string; enabled: boolean; priority: number; capacityBytes: number };
      summary: Record<string, unknown>;
    }>('PATCH', `/api/v1/admin/storage/pool/nodes/${nodeId}`, payload);
  }

  async adminTestPoolNode(nodeId: string) {
    return this.rawRequest<{
      result: { ok: boolean; checks: { write: boolean; readVerify: boolean; delete: boolean }; message: string };
    }>('POST', `/api/v1/admin/storage/pool/nodes/${nodeId}/test`);
  }

  async adminDeletePoolNode(nodeId: string) {
    return this.rawRequest<{ removed: boolean }>('DELETE', `/api/v1/admin/storage/pool/nodes/${nodeId}`);
  }

  async adminRunReplication() {
    return this.rawRequest<{ result: Record<string, unknown> }>('POST', '/api/v1/admin/replication/run');
  }

  async adminIntegritySummary() {
    return this.rawRequest<{ replicaBreakdown: Array<{ slot: string; state: string; count: number }> }>(
      'GET',
      '/api/v1/admin/integrity/summary'
    );
  }

  async adminRunIntegrityScan() {
    return this.rawRequest<{ result: Record<string, unknown> }>('POST', '/api/v1/admin/integrity/scan');
  }
}
