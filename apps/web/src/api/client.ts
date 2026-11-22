import type {
  AdminOverview,
  AdminStoragePoolResponse,
  AdminUserSummary,
  AlbumItem,
  ApiErrorBody,
  AuthTokens,
  CloudStorageProvider,
  CompleteUploadResponse,
  CreateOrUpdateStorageNodeRequest,
  DeviceInfo,
  DownloadUrlResponse,
  DuplicateCheckItem,
  DuplicateCheckResult,
  DuplicateGroup,
  FileVersionItem,
  FolderItem,
  GoogleDriveOAuthConfigView,
  GoogleDriveOAuthStartResponse,
  GoogleDriveRefreshQuotaResponse,
  InitUploadRequest,
  InitUploadResponse,
  IntegrityScanResult,
  LoginRequest,
  LoginResponse,
  MediaFileItem,
  NotificationItem,
  PoolCapacitySummary,
  PresignPartResponse,
  RecoverAccountRequest,
  RecoverAccountResponse,
  RegisterRequest,
  RegisterResponse,
  ReplicaBreakdownItem,
  ReplicaSlot,
  ReplicationRunResult,
  SaveStorageTargetRequest,
  StorageMigrationResult,
  StorageNodeView,
  StorageSummaryResponse,
  StorageTargetConfigView,
  SyncPoolQuotaResponse,
  SystemSettingsMap,
  TagItem,
  TestStorageTargetResponse,
  TrashItemSummary,
  UploadSessionStatusResponse,
  UserProfile,
  VerifyMediaIntegrityResponse
} from '@smb/shared';

const TOKEN_STORAGE_KEY = 'smb_auth_tokens_v1';
const SERVER_URL_STORAGE_KEY = 'smb_server_url_v1';

const ENV_API_BASE = (
  (import.meta as { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL ?? ''
).replace(/\/$/, '');

const ENV_MOBILE_DEFAULT_API = (
  (import.meta as { env?: { VITE_MOBILE_DEFAULT_API_URL?: string } }).env
    ?.VITE_MOBILE_DEFAULT_API_URL || 'https://kho-anh.anhduong-vault.workers.dev'
).replace(/\/$/, '');

export function isCapacitorNativeApp(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap?.isNativePlatform?.()) return true;
  // Also handle Capacitor WebView served at https://localhost (no dev port)
  return (
    (window.location.protocol === 'capacitor:' ||
      (window.location.protocol === 'https:' &&
        window.location.hostname === 'localhost' &&
        window.location.port === '')) &&
    Boolean(ENV_MOBILE_DEFAULT_API)
  );
}

export function getServerBaseUrl(): string {
  try {
    const saved = localStorage.getItem(SERVER_URL_STORAGE_KEY);
    if (saved && saved.trim()) {
      return saved.trim().replace(/\/$/, '');
    }
  } catch {
    // ignore storage errors
  }
  if (ENV_API_BASE) return ENV_API_BASE;
  if (isCapacitorNativeApp() && ENV_MOBILE_DEFAULT_API) return ENV_MOBILE_DEFAULT_API;
  return '';
}

export function setServerBaseUrl(url: string): void {
  const cleaned = url.trim().replace(/\/$/, '');
  if (!cleaned) {
    localStorage.removeItem(SERVER_URL_STORAGE_KEY);
    return;
  }
  localStorage.setItem(SERVER_URL_STORAGE_KEY, cleaned);
}

function apiUrl(path: string): string {
  const base = getServerBaseUrl();
  return `${base}${path}`;
}

export async function checkServerHealth(customBaseUrl?: string): Promise<{
  ok: boolean;
  dbDriver?: string;
  message: string;
}> {
  const base = (customBaseUrl !== undefined ? customBaseUrl : getServerBaseUrl())
    .trim()
    .replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/health`, { method: 'GET' });
    if (!res.ok) {
      return { ok: false, message: `Máy chủ phản hồi HTTP ${res.status}` };
    }
    const data = (await res.json()) as { status?: string; dbDriver?: string };
    return {
      ok: data.status === 'ok',
      dbDriver: data.dbDriver,
      message: `Kết nối máy chủ thành công (${base || 'cùng tên miền'} · DB: ${data.dbDriver ?? 'pg'})`
    };
  } catch (err) {
    return {
      ok: false,
      message: `Không kết nối được tới ${base || 'máy chủ'} (${(err as Error).message}). Hãy kiểm tra Wi-Fi và địa chỉ IP/URL.`
    };
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function loadStoredTokens(): AuthTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthTokens;
  } catch {
    return null;
  }
}

export function saveStoredTokens(tokens: AuthTokens | null): void {
  if (!tokens) {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    return;
  }
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
}

let refreshPromise: Promise<AuthTokens | null> | null = null;

async function refreshSession(): Promise<AuthTokens | null> {
  if (refreshPromise) return refreshPromise;

  const current = loadStoredTokens();
  if (!current?.refreshToken) return null;

  refreshPromise = (async () => {
    try {
      const res = await fetch(apiUrl('/api/v1/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken })
      });
      if (!res.ok) {
        saveStoredTokens(null);
        return null;
      }
      const data = (await res.json()) as { tokens: AuthTokens };
      saveStoredTokens(data.tokens);
      return data.tokens;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function request<T>(
  path: string,
  options: RequestInit & { auth?: boolean } = {},
  retried = false
): Promise<T> {
  const { auth = true, headers, ...rest } = options;
  const reqHeaders = new Headers(headers);
  if (rest.body && !reqHeaders.has('Content-Type')) {
    reqHeaders.set('Content-Type', 'application/json');
  }

  if (auth) {
    const tokens = loadStoredTokens();
    if (tokens?.accessToken) {
      reqHeaders.set('Authorization', `Bearer ${tokens.accessToken}`);
    }
  }

  const res = await fetch(apiUrl(path), { ...rest, headers: reqHeaders });

  if (res.status === 401 && auth && !retried) {
    const renewed = await refreshSession();
    if (renewed) {
      return request<T>(path, options, true);
    }
  }

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const errBody = data as ApiErrorBody | null;
    throw new ApiError(
      res.status,
      errBody?.error?.code ?? 'API_ERROR',
      errBody?.error?.message ?? `Request failed with status ${res.status}`
    );
  }

  return data as T;
}

async function fetchAuthBlob(
  url: string,
  init: RequestInit = {},
  retried = false
): Promise<{ blob: Blob; headers: Headers }> {
  const tokens = loadStoredTokens();
  const headers = new Headers(init.headers);
  if (tokens?.accessToken) {
    headers.set('Authorization', `Bearer ${tokens.accessToken}`);
  }
  const res = await fetch(apiUrl(url), { ...init, headers });
  if (res.status === 401 && !retried) {
    const renewed = await refreshSession();
    if (renewed) return fetchAuthBlob(url, init, true);
  }
  if (!res.ok) {
    throw new ApiError(res.status, 'BINARY_FETCH_FAILED', `Request failed (${res.status})`);
  }
  return { blob: await res.blob(), headers: res.headers };
}

export interface MeResponse {
  user: UserProfile;
  policies: {
    uploadNetworkPolicy: string;
    retentionPolicy: string;
    trashRetentionDays: number;
    gpsMapEnabled: boolean;
    searchEnabled: boolean;
    sharingEnabled: boolean;
    requiredReplicas: number;
  };
}

export interface SecurityEventItem {
  id: string;
  eventType: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export const api = {
  // Phase 1: Auth, Devices & RBAC
  register: (payload: RegisterRequest) =>
    request<RegisterResponse>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
      auth: false
    }),

  login: (payload: LoginRequest) =>
    request<LoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
      auth: false
    }),

  recover: (payload: RecoverAccountRequest) =>
    request<RecoverAccountResponse>('/api/v1/auth/recover', {
      method: 'POST',
      body: JSON.stringify(payload),
      auth: false
    }),

  logout: () => request<{ loggedOut: boolean }>('/api/v1/auth/logout', { method: 'POST' }),

  me: () => request<MeResponse>('/api/v1/users/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ updated: boolean }>('/api/v1/users/me/password', {
      method: 'PATCH',
      body: JSON.stringify({ currentPassword, newPassword })
    }),

  regenerateRecoveryCodes: (currentPassword: string) =>
    request<{ recoveryCodes: string[] }>('/api/v1/users/me/recovery-codes/regenerate', {
      method: 'POST',
      body: JSON.stringify({ currentPassword })
    }),

  listDevices: () => request<{ devices: DeviceInfo[] }>('/api/v1/devices'),

  revokeDevice: (deviceId: string) =>
    request<{ revoked: boolean }>(`/api/v1/devices/${deviceId}`, { method: 'DELETE' }),

  updateDeviceTrust: (deviceId: string, isTrusted: boolean) =>
    request<{ updated: boolean }>(`/api/v1/devices/${deviceId}/trust`, {
      method: 'PATCH',
      body: JSON.stringify({ isTrusted })
    }),

  securityEvents: () => request<{ events: SecurityEventItem[] }>('/api/v1/security/events'),

  // Phase 2: Resumable Upload & Original Media
  checkDuplicates: (items: DuplicateCheckItem[]) =>
    request<{ results: DuplicateCheckResult[] }>('/api/v1/uploads/check-duplicates', {
      method: 'POST',
      body: JSON.stringify({ items })
    }),

  initUpload: (payload: InitUploadRequest) =>
    request<InitUploadResponse>('/api/v1/uploads/init', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),

  getUploadSession: (sessionId: string) =>
    request<UploadSessionStatusResponse>(`/api/v1/uploads/${sessionId}`),

  presignUploadPart: (sessionId: string, partNumber: number) =>
    request<PresignPartResponse>(`/api/v1/uploads/${sessionId}/parts/${partNumber}/presign`, {
      method: 'POST'
    }),

  confirmUploadedPart: (
    sessionId: string,
    partNumber: number,
    payload: { etag: string; sizeBytes: number; partSha256: string }
  ) =>
    request<{ uploadedPartCount: number; totalParts: number; bytesUploaded: number }>(
      `/api/v1/uploads/${sessionId}/parts/${partNumber}/confirm`,
      {
        method: 'POST',
        body: JSON.stringify(payload)
      }
    ),

  getDownloadUrl: (mediaId: string) =>
    request<DownloadUrlResponse>(`/api/v1/media/${mediaId}/download-url`),

  uploadPart: async (
    sessionId: string,
    partNumber: number,
    chunk: Uint8Array,
    partSha256: string,
    signal?: AbortSignal
  ): Promise<{ uploadedPartCount: number; totalParts: number; bytesUploaded: number }> => {
    const attempt = async (
      retried: boolean
    ): Promise<{ uploadedPartCount: number; totalParts: number; bytesUploaded: number }> => {
      const tokens = loadStoredTokens();
      const headers = new Headers({
        'Content-Type': 'application/octet-stream',
        'X-Part-SHA256': partSha256
      });
      if (tokens?.accessToken) {
        headers.set('Authorization', `Bearer ${tokens.accessToken}`);
      }
      const res = await fetch(apiUrl(`/api/v1/uploads/${sessionId}/parts/${partNumber}`), {
        method: 'PUT',
        headers,
        body: chunk as unknown as BodyInit,
        signal
      });
      if (res.status === 401 && !retried) {
        const renewed = await refreshSession();
        if (renewed) return attempt(true);
      }
      const text = await res.text();
      const data = text ? (JSON.parse(text) as unknown) : null;
      if (!res.ok) {
        const errBody = data as ApiErrorBody | null;
        throw new ApiError(
          res.status,
          errBody?.error?.code ?? 'PART_UPLOAD_FAILED',
          errBody?.error?.message ?? `Chunk upload failed (${res.status})`
        );
      }
      return data as { uploadedPartCount: number; totalParts: number; bytesUploaded: number };
    };
    return attempt(false);
  },

  completeUpload: (sessionId: string) =>
    request<CompleteUploadResponse>(`/api/v1/uploads/${sessionId}/complete`, { method: 'POST' }),

  abortUpload: (sessionId: string) =>
    request<{ aborted: boolean }>(`/api/v1/uploads/${sessionId}`, { method: 'DELETE' }),

  // Phase 3: Library, Folders, Albums, Tags & Streaming
  listMedia: (params?: {
    kind?: 'all' | 'image' | 'video';
    favoriteOnly?: boolean;
    albumId?: string;
    folderId?: string;
    tagId?: string;
    sortBy?: 'created_at' | 'captured_at' | 'size_bytes' | 'original_filename';
    sortDir?: 'asc' | 'desc';
  }) => {
    const qs = new URLSearchParams();
    if (params?.kind) qs.set('kind', params.kind);
    if (params?.favoriteOnly) qs.set('favoriteOnly', 'true');
    if (params?.albumId) qs.set('albumId', params.albumId);
    if (params?.folderId) qs.set('folderId', params.folderId);
    if (params?.tagId) qs.set('tagId', params.tagId);
    if (params?.sortBy) qs.set('sortBy', params.sortBy);
    if (params?.sortDir) qs.set('sortDir', params.sortDir);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ items: MediaFileItem[]; total: number }>(`/api/v1/media${suffix}`);
  },

  updateMedia: (mediaId: string, payload: { isFavorite?: boolean; folderId?: string | null }) =>
    request<{ updated: boolean }>(`/api/v1/media/${mediaId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }),

  streamMediaBlob: (mediaId: string) => fetchAuthBlob(`/api/v1/media/${mediaId}/stream`),

  downloadOriginalMedia: async (
    mediaId: string
  ): Promise<{ blob: Blob; expectedSha256: string | null }> => {
    const { blob, headers } = await fetchAuthBlob(`/api/v1/media/${mediaId}/download`);
    return { blob, expectedSha256: headers.get('X-Content-SHA256') };
  },

  verifyMediaIntegrity: (mediaId: string) =>
    request<VerifyMediaIntegrityResponse>(`/api/v1/media/${mediaId}/verify`),

  listFolders: () => request<{ folders: FolderItem[] }>('/api/v1/folders'),
  createFolder: (name: string, parentId?: string | null) =>
    request<{ folder: FolderItem }>('/api/v1/folders', {
      method: 'POST',
      body: JSON.stringify({ name, parentId: parentId ?? null })
    }),
  deleteFolder: (id: string) => request<{ deleted: boolean }>(`/api/v1/folders/${id}`, { method: 'DELETE' }),

  listAlbums: () => request<{ albums: AlbumItem[] }>('/api/v1/albums'),
  createAlbum: (name: string, folderId?: string | null) =>
    request<{ album: AlbumItem }>('/api/v1/albums', {
      method: 'POST',
      body: JSON.stringify({ name, folderId: folderId ?? null })
    }),
  deleteAlbum: (id: string) => request<{ deleted: boolean }>(`/api/v1/albums/${id}`, { method: 'DELETE' }),
  addMediaToAlbum: (albumId: string, mediaIds: string[]) =>
    request<{ added: number }>(`/api/v1/albums/${albumId}/media`, {
      method: 'POST',
      body: JSON.stringify({ mediaIds })
    }),
  removeMediaFromAlbum: (albumId: string, mediaId: string) =>
    request<{ removed: boolean }>(`/api/v1/albums/${albumId}/media/${mediaId}`, { method: 'DELETE' }),

  listTags: () => request<{ tags: TagItem[] }>('/api/v1/tags'),
  createTag: (name: string) =>
    request<{ tag: TagItem }>('/api/v1/tags', { method: 'POST', body: JSON.stringify({ name }) }),
  attachTag: (mediaId: string, tagId: string) =>
    request<{ attached: boolean }>(`/api/v1/media/${mediaId}/tags`, {
      method: 'POST',
      body: JSON.stringify({ tagId })
    }),
  detachTag: (mediaId: string, tagId: string) =>
    request<{ detached: boolean }>(`/api/v1/media/${mediaId}/tags/${tagId}`, { method: 'DELETE' }),

  // Phase 4: Restore, Duplicates, Trash & Versions
  storageSummary: () => request<StorageSummaryResponse>('/api/v1/storage/summary'),
  listDuplicates: () => request<{ groups: DuplicateGroup[] }>('/api/v1/storage/duplicates'),
  exportZip: (payload: {
    scope: 'selection' | 'album' | 'folder' | 'all';
    mediaIds?: string[];
    albumId?: string;
    folderId?: string;
  }) =>
    fetchAuthBlob('/api/v1/restore/export-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }),

  trashMedia: (mediaId: string) =>
    request<{ trashed: boolean }>(`/api/v1/media/${mediaId}/trash`, { method: 'POST' }),
  listTrash: () => request<{ items: TrashItemSummary[] }>('/api/v1/trash'),
  restoreTrash: (mediaId: string) =>
    request<{ restored: boolean }>(`/api/v1/trash/${mediaId}/restore`, { method: 'POST' }),
  permanentDeleteTrash: (mediaId: string) =>
    request<{ permanentlyDeleted: boolean; freedBytes: number }>(`/api/v1/trash/${mediaId}`, {
      method: 'DELETE'
    }),
  listVersions: (mediaId: string) =>
    request<{ versions: FileVersionItem[] }>(`/api/v1/media/${mediaId}/versions`),

  // Phase 5: Notifications
  listNotifications: () =>
    request<{ notifications: NotificationItem[]; unreadCount: number }>('/api/v1/notifications'),
  markNotificationRead: (id: string) =>
    request<{ read: boolean }>(`/api/v1/notifications/${id}/read`, { method: 'PATCH' }),
  markAllNotificationsRead: () =>
    request<{ readAll: boolean }>('/api/v1/notifications/read-all', { method: 'POST' }),

  // Phase 1 & 6: Admin Infrastructure, Replication & Integrity
  adminOverview: () => request<AdminOverview>('/api/v1/admin/overview'),
  adminUsers: () => request<{ users: AdminUserSummary[] }>('/api/v1/admin/users'),
  adminUpdateUser: (
    userId: string,
    payload: { isActive?: boolean; quotaBytes?: number; isAdmin?: boolean }
  ) =>
    request<{ updated: boolean; userId?: string }>(`/api/v1/admin/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }),
  adminGetSettings: () => request<{ settings: SystemSettingsMap }>('/api/v1/admin/settings'),
  adminUpdateSettings: (
    payload: Partial<
      Pick<SystemSettingsMap, 'registration_enabled' | 'trash_retention_days' | 'required_replicas'>
    >
  ) =>
    request<{ settings: SystemSettingsMap }>('/api/v1/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }),
  adminRunReplication: () =>
    request<{ result: ReplicationRunResult }>('/api/v1/admin/replication/run', { method: 'POST' }),
  adminRunIntegrityScan: () =>
    request<{ result: IntegrityScanResult }>('/api/v1/admin/integrity/scan', { method: 'POST' }),
  adminIntegritySummary: () =>
    request<{ replicaBreakdown: ReplicaBreakdownItem[] }>('/api/v1/admin/integrity/summary'),

  // Cloud Storage Targets Management (R2, B2, OCI, MinIO, S3, Local)
  adminListStorageTargets: () =>
    request<{
      targets: StorageTargetConfigView[];
      presets: Array<{
        provider: CloudStorageProvider;
        label: string;
        freeTier: string;
        requiresCard: boolean;
        endpointTemplate: string;
        defaultRegion: string;
        notes: string;
      }>;
    }>('/api/v1/admin/storage/targets'),

  adminTestStorageTarget: (slot: ReplicaSlot, payload?: SaveStorageTargetRequest) =>
    request<{ result: TestStorageTargetResponse }>(`/api/v1/admin/storage/targets/${slot}/test`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {})
    }),

  adminSaveStorageTarget: (slot: ReplicaSlot, payload: SaveStorageTargetRequest) =>
    request<{ saved: boolean; target: StorageTargetConfigView }>(
      `/api/v1/admin/storage/targets/${slot}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload)
      }
    ),

  adminRemoveStorageTarget: (slot: ReplicaSlot) =>
    request<{ removed: boolean }>(`/api/v1/admin/storage/targets/${slot}`, {
      method: 'DELETE'
    }),

  adminMigrateStorage: (sourceSlot: ReplicaSlot, targetSlot: ReplicaSlot) =>
    request<{ result: StorageMigrationResult }>('/api/v1/admin/storage/migrate', {
      method: 'POST',
      body: JSON.stringify({ sourceSlot, targetSlot })
    }),

  // Multi-Cloud Storage Pool API (Unlimited S3 + WebDAV + Local Nodes -> >= 400 GB)
  adminGetStoragePool: () => request<AdminStoragePoolResponse>('/api/v1/admin/storage/pool'),

  adminTestPoolNodeDraft: (payload: CreateOrUpdateStorageNodeRequest) =>
    request<{ result: TestStorageTargetResponse }>('/api/v1/admin/storage/pool/test', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),

  adminCreatePoolNode: (payload: CreateOrUpdateStorageNodeRequest) =>
    request<{ node: StorageNodeView; summary: PoolCapacitySummary }>('/api/v1/admin/storage/pool/nodes', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),

  adminUpdatePoolNode: (nodeId: string, payload: Partial<CreateOrUpdateStorageNodeRequest>) =>
    request<{ node: StorageNodeView; summary: PoolCapacitySummary }>(
      `/api/v1/admin/storage/pool/nodes/${nodeId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      }
    ),

  adminTestPoolNode: (nodeId: string) =>
    request<{ result: TestStorageTargetResponse }>(`/api/v1/admin/storage/pool/nodes/${nodeId}/test`, {
      method: 'POST'
    }),

  adminDeletePoolNode: (nodeId: string) =>
    request<{ removed: boolean; summary: PoolCapacitySummary }>(
      `/api/v1/admin/storage/pool/nodes/${nodeId}`,
      { method: 'DELETE' }
    ),

  adminSyncPoolQuota: (userId?: string) =>
    request<SyncPoolQuotaResponse>('/api/v1/admin/users/sync-pool-quota', {
      method: 'POST',
      body: JSON.stringify(userId ? { userId } : {})
    }),

  adminGetGoogleDriveConfig: () =>
    request<GoogleDriveOAuthConfigView>('/api/v1/admin/storage/pool/google-drive/config'),

  adminSaveGoogleDriveConfig: (payload: { clientId: string; clientSecret?: string }) =>
    request<GoogleDriveOAuthConfigView>('/api/v1/admin/storage/pool/google-drive/config', {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),

  adminStartGoogleDriveOAuth: (payload?: {
    slot?: ReplicaSlot;
    folderName?: string;
    priority?: number;
    openerOrigin?: string;
  }) =>
    request<GoogleDriveOAuthStartResponse>('/api/v1/admin/storage/pool/google-drive/oauth/start', {
      method: 'POST',
      body: JSON.stringify(payload ?? {})
    }),

  adminRefreshGoogleDriveQuota: (nodeId: string) =>
    request<GoogleDriveRefreshQuotaResponse>(
      `/api/v1/admin/storage/pool/google-drive/${nodeId}/refresh-quota`,
      { method: 'POST' }
    )
};
