export type RoleName = 'user' | 'admin';

export const DEFAULT_R2_FREE_CAPACITY_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB (real Cloudflare R2 free tier)
export const DEFAULT_USER_QUOTA_BYTES = 100 * 1024 * 1024 * 1024; // 100 GiB default (Admin can sync to full Pool 500GB-5TB+)
export const POOL_TARGET_GOAL_BYTES = 1024 * 1024 * 1024 * 1024; // 1 TiB target goal

export type EncryptionMode = 'server_side' | 'e2ee';

export type DevicePlatform = 'ios' | 'android' | 'windows' | 'web';

export type UploadNetworkPolicy = 'wifi_only';

export type RetentionPolicy = 'indefinite_manual_delete';

export type MediaKind = 'image' | 'video';

export type MediaUploadState =
  | 'detected'
  | 'queued'
  | 'uploading'
  | 'uploaded'
  | 'verifying'
  | 'verified'
  | 'insufficient_replicas'
  | 'failed';

export type ReplicaSlot = 'copy1_primary' | 'copy2_secondary' | 'copy3_offsite';

export type ReplicaHealthState = 'pending' | 'syncing' | 'verified' | 'corrupted' | 'missing';

export type CloudStorageProvider =
  | 'local'
  | 'cloudflare_r2'
  | 'google_drive'
  | 'backblaze_b2'
  | 'oracle_oci'
  | 'oracle_vm_minio'
  | 'infinicloud_webdav'
  | 'koofr_webdav'
  | 'webdav_custom'
  | 'minio'
  | 's3_custom';

export type StorageProtocol = 'local' | 's3' | 'webdav' | 'gdrive';

export interface StorageNodeView {
  id: string;
  name: string;
  slot: ReplicaSlot;
  provider: CloudStorageProvider;
  protocol: StorageProtocol;
  enabled: boolean;
  priority: number;
  capacityBytes: number;
  usedBytes: number;
  freeBytes: number;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyIdPreview: string;
  hasSecretKey: boolean;
  forcePathStyle: boolean;
  localRoot: string;
  lastTestOk: boolean | null;
  lastTestAt: string | null;
  lastTestMessage: string | null;
  createdAt: string;
}

export interface CreateOrUpdateStorageNodeRequest {
  name: string;
  slot: ReplicaSlot;
  provider: CloudStorageProvider;
  enabled?: boolean;
  priority?: number;
  capacityBytes: number;
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  localRoot?: string;
}

export interface PoolCapacitySummary {
  targetGoalBytes: number;
  bySlot: Record<
    ReplicaSlot,
    {
      nodeCount: number;
      activeNodeCount: number;
      totalCapacityBytes: number;
      totalUsedBytes: number;
      totalFreeBytes: number;
      percentOfGoal: number;
    }
  >;
  grandTotalCapacityBytes: number;
  grandTotalUsedBytes: number;
}

export interface StorageTargetConfigView {
  slot: ReplicaSlot;
  provider: CloudStorageProvider;
  enabled: boolean;
  configured: boolean;
  source: 'database' | 'env' | 'default';
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyIdPreview: string;
  hasSecretKey: boolean;
  forcePathStyle: boolean;
  localRoot: string;
  lastTestOk: boolean | null;
  lastTestAt: string | null;
  lastTestMessage: string | null;
}

export interface SaveStorageTargetRequest {
  provider: CloudStorageProvider;
  enabled?: boolean;
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  localRoot?: string;
}

export interface TestStorageTargetResponse {
  ok: boolean;
  provider: CloudStorageProvider;
  latencyMs: number;
  checks: {
    write: boolean;
    readVerify: boolean;
    delete: boolean;
  };
  message: string;
}

export interface StorageMigrationResult {
  sourceSlot: ReplicaSlot;
  targetSlot: ReplicaSlot;
  migratedCount: number;
  skippedAlreadyVerified: number;
  failedCount: number;
  failures: Array<{ objectKey: string; error: string }>;
}

export interface PresignPartResponse {
  mode: 'presigned_s3' | 'api_chunk';
  uploadUrl: string | null;
  expiresInSeconds: number;
}

export interface DownloadUrlResponse {
  mode: 'presigned_s3' | 'api_proxy';
  url: string;
  expiresInSeconds: number;
  originalFilename: string;
  expectedSha256: string;
  sizeBytes: number;
}

export type NotificationCategory =
  | 'backup_progress'
  | 'backup_success'
  | 'backup_failed'
  | 'backup_pending'
  | 'device_health'
  | 'security_alert'
  | 'storage_status';

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  roles: RoleName[];
  encryptionMode: EncryptionMode;
  e2eeConfigured: boolean;
  quotaBytes: number;
  usedBytes: number;
  isActive: boolean;
  createdAt: string;
}

export interface DeviceInfo {
  id: string;
  deviceName: string;
  platform: DevicePlatform;
  isTrusted: boolean;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  isCurrent?: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
}

export interface RegisterRequest {
  email: string;
  password: string;
  displayName: string;
  encryptionMode: EncryptionMode;
  deviceName?: string;
  platform?: DevicePlatform;
  e2eeKeySalt?: string;
  e2eeEncryptedMasterKey?: string;
  e2eeKdfParams?: Record<string, unknown>;
}

export interface RegisterResponse {
  user: UserProfile;
  device: DeviceInfo;
  tokens: AuthTokens;
  recoveryCodes: string[];
}

export interface LoginRequest {
  email: string;
  password: string;
  deviceName?: string;
  platform?: DevicePlatform;
}

export interface E2eeKeyBundle {
  keySalt: string;
  encryptedMasterKey: string;
  kdfParams: Record<string, unknown>;
}

export interface LoginResponse {
  user: UserProfile;
  device: DeviceInfo;
  tokens: AuthTokens;
  e2eeKeyBundle?: E2eeKeyBundle | null;
}

export interface RecoverAccountRequest {
  email: string;
  recoveryCode: string;
  newPassword: string;
  deviceName?: string;
  platform?: DevicePlatform;
}

export interface RecoverAccountResponse {
  recovered: true;
  remainingRecoveryCodes: number;
  e2eeVaultUnlockRequired: boolean;
  message: string;
}

export interface StorageTargetStatus {
  slot: ReplicaSlot;
  provider: string;
  configured: boolean;
  healthy: boolean;
  message?: string;
}

export interface SystemSettingsMap {
  upload_network_policy: UploadNetworkPolicy;
  retention_policy: RetentionPolicy;
  trash_retention_days: number;
  gps_map_enabled: boolean;
  search_enabled: boolean;
  sharing_enabled: boolean;
  registration_enabled: boolean;
  required_replicas: number;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  displayName: string;
  roles: RoleName[];
  encryptionMode: EncryptionMode;
  quotaBytes: number;
  usedBytes: number;
  isActive: boolean;
  deviceCount: number;
  mediaCount: number;
  createdAt: string;
}

export interface AdminOverview {
  totalUsers: number;
  activeUsers: number;
  totalDevices: number;
  totalMediaFiles: number;
  totalUsedBytes: number;
  totalQuotaBytes: number;
  storageTargets: StorageTargetStatus[];
  settings: SystemSettingsMap;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// ==========================================
// Phase 2: Backup, Resumable Upload & Media
// ==========================================

export interface DuplicateCheckItem {
  clientRef: string;
  sha256: string;
  sizeBytes: number;
  originalFilename: string;
}

export interface DuplicateCheckResult {
  clientRef: string;
  status: 'new' | 'duplicate' | 'resumable';
  duplicateOf?: {
    mediaId: string;
    originalFilename: string;
    sizeBytes: number;
    createdAt: string;
  };
  resumableSession?: {
    sessionId: string;
    chunkSizeBytes: number;
    totalParts: number;
    uploadedPartNumbers: number[];
    bytesUploaded: number;
  };
}

export interface InitUploadRequest {
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  networkType: 'wifi' | 'cellular' | 'unknown';
  chunkSizeBytes?: number;
  capturedAt?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
  encryptedFileKey?: string | null;
  encryptionIv?: string | null;
  allowDuplicate?: boolean;
}

export interface InitUploadResponse {
  status: 'ready' | 'duplicate';
  resumed?: boolean;
  sessionId?: string;
  chunkSizeBytes?: number;
  totalParts?: number;
  uploadedPartNumbers?: number[];
  bytesUploaded?: number;
  duplicateOf?: {
    mediaId: string;
    originalFilename: string;
    sizeBytes: number;
    createdAt: string;
  };
}

export interface UploadSessionStatusResponse {
  sessionId: string;
  status: 'uploading' | 'verifying' | 'completed' | 'aborted' | 'failed';
  originalFilename: string;
  expectedSizeBytes: number;
  expectedSha256: string;
  chunkSizeBytes: number;
  totalParts: number;
  uploadedPartNumbers: number[];
  bytesUploaded: number;
  mediaId: string | null;
  errorMessage: string | null;
}

export interface ReplicaSummaryItem {
  slot: ReplicaSlot;
  provider: string;
  state: ReplicaHealthState;
  verifiedSha256: string | null;
  lastVerifiedAt: string | null;
}

export interface TagItem {
  id: string;
  name: string;
  mediaCount?: number;
  createdAt: string;
}

export interface FolderItem {
  id: string;
  parentId: string | null;
  name: string;
  mediaCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AlbumItem {
  id: string;
  folderId: string | null;
  name: string;
  coverMediaId: string | null;
  mediaCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MediaFileItem {
  id: string;
  originalFilename: string;
  mimeType: string;
  mediaKind: MediaKind;
  sizeBytes: number;
  sha256: string;
  encryptionMode: EncryptionMode;
  encryptedFileKey: string | null;
  encryptionIv: string | null;
  uploadState: MediaUploadState;
  isFavorite: boolean;
  folderId: string | null;
  sourceDeviceId: string | null;
  capturedAt: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  tags: TagItem[];
  albumIds: string[];
  replicas: ReplicaSummaryItem[];
  verifiedReplicaCount: number;
  requiredReplicas: number;
}

export interface CompleteUploadResponse {
  media: MediaFileItem;
  integrityVerified: boolean;
  replicaNotice: string;
}

export interface VerifyMediaIntegrityResponse {
  mediaId: string;
  verified: boolean;
  expectedSha256: string;
  actualSha256: string;
  sizeBytes: number;
  checkedAt: string;
}

// ==========================================
// Phase 4: Restore, Duplicates, Trash, Versions
// ==========================================

export interface TrashItemSummary {
  mediaId: string;
  originalFilename: string;
  mimeType: string;
  mediaKind: MediaKind;
  sizeBytes: number;
  sha256: string;
  trashedAt: string;
  purgeAfter: string | null;
}

export interface DuplicateGroup {
  sha256: string;
  sizeBytes: number;
  count: number;
  reclaimableBytes: number;
  files: Array<{
    id: string;
    originalFilename: string;
    createdAt: string;
    folderId: string | null;
  }>;
}

export interface FileVersionItem {
  id: string;
  mediaId: string;
  versionNumber: number;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

export interface StorageSummaryResponse {
  quotaBytes: number;
  usedBytes: number;
  totalFiles: number;
  imageCount: number;
  imageBytes: number;
  videoCount: number;
  videoBytes: number;
  verifiedSafeCount: number;
  verifiedSafeBytes: number;
  insufficientReplicaCount: number;
  trashCount: number;
  trashBytes: number;
  duplicateGroupCount: number;
  duplicateReclaimableBytes: number;
  requiredReplicas: number;
}

// ==========================================
// Phase 5 & 6: Notifications, Replication & Integrity
// ==========================================

export interface NotificationItem {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
}

export interface ReplicationRunResult {
  processedObjects: number;
  replicatedCopies: number;
  skippedUnconfigured: number;
  promotedToVerified: number;
  failures: Array<{ storageObjectId: string; slot: ReplicaSlot; error: string }>;
}

export interface IntegrityScanResult {
  scannedReplicas: number;
  healthyReplicas: number;
  corruptedDetected: number;
  missingDetected: number;
  healedReplicas: number;
  unrecoverable: Array<{ storageObjectId: string; slot: ReplicaSlot; reason: string }>;
}

// ==========================================
// Media Format Classifier (PRD 2.3 & 2.4)
// Only images & videos (including RAW/Apple/ProRes); rejects documents/executables.
// ==========================================

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'heic', 'heif', 'hif', 'avif',
  'bmp', 'tif', 'tiff', 'dng', 'raw', 'cr2', 'cr3', 'crw', 'nef', 'nrw',
  'arw', 'srf', 'sr2', 'orf', 'rw2', 'pef', 'raf', 'srw', '3fr', 'iiq',
  'erf', 'kdc', 'dcr', 'mos', 'mrw', 'x3f', 'jxl', 'jp2', 'j2k', 'ico', 'psd'
]);

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', '3gp', '3g2', 'mts', 'm2ts',
  'ts', 'wmv', 'flv', 'mpg', 'mpeg', 'mpe', 'vob', 'ogv', 'mxf', 'prores',
  'r3d', 'braw', 'insv', 'lrv', 'asf', 'f4v', 'hevc', 'h264', 'h265'
]);

export function extractFileExtension(filename: string): string {
  const base = filename.trim().split(/[\\/]/).pop() ?? '';
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === base.length - 1) return '';
  return base.slice(dotIdx + 1).toLowerCase();
}

export function classifyMediaFormat(filename: string, mimeType?: string): MediaKind | null {
  const normalizedMime = (mimeType ?? '').trim().toLowerCase();
  const ext = extractFileExtension(filename);

  if (normalizedMime.startsWith('image/')) {
    return 'image';
  }
  if (normalizedMime.startsWith('video/')) {
    return 'video';
  }

  // Camera RAW / ProRAW / HEIC / ProRes often arrive as application/octet-stream or empty MIME
  if (IMAGE_EXTENSIONS.has(ext)) {
    return 'image';
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return 'video';
  }

  return null;
}

// ==========================================
// M1 Additive Contracts: Storage Pool Presets, Admin/E2EE & Native Gallery Bridge
// ==========================================

export interface StorageProviderPreset {
  provider: CloudStorageProvider;
  protocol: StorageProtocol;
  label: string;
  suggestedCapacityGb: number;
  freeTier: string;
  requiresCard: boolean;
  endpointTemplate: string;
  defaultRegion: string;
  notes: string;
}

export interface AdminUpdateUserRequest {
  isActive?: boolean;
  quotaBytes?: number;
  isAdmin?: boolean;
}

export interface UpdateE2eeKeyRequest {
  e2eeKeySalt: string;
  e2eeEncryptedMasterKey: string;
  e2eeKdfParams: Record<string, unknown>;
}

export interface AdminStoragePoolResponse {
  nodes: StorageNodeView[];
  summary: PoolCapacitySummary;
  presets: StorageProviderPreset[];
}

export interface GoogleDriveOAuthConfigView {
  configured: boolean;
  source: 'database' | 'env' | 'none';
  clientId: string;
  hasClientSecret: boolean;
  redirectUri: string;
}

export interface GoogleDriveOAuthStartResponse {
  authUrl: string;
  redirectUri: string;
}

export interface GoogleDriveRefreshQuotaResponse {
  node: StorageNodeView;
  summary: PoolCapacitySummary;
  driveQuota: {
    email: string;
    limitBytes: number;
    usageBytes: number;
    freeBytes: number;
  };
}

export interface SyncPoolQuotaResponse {
  updatedUsers: number;
  quotaBytes: number;
}

export interface ReplicaBreakdownItem {
  slot: ReplicaSlot | string;
  state: ReplicaHealthState | string;
  count: number;
}

export type NetworkConnectionType = 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown';

export interface VaultNetworkStatus {
  connected: boolean;
  type: NetworkConnectionType;
  isWifi: boolean;
}

export type MediaPermissionAccessLevel = 'all' | 'limited' | 'denied';

export interface MediaPermissionStatus {
  granted: boolean;
  accessLevel: MediaPermissionAccessLevel;
}

export interface DeviceAlbumInfo {
  id: string;
  name: string;
  count: number;
}

export interface NativeMediaAsset {
  assetId: string;
  filename: string;
  mimeType: string;
  mediaKind: MediaKind;
  sizeBytes: number;
  capturedAt: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  albumId: string | null;
  albumName: string | null;
}

export interface VaultMediaBridge {
  getNetworkStatus(): Promise<VaultNetworkStatus>;
  checkAndRequestMediaPermissions(): Promise<MediaPermissionStatus>;
  listDeviceAlbums(): Promise<{ albums: DeviceAlbumInfo[] }>;
  scanDeviceMedia(opts: {
    albumId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: NativeMediaAsset[]; total: number }>;
  getAssetThumbnail?(opts: { assetId: string }): Promise<{ dataBase64?: string }>;
  computeAssetSha256(opts: { assetId: string }): Promise<{ sha256: string; sizeBytes: number }>;
  readAssetSlice(opts: {
    assetId: string;
    offset: number;
    length: number;
  }): Promise<{ dataBase64: string; bytesRead: number }>;
  saveOriginalToGallery(opts: {
    filename: string;
    mimeType: string;
    mediaKind: MediaKind;
    dataBase64: string;
  }): Promise<{ saved: boolean; assetId?: string }>;
}
