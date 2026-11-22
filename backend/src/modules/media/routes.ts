import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  DownloadUrlResponse,
  EncryptionMode,
  MediaFileItem,
  MediaKind,
  MediaUploadState,
  ReplicaHealthState,
  ReplicaSlot,
  ReplicaSummaryItem,
  TagItem,
  VerifyMediaIntegrityResponse
} from '@smb/shared';
import type { AppConfig } from '../../config/env.js';
import type { DbClient, DbQueryable } from '../../db/client.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import type { StorageRegistry } from '../../storage/registry.js';
import { Errors } from '../../utils/errors.js';
import { getSystemSettings } from '../settings/service.js';

const ListMediaQuerySchema = z.object({
  kind: z.enum(['all', 'image', 'video']).optional().default('all'),
  state: z
    .enum([
      'all',
      'detected',
      'queued',
      'uploading',
      'uploaded',
      'verifying',
      'verified',
      'insufficient_replicas',
      'failed'
    ])
    .optional()
    .default('all'),
  favoriteOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  albumId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional(),
  tagId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  sortBy: z.enum(['created_at', 'captured_at', 'size_bytes', 'original_filename']).optional().default('captured_at'),
  sortDir: z.enum(['asc', 'desc']).optional().default('desc'),
  limit: z.coerce.number().int().min(1).max(300).optional().default(150),
  offset: z.coerce.number().int().min(0).optional().default(0)
});

const MediaIdParamSchema = z.object({
  mediaId: z.string().uuid()
});

const PatchMediaSchema = z.object({
  isFavorite: z.boolean().optional(),
  folderId: z.string().uuid().nullable().optional()
});

export interface MediaRow {
  id: string;
  original_filename: string;
  mime_type: string;
  media_kind: MediaKind;
  size_bytes: string | number;
  sha256: string;
  encryption_mode: EncryptionMode;
  encrypted_file_key: string | null;
  encryption_iv: string | null;
  upload_state: MediaUploadState;
  is_favorite: boolean;
  folder_id: string | null;
  source_device_id: string | null;
  captured_at: string | Date | null;
  width: number | null;
  height: number | null;
  duration_ms: string | number | null;
  metadata: Record<string, unknown> | null;
  created_at: string | Date;
}

interface ReplicaRow {
  media_id: string;
  replica_slot: ReplicaSlot;
  provider: string;
  state: ReplicaHealthState;
  verified_sha256: string | null;
  last_verified_at: string | Date | null;
}

function toIso(v: string | Date | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export async function hydrateMediaItems(
  db: DbQueryable,
  rows: MediaRow[],
  requiredReplicas: number
): Promise<MediaFileItem[]> {
  if (rows.length === 0) return [];

  const mediaIds = rows.map((r) => r.id);
  const [replicaRes, tagsRes, albumsRes] = await Promise.all([
    db.query<ReplicaRow>(
      `
      SELECT
        so.media_id,
        rs.replica_slot,
        rs.provider,
        rs.state,
        rs.verified_sha256,
        rs.last_verified_at
      FROM storage_objects so
      JOIN replica_status rs ON rs.storage_object_id = so.id
      WHERE so.media_id = ANY($1::uuid[]) AND so.object_kind = 'original'
      ORDER BY rs.replica_slot ASC
      `,
      [mediaIds]
    ),
    db.query<{ media_id: string; id: string; name: string; created_at: string | Date }>(
      `
      SELECT mt.media_id, t.id, t.name, t.created_at
      FROM media_tags mt
      JOIN tags t ON t.id = mt.tag_id
      WHERE mt.media_id = ANY($1::uuid[])
      ORDER BY LOWER(t.name) ASC
      `,
      [mediaIds]
    ),
    db.query<{ media_id: string; album_id: string }>(
      `
      SELECT media_id, album_id
      FROM album_media
      WHERE media_id = ANY($1::uuid[])
      `,
      [mediaIds]
    )
  ]);

  const replicaMap = new Map<string, ReplicaSummaryItem[]>();
  for (const r of replicaRes.rows) {
    const list = replicaMap.get(r.media_id) ?? [];
    list.push({
      slot: r.replica_slot,
      provider: r.provider,
      state: r.state,
      verifiedSha256: r.verified_sha256,
      lastVerifiedAt: toIso(r.last_verified_at)
    });
    replicaMap.set(r.media_id, list);
  }

  const tagMap = new Map<string, TagItem[]>();
  for (const t of tagsRes.rows) {
    const list = tagMap.get(t.media_id) ?? [];
    list.push({ id: t.id, name: t.name, createdAt: toIso(t.created_at) ?? new Date().toISOString() });
    tagMap.set(t.media_id, list);
  }

  const albumMap = new Map<string, string[]>();
  for (const a of albumsRes.rows) {
    const list = albumMap.get(a.media_id) ?? [];
    list.push(a.album_id);
    albumMap.set(a.media_id, list);
  }

  return rows.map((row) => {
    const replicas = replicaMap.get(row.id) ?? [];
    const verifiedReplicaCount = new Set(replicas.filter((r) => r.slot !== 'copy3_offsite' && r.state === 'verified').map((r) => r.slot)).size;
    return {
      id: row.id,
      originalFilename: row.original_filename,
      mimeType: row.mime_type,
      mediaKind: row.media_kind,
      sizeBytes: Number(row.size_bytes),
      sha256: row.sha256,
      encryptionMode: row.encryption_mode,
      encryptedFileKey: row.encrypted_file_key,
      encryptionIv: row.encryption_iv,
      uploadState: row.upload_state,
      isFavorite: row.is_favorite,
      folderId: row.folder_id,
      sourceDeviceId: row.source_device_id,
      capturedAt: toIso(row.captured_at),
      width: row.width,
      height: row.height,
      durationMs: row.duration_ms !== null ? Number(row.duration_ms) : null,
      metadata: row.metadata ?? {},
      createdAt: toIso(row.created_at) ?? new Date().toISOString(),
      tags: tagMap.get(row.id) ?? [],
      albumIds: albumMap.get(row.id) ?? [],
      replicas,
      verifiedReplicaCount,
      requiredReplicas
    };
  });
}

function buildContentDisposition(filename: string, disposition: 'attachment' | 'inline' = 'attachment'): string {
  const safeAscii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encodedUtf8 = encodeURIComponent(filename);
  return `${disposition}; filename="${safeAscii}"; filename*=UTF-8''${encodedUtf8}`;
}

export function registerMediaRoutes(
  app: FastifyInstance,
  db: DbClient,
  config: AppConfig,
  storageRegistry: StorageRegistry
) {
  const authenticate = createAuthMiddleware(db, config);

  // Tenant-scoped media listing with rich filters & sort (strictly NO search per PRD 1.2)
  app.get('/api/v1/media', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const parsed = ListMediaQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw Errors.badRequest('Invalid media query parameters', parsed.error.flatten());
    }

    const { kind, state, favoriteOnly, albumId, folderId, tagId, deviceId, sortBy, sortDir, limit, offset } =
      parsed.data;

    const conditions: string[] = ['m.user_id = $1', 'm.deleted_at IS NULL'];
    const params: unknown[] = [auth.userId];

    if (kind !== 'all') {
      params.push(kind);
      conditions.push(`m.media_kind = $${params.length}`);
    }
    if (state !== 'all') {
      params.push(state);
      conditions.push(`m.upload_state = $${params.length}`);
    }
    if (favoriteOnly) {
      conditions.push('m.is_favorite = TRUE');
    }
    if (folderId) {
      params.push(folderId);
      conditions.push(`m.folder_id = $${params.length}`);
    }
    if (deviceId) {
      params.push(deviceId);
      conditions.push(`m.source_device_id = $${params.length}`);
    }
    if (albumId) {
      params.push(albumId);
      conditions.push(
        `EXISTS (SELECT 1 FROM album_media am WHERE am.media_id = m.id AND am.album_id = $${params.length})`
      );
    }
    if (tagId) {
      params.push(tagId);
      conditions.push(
        `EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = m.id AND mt.tag_id = $${params.length})`
      );
    }

    const orderColumnMap: Record<typeof sortBy, string> = {
      created_at: 'm.created_at',
      captured_at: 'COALESCE(m.captured_at, m.created_at)',
      size_bytes: 'm.size_bytes',
      original_filename: 'LOWER(m.original_filename)'
    };
    const orderSql = `${orderColumnMap[sortBy]} ${sortDir === 'asc' ? 'ASC' : 'DESC'}, m.id DESC`;

    const countRes = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM media_files m WHERE ${conditions.join(' AND ')}`,
      params
    );

    const dataParams = [...params, limit, offset];
    const rowsRes = await db.query<MediaRow>(
      `
      SELECT
        m.id, m.original_filename, m.mime_type, m.media_kind, m.size_bytes, m.sha256,
        m.encryption_mode, m.encrypted_file_key, m.encryption_iv, m.upload_state,
        m.is_favorite, m.folder_id, m.source_device_id,
        m.captured_at, m.width, m.height, m.duration_ms, m.metadata, m.created_at
      FROM media_files m
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderSql}
      LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}
      `,
      dataParams
    );

    const settings = await getSystemSettings(db);
    const items = await hydrateMediaItems(db, rowsRes.rows, settings.required_replicas);

    return {
      items,
      total: Number(countRes.rows[0]?.count ?? '0'),
      limit,
      offset
    };
  });

  // Update metadata organization fields (favorite toggle, move folder) — never alters original bytes
  app.patch('/api/v1/media/:mediaId', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = MediaIdParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid mediaId');
    const body = PatchMediaSchema.safeParse(request.body);
    if (!body.success) throw Errors.badRequest('Invalid media update payload', body.error.flatten());

    const existing = await db.query<{ id: string; is_favorite: boolean; folder_id: string | null }>(
      'SELECT id, is_favorite, folder_id FROM media_files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [params.data.mediaId, auth.userId]
    );
    if (existing.rowCount === 0) throw Errors.notFound('Media file not found');

    const cur = existing.rows[0]!;
    const nextFavorite = body.data.isFavorite ?? cur.is_favorite;
    const nextFolderId = body.data.folderId !== undefined ? body.data.folderId : cur.folder_id;

    if (nextFolderId) {
      const f = await db.query('SELECT id FROM folders WHERE id = $1 AND user_id = $2', [
        nextFolderId,
        auth.userId
      ]);
      if (f.rowCount === 0) throw Errors.notFound('Target folder not found');
    }

    await db.query(
      'UPDATE media_files SET is_favorite = $3, folder_id = $4, updated_at = NOW() WHERE id = $1 AND user_id = $2',
      [params.data.mediaId, auth.userId, nextFavorite, nextFolderId]
    );

    return { updated: true, id: params.data.mediaId, isFavorite: nextFavorite, folderId: nextFolderId };
  });

  // HTTP 206 Partial Content byte-range streaming for smooth video playback & inline image preview
  app.get('/api/v1/media/:mediaId/stream', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const params = MediaIdParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid mediaId');

    const res = await db.query<{
      id: string;
      original_filename: string;
      mime_type: string;
      size_bytes: string | number;
      sha256: string;
      object_key: string;
      primary_node_id: string | null;
    }>(
      `
      SELECT m.id, m.original_filename, m.mime_type, m.size_bytes, m.sha256, so.object_key, so.primary_node_id
      FROM media_files m
      JOIN storage_objects so ON so.media_id = m.id AND so.object_kind = 'original'
      WHERE m.id = $1 AND m.user_id = $2 AND m.deleted_at IS NULL
      LIMIT 1
      `,
      [params.data.mediaId, auth.userId]
    );

    const row = res.rows[0];
    if (!row) throw Errors.notFound('Media file not found');

    const adapter =
      storageRegistry.resolveAdapter(row.primary_node_id, 'copy1_primary') ??
      storageRegistry.getPrimary();
    const buffer = await adapter.getObject(row.object_key);
    const totalLength = buffer.length;
    const rangeHeader = request.headers.range;

    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', row.mime_type || 'application/octet-stream');
    reply.header('Content-Disposition', buildContentDisposition(row.original_filename, 'inline'));
    reply.header('X-Content-SHA256', row.sha256);
    reply.header('Cache-Control', 'private, max-age=300');

    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const [startStr, endStr] = rangeHeader.slice('bytes='.length).split('-');
      const start = startStr ? Number.parseInt(startStr, 10) : 0;
      const end = endStr ? Math.min(Number.parseInt(endStr, 10), totalLength - 1) : totalLength - 1;

      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalLength) {
        reply.header('Content-Range', `bytes */${totalLength}`);
        return reply.code(416).send();
      }

      const slice = buffer.subarray(start, end + 1);
      reply.header('Content-Range', `bytes ${start}-${end}/${totalLength}`);
      reply.header('Content-Length', String(slice.length));
      return reply.code(206).send(slice);
    }

    reply.header('Content-Length', String(totalLength));
    return reply.code(200).send(buffer);
  });

  // Direct-to-Cloud S3 Presigned Download URL (0 egress on Cloudflare R2 & 0 RAM overhead on Render!)
  app.get('/api/v1/media/:mediaId/download-url', { preHandler: [authenticate] }, async (request): Promise<DownloadUrlResponse> => {
    const auth = request.auth!;
    const params = MediaIdParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid mediaId');

    const res = await db.query<{
      id: string;
      original_filename: string;
      size_bytes: string | number;
      sha256: string;
      object_key: string;
      primary_node_id: string | null;
    }>(
      `
      SELECT m.id, m.original_filename, m.size_bytes, m.sha256, so.object_key, so.primary_node_id
      FROM media_files m
      JOIN storage_objects so ON so.media_id = m.id AND so.object_kind = 'original'
      WHERE m.id = $1 AND m.user_id = $2 AND m.deleted_at IS NULL
      LIMIT 1
      `,
      [params.data.mediaId, auth.userId]
    );

    const row = res.rows[0];
    if (!row) throw Errors.notFound('Media file not found');

    const expiresInSeconds = 900;
    const adapter =
      storageRegistry.resolveAdapter(row.primary_node_id, 'copy1_primary') ??
      storageRegistry.getPrimary();
    const presigned = await adapter.getPresignedDownloadUrl(row.object_key, expiresInSeconds);

    if (presigned) {
      return {
        mode: 'presigned_s3',
        url: presigned,
        expiresInSeconds,
        originalFilename: row.original_filename,
        expectedSha256: row.sha256,
        sizeBytes: Number(row.size_bytes)
      };
    }

    return {
      mode: 'api_proxy',
      url: `/api/v1/media/${row.id}/download`,
      expiresInSeconds,
      originalFilename: row.original_filename,
      expectedSha256: row.sha256,
      sizeBytes: Number(row.size_bytes)
    };
  });

  // Download exact 100% original file (strict tenant isolation — Admin cannot access other users' media)
  app.get('/api/v1/media/:mediaId/download', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const params = MediaIdParamSchema.safeParse(request.params);
    if (!params.success) {
      throw Errors.badRequest('Invalid mediaId');
    }

    const res = await db.query<{
      id: string;
      original_filename: string;
      mime_type: string;
      size_bytes: string | number;
      sha256: string;
      object_key: string;
      primary_node_id: string | null;
    }>(
      `
      SELECT
        m.id, m.original_filename, m.mime_type, m.size_bytes, m.sha256,
        so.object_key, so.primary_node_id
      FROM media_files m
      JOIN storage_objects so ON so.media_id = m.id AND so.object_kind = 'original'
      WHERE m.id = $1 AND m.user_id = $2 AND m.deleted_at IS NULL
      LIMIT 1
      `,
      [params.data.mediaId, auth.userId]
    );

    const row = res.rows[0];
    if (!row) {
      throw Errors.notFound('Media file not found');
    }

    const primary =
      storageRegistry.resolveAdapter(row.primary_node_id, 'copy1_primary') ??
      storageRegistry.getPrimary();
    const buffer = await primary.getObject(row.object_key);

    reply.header('Content-Type', row.mime_type || 'application/octet-stream');
    reply.header('Content-Disposition', buildContentDisposition(row.original_filename, 'attachment'));
    reply.header('Content-Length', String(buffer.length));
    reply.header('X-Content-SHA256', row.sha256);
    reply.header('X-Original-Size', String(row.size_bytes));
    reply.header('Cache-Control', 'private, no-store');

    return reply.send(buffer);
  });

  // On-demand bit-for-bit SHA-256 integrity verification against stored original object
  app.get('/api/v1/media/:mediaId/verify', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = MediaIdParamSchema.safeParse(request.params);
    if (!params.success) {
      throw Errors.badRequest('Invalid mediaId');
    }

    const res = await db.query<{
      media_id: string;
      storage_object_id: string;
      object_key: string;
      primary_node_id: string | null;
      sha256: string;
      size_bytes: string | number;
    }>(
      `
      SELECT
        m.id AS media_id,
        so.id AS storage_object_id,
        so.object_key,
        so.primary_node_id,
        so.sha256,
        so.size_bytes
      FROM media_files m
      JOIN storage_objects so ON so.media_id = m.id AND so.object_kind = 'original'
      WHERE m.id = $1 AND m.user_id = $2 AND m.deleted_at IS NULL
      LIMIT 1
      `,
      [params.data.mediaId, auth.userId]
    );

    const row = res.rows[0];
    if (!row) {
      throw Errors.notFound('Media file not found');
    }

    const primary =
      storageRegistry.resolveAdapter(row.primary_node_id, 'copy1_primary') ??
      storageRegistry.getPrimary();
    const actual = await primary.computeObjectSha256(row.object_key);
    const verified = actual.sha256 === row.sha256 && actual.sizeBytes === Number(row.size_bytes);
    const checkedAt = new Date().toISOString();

    await db.query(
      `
      UPDATE replica_status
      SET state = $2,
          verified_sha256 = $3,
          last_verified_at = NOW(),
          error_message = $4,
          updated_at = NOW()
      WHERE storage_object_id = $1 AND replica_slot = 'copy1_primary'
      `,
      [
        row.storage_object_id,
        verified ? 'verified' : 'corrupted',
        actual.sha256,
        verified ? null : `Expected ${row.sha256}, actual ${actual.sha256}`
      ]
    );

    const response: VerifyMediaIntegrityResponse = {
      mediaId: row.media_id,
      verified,
      expectedSha256: row.sha256,
      actualSha256: actual.sha256,
      sizeBytes: actual.sizeBytes,
      checkedAt
    };

    return response;
  });
}
