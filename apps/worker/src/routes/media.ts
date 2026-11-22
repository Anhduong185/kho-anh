import type {
  EncryptionMode,
  MediaFileItem,
  MediaKind,
  MediaUploadState,
  ReplicaHealthState,
  ReplicaSlot,
  ReplicaSummaryItem,
  TagItem
} from '@smb/shared';
import type { WorkerEnv } from '../env.js';
import { resolveAdapter } from '../storage/poolRouter.js';
import {
  getSystemSettings,
  HttpError,
  jsonResponse,
  readJson,
  requireAuth
} from '../utils/http.js';

interface MediaRow {
  id: string;
  user_id: string;
  source_device_id: string | null;
  folder_id: string | null;
  original_filename: string;
  mime_type: string;
  media_kind: MediaKind;
  size_bytes: number;
  sha256: string;
  encryption_mode: EncryptionMode;
  encrypted_file_key: string | null;
  encryption_iv: string | null;
  upload_state: MediaUploadState;
  is_favorite: number;
  captured_at: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  metadata: string;
  object_key: string;
  storage_node_id: string | null;
  created_at: string;
}

function buildContentDisposition(
  filename: string,
  disposition: 'attachment' | 'inline' = 'attachment'
): string {
  const safeAscii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encodedUtf8 = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `${disposition}; filename="${safeAscii}"; filename*=UTF-8''${encodedUtf8}`;
}

function parseHttpRange(
  rangeHeader: string | null,
  totalSize: number
): { kind: 'none' } | { kind: 'invalid' } | { kind: 'range'; start: number; end: number } {
  if (!rangeHeader) return { kind: 'none' };
  if (!rangeHeader.startsWith('bytes=') || totalSize <= 0) return { kind: 'invalid' };
  const spec = rangeHeader.slice(6).split(',')[0]?.trim() ?? '';
  const parts = spec.split('-');
  if (parts.length !== 2) return { kind: 'invalid' };
  const [startStr, endStr] = parts;
  if ((!startStr && !endStr) || !/^\d*$/.test(startStr) || !/^\d*$/.test(endStr)) {
    return { kind: 'invalid' };
  }
  if (!startStr && endStr) {
    const suffix = Number(endStr);
    if (!Number.isInteger(suffix) || suffix <= 0) return { kind: 'invalid' };
    return {
      kind: 'range',
      start: Math.max(0, totalSize - suffix),
      end: totalSize - 1
    };
  }
  const start = Number(startStr);
  const end = endStr ? Number(endStr) : totalSize - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start > end ||
    start >= totalSize
  ) {
    return { kind: 'invalid' };
  }
  return { kind: 'range', start, end: Math.min(end, totalSize - 1) };
}

async function resolveMediaObjectLocation(
  env: WorkerEnv,
  mediaId: string,
  userId: string
): Promise<{
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  objectKey: string;
  nodeId: string | null;
  storageObjectId: string | null;
} | null> {
  const row = await env.DB.prepare(
    `SELECT
       m.id, m.original_filename, m.mime_type, m.size_bytes, m.sha256,
       COALESCE(so.object_key, m.object_key) AS object_key,
       COALESCE(so.primary_node_id, m.storage_node_id) AS node_id,
       so.id AS storage_object_id
     FROM media_files m
     LEFT JOIN storage_objects so ON so.media_id = m.id AND so.object_kind = 'original'
     WHERE m.id = ? AND m.user_id = ? AND m.deleted_at IS NULL
     LIMIT 1`
  )
    .bind(mediaId, userId)
    .first<{
      id: string;
      original_filename: string;
      mime_type: string;
      size_bytes: number;
      sha256: string;
      object_key: string;
      node_id: string | null;
      storage_object_id: string | null;
    }>();

  if (!row) return null;
  return {
    id: row.id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    objectKey: row.object_key,
    nodeId: row.node_id,
    storageObjectId: row.storage_object_id
  };
}

export async function handleMediaRoutes(
  request: Request,
  url: URL,
  env: WorkerEnv
): Promise<Response | null> {
  const { pathname } = url;
  const method = request.method;

  // GET /api/v1/media (filters + sort, strictly NO search per PRD 1.2)
  if (method === 'GET' && pathname === '/api/v1/media') {
    const auth = await requireAuth(request, env);
    const kind = url.searchParams.get('kind') ?? 'all';
    const state = url.searchParams.get('state') ?? 'all';
    const favoriteOnly = url.searchParams.get('favoriteOnly') === 'true';
    const albumId = url.searchParams.get('albumId');
    const folderId = url.searchParams.get('folderId');
    const tagId = url.searchParams.get('tagId');
    const deviceId = url.searchParams.get('deviceId');
    const sortBy = url.searchParams.get('sortBy') ?? 'captured_at';
    const sortDir = url.searchParams.get('sortDir') === 'asc' ? 'ASC' : 'DESC';
    const rawLimit = Number(url.searchParams.get('limit') ?? 150);
    const limit = Number.isFinite(rawLimit) ? Math.min(300, Math.max(1, Math.floor(rawLimit))) : 150;
    const rawOffset = Number(url.searchParams.get('offset') ?? 0);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;

    const where: string[] = ['m.user_id = ?', 'm.deleted_at IS NULL'];
    const params: unknown[] = [auth.userId];

    if (kind === 'image' || kind === 'video') {
      where.push('m.media_kind = ?');
      params.push(kind);
    }
    if (state !== 'all') {
      where.push('m.upload_state = ?');
      params.push(state);
    }
    if (favoriteOnly) {
      where.push('m.is_favorite = 1');
    }
    if (folderId) {
      where.push('m.folder_id = ?');
      params.push(folderId);
    }
    if (deviceId) {
      where.push('m.source_device_id = ?');
      params.push(deviceId);
    }
    if (albumId) {
      where.push('EXISTS (SELECT 1 FROM album_media am WHERE am.media_id = m.id AND am.album_id = ?)');
      params.push(albumId);
    }
    if (tagId) {
      where.push('EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = m.id AND mt.tag_id = ?)');
      params.push(tagId);
    }

    const orderSql =
      sortBy === 'size_bytes'
        ? `m.size_bytes ${sortDir}, m.created_at DESC`
        : sortBy === 'original_filename'
          ? `LOWER(m.original_filename) ${sortDir}`
          : sortBy === 'created_at'
            ? `m.created_at ${sortDir}`
            : `COALESCE(m.captured_at, m.created_at) ${sortDir}, m.created_at DESC`;

    const [countRes, rowsRes, settings] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS total FROM media_files m WHERE ${where.join(' AND ')}`)
        .bind(...params)
        .first<{ total: number }>(),
      env.DB.prepare(
        `SELECT m.* FROM media_files m WHERE ${where.join(' AND ')} ORDER BY ${orderSql} LIMIT ? OFFSET ?`
      )
        .bind(...params, limit, offset)
        .all<MediaRow>(),
      getSystemSettings(env.DB)
    ]);

    const [albumsRes, tagsRes, replicasRes] = await Promise.all([
      env.DB.prepare(
        `SELECT am.media_id, am.album_id FROM album_media am
         JOIN albums a ON a.id = am.album_id WHERE a.user_id = ?`
      )
        .bind(auth.userId)
        .all<{ media_id: string; album_id: string }>(),
      env.DB.prepare(
        `SELECT mt.media_id, t.id, t.name, t.created_at FROM media_tags mt
         JOIN tags t ON t.id = mt.tag_id WHERE t.user_id = ?`
      )
        .bind(auth.userId)
        .all<{ media_id: string; id: string; name: string; created_at: string }>(),
      env.DB.prepare(
        `SELECT so.media_id, rs.replica_slot, rs.provider, rs.state, rs.verified_sha256, rs.last_verified_at
         FROM storage_objects so
         JOIN replica_status rs ON rs.storage_object_id = so.id
         WHERE so.user_id = ? AND so.object_kind = 'original'
         ORDER BY rs.replica_slot ASC`
      )
        .bind(auth.userId)
        .all<{
          media_id: string;
          replica_slot: ReplicaSlot;
          provider: string;
          state: ReplicaHealthState;
          verified_sha256: string | null;
          last_verified_at: string | null;
        }>()
    ]);

    const albumMap = new Map<string, string[]>();
    for (const r of albumsRes.results) {
      const list = albumMap.get(r.media_id) ?? [];
      list.push(r.album_id);
      albumMap.set(r.media_id, list);
    }

    const tagMap = new Map<string, TagItem[]>();
    for (const r of tagsRes.results) {
      const list = tagMap.get(r.media_id) ?? [];
      list.push({ id: r.id, name: r.name, createdAt: r.created_at });
      tagMap.set(r.media_id, list);
    }

    const replicaMap = new Map<string, ReplicaSummaryItem[]>();
    for (const r of replicasRes.results) {
      const list = replicaMap.get(r.media_id) ?? [];
      list.push({
        slot: r.replica_slot,
        provider: r.provider,
        state: r.state,
        verifiedSha256: r.verified_sha256,
        lastVerifiedAt: r.last_verified_at
      });
      replicaMap.set(r.media_id, list);
    }

    const items: MediaFileItem[] = rowsRes.results.map((r) => {
      const replicas = replicaMap.get(r.id) ?? [
        {
          slot: 'copy1_primary',
          provider: 'cloudflare_r2',
          state: 'verified',
          verifiedSha256: r.sha256,
          lastVerifiedAt: r.created_at
        }
      ];
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
        tags: tagMap.get(r.id) ?? [],
        albumIds: albumMap.get(r.id) ?? [],
        replicas,
        verifiedReplicaCount,
        requiredReplicas: settings.required_replicas
      };
    });

    return jsonResponse({ items, total: Number(countRes?.total ?? items.length), limit, offset });
  }

  // PATCH /api/v1/media/:id
  const mediaPatchMatch = pathname.match(/^\/api\/v1\/media\/([^/]+)$/);
  if (method === 'PATCH' && mediaPatchMatch) {
    const auth = await requireAuth(request, env);
    const body = await readJson<{ isFavorite?: boolean; folderId?: string | null }>(request);
    const mediaId = mediaPatchMatch[1]!;

    const existing = await env.DB.prepare(
      'SELECT id FROM media_files WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    )
      .bind(mediaId, auth.userId)
      .first<{ id: string }>();
    if (!existing) throw new HttpError(404, 'MEDIA_NOT_FOUND', 'Không tìm thấy ảnh/video');

    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [new Date().toISOString()];
    if (typeof body.isFavorite === 'boolean') {
      sets.push('is_favorite = ?');
      params.push(body.isFavorite ? 1 : 0);
    }
    if (body.folderId !== undefined) {
      if (body.folderId !== null) {
        const f = await env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
          .bind(body.folderId, auth.userId)
          .first<{ id: string }>();
        if (!f) throw new HttpError(404, 'FOLDER_NOT_FOUND', 'Thư mục không tồn tại');
      }
      sets.push('folder_id = ?');
      params.push(body.folderId);
    }
    params.push(mediaId, auth.userId);
    await env.DB.prepare(`UPDATE media_files SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .bind(...params)
      .run();

    return jsonResponse({ updated: true });
  }

  // GET /api/v1/media/:id/stream (Pool streaming with HTTP 206 Range + 416 handling)
  const streamMatch = pathname.match(/^\/api\/v1\/media\/([^/]+)\/stream$/);
  if (method === 'GET' && streamMatch) {
    const auth = await requireAuth(request, env);
    const row = await resolveMediaObjectLocation(env, streamMatch[1]!, auth.userId);
    if (!row) throw new HttpError(404, 'MEDIA_NOT_FOUND', 'Không tìm thấy tệp');

    const adapter = await resolveAdapter(env, row.nodeId, 'copy1_primary');
    if (!adapter) {
      throw new HttpError(503, 'STORAGE_NOT_CONFIGURED', 'Kho lưu trữ không khả dụng');
    }

    const totalSize = row.sizeBytes;
    const rangeParsed = parseHttpRange(request.headers.get('Range'), totalSize);

    if (rangeParsed.kind === 'invalid') {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${totalSize}`,
          'Accept-Ranges': 'bytes'
        }
      });
    }

    if (rangeParsed.kind === 'range') {
      const length = rangeParsed.end - rangeParsed.start + 1;
      const obj = await adapter.getRange(row.objectKey, rangeParsed.start, rangeParsed.end);
      if (!obj) throw new HttpError(404, 'OBJECT_MISSING', 'Không tìm thấy đối tượng trong kho lưu trữ');

      return new Response(obj.body, {
        status: 206,
        headers: {
          'Content-Type': row.mimeType || 'application/octet-stream',
          'Content-Disposition': buildContentDisposition(row.originalFilename, 'inline'),
          'Content-Range': `bytes ${rangeParsed.start}-${rangeParsed.end}/${totalSize}`,
          'Content-Length': String(obj.size ?? length),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=300',
          'X-Content-SHA256': row.sha256
        }
      });
    }

    const obj = await adapter.get(row.objectKey);
    if (!obj) throw new HttpError(404, 'OBJECT_MISSING', 'Không tìm thấy đối tượng trong kho lưu trữ');

    return new Response(obj.body, {
      status: 200,
      headers: {
        'Content-Type': row.mimeType || 'application/octet-stream',
        'Content-Disposition': buildContentDisposition(row.originalFilename, 'inline'),
        'Content-Length': String(obj.size ?? totalSize),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=300',
        'X-Content-SHA256': row.sha256
      }
    });
  }

  // GET /api/v1/media/:id/download (100% original bytes + RFC 5987 + X-Content-SHA256)
  const dlMatch = pathname.match(/^\/api\/v1\/media\/([^/]+)\/download$/);
  if (method === 'GET' && dlMatch) {
    const auth = await requireAuth(request, env);
    const row = await resolveMediaObjectLocation(env, dlMatch[1]!, auth.userId);
    if (!row) throw new HttpError(404, 'MEDIA_NOT_FOUND', 'Không tìm thấy tệp');

    const adapter = await resolveAdapter(env, row.nodeId, 'copy1_primary');
    if (!adapter) {
      throw new HttpError(503, 'STORAGE_NOT_CONFIGURED', 'Kho lưu trữ không khả dụng');
    }

    const obj = await adapter.get(row.objectKey);
    if (!obj) throw new HttpError(404, 'OBJECT_MISSING', 'Không tìm thấy tệp trong kho lưu trữ');

    return new Response(obj.body, {
      status: 200,
      headers: {
        'Content-Type': row.mimeType || 'application/octet-stream',
        'Content-Disposition': buildContentDisposition(row.originalFilename, 'attachment'),
        'Content-Length': String(obj.size ?? row.sizeBytes),
        'X-Original-Size': String(row.sizeBytes),
        'Cache-Control': 'private, no-store',
        'X-Content-SHA256': row.sha256
      }
    });
  }

  // GET /api/v1/media/:id/download-url
  const dlUrlMatch = pathname.match(/^\/api\/v1\/media\/([^/]+)\/download-url$/);
  if (method === 'GET' && dlUrlMatch) {
    const auth = await requireAuth(request, env);
    const row = await env.DB.prepare(
      'SELECT id, original_filename, sha256, size_bytes FROM media_files WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    )
      .bind(dlUrlMatch[1]!, auth.userId)
      .first<{ id: string; original_filename: string; sha256: string; size_bytes: number }>();
    if (!row) throw new HttpError(404, 'MEDIA_NOT_FOUND', 'Không tìm thấy tệp');

    return jsonResponse({
      mode: 'api_proxy',
      url: `/api/v1/media/${row.id}/download`,
      expiresInSeconds: 300,
      originalFilename: row.original_filename,
      expectedSha256: row.sha256,
      sizeBytes: Number(row.size_bytes)
    });
  }

  // GET /api/v1/media/:id/verify
  const verifyMatch = pathname.match(/^\/api\/v1\/media\/([^/]+)\/verify$/);
  if (method === 'GET' && verifyMatch) {
    const auth = await requireAuth(request, env);
    const row = await resolveMediaObjectLocation(env, verifyMatch[1]!, auth.userId);
    if (!row) throw new HttpError(404, 'MEDIA_NOT_FOUND', 'Không tìm thấy tệp');

    const adapter = await resolveAdapter(env, row.nodeId, 'copy1_primary');
    if (!adapter) {
      throw new HttpError(503, 'STORAGE_NOT_CONFIGURED', 'Kho lưu trữ không khả dụng');
    }

    let actualSha = '';
    let actualSize = 0;
    try {
      const digest = await adapter.computeSha256(row.objectKey);
      actualSha = digest.sha256;
      actualSize = digest.sizeBytes;
    } catch {
      throw new HttpError(404, 'OBJECT_MISSING', 'Không tìm thấy tệp trong kho lưu trữ');
    }

    const verified = actualSha === row.sha256 && actualSize === row.sizeBytes;
    const checkedAt = new Date().toISOString();

    if (row.storageObjectId) {
      await env.DB.prepare(
        `UPDATE replica_status
         SET state = ?, verified_sha256 = ?, last_verified_at = ?, error_message = ?, updated_at = ?
         WHERE storage_object_id = ? AND replica_slot = 'copy1_primary'`
      )
        .bind(
          verified ? 'verified' : 'corrupted',
          actualSha,
          checkedAt,
          verified ? null : `Expected ${row.sha256}, actual ${actualSha}`,
          checkedAt,
          row.storageObjectId
        )
        .run();
    }

    return jsonResponse({
      mediaId: row.id,
      verified,
      expectedSha256: row.sha256,
      actualSha256: actualSha,
      sizeBytes: actualSize,
      checkedAt
    });
  }

  return null;
}
