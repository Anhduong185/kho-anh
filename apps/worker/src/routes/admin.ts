import {
  type CloudStorageProvider,
  type CreateOrUpdateStorageNodeRequest,
  type IntegrityScanResult,
  type ReplicaSlot,
  type ReplicationRunResult,
  type SaveStorageTargetRequest,
  type StorageMigrationResult,
  type StorageProviderPreset,
  type TestStorageTargetResponse
} from '@smb/shared';
import type { WorkerEnv } from '../env.js';
import { encryptStorageSecret, getStorageSecretSeed } from '../storage/crypto.js';
import {
  fetchGoogleDriveAbout,
  GoogleDriveStorageAdapter
} from '../storage/googleDriveAdapter.js';
import {
  buildAdapterFromRecord,
  buildPoolView,
  getHealthSummary,
  listLegacyTargetViews,
  loadGoogleOAuthCredentials,
  loadPoolNodes,
  loadR2NativeOverride,
  NATIVE_R2_NODE_ID,
  providerProtocol,
  resolveAdapter,
  saveR2NativeOverride,
  selectTargetForWrite,
  toStorageNodeView,
  type StorageNodeDbRow,
  type StorageTargetDbRow
} from '../storage/poolRouter.js';
import { R2StorageAdapter } from '../storage/r2Adapter.js';
import { hmacSha256Hex } from '../utils/crypto.js';
import {
  getSystemSettings,
  HttpError,
  jsonResponse,
  readJson,
  requireAdmin,
  requireAuth
} from '../utils/http.js';

const VALID_SLOTS = new Set<ReplicaSlot>(['copy1_primary', 'copy2_secondary', 'copy3_offsite']);
const VALID_PROVIDERS = new Set<CloudStorageProvider>([
  'local',
  'cloudflare_r2',
  'google_drive',
  'backblaze_b2',
  'oracle_oci',
  'oracle_vm_minio',
  'infinicloud_webdav',
  'koofr_webdav',
  'webdav_custom',
  'minio',
  's3_custom'
]);

const MAX_QUOTA_BYTES = 100 * 1024 * 1024 * 1024 * 1024; // 100 TiB

const PRESETS: StorageProviderPreset[] = [
  {
    provider: 'google_drive',
    protocol: 'gdrive',
    label: 'Google Drive / Google One (OAuth 2.0 — 15 GB đến 5 TB+)',
    suggestedCapacityGb: 100,
    freeTier: '15 GB miễn phí/tài khoản hoặc dùng gói Google One 100 GB – 5 TB sẵn có (tự đọc dung lượng thật)',
    requiresCard: false,
    endpointTemplate: 'https://www.googleapis.com/drive/v3',
    defaultRegion: 'global',
    notes: 'Kết nối 1-click bằng OAuth 2.0 (quyền drive.file chỉ truy cập thư mục kho-anh-vault). Có thể ghép nhiều tài khoản Google Drive cộng dồn.'
  },
  {
    provider: 'oracle_vm_minio',
    protocol: 's3',
    label: 'Oracle Cloud Always Free VM + MinIO',
    suggestedCapacityGb: 180,
    freeTier: 'Dung lượng tùy tài nguyên Always Free được cấp; VM nhàn rỗi có thể bị thu hồi',
    requiresCard: true,
    endpointTemplate: 'https://minio.your-oci-domain.com',
    defaultRegion: 'ap-singapore-1',
    notes: 'Không tính vào dung lượng cam kết cho lưu ảnh dài hạn.'
  },
  {
    provider: 'oracle_oci',
    protocol: 's3',
    label: 'Oracle Cloud Object Storage (OCI S3)',
    suggestedCapacityGb: 20,
    freeTier: '20 GB Object Storage miễn phí trọn đời',
    requiresCard: true,
    endpointTemplate: 'https://<NAMESPACE>.compat.objectstorage.<REGION>.oraclecloud.com',
    defaultRegion: 'ap-singapore-1',
    notes: 'Tạo Customer Secret Key trong OCI Console để kết nối qua S3 Compatibility API.'
  },
  {
    provider: 'infinicloud_webdav',
    protocol: 'webdav',
    label: 'InfiniCLOUD (WebDAV)',
    suggestedCapacityGb: 20,
    freeTier: '20 GB miễn phí vĩnh viễn (có thể tăng thêm bằng mã thưởng chính thức)',
    requiresCard: false,
    endpointTemplate: 'https://teracloud.jp/dav',
    defaultRegion: 'jp',
    notes: 'Bật Apps Connection (WebDAV) trong tài khoản InfiniCLOUD để lấy User ID & App Password.'
  },
  {
    provider: 'cloudflare_r2',
    protocol: 's3',
    label: 'Cloudflare R2 (S3)',
    suggestedCapacityGb: 100,
    freeTier: 'Băng thông tải xuống/xem video (egress) 0 USD không giới hạn',
    requiresCard: true,
    endpointTemplate: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com',
    defaultRegion: 'auto',
    notes: 'Rất lý tưởng cho ảnh xem thường xuyên vì băng thông tải xuống hoàn toàn miễn phí.'
  },
  {
    provider: 'backblaze_b2',
    protocol: 's3',
    label: 'Backblaze B2 (S3)',
    suggestedCapacityGb: 10,
    freeTier: '10 GB miễn phí · Không cần thẻ tín dụng',
    requiresCard: false,
    endpointTemplate: 'https://s3.<REGION>.backblazeb2.com',
    defaultRegion: 'us-west-004',
    notes: 'Đăng ký nhanh không cần thẻ; phù hợp làm bản sao dự phòng Copy 2.'
  },
  {
    provider: 'koofr_webdav',
    protocol: 'webdav',
    label: 'Koofr (WebDAV)',
    suggestedCapacityGb: 10,
    freeTier: '10 GB miễn phí vĩnh viễn · Không cần thẻ tín dụng',
    requiresCard: false,
    endpointTemplate: 'https://app.koofr.net/dav/Koofr',
    defaultRegion: 'eu',
    notes: 'Cloud châu Âu bảo mật; tạo App Password trong Koofr Settings → Password để kết nối WebDAV.'
  },
  {
    provider: 'webdav_custom',
    protocol: 'webdav',
    label: 'WebDAV khác (Nextcloud · Yandex Disk · Synology/QNAP NAS)',
    suggestedCapacityGb: 20,
    freeTier: 'Yandex Disk 10 GB free · Nextcloud/NAS tùy gói hoặc ổ cứng của bạn',
    requiresCard: false,
    endpointTemplate: 'https://webdav.yandex.com',
    defaultRegion: 'webdav',
    notes: 'Hỗ trợ mọi kho WebDAV chuẩn (Nextcloud, OwnCloud, Yandex Disk, pCloud, NAS tại nhà).'
  },
  {
    provider: 'minio',
    protocol: 's3',
    label: 'MinIO / NAS tự host tại nhà (S3)',
    suggestedCapacityGb: 400,
    freeTier: '200 GB – 4 TB+ (0 USD/tháng, dùng ổ cứng PC/NAS của bạn)',
    requiresCard: false,
    endpointTemplate: 'https://s3.your-nas-domain.com',
    defaultRegion: 'us-east-1',
    notes: 'Cách bền vững nhất để đạt 400 GB – vài TB không tốn phí thuê hàng tháng.'
  },
  {
    provider: 's3_custom',
    protocol: 's3',
    label: 'Nhà cung cấp S3-Compatible khác',
    suggestedCapacityGb: 100,
    freeTier: 'Tùy gói (Wasabi, DigitalOcean Spaces, Garage, Ceph...)',
    requiresCard: false,
    endpointTemplate: 'https://s3.example.com',
    defaultRegion: 'us-east-1',
    notes: 'Tương thích chuẩn AWS S3 v4.'
  }
];

function validateEndpointUrl(endpoint: string, required = true): void {
  if (!endpoint) {
    if (required) {
      throw new HttpError(400, 'INVALID_ENDPOINT', 'Endpoint là bắt buộc');
    }
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new HttpError(
      400,
      'INVALID_ENDPOINT',
      'Endpoint phải là URL hợp lệ (ví dụ: https://s3.us-west-004.backblazeb2.com)'
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new HttpError(
      400,
      'INVALID_ENDPOINT',
      'Endpoint chỉ hỗ trợ giao thức http:// hoặc https://'
    );
  }
}

function validateNodeInput(body: Partial<CreateOrUpdateStorageNodeRequest>, isCreate: boolean): void {
  if (isCreate) {
    if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 120) {
      throw new HttpError(400, 'INVALID_NODE_NAME', 'Tên node phải từ 1 đến 120 ký tự');
    }
    if (!body.slot || !VALID_SLOTS.has(body.slot) || body.slot === 'copy3_offsite') {
      throw new HttpError(400, 'INVALID_SLOT', 'Replica slot không hợp lệ');
    }
    if (!body.provider || !VALID_PROVIDERS.has(body.provider)) {
      throw new HttpError(400, 'INVALID_PROVIDER', 'Nhà cung cấp lưu trữ không hợp lệ');
    }
    if (
      typeof body.capacityBytes !== 'number' ||
      !Number.isFinite(body.capacityBytes) ||
      body.capacityBytes <= 0 ||
      body.capacityBytes > MAX_QUOTA_BYTES
    ) {
      throw new HttpError(400, 'INVALID_CAPACITY', 'Dung lượng node không hợp lệ');
    }
  } else {
    if (body.slot !== undefined && !VALID_SLOTS.has(body.slot)) {
      throw new HttpError(400, 'INVALID_SLOT', 'Replica slot không hợp lệ');
    }
    if (body.provider !== undefined && !VALID_PROVIDERS.has(body.provider)) {
      throw new HttpError(400, 'INVALID_PROVIDER', 'Nhà cung cấp lưu trữ không hợp lệ');
    }
    if (
      body.capacityBytes !== undefined &&
      (typeof body.capacityBytes !== 'number' ||
        !Number.isFinite(body.capacityBytes) ||
        body.capacityBytes <= 0 ||
        body.capacityBytes > MAX_QUOTA_BYTES)
    ) {
      throw new HttpError(400, 'INVALID_CAPACITY', 'Dung lượng node không hợp lệ');
    }
  }

  if (body.provider === 'local') {
    throw new HttpError(
      400,
      'UNSUPPORTED_ON_WORKER',
      'Cloudflare Workers không hỗ trợ lưu trữ ổ đĩa cục bộ (local). Hãy chọn S3-compatible hoặc WebDAV.'
    );
  }
}

export async function handleAdminAndNotificationRoutes(
  request: Request,
  url: URL,
  env: WorkerEnv
): Promise<Response | null> {
  const { pathname } = url;
  const method = request.method;

  // ==================== NOTIFICATIONS ====================
  if (method === 'GET' && pathname === '/api/v1/notifications') {
    const auth = await requireAuth(request, env);
    const res = await env.DB.prepare(
      'SELECT id, category, title, body, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
    )
      .bind(auth.userId)
      .all<{
        id: string;
        category: string;
        title: string;
        body: string;
        is_read: number;
        created_at: string;
      }>();

    const notifications = res.results.map((r) => ({
      id: r.id,
      category: r.category,
      title: r.title,
      body: r.body,
      isRead: Boolean(r.is_read),
      createdAt: r.created_at
    }));
    const unreadCount = notifications.filter((n) => !n.isRead).length;
    return jsonResponse({ notifications, unreadCount });
  }

  const notifReadMatch = pathname.match(/^\/api\/v1\/notifications\/([^/]+)\/read$/);
  if (method === 'PATCH' && notifReadMatch) {
    const auth = await requireAuth(request, env);
    const res = await env.DB.prepare(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?'
    )
      .bind(notifReadMatch[1]!, auth.userId)
      .run();
    if (!res.meta.changes) {
      throw new HttpError(404, 'NOTIFICATION_NOT_FOUND', 'Không tìm thấy thông báo');
    }
    return jsonResponse({ read: true });
  }

  if (method === 'POST' && pathname === '/api/v1/notifications/read-all') {
    const auth = await requireAuth(request, env);
    await env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?')
      .bind(auth.userId)
      .run();
    return jsonResponse({ readAll: true });
  }

  // ==================== ADMIN (STRICT ZERO ACCESS TO PERSONAL MEDIA OR E2EE KEYS) ====================
  if (method === 'GET' && pathname === '/api/v1/admin/overview') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);

    const [uStats, dStats, mStats, storageTargets, settings] = await Promise.all([
      env.DB.prepare(
        `SELECT COUNT(*) AS total_users, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_users,
         COALESCE(SUM(used_bytes), 0) AS total_used, COALESCE(SUM(quota_bytes), 0) AS total_quota
         FROM users`
      ).first<Record<string, number>>(),
      env.DB.prepare('SELECT COUNT(*) AS total_devices FROM devices WHERE revoked_at IS NULL').first<{
        total_devices: number;
      }>(),
      env.DB.prepare('SELECT COUNT(*) AS total_media FROM media_files WHERE deleted_at IS NULL').first<{
        total_media: number;
      }>(),
      getHealthSummary(env),
      getSystemSettings(env.DB)
    ]);

    return jsonResponse({
      totalUsers: Number(uStats?.total_users ?? 0),
      activeUsers: Number(uStats?.active_users ?? 0),
      totalDevices: Number(dStats?.total_devices ?? 0),
      totalMediaFiles: Number(mStats?.total_media ?? 0),
      totalUsedBytes: Number(uStats?.total_used ?? 0),
      totalQuotaBytes: Number(uStats?.total_quota ?? 0),
      storageTargets,
      settings
    });
  }

  if (method === 'GET' && pathname === '/api/v1/admin/users') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const res = await env.DB.prepare(
      `SELECT u.id, u.email, u.display_name, u.encryption_mode, u.quota_bytes, u.used_bytes, u.is_active, u.is_admin, u.created_at,
        (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS device_count,
        (SELECT COUNT(*) FROM media_files m WHERE m.user_id = u.id AND m.deleted_at IS NULL) AS media_count
       FROM users u ORDER BY u.created_at ASC`
    ).all<{
      id: string;
      email: string;
      display_name: string;
      encryption_mode: 'server_side' | 'e2ee';
      quota_bytes: number;
      used_bytes: number;
      is_active: number;
      is_admin: number;
      device_count: number;
      media_count: number;
      created_at: string;
    }>();

    return jsonResponse({
      users: res.results.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        roles: u.is_admin ? ['admin', 'user'] : ['user'],
        encryptionMode: u.encryption_mode,
        quotaBytes: Number(u.quota_bytes),
        usedBytes: Number(u.used_bytes),
        isActive: Boolean(u.is_active),
        deviceCount: Number(u.device_count),
        mediaCount: Number(u.media_count),
        createdAt: u.created_at
      }))
    });
  }

  const userPatchMatch = pathname.match(/^\/api\/v1\/admin\/users\/([^/]+)$/);
  if (method === 'PATCH' && userPatchMatch) {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const targetUserId = userPatchMatch[1]!;
    const body = await readJson<{ isActive?: boolean; quotaBytes?: number; isAdmin?: boolean }>(
      request
    );

    const target = await env.DB.prepare(
      'SELECT id, is_active, is_admin FROM users WHERE id = ?'
    )
      .bind(targetUserId)
      .first<{ id: string; is_active: number; is_admin: number }>();
    if (!target) {
      throw new HttpError(404, 'USER_NOT_FOUND', 'Không tìm thấy người dùng');
    }

    if (body.isActive === false && target.id === auth.userId) {
      throw new HttpError(
        400,
        'SELF_DEACTIVATION_FORBIDDEN',
        'Quản trị viên không thể tự khóa tài khoản của chính mình'
      );
    }

    if (body.quotaBytes !== undefined) {
      if (
        typeof body.quotaBytes !== 'number' ||
        !Number.isInteger(body.quotaBytes) ||
        body.quotaBytes <= 0 ||
        body.quotaBytes > MAX_QUOTA_BYTES
      ) {
        throw new HttpError(400, 'INVALID_QUOTA', 'Hạn mức dung lượng không hợp lệ (1 byte .. 100 TiB)');
      }
    }

    if (body.isAdmin === false && target.is_admin === 1) {
      const activeAdmins = await env.DB.prepare(
        'SELECT COUNT(*) AS cnt FROM users WHERE is_admin = 1 AND is_active = 1'
      ).first<{ cnt: number }>();
      if (Number(activeAdmins?.cnt ?? 0) <= 1) {
        throw new HttpError(
          400,
          'LAST_ADMIN_REQUIRED',
          'Không thể gỡ quyền quản trị của tài khoản Admin hoạt động cuối cùng'
        );
      }
    }

    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];
    if (typeof body.isActive === 'boolean') {
      sets.push('is_active = ?');
      params.push(body.isActive ? 1 : 0);
    }
    if (body.quotaBytes !== undefined) {
      sets.push('quota_bytes = ?');
      params.push(body.quotaBytes);
    }
    if (typeof body.isAdmin === 'boolean') {
      sets.push('is_admin = ?');
      params.push(body.isAdmin ? 1 : 0);
    }
    params.push(targetUserId);

    const statements = [
      env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...params)
    ];
    if (body.isActive === false) {
      statements.push(
        env.DB.prepare(
          'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
        ).bind(now, targetUserId)
      );
    }

    await env.DB.batch(statements);
    return jsonResponse({ updated: true, userId: targetUserId });
  }

  if (method === 'GET' && pathname === '/api/v1/admin/settings') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const settings = await getSystemSettings(env.DB);
    return jsonResponse({ settings });
  }

  if (method === 'PATCH' && pathname === '/api/v1/admin/settings') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const body = await readJson<Record<string, unknown>>(request);
    const now = new Date().toISOString();

    if (body.registration_enabled !== undefined && typeof body.registration_enabled !== 'boolean') {
      throw new HttpError(400, 'INVALID_SETTING', 'registration_enabled phải là boolean');
    }
    if (
      body.trash_retention_days !== undefined &&
      (typeof body.trash_retention_days !== 'number' ||
        !Number.isInteger(body.trash_retention_days) ||
        body.trash_retention_days < 1 ||
        body.trash_retention_days > 3650)
    ) {
      throw new HttpError(400, 'INVALID_SETTING', 'trash_retention_days phải từ 1 đến 3650');
    }
    if (body.required_replicas !== undefined && body.required_replicas !== 2) {
      throw new HttpError(400, 'INVALID_SETTING', 'required_replicas phải bằng 2');
    }

    const allowed = ['registration_enabled', 'trash_retention_days', 'required_replicas'] as const;
    for (const k of allowed) {
      if (body[k] !== undefined) {
        await env.DB.prepare(
          'INSERT INTO system_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
        )
          .bind(k, JSON.stringify(body[k]), now, auth.userId)
          .run();
      }
    }
    const settings = await getSystemSettings(env.DB);
    return jsonResponse({ settings });
  }

  if (method === 'GET' && pathname === '/api/v1/admin/integrity/summary') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const res = await env.DB.prepare(
      `SELECT replica_slot, state, COUNT(*) AS count
       FROM replica_status
       GROUP BY replica_slot, state
       ORDER BY replica_slot ASC, state ASC`
    ).all<{ replica_slot: string; state: string; count: number }>();

    return jsonResponse({
      replicaBreakdown: res.results.map((r) => ({
        slot: r.replica_slot,
        state: r.state,
        count: Number(r.count)
      }))
    });
  }

  if (method === 'POST' && pathname === '/api/v1/admin/replication/run') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const settings = await getSystemSettings(env.DB);
    const requiredReplicas = settings.required_replicas;

    // Backfill Copy 2 for uploads made before two copies were required.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO replica_status (
         id, storage_object_id, replica_slot, provider, bucket, state, updated_at
       )
       SELECT lower(hex(randomblob(16))), so.id, 'copy2_secondary', 'unconfigured', 'pending', 'pending', ?
       FROM storage_objects so
       JOIN media_files m ON m.id = so.media_id
       WHERE so.object_kind = 'original' AND m.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM replica_status rs
           WHERE rs.storage_object_id = so.id AND rs.replica_slot = 'copy2_secondary'
         )
       LIMIT 50`
    ).bind(new Date().toISOString()).run();

    const pendingRes = await env.DB.prepare(
      `SELECT so.id AS storage_object_id, so.media_id, so.object_key, so.primary_node_id,
              so.sha256, so.size_bytes, rs.replica_slot, rs.storage_node_id AS existing_node_id
       FROM replica_status rs
       JOIN storage_objects so ON so.id = rs.storage_object_id
       JOIN media_files m ON m.id = so.media_id
       WHERE rs.replica_slot = 'copy2_secondary'
         AND rs.state IN ('pending', 'missing', 'corrupted')
         AND m.deleted_at IS NULL
       ORDER BY so.created_at ASC
       LIMIT 50`
    ).all<{
      storage_object_id: string;
      media_id: string;
      object_key: string;
      primary_node_id: string | null;
      sha256: string;
      size_bytes: number;
      replica_slot: ReplicaSlot;
      existing_node_id: string | null;
    }>();

    const processedObjects = new Set<string>();
    const touchedMedia = new Set<string>();
    let replicatedCopies = 0;
    let skippedUnconfigured = 0;
    const failures: ReplicationRunResult['failures'] = [];

    for (const row of pendingRes.results) {
      processedObjects.add(row.storage_object_id);
      const sizeBytes = Number(row.size_bytes);
      const selectedTarget = await selectTargetForWrite(env, row.replica_slot, sizeBytes);
      if (!selectedTarget) {
        skippedUnconfigured++;
        continue;
      }

      const primary = await resolveAdapter(env, row.primary_node_id, 'copy1_primary');
      if (!primary) {
        failures.push({
          storageObjectId: row.storage_object_id,
          slot: row.replica_slot,
          error: 'Primary storage unavailable'
        });
        continue;
      }

      try {
        const now = new Date().toISOString();
        await env.DB.prepare(
          `UPDATE replica_status
           SET state = 'syncing', updated_at = ?
           WHERE storage_object_id = ? AND replica_slot = ?`
        )
          .bind(now, row.storage_object_id, row.replica_slot)
          .run();

        const obj = await primary.get(row.object_key);
        if (!obj) {
          throw new Error(`Missing source object ${row.object_key}`);
        }
        const sourceBytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
        await selectedTarget.adapter.put(
          row.object_key,
          sourceBytes,
          obj.contentType ?? 'application/octet-stream',
          row.sha256
        );

        const verified = await selectedTarget.adapter.computeSha256(row.object_key);
        if (verified.sha256 !== row.sha256 || verified.sizeBytes !== sizeBytes) {
          throw new Error(`Post-replication SHA-256 mismatch on ${row.replica_slot}`);
        }

        const doneAt = new Date().toISOString();
        const stmts = [
          env.DB.prepare(
            `UPDATE replica_status
             SET state = 'verified', storage_node_id = ?, provider = ?, bucket = ?,
                 verified_sha256 = ?, last_verified_at = ?, error_message = NULL, updated_at = ?
             WHERE storage_object_id = ? AND replica_slot = ?`
          ).bind(
            selectedTarget.nodeId,
            selectedTarget.adapter.provider,
            selectedTarget.adapter.bucket,
            verified.sha256,
            doneAt,
            doneAt,
            row.storage_object_id,
            row.replica_slot
          )
        ];

        if (selectedTarget.nodeId && selectedTarget.nodeId !== row.existing_node_id) {
          stmts.push(
            env.DB.prepare(
              'UPDATE storage_nodes SET used_bytes = used_bytes + ?, updated_at = ? WHERE id = ?'
            ).bind(sizeBytes, doneAt, selectedTarget.nodeId)
          );
        }

        await env.DB.batch(stmts);
        replicatedCopies++;
        touchedMedia.add(row.media_id);
      } catch (err) {
        const msg = (err as Error).message;
        await env.DB.prepare(
          "UPDATE replica_status SET state = 'missing', error_message = ?, updated_at = ? WHERE storage_object_id = ? AND replica_slot = ?"
        )
          .bind(msg, new Date().toISOString(), row.storage_object_id, row.replica_slot)
          .run();
        failures.push({ storageObjectId: row.storage_object_id, slot: row.replica_slot, error: msg });
      }
    }

    let promotedToVerified = 0;
    for (const mediaId of touchedMedia) {
      const countRow = await env.DB.prepare(
        `SELECT COUNT(DISTINCT rs.replica_slot) AS cnt
         FROM storage_objects so
         JOIN replica_status rs ON rs.storage_object_id = so.id
         WHERE so.media_id = ? AND so.object_kind = 'original' AND rs.state = 'verified'
           AND rs.replica_slot IN ('copy1_primary', 'copy2_secondary')`
      )
        .bind(mediaId)
        .first<{ cnt: number }>();
      if (Number(countRow?.cnt ?? 0) >= requiredReplicas) {
        const upd = await env.DB.prepare(
          "UPDATE media_files SET upload_state = 'verified', updated_at = ? WHERE id = ? AND upload_state <> 'verified'"
        )
          .bind(new Date().toISOString(), mediaId)
          .run();
        if (upd.meta.changes) promotedToVerified++;
      }
    }

    const result: ReplicationRunResult = {
      processedObjects: processedObjects.size,
      replicatedCopies,
      skippedUnconfigured,
      promotedToVerified,
      failures
    };
    return jsonResponse({ result });
  }

  if (method === 'POST' && pathname === '/api/v1/admin/integrity/scan') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);

    const objectsRes = await env.DB.prepare(
      `SELECT so.id, so.media_id, so.object_key, so.primary_node_id, so.sha256, so.size_bytes
       FROM storage_objects so
       JOIN media_files m ON m.id = so.media_id
       WHERE so.object_kind = 'original' AND m.deleted_at IS NULL
       ORDER BY so.created_at ASC
       LIMIT 50`
    ).all<{
      id: string;
      media_id: string;
      object_key: string;
      primary_node_id: string | null;
      sha256: string;
      size_bytes: number;
    }>();

    let scannedReplicas = 0;
    let healthyReplicas = 0;
    let corruptedDetected = 0;
    let missingDetected = 0;
    let healedReplicas = 0;
    const unrecoverable: IntegrityScanResult['unrecoverable'] = [];

    for (const obj of objectsRes.results) {
      const expectedSize = Number(obj.size_bytes);
      const repRows = await env.DB.prepare(
        "SELECT replica_slot, storage_node_id FROM replica_status WHERE storage_object_id = ? AND state NOT IN ('pending', 'syncing')"
      )
        .bind(obj.id)
        .all<{ replica_slot: ReplicaSlot; storage_node_id: string | null }>();

      const nodeBySlot = new Map<ReplicaSlot, string | null>(
        repRows.results.map((r) => [r.replica_slot, r.storage_node_id])
      );
      if (!nodeBySlot.has('copy1_primary')) {
        nodeBySlot.set('copy1_primary', obj.primary_node_id);
      }

      const healthySlots: Array<{ slot: ReplicaSlot; nodeId: string | null }> = [];
      const damagedSlots: Array<{
        slot: ReplicaSlot;
        nodeId: string | null;
        kind: 'missing' | 'corrupted';
      }> = [];

      for (const slot of ['copy1_primary', 'copy2_secondary', 'copy3_offsite'] as ReplicaSlot[]) {
        if (!nodeBySlot.has(slot) && slot !== 'copy1_primary') continue;
        const nodeId = nodeBySlot.get(slot) ?? null;
        const adapter = await resolveAdapter(env, nodeId, slot);
        if (!adapter) continue;

        scannedReplicas++;
        const now = new Date().toISOString();
        try {
          const head = await adapter.head(obj.object_key);
          if (!head) {
            missingDetected++;
            damagedSlots.push({ slot, nodeId, kind: 'missing' });
            await env.DB.prepare(
              "UPDATE replica_status SET state = 'missing', error_message = 'Object missing during integrity scan', updated_at = ? WHERE storage_object_id = ? AND replica_slot = ?"
            )
              .bind(now, obj.id, slot)
              .run();
            continue;
          }

          const actual = await adapter.computeSha256(obj.object_key);
          if (actual.sha256 === obj.sha256 && actual.sizeBytes === expectedSize) {
            healthyReplicas++;
            healthySlots.push({ slot, nodeId });
            await env.DB.prepare(
              "UPDATE replica_status SET state = 'verified', verified_sha256 = ?, last_verified_at = ?, error_message = NULL, updated_at = ? WHERE storage_object_id = ? AND replica_slot = ?"
            )
              .bind(actual.sha256, now, now, obj.id, slot)
              .run();
          } else {
            corruptedDetected++;
            damagedSlots.push({ slot, nodeId, kind: 'corrupted' });
            await env.DB.prepare(
              "UPDATE replica_status SET state = 'corrupted', verified_sha256 = ?, error_message = 'SHA-256 bit-rot detected', updated_at = ? WHERE storage_object_id = ? AND replica_slot = ?"
            )
              .bind(actual.sha256, now, obj.id, slot)
              .run();
          }
        } catch {
          missingDetected++;
          damagedSlots.push({ slot, nodeId, kind: 'missing' });
          await env.DB.prepare(
            "UPDATE replica_status SET state = 'missing', error_message = 'Unable to verify object during integrity scan', updated_at = ? WHERE storage_object_id = ? AND replica_slot = ?"
          ).bind(now, obj.id, slot).run();
        }
      }

      if (damagedSlots.length > 0 && healthySlots.length > 0) {
        const donor = healthySlots[0]!;
        const donorAdapter = (await resolveAdapter(env, donor.nodeId, donor.slot))!;
        const donorObj = await donorAdapter.get(obj.object_key);
        if (!donorObj) {
          for (const d of damagedSlots) {
            unrecoverable.push({
              storageObjectId: obj.id,
              slot: d.slot,
              reason: 'Healthy donor stream unavailable'
            });
          }
          continue;
        }
        const healthyBytes = new Uint8Array(await new Response(donorObj.body).arrayBuffer());

        for (const damaged of damagedSlots) {
          if (damaged.slot === 'copy3_offsite') continue;
          const targetAdapter = (await resolveAdapter(env, damaged.nodeId, damaged.slot))!;
          try {
            await targetAdapter.put(
              obj.object_key,
              healthyBytes,
              donorObj.contentType ?? 'application/octet-stream',
              obj.sha256
            );
            const recheck = await targetAdapter.computeSha256(obj.object_key);
            if (recheck.sha256 === obj.sha256 && recheck.sizeBytes === expectedSize) {
              healedReplicas++;
              const healedAt = new Date().toISOString();
              await env.DB.prepare(
                `INSERT INTO replica_status (
                   id, storage_object_id, replica_slot, storage_node_id, provider, bucket, state, verified_sha256, last_verified_at, error_message, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, ?, NULL, ?)
                 ON CONFLICT (storage_object_id, replica_slot) DO UPDATE SET
                   state = 'verified',
                   storage_node_id = excluded.storage_node_id,
                   provider = excluded.provider,
                   bucket = excluded.bucket,
                   verified_sha256 = excluded.verified_sha256,
                   last_verified_at = excluded.last_verified_at,
                   error_message = NULL,
                   updated_at = excluded.updated_at`
              )
                .bind(
                  crypto.randomUUID(),
                  obj.id,
                  damaged.slot,
                  damaged.nodeId,
                  targetAdapter.provider,
                  targetAdapter.bucket,
                  recheck.sha256,
                  healedAt,
                  healedAt
                )
                .run();
            } else {
              unrecoverable.push({
                storageObjectId: obj.id,
                slot: damaged.slot,
                reason: 'Post-heal SHA-256 verification failed'
              });
            }
          } catch (err) {
            unrecoverable.push({
              storageObjectId: obj.id,
              slot: damaged.slot,
              reason: (err as Error).message
            });
          }
        }
      } else if (damagedSlots.length > 0 && healthySlots.length === 0) {
        for (const d of damagedSlots) {
          unrecoverable.push({
            storageObjectId: obj.id,
            slot: d.slot,
            reason: 'No healthy replica available to self-heal'
          });
        }
      }

      await env.DB.prepare(
        `UPDATE media_files SET upload_state = CASE WHEN (
           SELECT COUNT(*) FROM replica_status
           WHERE storage_object_id = ? AND state = 'verified'
             AND replica_slot IN ('copy1_primary', 'copy2_secondary')
         ) = 2 THEN 'verified' ELSE 'insufficient_replicas' END
         WHERE id = ? AND upload_state IN ('verified', 'insufficient_replicas')`
      ).bind(obj.id, obj.media_id).run();
    }

    const result: IntegrityScanResult = {
      scannedReplicas,
      healthyReplicas,
      corruptedDetected,
      missingDetected,
      healedReplicas,
      unrecoverable
    };
    return jsonResponse({ result });
  }

  // ==================== MULTI-CLOUD STORAGE POOL ====================

  // POST /api/v1/admin/users/sync-pool-quota (1-click sync user quota to real copy1_primary pool capacity)
  if (method === 'POST' && pathname === '/api/v1/admin/users/sync-pool-quota') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const body = await readJson<{ userId?: string }>(request).catch(() => ({} as { userId?: string }));
    const pool = await buildPoolView(env);
    const primaryCap = Math.max(
      10 * 1024 * 1024 * 1024,
      Math.min(MAX_QUOTA_BYTES, Math.floor(pool.summary.bySlot.copy1_primary.totalCapacityBytes))
    );
    const now = new Date().toISOString();

    if (body.userId) {
      const res = await env.DB.prepare(
        'UPDATE users SET quota_bytes = ?, updated_at = ? WHERE id = ?'
      )
        .bind(primaryCap, now, body.userId)
        .run();
      return jsonResponse({
        updatedUsers: res.meta.changes ?? 0,
        quotaBytes: primaryCap
      });
    }

    const res = await env.DB.prepare(
      'UPDATE users SET quota_bytes = ?, updated_at = ? WHERE is_active = 1'
    )
      .bind(primaryCap, now)
      .run();
    return jsonResponse({
      updatedUsers: res.meta.changes ?? 0,
      quotaBytes: primaryCap
    });
  }

  // GET /api/v1/admin/storage/pool/google-drive/config
  if (method === 'GET' && pathname === '/api/v1/admin/storage/pool/google-drive/config') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const creds = await loadGoogleOAuthCredentials(env);
    const redirectUri = `${url.origin}/api/v1/admin/storage/pool/google-drive/oauth/callback`;
    return jsonResponse({
      configured: Boolean(creds),
      source: creds?.source ?? 'none',
      clientId: creds?.clientId ?? '',
      hasClientSecret: Boolean(creds?.clientSecret),
      redirectUri
    });
  }

  // PUT /api/v1/admin/storage/pool/google-drive/config
  if (method === 'PUT' && pathname === '/api/v1/admin/storage/pool/google-drive/config') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const body = await readJson<{ clientId?: string; clientSecret?: string }>(request);
    const clientId = (body.clientId ?? '').trim();
    if (!clientId || !clientId.includes('.apps.googleusercontent.com')) {
      throw new HttpError(
        400,
        'INVALID_GOOGLE_CLIENT_ID',
        'Google Client ID không hợp lệ (cần có đuôi .apps.googleusercontent.com).'
      );
    }

    const existing = await loadGoogleOAuthCredentials(env);
    const rawSecret = (body.clientSecret ?? '').trim() || existing?.clientSecret || '';
    if (!rawSecret) {
      throw new HttpError(400, 'MISSING_GOOGLE_CLIENT_SECRET', 'Vui lòng nhập Google Client Secret.');
    }

    const encryptedClientSecret = await encryptStorageSecret(rawSecret, getStorageSecretSeed(env));
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO system_settings (key, value, updated_at, updated_by)
       VALUES ('google_drive_oauth', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    )
      .bind(JSON.stringify({ clientId, encryptedClientSecret }), now, auth.userId)
      .run();

    const redirectUri = `${url.origin}/api/v1/admin/storage/pool/google-drive/oauth/callback`;
    return jsonResponse({
      configured: true,
      source: 'database',
      clientId,
      hasClientSecret: true,
      redirectUri
    });
  }

  // POST /api/v1/admin/storage/pool/google-drive/oauth/start
  if (method === 'POST' && pathname === '/api/v1/admin/storage/pool/google-drive/oauth/start') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const creds = await loadGoogleOAuthCredentials(env);
    if (!creds) {
      throw new HttpError(
        400,
        'GOOGLE_OAUTH_NOT_CONFIGURED',
        'Chưa cấu hình Google OAuth Client ID và Client Secret.'
      );
    }
    const body = await readJson<{
      slot?: ReplicaSlot;
      folderName?: string;
      priority?: number;
      openerOrigin?: string;
    }>(request).catch(() => ({} as {
      slot?: ReplicaSlot;
      folderName?: string;
      priority?: number;
      openerOrigin?: string;
    }));
    const slot: ReplicaSlot =
      body.slot === 'copy2_secondary' ? 'copy2_secondary' : 'copy1_primary';
    const folderName = (body.folderName ?? 'kho-anh-vault').trim().replace(/^\/+|\/+$/g, '') || 'kho-anh-vault';
    const priority =
      typeof body.priority === 'number' && Number.isInteger(body.priority) && body.priority >= 1
        ? body.priority
        : 2;
    const redirectUri = `${url.origin}/api/v1/admin/storage/pool/google-drive/oauth/callback`;

    const statePayload = JSON.stringify({
      userId: auth.userId,
      slot,
      folderName,
      priority,
      openerOrigin: body.openerOrigin || url.origin,
      exp: Date.now() + 15 * 60 * 1000
    });
    const stateB64 = btoa(statePayload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const sig = await hmacSha256Hex(getStorageSecretSeed(env), stateB64);
    const state = `${stateB64}.${sig}`;

    const authParams = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/drive.file',
      access_type: 'offline',
      prompt: 'select_account consent',
      include_granted_scopes: 'true',
      state
    });

    return jsonResponse({
      authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`,
      redirectUri
    });
  }

  // GET /api/v1/admin/storage/pool/google-drive/oauth/callback (Browser redirect from Google)
  if (method === 'GET' && pathname === '/api/v1/admin/storage/pool/google-drive/oauth/callback') {
    const renderPopupResult = (ok: boolean, message: string, openerOrigin = '*', extra: Record<string, unknown> = {}) => {
      const safeMsg = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const payloadJson = JSON.stringify({ type: 'kho-anh-gdrive-oauth', ok, message, ...extra }).replace(
        /</g,
        '\\u003c'
      );
      const safeOrigin = JSON.stringify(openerOrigin);
      const html = `<!doctype html>
<html lang="vi">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kết nối Google Drive</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#111113;color:#f5f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}.card{max-width:440px;background:#1c1c20;border:1px solid #2e2e35;border-radius:16px;padding:24px}h2{margin:0 0 8px;color:${ok ? '#34d399' : '#f87171'}}p{color:#a1a1aa;line-height:1.5}button{margin-top:16px;padding:10px 18px;border-radius:10px;border:none;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}</style>
</head>
<body>
<div class="card">
  <h2>${ok ? 'Kết nối Google Drive thành công!' : 'Kết nối Google Drive thất bại'}</h2>
  <p>${safeMsg}</p>
  <button onclick="window.close()">Đóng cửa sổ</button>
</div>
<script>
try {
  if (window.opener) {
    window.opener.postMessage(${payloadJson}, ${safeOrigin});
    ${ok ? 'setTimeout(function(){ window.close(); }, 1200);' : ''}
  }
} catch (e) {}
</script>
</body></html>`;
      return new Response(html, {
        status: ok ? 200 : 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    };

    const errorParam = url.searchParams.get('error');
    if (errorParam) {
      return renderPopupResult(false, `Google từ chối cấp quyền: ${errorParam}`);
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || !state.includes('.')) {
      return renderPopupResult(false, 'Thiếu mã xác thực (code/state) từ Google.');
    }

    const [stateB64, providedSig] = state.split('.');
    const expectedSig = await hmacSha256Hex(getStorageSecretSeed(env), stateB64!);
    if (providedSig !== expectedSig) {
      return renderPopupResult(false, 'Chữ ký OAuth state không hợp lệ.');
    }

    let parsedState: {
      userId: string;
      slot: ReplicaSlot;
      folderName: string;
      priority: number;
      openerOrigin: string;
      exp: number;
    };
    try {
      const padded = stateB64!.replace(/-/g, '+').replace(/_/g, '/');
      parsedState = JSON.parse(atob(padded));
    } catch {
      return renderPopupResult(false, 'Không giải mã được OAuth state.');
    }

    if (Date.now() > parsedState.exp) {
      return renderPopupResult(false, 'Phiên kết nối Google OAuth đã hết hạn, vui lòng thử lại.', parsedState.openerOrigin);
    }

    const creds = await loadGoogleOAuthCredentials(env);
    if (!creds) {
      return renderPopupResult(false, 'Chưa cấu hình Google OAuth credentials trên server.', parsedState.openerOrigin);
    }

    const redirectUri = `${url.origin}/api/v1/admin/storage/pool/google-drive/oauth/callback`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      return renderPopupResult(false, `Đổi mã token thất bại (${tokenRes.status}): ${errText.slice(0, 200)}`, parsedState.openerOrigin);
    }

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (!tokenData.access_token || !tokenData.refresh_token) {
      return renderPopupResult(
        false,
        'Google không trả về refresh_token. Hãy gỡ quyền cũ của app trong myaccount.google.com/permissions rồi kết nối lại.',
        parsedState.openerOrigin
      );
    }

    let about;
    try {
      about = await fetchGoogleDriveAbout(tokenData.access_token);
    } catch (err) {
      return renderPopupResult(
        false,
        `Không đọc được thông tin dung lượng Google Drive: ${err instanceof Error ? err.message : String(err)}`,
        parsedState.openerOrigin
      );
    }

    const now = new Date().toISOString();
    const existingNode = await env.DB.prepare(
      "SELECT id, used_bytes FROM storage_nodes WHERE provider = 'google_drive' AND access_key_id = ? AND replica_slot = ?"
    )
      .bind(about.email, parsedState.slot)
      .first<{ id: string; used_bytes: number }>();

    const existingUsed = Number(existingNode?.used_bytes ?? 0);
    // Available space for Kho Ảnh = Google Drive free space + bytes already stored by Kho Ảnh
    const realCapacityBytes = Math.max(1024 * 1024, Math.min(MAX_QUOTA_BYTES, about.freeBytes + existingUsed));
    const secretPayload = JSON.stringify({
      refreshToken: tokenData.refresh_token,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret
    });
    const encryptedSecret = await encryptStorageSecret(secretPayload, getStorageSecretSeed(env));
    const limitGb = Math.round((about.limitBytes / (1024 * 1024 * 1024)) * 10) / 10;
    const freeGb = Math.round((about.freeBytes / (1024 * 1024 * 1024)) * 10) / 10;
    const nodeName = `Google Drive · ${about.email} (${limitGb >= 1024 ? `${(limitGb / 1024).toFixed(1)} TB` : `${limitGb} GB`})`;
    const testMsg = `Đã kết nối OAuth (${about.email}) — còn trống ${freeGb} GB / ${limitGb} GB.`;

    let nodeId: string;
    if (existingNode) {
      nodeId = existingNode.id;
      await env.DB.prepare(
        `UPDATE storage_nodes
         SET name = ?, enabled = 1, priority = ?, capacity_bytes = ?, bucket = ?,
             encrypted_secret_access_key = ?, last_test_ok = 1, last_test_at = ?, last_test_message = ?, updated_at = ?
         WHERE id = ?`
      )
        .bind(
          nodeName,
          parsedState.priority,
          realCapacityBytes,
          parsedState.folderName,
          encryptedSecret,
          now,
          testMsg,
          now,
          nodeId
        )
        .run();
    } else {
      nodeId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO storage_nodes (
           id, name, replica_slot, provider, enabled, priority, capacity_bytes, used_bytes,
           endpoint, region, bucket, access_key_id, encrypted_secret_access_key,
           force_path_style, local_root, last_test_ok, last_test_at, last_test_message, created_at, updated_at
         ) VALUES (?, ?, ?, 'google_drive', 1, ?, ?, 0, 'https://www.googleapis.com/drive/v3', 'global', ?, ?, ?, 0, '', 1, ?, ?, ?, ?)`
      )
        .bind(
          nodeId,
          nodeName,
          parsedState.slot,
          parsedState.priority,
          realCapacityBytes,
          parsedState.folderName,
          about.email,
          encryptedSecret,
          now,
          testMsg,
          now,
          now
        )
        .run();
    }

    return renderPopupResult(
      true,
      `Đã thêm kho ${nodeName} (còn trống ${freeGb} GB) vào Multi-Cloud Storage Pool.`,
      parsedState.openerOrigin,
      { nodeId, email: about.email, capacityBytes: realCapacityBytes }
    );
  }

  // POST /api/v1/admin/storage/pool/google-drive/:nodeId/refresh-quota
  const gdRefreshMatch = pathname.match(
    /^\/api\/v1\/admin\/storage\/pool\/google-drive\/([^/]+)\/refresh-quota$/
  );
  if (method === 'POST' && gdRefreshMatch) {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const nodeId = gdRefreshMatch[1]!;
    const nodes = await loadPoolNodes(env);
    const node = nodes.find((n) => n.id === nodeId);
    if (!node || node.provider !== 'google_drive' || !(node.adapter instanceof GoogleDriveStorageAdapter)) {
      throw new HttpError(404, 'NODE_NOT_FOUND', 'Không tìm thấy kho Google Drive này trong Pool.');
    }

    const driveQuota = await node.adapter.fetchQuotaInfo();
    const realCapacityBytes = Math.max(
      1024 * 1024,
      Math.min(MAX_QUOTA_BYTES, driveQuota.freeBytes + node.usedBytes)
    );
    const freeGb = Math.round((driveQuota.freeBytes / (1024 * 1024 * 1024)) * 10) / 10;
    const limitGb = Math.round((driveQuota.limitBytes / (1024 * 1024 * 1024)) * 10) / 10;
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE storage_nodes
       SET capacity_bytes = ?, last_test_ok = 1, last_test_at = ?, last_test_message = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(
        realCapacityBytes,
        now,
        `Đồng bộ dung lượng thật (${driveQuota.email}): còn trống ${freeGb} GB / ${limitGb} GB.`,
        now,
        nodeId
      )
      .run();

    const pool = await buildPoolView(env);
    const updatedNode = pool.nodes.find((n) => n.id === nodeId)!;
    return jsonResponse({
      node: updatedNode,
      summary: pool.summary,
      driveQuota
    });
  }

  if (method === 'GET' && pathname === '/api/v1/admin/storage/pool') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const pool = await buildPoolView(env);
    return jsonResponse({
      nodes: pool.nodes,
      summary: pool.summary,
      presets: PRESETS
    });
  }

  // POST /api/v1/admin/storage/pool/test (live probe for unsaved draft config)
  if (method === 'POST' && pathname === '/api/v1/admin/storage/pool/test') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const body = await readJson<Partial<CreateOrUpdateStorageNodeRequest>>(request);
    validateNodeInput(body, true);

    const provider = body.provider!;
    const endpoint = (body.endpoint ?? '').trim();
    validateEndpointUrl(endpoint, true);

    const adapter = buildAdapterFromRecord(env, {
      provider,
      endpoint,
      region: (body.region ?? 'auto').trim() || 'auto',
      bucket:
        (body.bucket ?? '').trim() ||
        (providerProtocol(provider) === 'webdav' ? 'vault-photos' : ''),
      accessKeyId: (body.accessKeyId ?? '').trim(),
      secretAccessKey: body.secretAccessKey ?? '',
      forcePathStyle: body.forcePathStyle !== false
    });

    if (!adapter) {
      return jsonResponse({
        result: {
          ok: false,
          provider,
          latencyMs: 0,
          checks: { write: false, readVerify: false, delete: false },
          message:
            'Thiếu thông tin kết nối bắt buộc (Endpoint / AccessKey-Username / SecretKey-Password / Bucket).'
        } satisfies TestStorageTargetResponse
      });
    }

    const result = await adapter.probe();
    return jsonResponse({ result });
  }

  // POST /api/v1/admin/storage/pool/nodes
  if (method === 'POST' && pathname === '/api/v1/admin/storage/pool/nodes') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const body = await readJson<Partial<CreateOrUpdateStorageNodeRequest>>(request);
    validateNodeInput(body, true);

    const provider = body.provider!;
    const proto = providerProtocol(provider);
    const endpoint = (body.endpoint ?? '').trim();
    validateEndpointUrl(endpoint, true);

    const accessKeyId = (body.accessKeyId ?? '').trim();
    const secretPlain = body.secretAccessKey ?? '';
    const bucket =
      (body.bucket ?? '').trim() ||
      (proto === 'webdav'
        ? 'vault-photos'
        : body.name!
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-'));

    if (!endpoint || !accessKeyId || !secretPlain) {
      throw new HttpError(
        400,
        'MISSING_CREDENTIALS',
        proto === 'webdav'
          ? 'Cần nhập đầy đủ WebDAV Endpoint, Username và App Password.'
          : 'Cần nhập đầy đủ Endpoint, Bucket, Access Key ID và Secret Access Key.'
      );
    }
    if (proto === 's3' && !bucket) {
      throw new HttpError(400, 'MISSING_BUCKET', 'Cần nhập tên Bucket cho kho S3.');
    }

    const encryptedSecret = await encryptStorageSecret(secretPlain, getStorageSecretSeed(env));
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO storage_nodes (
        id, name, replica_slot, provider, enabled, priority, capacity_bytes, used_bytes,
        endpoint, region, bucket, access_key_id, encrypted_secret_access_key,
        force_path_style, local_root, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, '', ?, ?)`
    )
      .bind(
        id,
        body.name!.trim(),
        body.slot!,
        provider,
        body.enabled === false ? 0 : 1,
        body.priority ?? 100,
        Math.floor(body.capacityBytes!),
        endpoint,
        (body.region ?? 'auto').trim() || 'auto',
        bucket,
        accessKeyId,
        encryptedSecret,
        body.forcePathStyle === false ? 0 : 1,
        now,
        now
      )
      .run();

    const pool = await buildPoolView(env);
    const node = pool.nodes.find((n) => n.id === id)!;
    return jsonResponse({ node, summary: pool.summary }, 201);
  }

  // PATCH /api/v1/admin/storage/pool/nodes/:nodeId
  const patchNodeMatch = pathname.match(/^\/api\/v1\/admin\/storage\/pool\/nodes\/([^/]+)$/);
  if (method === 'PATCH' && patchNodeMatch) {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const nodeId = patchNodeMatch[1]!;
    const body = await readJson<Partial<CreateOrUpdateStorageNodeRequest>>(request);
    validateNodeInput(body, false);

    if (nodeId === NATIVE_R2_NODE_ID) {
      const current = await loadR2NativeOverride(env);
      const next = {
        ...current,
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.capacityBytes !== undefined ? { capacityBytes: Math.floor(body.capacityBytes) } : {})
      };
      await saveR2NativeOverride(env, next, auth.userId);
      const pool = await buildPoolView(env);
      const node = pool.nodes.find((n) => n.id === NATIVE_R2_NODE_ID)!;
      return jsonResponse({ node, summary: pool.summary });
    }

    const existing = await env.DB.prepare('SELECT * FROM storage_nodes WHERE id = ?')
      .bind(nodeId)
      .first<StorageNodeDbRow>();
    if (!existing) {
      throw new HttpError(404, 'NODE_NOT_FOUND', 'Không tìm thấy storage pool node');
    }

    const nextProvider = body.provider ?? existing.provider;
    const nextEndpoint = body.endpoint !== undefined ? body.endpoint.trim() : existing.endpoint;
    validateEndpointUrl(nextEndpoint, true);

    const nextSecretEncrypted =
      body.secretAccessKey && body.secretAccessKey.length > 0
        ? await encryptStorageSecret(body.secretAccessKey, getStorageSecretSeed(env))
        : existing.encrypted_secret_access_key;

    await env.DB.prepare(
      `UPDATE storage_nodes
       SET name = ?, replica_slot = ?, provider = ?, enabled = ?, priority = ?, capacity_bytes = ?,
           endpoint = ?, region = ?, bucket = ?, access_key_id = ?, encrypted_secret_access_key = ?,
           force_path_style = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(
        body.name !== undefined ? body.name.trim() : existing.name,
        body.slot ?? existing.replica_slot,
        nextProvider,
        body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
        body.priority !== undefined ? body.priority : existing.priority,
        body.capacityBytes !== undefined ? Math.floor(body.capacityBytes) : existing.capacity_bytes,
        nextEndpoint,
        body.region !== undefined ? body.region.trim() || 'auto' : existing.region,
        body.bucket !== undefined ? body.bucket.trim() : existing.bucket,
        body.accessKeyId !== undefined ? body.accessKeyId.trim() : existing.access_key_id,
        nextSecretEncrypted,
        body.forcePathStyle !== undefined
          ? body.forcePathStyle
            ? 1
            : 0
          : existing.force_path_style,
        new Date().toISOString(),
        nodeId
      )
      .run();

    const pool = await buildPoolView(env);
    const node = pool.nodes.find((n) => n.id === nodeId)!;
    return jsonResponse({ node, summary: pool.summary });
  }

  // POST /api/v1/admin/storage/pool/nodes/:id/test (Real live network probe!)
  const testNodeMatch = pathname.match(/^\/api\/v1\/admin\/storage\/pool\/nodes\/([^/]+)\/test$/);
  if (method === 'POST' && testNodeMatch) {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const nodeId = testNodeMatch[1]!;

    if (nodeId === NATIVE_R2_NODE_ID) {
      if (!env.VAULT_BUCKET) {
        return jsonResponse({
          result: {
            ok: false,
            provider: 'cloudflare_r2',
            latencyMs: 0,
            checks: { write: false, readVerify: false, delete: false },
            message: 'Cloudflare R2 chưa được bật trên tài khoản.'
          } satisfies TestStorageTargetResponse
        });
      }
      const r2Adapter = new R2StorageAdapter(env.VAULT_BUCKET, 'kho-anh-vault');
      const result = await r2Adapter.probe();
      const currentOverride = await loadR2NativeOverride(env);
      await saveR2NativeOverride(
        env,
        {
          ...currentOverride,
          lastTestOk: result.ok,
          lastTestAt: new Date().toISOString(),
          lastTestMessage: result.message
        },
        auth.userId
      );
      return jsonResponse({ result });
    }

    const nodes = await loadPoolNodes(env);
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new HttpError(404, 'NODE_NOT_FOUND', 'Không tìm thấy storage pool node');
    }
    if (!node.adapter) {
      return jsonResponse({
        result: {
          ok: false,
          provider: node.provider,
          latencyMs: 0,
          checks: { write: false, readVerify: false, delete: false },
          message: 'Node thiếu cấu hình kết nối hoặc giao thức không được hỗ trợ trên Worker.'
        } satisfies TestStorageTargetResponse
      });
    }

    const result = await node.adapter.probe();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'UPDATE storage_nodes SET last_test_ok = ?, last_test_at = ?, last_test_message = ?, updated_at = ? WHERE id = ?'
    )
      .bind(result.ok ? 1 : 0, now, result.message, now, nodeId)
      .run();

    return jsonResponse({ result });
  }

  // DELETE /api/v1/admin/storage/pool/nodes/:id (409 guard if files/replicas remain)
  const delNodeMatch = pathname.match(/^\/api\/v1\/admin\/storage\/pool\/nodes\/([^/]+)$/);
  if (method === 'DELETE' && delNodeMatch) {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const nodeId = delNodeMatch[1]!;

    if (nodeId === NATIVE_R2_NODE_ID) {
      throw new HttpError(400, 'CANNOT_DELETE_NATIVE', 'Không thể xóa R2 Native Binding mặc định');
    }

    const existing = await env.DB.prepare('SELECT id FROM storage_nodes WHERE id = ?')
      .bind(nodeId)
      .first<{ id: string }>();
    if (!existing) {
      throw new HttpError(404, 'NODE_NOT_FOUND', 'Không tìm thấy storage pool node');
    }

    const usageRow = await env.DB.prepare(
      `SELECT (
         (SELECT COUNT(*) FROM storage_objects WHERE primary_node_id = ?) +
         (SELECT COUNT(*) FROM replica_status WHERE storage_node_id = ?) +
         (SELECT COUNT(*) FROM upload_sessions WHERE storage_node_id = ? AND status = 'uploading')
       ) AS cnt`
    )
      .bind(nodeId, nodeId, nodeId)
      .first<{ cnt: number }>();

    if (Number(usageRow?.cnt ?? 0) > 0) {
      throw new HttpError(
        409,
        'NODE_NOT_EMPTY',
        'Kho này vẫn đang chứa file gốc hoặc bản sao của người dùng. Hãy tạm tắt nhận file mới hoặc chạy Migration sang kho khác trước khi gỡ.'
      );
    }

    await env.DB.prepare('DELETE FROM storage_nodes WHERE id = ?').bind(nodeId).run();
    const pool = await buildPoolView(env);
    return jsonResponse({ removed: true, summary: pool.summary });
  }

  // POST /api/v1/admin/storage/migrate
  if (method === 'POST' && pathname === '/api/v1/admin/storage/migrate') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const body = await readJson<{ sourceSlot?: ReplicaSlot; targetSlot?: ReplicaSlot }>(request);
    if (
      !body.sourceSlot ||
      !body.targetSlot ||
      !VALID_SLOTS.has(body.sourceSlot) ||
      !VALID_SLOTS.has(body.targetSlot) ||
      body.targetSlot === 'copy3_offsite'
    ) {
      throw new HttpError(400, 'INVALID_MIGRATE_REQUEST', 'sourceSlot và targetSlot không hợp lệ');
    }
    if (body.sourceSlot === body.targetSlot) {
      throw new HttpError(400, 'SAME_SLOT', 'sourceSlot và targetSlot phải khác nhau.');
    }

    const objectsRes = await env.DB.prepare(
      `SELECT so.id, so.object_key, so.primary_node_id, so.sha256, so.size_bytes
       FROM storage_objects so
       JOIN media_files m ON m.id = so.media_id
       WHERE so.object_kind = 'original' AND m.deleted_at IS NULL
       ORDER BY so.created_at ASC
       LIMIT 50`
    ).all<{
      id: string;
      object_key: string;
      primary_node_id: string | null;
      sha256: string;
      size_bytes: number;
    }>();

    let migratedCount = 0;
    let skippedAlreadyVerified = 0;
    const failures: StorageMigrationResult['failures'] = [];

    for (const obj of objectsRes.results) {
      const expectedSize = Number(obj.size_bytes);
      const sourceNodeRow =
        body.sourceSlot === 'copy1_primary'
          ? { nodeId: obj.primary_node_id }
          : await env.DB.prepare(
              'SELECT storage_node_id AS nodeId FROM replica_status WHERE storage_object_id = ? AND replica_slot = ?'
            )
              .bind(obj.id, body.sourceSlot)
              .first<{ nodeId: string | null }>();

      const existingTargetRow = await env.DB.prepare(
        'SELECT storage_node_id AS nodeId FROM replica_status WHERE storage_object_id = ? AND replica_slot = ?'
      )
        .bind(obj.id, body.targetSlot)
        .first<{ nodeId: string | null }>();
      const existingTargetNodeId = existingTargetRow?.nodeId ?? null;

      const sourceAdapter = await resolveAdapter(
        env,
        sourceNodeRow?.nodeId ?? null,
        body.sourceSlot
      );
      const targetSelected = await selectTargetForWrite(env, body.targetSlot, expectedSize);
      if (!sourceAdapter || !targetSelected) {
        failures.push({
          objectKey: obj.object_key,
          error: 'Source or target storage unavailable or full'
        });
        continue;
      }

      const targetAdapter = targetSelected.adapter;
      try {
        const existingHead = await targetAdapter.head(obj.object_key);
        if (existingHead && existingHead.sizeBytes === expectedSize) {
          const check = await targetAdapter.computeSha256(obj.object_key);
          if (check.sha256 === obj.sha256) {
            const now = new Date().toISOString();
            skippedAlreadyVerified++;
            await env.DB.prepare(
              `INSERT INTO replica_status (
                 id, storage_object_id, replica_slot, storage_node_id, provider, bucket, state, verified_sha256, last_verified_at, error_message, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, ?, NULL, ?)
               ON CONFLICT (storage_object_id, replica_slot) DO UPDATE SET
                 state = 'verified',
                 storage_node_id = excluded.storage_node_id,
                 provider = excluded.provider,
                 bucket = excluded.bucket,
                 verified_sha256 = excluded.verified_sha256,
                 last_verified_at = excluded.last_verified_at,
                 error_message = NULL,
                 updated_at = excluded.updated_at`
            )
              .bind(
                crypto.randomUUID(),
                obj.id,
                body.targetSlot,
                targetSelected.nodeId,
                targetAdapter.provider,
                targetAdapter.bucket,
                check.sha256,
                now,
                now
              )
              .run();
            continue;
          }
        }

        const sourceObj = await sourceAdapter.get(obj.object_key);
        if (!sourceObj) {
          throw new Error(`Missing source object ${obj.object_key}`);
        }
        const bytes = new Uint8Array(await new Response(sourceObj.body).arrayBuffer());
        await targetAdapter.put(
          obj.object_key,
          bytes,
          sourceObj.contentType ?? 'application/octet-stream',
          obj.sha256
        );

        const verified = await targetAdapter.computeSha256(obj.object_key);
        if (verified.sha256 !== obj.sha256 || verified.sizeBytes !== expectedSize) {
          throw new Error('Post-migration SHA-256 verification mismatch');
        }

        const now = new Date().toISOString();
        const stmts = [
          env.DB.prepare(
            `INSERT INTO replica_status (
               id, storage_object_id, replica_slot, storage_node_id, provider, bucket, state, verified_sha256, last_verified_at, error_message, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, ?, NULL, ?)
             ON CONFLICT (storage_object_id, replica_slot) DO UPDATE SET
               state = 'verified',
               storage_node_id = excluded.storage_node_id,
               provider = excluded.provider,
               bucket = excluded.bucket,
               verified_sha256 = excluded.verified_sha256,
               last_verified_at = excluded.last_verified_at,
               error_message = NULL,
               updated_at = excluded.updated_at`
          ).bind(
            crypto.randomUUID(),
            obj.id,
            body.targetSlot,
            targetSelected.nodeId,
            targetAdapter.provider,
            targetAdapter.bucket,
            verified.sha256,
            now,
            now
          )
        ];

        if (targetSelected.nodeId && targetSelected.nodeId !== existingTargetNodeId) {
          stmts.push(
            env.DB.prepare(
              'UPDATE storage_nodes SET used_bytes = used_bytes + ?, updated_at = ? WHERE id = ?'
            ).bind(expectedSize, now, targetSelected.nodeId)
          );
        }
        await env.DB.batch(stmts);
        migratedCount++;
      } catch (err) {
        failures.push({ objectKey: obj.object_key, error: (err as Error).message });
      }
    }

    const result: StorageMigrationResult = {
      sourceSlot: body.sourceSlot,
      targetSlot: body.targetSlot,
      migratedCount,
      skippedAlreadyVerified,
      failedCount: failures.length,
      failures
    };
    return jsonResponse({ result });
  }

  // ==================== LEGACY SINGLE-SLOT STORAGE TARGETS PARITY ====================

  if (method === 'GET' && pathname === '/api/v1/admin/storage/targets') {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const targets = await listLegacyTargetViews(env);
    return jsonResponse({ targets, presets: PRESETS });
  }

  const testTargetMatch = pathname.match(/^\/api\/v1\/admin\/storage\/targets\/([^/]+)\/test$/);
  if (method === 'POST' && testTargetMatch) {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const slot = testTargetMatch[1] as ReplicaSlot;
    if (!VALID_SLOTS.has(slot)) {
      throw new HttpError(400, 'INVALID_SLOT', 'Invalid storage slot');
    }

    const body = await readJson<Partial<SaveStorageTargetRequest>>(request).catch(
      () => ({}) as Partial<SaveStorageTargetRequest>
    );
    const existing = await env.DB.prepare('SELECT * FROM storage_targets WHERE slot = ?')
      .bind(slot)
      .first<StorageTargetDbRow>();

    if (body.provider) {
      if (!VALID_PROVIDERS.has(body.provider) || body.provider === 'local') {
        throw new HttpError(400, 'INVALID_PROVIDER', 'Nhà cung cấp không hợp lệ trên Worker');
      }
      const endpoint = (body.endpoint ?? '').trim();
      validateEndpointUrl(endpoint, true);
      const adapter = buildAdapterFromRecord(env, {
        provider: body.provider,
        endpoint,
        region: (body.region ?? 'auto').trim() || 'auto',
        bucket: (body.bucket ?? '').trim() || slot,
        accessKeyId: (body.accessKeyId ?? '').trim() || existing?.access_key_id || '',
        secretAccessKey: body.secretAccessKey || '',
        forcePathStyle: body.forcePathStyle !== false
      });
      if (!adapter) {
        return jsonResponse({
          result: {
            ok: false,
            provider: body.provider,
            latencyMs: 0,
            checks: { write: false, readVerify: false, delete: false },
            message: 'Thiếu thông tin kết nối bắt buộc.'
          } satisfies TestStorageTargetResponse
        });
      }
      const result = await adapter.probe();
      return jsonResponse({ result });
    }

    const adapter = await resolveAdapter(env, null, slot);
    if (!adapter) {
      return jsonResponse({
        result: {
          ok: false,
          provider: existing?.provider ?? 's3_custom',
          latencyMs: 0,
          checks: { write: false, readVerify: false, delete: false },
          message: 'Slot chưa được cấu hình.'
        } satisfies TestStorageTargetResponse
      });
    }
    const result = await adapter.probe();
    if (existing) {
      await env.DB.prepare(
        'UPDATE storage_targets SET last_test_ok = ?, last_test_at = ?, last_test_message = ? WHERE slot = ?'
      )
        .bind(result.ok ? 1 : 0, new Date().toISOString(), result.message, slot)
        .run();
    }
    return jsonResponse({ result });
  }

  const targetSlotMatch = pathname.match(/^\/api\/v1\/admin\/storage\/targets\/([^/]+)$/);
  if (method === 'PUT' && targetSlotMatch) {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const slot = targetSlotMatch[1] as ReplicaSlot;
    if (!VALID_SLOTS.has(slot)) {
      throw new HttpError(400, 'INVALID_SLOT', 'Invalid storage slot');
    }

    const body = await readJson<SaveStorageTargetRequest>(request);
    if (!body.provider || !VALID_PROVIDERS.has(body.provider) || body.provider === 'local') {
      throw new HttpError(400, 'INVALID_PROVIDER', 'Nhà cung cấp không hợp lệ trên Worker');
    }
    const enabled = body.enabled !== false;
    if (slot === 'copy1_primary' && !enabled) {
      throw new HttpError(400, 'PRIMARY_REQUIRED', 'Copy 1 (Primary) không thể bị tắt.');
    }

    const endpoint = (body.endpoint ?? '').trim();
    validateEndpointUrl(endpoint, enabled);
    const existing = await env.DB.prepare('SELECT * FROM storage_targets WHERE slot = ?')
      .bind(slot)
      .first<StorageTargetDbRow>();

    const accessKeyId = (body.accessKeyId ?? '').trim() || existing?.access_key_id || '';
    const encryptedSecret = body.secretAccessKey
      ? await encryptStorageSecret(body.secretAccessKey, getStorageSecretSeed(env))
      : existing?.encrypted_secret_access_key || '';

    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO storage_targets (
         slot, provider, enabled, endpoint, region, bucket,
         access_key_id, encrypted_secret_access_key, force_path_style, local_root,
         updated_at, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
       ON CONFLICT(slot) DO UPDATE SET
         provider = excluded.provider,
         enabled = excluded.enabled,
         endpoint = excluded.endpoint,
         region = excluded.region,
         bucket = excluded.bucket,
         access_key_id = excluded.access_key_id,
         encrypted_secret_access_key = excluded.encrypted_secret_access_key,
         force_path_style = excluded.force_path_style,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    )
      .bind(
        slot,
        body.provider,
        enabled ? 1 : 0,
        endpoint,
        (body.region ?? 'auto').trim() || 'auto',
        (body.bucket ?? '').trim() || slot,
        accessKeyId,
        encryptedSecret,
        body.forcePathStyle !== false ? 1 : 0,
        now,
        auth.userId
      )
      .run();

    const targets = await listLegacyTargetViews(env);
    return jsonResponse({
      saved: true,
      target: targets.find((t) => t.slot === slot)!
    });
  }

  if (method === 'DELETE' && targetSlotMatch) {
    const auth = await requireAuth(request, env);
    requireAdmin(auth);
    const slot = targetSlotMatch[1] as ReplicaSlot;
    if (!VALID_SLOTS.has(slot)) {
      throw new HttpError(400, 'INVALID_SLOT', 'Invalid storage slot');
    }
    if (slot === 'copy1_primary') {
      throw new HttpError(400, 'PRIMARY_REQUIRED', 'Không thể gỡ bỏ Copy 1 (Primary).');
    }
    await env.DB.prepare('DELETE FROM storage_targets WHERE slot = ?').bind(slot).run();
    return jsonResponse({ removed: true, slot });
  }

  return null;
}
