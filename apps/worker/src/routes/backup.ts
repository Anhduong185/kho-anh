import {
  classifyMediaFormat,
  type CompleteUploadResponse,
  type DuplicateCheckItem,
  type DuplicateCheckResult,
  type InitUploadRequest,
  type MediaFileItem,
  type ReplicaSummaryItem
} from '@smb/shared';
import type { WorkerEnv } from '../env.js';
import { loadPoolNodes, resolveAdapter, selectTargetForWrite } from '../storage/poolRouter.js';
import { sha256Hex } from '../utils/crypto.js';
import {
  addNotification,
  getSystemSettings,
  HttpError,
  jsonResponse,
  readJson,
  requireAuth
} from '../utils/http.js';

// R2 Multipart Upload minimum part size is exact 5 MiB (except final part).
// Files <= 5 MiB use direct single-part put() with SHA-256 verification.
const WORKER_CHUNK_BYTES = 5 * 1024 * 1024;

interface UploadedPartRecord {
  partNumber: number;
  etag: string;
  sizeBytes: number;
  sha256: string;
}

interface UploadSessionRow {
  id: string;
  user_id: string;
  device_id: string;
  storage_node_id: string | null;
  storage_upload_id: string;
  upload_mode: 'single' | 'multipart';
  object_key: string;
  original_filename: string;
  mime_type: string;
  media_kind: 'image' | 'video';
  expected_size_bytes: number;
  expected_sha256: string;
  chunk_size_bytes: number;
  total_parts: number;
  uploaded_parts: string;
  bytes_uploaded: number;
  captured_at: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  metadata: string;
  encrypted_file_key: string | null;
  encryption_iv: string | null;
  status: 'uploading' | 'verifying' | 'completed' | 'aborted' | 'failed';
  media_id: string | null;
  error_message: string | null;
  expires_at: string;
}

async function hydrateCompletedMedia(
  env: WorkerEnv,
  mediaId: string,
  userId: string,
  requiredReplicas: number
): Promise<MediaFileItem | null> {
  const r = await env.DB.prepare('SELECT * FROM media_files WHERE id = ? AND user_id = ?')
    .bind(mediaId, userId)
    .first<{
      id: string;
      original_filename: string;
      mime_type: string;
      media_kind: 'image' | 'video';
      size_bytes: number;
      sha256: string;
      encryption_mode: 'server_side' | 'e2ee';
      encrypted_file_key: string | null;
      encryption_iv: string | null;
      upload_state: MediaFileItem['uploadState'];
      is_favorite: number;
      folder_id: string | null;
      source_device_id: string | null;
      captured_at: string | null;
      width: number | null;
      height: number | null;
      duration_ms: number | null;
      metadata: string;
      created_at: string;
    }>();
  if (!r) return null;

  const repRes = await env.DB.prepare(
    `SELECT rs.replica_slot, rs.provider, rs.state, rs.verified_sha256, rs.last_verified_at
     FROM storage_objects so
     JOIN replica_status rs ON rs.storage_object_id = so.id
     WHERE so.media_id = ? AND so.object_kind = 'original'
     ORDER BY rs.replica_slot ASC`
  )
    .bind(mediaId)
    .all<{
      replica_slot: ReplicaSummaryItem['slot'];
      provider: string;
      state: ReplicaSummaryItem['state'];
      verified_sha256: string | null;
      last_verified_at: string | null;
    }>();

  const replicas: ReplicaSummaryItem[] = repRes.results.map((rep) => ({
    slot: rep.replica_slot,
    provider: rep.provider,
    state: rep.state,
    verifiedSha256: rep.verified_sha256,
    lastVerifiedAt: rep.last_verified_at
  }));

  const verifiedReplicaCount = new Set(replicas.filter((rep) => rep.slot !== 'copy3_offsite' && rep.state === 'verified').map((rep) => rep.slot)).size;

  return {
    id: r.id,
    originalFilename: r.original_filename,
    mimeType: r.mime_type,
    mediaKind: r.media_kind,
    sizeBytes: Number(r.size_bytes),
    sha256: r.sha256,
    encryptionMode: r.encryption_mode,
    encryptedFileKey: r.encrypted_file_key,
    encryptionIv: r.encryption_iv,
    uploadState: r.upload_state,
    isFavorite: Boolean(r.is_favorite),
    folderId: r.folder_id,
    sourceDeviceId: r.source_device_id,
    capturedAt: r.captured_at,
    width: r.width,
    height: r.height,
    durationMs: r.duration_ms,
    metadata: JSON.parse(r.metadata || '{}') as Record<string, unknown>,
    createdAt: r.created_at,
    tags: [],
    albumIds: [],
    replicas,
    verifiedReplicaCount,
    requiredReplicas
  };
}

export async function handleBackupRoutes(
  request: Request,
  url: URL,
  env: WorkerEnv
): Promise<Response | null> {
  const { pathname } = url;
  const method = request.method;

  // POST /api/v1/uploads/check-duplicates
  if (method === 'POST' && pathname === '/api/v1/uploads/check-duplicates') {
    const auth = await requireAuth(request, env);
    const body = await readJson<{ items?: DuplicateCheckItem[] }>(request);
    const items = body.items ?? [];
    const results: DuplicateCheckResult[] = [];

    for (const item of items.slice(0, 100)) {
      const dup = await env.DB.prepare(
        'SELECT id, original_filename, size_bytes, created_at FROM media_files WHERE user_id = ? AND sha256 = ? AND deleted_at IS NULL LIMIT 1'
      )
        .bind(auth.userId, item.sha256.toLowerCase())
        .first<{ id: string; original_filename: string; size_bytes: number; created_at: string }>();

      if (dup) {
        results.push({
          clientRef: item.clientRef,
          status: 'duplicate',
          duplicateOf: {
            mediaId: dup.id,
            originalFilename: dup.original_filename,
            sizeBytes: Number(dup.size_bytes),
            createdAt: dup.created_at
          }
        });
        continue;
      }

      const sess = await env.DB.prepare(
        "SELECT id, chunk_size_bytes, total_parts, uploaded_parts, bytes_uploaded FROM upload_sessions WHERE user_id = ? AND expected_sha256 = ? AND expected_size_bytes = ? AND status = 'uploading' ORDER BY created_at DESC LIMIT 1"
      )
        .bind(auth.userId, item.sha256.toLowerCase(), item.sizeBytes)
        .first<{
          id: string;
          chunk_size_bytes: number;
          total_parts: number;
          uploaded_parts: string;
          bytes_uploaded: number;
        }>();

      if (sess) {
        const parts = JSON.parse(sess.uploaded_parts || '[]') as UploadedPartRecord[];
        results.push({
          clientRef: item.clientRef,
          status: 'resumable',
          resumableSession: {
            sessionId: sess.id,
            chunkSizeBytes: Number(sess.chunk_size_bytes),
            totalParts: Number(sess.total_parts),
            uploadedPartNumbers: parts.map((p) => p.partNumber),
            bytesUploaded: Number(sess.bytes_uploaded)
          }
        });
      } else {
        results.push({ clientRef: item.clientRef, status: 'new' });
      }
    }

    return jsonResponse({ results });
  }

  // POST /api/v1/uploads/init
  if (method === 'POST' && pathname === '/api/v1/uploads/init') {
    const auth = await requireAuth(request, env);
    const body = await readJson<InitUploadRequest>(request);

    // PRD Policy: Strict Wi-Fi only
    if (body.networkType !== 'wifi') {
      throw new HttpError(
        403,
        'WIFI_ONLY_REQUIRED',
        'Chính sách bảo vệ dữ liệu di động chỉ cho phép sao lưu qua Wi-Fi.'
      );
    }

    const mediaKind = classifyMediaFormat(body.originalFilename, body.mimeType);
    if (!mediaKind) {
      throw new HttpError(
        415,
        'UNSUPPORTED_MEDIA_FORMAT',
        `Định dạng "${body.originalFilename}" không được hỗ trợ. Chỉ chấp nhận ảnh và video.`
      );
    }

    if (!body.sizeBytes || body.sizeBytes <= 0) {
      throw new HttpError(400, 'INVALID_SIZE', 'Dung lượng file không hợp lệ');
    }
    if (!body.sha256 || !/^[a-f0-9]{64}$/i.test(body.sha256)) {
      throw new HttpError(400, 'INVALID_SHA256', 'Thiếu mã băm SHA-256 hợp lệ');
    }

    const userRow = (await env.DB.prepare('SELECT quota_bytes, used_bytes FROM users WHERE id = ?')
      .bind(auth.userId)
      .first<{ quota_bytes: number; used_bytes: number }>())!;
    if (Number(userRow.used_bytes) + body.sizeBytes > Number(userRow.quota_bytes)) {
      throw new HttpError(413, 'QUOTA_EXCEEDED', 'Dung lượng kho tài khoản không đủ cho tệp này');
    }

    if (!body.allowDuplicate) {
      const dup = await env.DB.prepare(
        'SELECT id, original_filename, size_bytes, created_at FROM media_files WHERE user_id = ? AND sha256 = ? AND deleted_at IS NULL LIMIT 1'
      )
        .bind(auth.userId, body.sha256.toLowerCase())
        .first<{ id: string; original_filename: string; size_bytes: number; created_at: string }>();

      if (dup) {
        return jsonResponse({
          status: 'duplicate',
          duplicateOf: {
            mediaId: dup.id,
            originalFilename: dup.original_filename,
            sizeBytes: Number(dup.size_bytes),
            createdAt: dup.created_at
          }
        });
      }
    }

    // Resume existing uploading session if found for same user + sha256 + size
    const existing = await env.DB.prepare(
      "SELECT * FROM upload_sessions WHERE user_id = ? AND expected_sha256 = ? AND expected_size_bytes = ? AND status = 'uploading' ORDER BY created_at DESC LIMIT 1"
    )
      .bind(auth.userId, body.sha256.toLowerCase(), body.sizeBytes)
      .first<UploadSessionRow>();

    if (existing) {
      const parts = JSON.parse(existing.uploaded_parts || '[]') as UploadedPartRecord[];
      return jsonResponse({
        status: 'ready',
        resumed: true,
        sessionId: existing.id,
        chunkSizeBytes: Number(existing.chunk_size_bytes),
        totalParts: Number(existing.total_parts),
        uploadedPartNumbers: parts.map((p) => p.partNumber),
        bytesUploaded: Number(existing.bytes_uploaded)
      });
    }

    const selected = await selectTargetForWrite(env, 'copy1_primary', body.sizeBytes);
    if (!selected) {
      const nodes = await loadPoolNodes(env);
      const anyActivePrimary = nodes.some(
        (n) => n.slot === 'copy1_primary' && n.enabled && n.adapter !== null
      );
      if (anyActivePrimary) {
        throw new HttpError(
          507,
          'POOL_CAPACITY_EXHAUSTED',
          'Tất cả kho lưu trữ trong Pool Copy 1 đã đầy. Hãy thêm kho Cloud mới trong mục Quản trị hệ thống.'
        );
      }
      throw new HttpError(
        503,
        'STORAGE_NOT_CONFIGURED',
        'Kho lưu trữ chính (R2/S3/WebDAV) chưa được cấu hình hoặc đang tắt.'
      );
    }

    const sessionId = crypto.randomUUID();
    const safeExt = (body.originalFilename.split('.').pop() ?? 'bin')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 12);
    const objectKey = `tenants/${auth.userId}/originals/${sessionId}.${safeExt || 'bin'}`;
    const isMultipart = body.sizeBytes > WORKER_CHUNK_BYTES;
    const chunkSizeBytes = WORKER_CHUNK_BYTES;
    const totalParts = isMultipart ? Math.ceil(body.sizeBytes / chunkSizeBytes) : 1;

    let storageUploadId = 'single-put';
    if (isMultipart) {
      const mpu = await selected.adapter.createMultipart(
        objectKey,
        body.mimeType || 'application/octet-stream'
      );
      storageUploadId = mpu.uploadId;
    }

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();

    await env.DB.prepare(
      `INSERT INTO upload_sessions (
        id, user_id, device_id, storage_node_id, storage_upload_id, upload_mode, object_key,
        original_filename, mime_type, media_kind, expected_size_bytes, expected_sha256,
        chunk_size_bytes, total_parts, uploaded_parts, bytes_uploaded,
        captured_at, width, height, duration_ms, metadata,
        encrypted_file_key, encryption_iv, status, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`
    )
      .bind(
        sessionId,
        auth.userId,
        auth.deviceId,
        selected.nodeId,
        storageUploadId,
        isMultipart ? 'multipart' : 'single',
        objectKey,
        body.originalFilename,
        body.mimeType || 'application/octet-stream',
        mediaKind,
        body.sizeBytes,
        body.sha256.toLowerCase(),
        chunkSizeBytes,
        totalParts,
        body.capturedAt ?? null,
        body.width ?? null,
        body.height ?? null,
        body.durationMs ?? null,
        JSON.stringify(body.metadata ?? {}),
        body.encryptedFileKey ?? null,
        body.encryptionIv ?? null,
        expiresAt,
        now,
        now
      )
      .run();

    return jsonResponse(
      {
        status: 'ready',
        resumed: false,
        sessionId,
        chunkSizeBytes,
        totalParts,
        uploadedPartNumbers: [],
        bytesUploaded: 0
      },
      201
    );
  }

  // POST /api/v1/uploads/:sessionId/parts/:partNumber/presign
  const presignMatch = pathname.match(/^\/api\/v1\/uploads\/([^/]+)\/parts\/(\d+)\/presign$/);
  if (method === 'POST' && presignMatch) {
    const auth = await requireAuth(request, env);
    const sessionId = presignMatch[1]!;
    const partNumber = Number(presignMatch[2]!);
    const session = await env.DB.prepare(
      'SELECT id, status, total_parts FROM upload_sessions WHERE id = ? AND user_id = ?'
    )
      .bind(sessionId, auth.userId)
      .first<{ id: string; status: string; total_parts: number }>();
    if (!session) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên tải lên');
    }
    if (session.status !== 'uploading') {
      throw new HttpError(409, 'SESSION_NOT_UPLOADING', 'Phiên tải lên đã kết thúc');
    }
    if (partNumber < 1 || partNumber > Number(session.total_parts)) {
      throw new HttpError(400, 'INVALID_PART', 'Số thứ tự phân đoạn không hợp lệ');
    }
    return jsonResponse({ mode: 'api_chunk', uploadUrl: null, expiresInSeconds: 0 });
  }

  // POST /api/v1/uploads/:sessionId/parts/:partNumber/confirm
  const confirmMatch = pathname.match(/^\/api\/v1\/uploads\/([^/]+)\/parts\/(\d+)\/confirm$/);
  if (method === 'POST' && confirmMatch) {
    const auth = await requireAuth(request, env);
    const sessionId = confirmMatch[1]!;
    const partNumber = Number(confirmMatch[2]!);
    const body = await readJson<{ etag?: string; sizeBytes?: number; partSha256?: string }>(request);
    if (!body.etag || !body.sizeBytes || body.sizeBytes <= 0 || !body.partSha256) {
      throw new HttpError(400, 'INVALID_CONFIRM_PAYLOAD', 'Thiếu thông tin xác nhận phân đoạn');
    }
    const session = await env.DB.prepare(
      'SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?'
    )
      .bind(sessionId, auth.userId)
      .first<UploadSessionRow>();
    if (!session || session.status !== 'uploading') {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên tải lên');
    }
    if (partNumber < 1 || partNumber > session.total_parts) {
      throw new HttpError(400, 'INVALID_PART', 'Số thứ tự phân đoạn không hợp lệ');
    }
    const parts = (JSON.parse(session.uploaded_parts || '[]') as UploadedPartRecord[]).filter(
      (p) => p.partNumber !== partNumber
    );
    parts.push({
      partNumber,
      etag: body.etag.replace(/"/g, ''),
      sizeBytes: body.sizeBytes,
      sha256: body.partSha256.toLowerCase()
    });
    parts.sort((a, b) => a.partNumber - b.partNumber);
    const bytesUploaded = parts.reduce((acc, p) => acc + p.sizeBytes, 0);
    await env.DB.prepare(
      'UPDATE upload_sessions SET uploaded_parts = ?, bytes_uploaded = ?, updated_at = ? WHERE id = ?'
    )
      .bind(JSON.stringify(parts), bytesUploaded, new Date().toISOString(), session.id)
      .run();

    return jsonResponse({
      uploadedPartCount: parts.length,
      totalParts: session.total_parts,
      bytesUploaded
    });
  }

  // PUT /api/v1/uploads/:sessionId/parts/:partNumber
  const partMatch = pathname.match(/^\/api\/v1\/uploads\/([^/]+)\/parts\/(\d+)$/);
  if (method === 'PUT' && partMatch) {
    const auth = await requireAuth(request, env);
    const sessionId = partMatch[1]!;
    const partNumber = Number(partMatch[2]!);

    const session = await env.DB.prepare(
      'SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?'
    )
      .bind(sessionId, auth.userId)
      .first<UploadSessionRow>();

    if (!session || session.status !== 'uploading') {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Phiên tải lên không tồn tại hoặc đã kết thúc');
    }
    if (partNumber < 1 || partNumber > session.total_parts) {
      throw new HttpError(400, 'INVALID_PART', 'Số thứ tự phân đoạn không hợp lệ');
    }

    const adapter = await resolveAdapter(env, session.storage_node_id, 'copy1_primary');
    if (!adapter) {
      throw new HttpError(503, 'STORAGE_NOT_CONFIGURED', 'Kho lưu trữ mục tiêu không khả dụng');
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length === 0) {
      throw new HttpError(400, 'EMPTY_PART', 'Dữ liệu phân đoạn trống');
    }
    const partSha = await sha256Hex(bytes);
    const clientSha = request.headers.get('X-Part-SHA256')?.trim().toLowerCase();
    if (clientSha && clientSha !== partSha) {
      throw new HttpError(400, 'PART_CHECKSUM_MISMATCH', 'Sai mã SHA-256 của phân đoạn khi truyền');
    }

    let etag: string;
    if (session.upload_mode === 'single') {
      if (partSha !== session.expected_sha256) {
        throw new HttpError(
          400,
          'CHECKSUM_MISMATCH',
          `Sai SHA-256 toàn tệp (nhận ${partSha}, kỳ vọng ${session.expected_sha256})`
        );
      }
      const obj = await adapter.put(
        session.object_key,
        bytes,
        session.mime_type,
        session.expected_sha256
      );
      etag = obj.etag ?? partSha;
    } else {
      const uploaded = await adapter.uploadPart(
        session.object_key,
        session.storage_upload_id,
        partNumber,
        bytes
      );
      etag = uploaded.etag;
    }

    const parts = (JSON.parse(session.uploaded_parts || '[]') as UploadedPartRecord[]).filter(
      (p) => p.partNumber !== partNumber
    );
    parts.push({ partNumber, etag, sizeBytes: bytes.length, sha256: partSha });
    parts.sort((a, b) => a.partNumber - b.partNumber);
    const bytesUploaded = parts.reduce((acc, p) => acc + p.sizeBytes, 0);

    await env.DB.prepare(
      'UPDATE upload_sessions SET uploaded_parts = ?, bytes_uploaded = ?, updated_at = ? WHERE id = ?'
    )
      .bind(JSON.stringify(parts), bytesUploaded, new Date().toISOString(), session.id)
      .run();

    return jsonResponse({
      uploadedPartCount: parts.length,
      totalParts: session.total_parts,
      bytesUploaded
    });
  }

  // POST /api/v1/uploads/:sessionId/complete
  const completeMatch = pathname.match(/^\/api\/v1\/uploads\/([^/]+)\/complete$/);
  if (method === 'POST' && completeMatch) {
    const auth = await requireAuth(request, env);
    const session = await env.DB.prepare(
      'SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?'
    )
      .bind(completeMatch[1]!, auth.userId)
      .first<UploadSessionRow>();

    if (!session) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên tải lên');
    }

    if (session.status === 'completed' && session.media_id) {
      const settings = await getSystemSettings(env.DB);
      const media = await hydrateCompletedMedia(
        env,
        session.media_id,
        auth.userId,
        settings.required_replicas
      );
      if (media) {
        return jsonResponse({
          media,
          integrityVerified: true,
          replicaNotice:
            media.verifiedReplicaCount >= settings.required_replicas
              ? `Đã xác minh đủ ${settings.required_replicas} bản sao an toàn.`
              : `File gốc đã xác minh SHA-256 trên Copy 1 (${media.verifiedReplicaCount}/${settings.required_replicas} bản sao).`
        } satisfies CompleteUploadResponse);
      }
    }

    if (session.status !== 'uploading') {
      throw new HttpError(409, 'SESSION_INVALID_STATE', `Phiên đang ở trạng thái "${session.status}"`);
    }

    const parts = JSON.parse(session.uploaded_parts || '[]') as UploadedPartRecord[];
    if (parts.length < session.total_parts) {
      throw new HttpError(
        400,
        'INCOMPLETE_PARTS',
        `Chưa đủ phân đoạn (${parts.length}/${session.total_parts})`
      );
    }

    const adapter = await resolveAdapter(env, session.storage_node_id, 'copy1_primary');
    if (!adapter) {
      throw new HttpError(503, 'STORAGE_NOT_CONFIGURED', 'Kho lưu trữ mục tiêu không khả dụng');
    }

    if (session.upload_mode === 'multipart') {
      await adapter.completeMultipart(
        session.object_key,
        session.storage_upload_id,
        parts
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
      );
    }

    const digest = await adapter.computeSha256(session.object_key);
    const expectedSize = Number(session.expected_size_bytes);
    if (digest.sizeBytes !== expectedSize || digest.sha256 !== session.expected_sha256) {
      await adapter.delete(session.object_key).catch(() => {});
      const reason = `Kiểm tra toàn vẹn thất bại: kỳ vọng size=${expectedSize} sha256=${session.expected_sha256}, thực tế size=${digest.sizeBytes} sha256=${digest.sha256}`;
      await env.DB.prepare(
        "UPDATE upload_sessions SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?"
      )
        .bind(reason, new Date().toISOString(), session.id)
        .run();
      throw new HttpError(422, 'CHECKSUM_MISMATCH', reason);
    }

    const userRow = (await env.DB.prepare('SELECT quota_bytes, used_bytes FROM users WHERE id = ?')
      .bind(auth.userId)
      .first<{ quota_bytes: number; used_bytes: number }>())!;
    if (Number(userRow.used_bytes) + expectedSize > Number(userRow.quota_bytes)) {
      await adapter.delete(session.object_key).catch(() => {});
      throw new HttpError(413, 'QUOTA_EXCEEDED', 'Dung lượng kho tài khoản không đủ cho tệp này');
    }

    const now = new Date().toISOString();
    const mediaId = crypto.randomUUID();
    const storageObjectId = crypto.randomUUID();
    const settings = await getSystemSettings(env.DB);
    const requiredReplicas = settings.required_replicas;
    const uploadState = requiredReplicas <= 1 ? 'verified' : 'insufficient_replicas';

    const statements = [
      env.DB.prepare(
        `INSERT INTO media_files (
          id, user_id, source_device_id, original_filename, mime_type, media_kind,
          size_bytes, sha256, encryption_mode, encrypted_file_key, encryption_iv,
          upload_state, is_favorite, captured_at, width, height, duration_ms,
          metadata, object_key, storage_node_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        mediaId,
        auth.userId,
        session.device_id,
        session.original_filename,
        session.mime_type,
        session.media_kind,
        expectedSize,
        digest.sha256,
        auth.encryptionMode,
        session.encrypted_file_key,
        session.encryption_iv,
        uploadState,
        session.captured_at,
        session.width,
        session.height,
        session.duration_ms,
        session.metadata,
        session.object_key,
        session.storage_node_id,
        now,
        now
      ),
      env.DB.prepare(
        `INSERT INTO storage_objects (
          id, user_id, media_id, object_kind, object_key, size_bytes, sha256, primary_node_id, created_at
        ) VALUES (?, ?, ?, 'original', ?, ?, ?, ?, ?)`
      ).bind(
        storageObjectId,
        auth.userId,
        mediaId,
        session.object_key,
        expectedSize,
        digest.sha256,
        session.storage_node_id,
        now
      ),
      env.DB.prepare(
        `INSERT INTO replica_status (
          id, storage_object_id, replica_slot, storage_node_id, provider, bucket, state, verified_sha256, last_verified_at, updated_at
        ) VALUES (?, ?, 'copy1_primary', ?, ?, ?, 'verified', ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        storageObjectId,
        session.storage_node_id,
        adapter.provider,
        adapter.bucket,
        digest.sha256,
        now,
        now
      ),
      env.DB.prepare(
        `INSERT INTO file_versions (id, user_id, media_id, version_number, object_key, sha256, size_bytes, storage_node_id, created_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        auth.userId,
        mediaId,
        session.object_key,
        digest.sha256,
        expectedSize,
        session.storage_node_id,
        now
      ),
      env.DB.prepare('UPDATE users SET used_bytes = used_bytes + ?, updated_at = ? WHERE id = ?').bind(
        expectedSize,
        now,
        auth.userId
      ),
      env.DB.prepare(
        "UPDATE upload_sessions SET status = 'completed', media_id = ?, updated_at = ? WHERE id = ?"
      ).bind(mediaId, now, session.id)
    ];

    if (session.storage_node_id) {
      statements.push(
        env.DB.prepare(
          'UPDATE storage_nodes SET used_bytes = used_bytes + ?, updated_at = ? WHERE id = ?'
        ).bind(expectedSize, now, session.storage_node_id)
      );
    }

    const sec = await resolveAdapter(env, null, 'copy2_secondary');
    statements.push(
      env.DB.prepare(
        `INSERT INTO replica_status (
          id, storage_object_id, replica_slot, storage_node_id, provider, bucket, state, updated_at
        ) VALUES (?, ?, 'copy2_secondary', NULL, ?, ?, 'pending', ?)`
      ).bind(
        crypto.randomUUID(),
        storageObjectId,
        sec?.provider ?? 'unconfigured',
        sec?.bucket ?? 'pending',
        now
      )
    );

    await env.DB.batch(statements);

    await addNotification(
      env.DB,
      auth.userId,
      'backup_success',
      `Đã sao lưu ${session.original_filename}`,
      uploadState === 'verified'
        ? `"${session.original_filename}" đã được lưu nguyên bản và xác minh SHA-256 trên ${adapter.provider}.`
        : `"${session.original_filename}" đã xác minh SHA-256 trên Copy 1 (1/${requiredReplicas} bản sao — đang chờ nhân bản).`
    );

    const media = (await hydrateCompletedMedia(env, mediaId, auth.userId, requiredReplicas))!;
    return jsonResponse({
      media,
      integrityVerified: true,
      replicaNotice:
        uploadState === 'verified'
          ? `Đã lưu nguyên bản 100% và xác minh SHA-256 (${requiredReplicas} bản sao).`
          : `File gốc đã xác minh SHA-256 trên Copy 1 (1/${requiredReplicas} bản sao). Chưa đánh dấu đủ ${requiredReplicas} bản sao.`
    } satisfies CompleteUploadResponse);
  }

  // GET /api/v1/uploads/:sessionId
  const getMatch = pathname.match(/^\/api\/v1\/uploads\/([^/]+)$/);
  if (method === 'GET' && getMatch) {
    const auth = await requireAuth(request, env);
    const s = await env.DB.prepare('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?')
      .bind(getMatch[1]!, auth.userId)
      .first<UploadSessionRow>();
    if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên tải lên');
    const parts = JSON.parse(s.uploaded_parts || '[]') as UploadedPartRecord[];
    return jsonResponse({
      sessionId: s.id,
      status: s.status,
      originalFilename: s.original_filename,
      expectedSizeBytes: Number(s.expected_size_bytes),
      expectedSha256: s.expected_sha256,
      chunkSizeBytes: Number(s.chunk_size_bytes),
      totalParts: Number(s.total_parts),
      uploadedPartNumbers: parts.map((p) => p.partNumber),
      bytesUploaded: Number(s.bytes_uploaded),
      mediaId: s.media_id,
      errorMessage: s.error_message
    });
  }

  // DELETE /api/v1/uploads/:sessionId
  if (method === 'DELETE' && getMatch) {
    const auth = await requireAuth(request, env);
    const s = await env.DB.prepare('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?')
      .bind(getMatch[1]!, auth.userId)
      .first<UploadSessionRow>();
    if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên tải lên');
    if (s.status === 'completed') {
      throw new HttpError(409, 'ALREADY_COMPLETED', 'Không thể hủy phiên tải lên đã hoàn tất');
    }
    if (s.status === 'uploading') {
      const adapter = await resolveAdapter(env, s.storage_node_id, 'copy1_primary');
      if (adapter) {
        if (s.upload_mode === 'multipart') {
          await adapter.abortMultipart(s.object_key, s.storage_upload_id).catch(() => {});
        } else {
          await adapter.delete(s.object_key).catch(() => {});
        }
      }
    }
    await env.DB.prepare("UPDATE upload_sessions SET status = 'aborted', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), s.id)
      .run();
    return jsonResponse({ aborted: true, sessionId: s.id });
  }

  return null;
}
