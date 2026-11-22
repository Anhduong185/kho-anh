import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  DuplicateGroup,
  FileVersionItem,
  MediaKind,
  ReplicaSlot,
  StorageSummaryResponse,
  TrashItemSummary
} from '@smb/shared';
import type { AppConfig } from '../../config/env.js';
import type { DbClient } from '../../db/client.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import type { StorageRegistry } from '../../storage/registry.js';
import { Errors } from '../../utils/errors.js';
import { buildZipStoreArchive, type ZipStoreEntry } from '../../utils/zipStore.js';
import { getSystemSettings } from '../settings/service.js';

const MediaIdParamSchema = z.object({ mediaId: z.string().uuid() });

const ExportZipSchema = z.object({
  scope: z.enum(['selection', 'album', 'folder', 'all']),
  mediaIds: z.array(z.string().uuid()).max(500).optional(),
  albumId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional()
});

const VersionParamSchema = z.object({
  mediaId: z.string().uuid(),
  versionNumber: z.coerce.number().int().min(1)
});

function buildFolderPathMap(
  folders: Array<{ id: string; parent_id: string | null; name: string }>
): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const memo = new Map<string, string>();

  const resolve = (id: string, depth = 0): string => {
    if (memo.has(id)) return memo.get(id)!;
    if (depth > 32) return '';
    const node = byId.get(id);
    if (!node) return '';
    const safeName = node.name.replace(/[\\/:*?"<>|]/g, '_');
    const path = node.parent_id ? `${resolve(node.parent_id, depth + 1)}/${safeName}` : safeName;
    memo.set(id, path);
    return path;
  };

  for (const f of folders) {
    resolve(f.id);
  }
  return memo;
}

function collectDescendantFolderIds(
  rootFolderId: string,
  folders: Array<{ id: string; parent_id: string | null }>
): string[] {
  const result = new Set<string>([rootFolderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of folders) {
      if (f.parent_id && result.has(f.parent_id) && !result.has(f.id)) {
        result.add(f.id);
        changed = true;
      }
    }
  }
  return [...result];
}

export function registerRestoreRoutes(
  app: FastifyInstance,
  db: DbClient,
  config: AppConfig,
  storageRegistry: StorageRegistry
) {
  const authenticate = createAuthMiddleware(db, config);

  // ==================== 1. STORAGE ANALYTICS & SAFE SPACE LIBERATION ====================

  app.get('/api/v1/storage/summary', { preHandler: [authenticate] }, async (request): Promise<StorageSummaryResponse> => {
    const auth = request.auth!;
    const settings = await getSystemSettings(db);

    const [userRes, mediaStatsRes, trashStatsRes, dupStatsRes] = await Promise.all([
      db.query<{ quota_bytes: string | number; used_bytes: string | number }>(
        'SELECT quota_bytes, used_bytes FROM users WHERE id = $1',
        [auth.userId]
      ),
      db.query<{
        total_files: string;
        image_count: string;
        image_bytes: string;
        video_count: string;
        video_bytes: string;
        verified_safe_count: string;
        verified_safe_bytes: string;
        insufficient_replica_count: string;
      }>(
        `
        SELECT
          COUNT(*)::text AS total_files,
          COUNT(*) FILTER (WHERE media_kind = 'image')::text AS image_count,
          COALESCE(SUM(size_bytes) FILTER (WHERE media_kind = 'image'), 0)::text AS image_bytes,
          COUNT(*) FILTER (WHERE media_kind = 'video')::text AS video_count,
          COALESCE(SUM(size_bytes) FILTER (WHERE media_kind = 'video'), 0)::text AS video_bytes,
          COUNT(*) FILTER (WHERE upload_state = 'verified')::text AS verified_safe_count,
          COALESCE(SUM(size_bytes) FILTER (WHERE upload_state = 'verified'), 0)::text AS verified_safe_bytes,
          COUNT(*) FILTER (WHERE upload_state = 'insufficient_replicas')::text AS insufficient_replica_count
        FROM media_files
        WHERE user_id = $1 AND deleted_at IS NULL
        `,
        [auth.userId]
      ),
      db.query<{ trash_count: string; trash_bytes: string }>(
        `
        SELECT COUNT(*)::text AS trash_count, COALESCE(SUM(m.size_bytes), 0)::text AS trash_bytes
        FROM trash_items t
        JOIN media_files m ON m.id = t.media_id
        WHERE t.user_id = $1
        `,
        [auth.userId]
      ),
      db.query<{ dup_groups: string; reclaimable: string }>(
        `
        SELECT
          COUNT(*)::text AS dup_groups,
          COALESCE(SUM((cnt - 1) * max_size), 0)::text AS reclaimable
        FROM (
          SELECT sha256, COUNT(*) AS cnt, MAX(size_bytes) AS max_size
          FROM media_files
          WHERE user_id = $1 AND deleted_at IS NULL
          GROUP BY sha256
          HAVING COUNT(*) > 1
        ) sub
        `,
        [auth.userId]
      )
    ]);

    const u = userRes.rows[0]!;
    const m = mediaStatsRes.rows[0]!;
    const tr = trashStatsRes.rows[0]!;
    const d = dupStatsRes.rows[0]!;

    return {
      quotaBytes: Number(u.quota_bytes),
      usedBytes: Number(u.used_bytes),
      totalFiles: Number(m.total_files),
      imageCount: Number(m.image_count),
      imageBytes: Number(m.image_bytes),
      videoCount: Number(m.video_count),
      videoBytes: Number(m.video_bytes),
      verifiedSafeCount: Number(m.verified_safe_count),
      verifiedSafeBytes: Number(m.verified_safe_bytes),
      insufficientReplicaCount: Number(m.insufficient_replica_count),
      trashCount: Number(tr.trash_count),
      trashBytes: Number(tr.trash_bytes),
      duplicateGroupCount: Number(d.dup_groups),
      duplicateReclaimableBytes: Number(d.reclaimable),
      requiredReplicas: settings.required_replicas
    };
  });

  // Tenant-scoped duplicate groups (proposes review — NEVER auto-deletes per PRD 3.3)
  app.get('/api/v1/storage/duplicates', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const dupHashes = await db.query<{ sha256: string; cnt: string }>(
      `
      SELECT sha256, COUNT(*)::text AS cnt
      FROM media_files
      WHERE user_id = $1 AND deleted_at IS NULL
      GROUP BY sha256
      HAVING COUNT(*) > 1
      ORDER BY MAX(size_bytes) * (COUNT(*) - 1) DESC
      LIMIT 100
      `,
      [auth.userId]
    );

    if (dupHashes.rows.length === 0) {
      return { groups: [] as DuplicateGroup[] };
    }

    const hashes = dupHashes.rows.map((r) => r.sha256);
    const filesRes = await db.query<{
      id: string;
      sha256: string;
      original_filename: string;
      size_bytes: string | number;
      folder_id: string | null;
      created_at: string | Date;
    }>(
      `
      SELECT id, sha256, original_filename, size_bytes, folder_id, created_at
      FROM media_files
      WHERE user_id = $1 AND sha256 = ANY($2::text[]) AND deleted_at IS NULL
      ORDER BY created_at ASC
      `,
      [auth.userId, hashes]
    );

    const byHash = new Map<string, DuplicateGroup>();
    for (const f of filesRes.rows) {
      const size = Number(f.size_bytes);
      const existing = byHash.get(f.sha256);
      if (!existing) {
        byHash.set(f.sha256, {
          sha256: f.sha256,
          sizeBytes: size,
          count: 1,
          reclaimableBytes: 0,
          files: [
            {
              id: f.id,
              originalFilename: f.original_filename,
              createdAt: new Date(f.created_at).toISOString(),
              folderId: f.folder_id
            }
          ]
        });
      } else {
        existing.count += 1;
        existing.reclaimableBytes = (existing.count - 1) * existing.sizeBytes;
        existing.files.push({
          id: f.id,
          originalFilename: f.original_filename,
          createdAt: new Date(f.created_at).toISOString(),
          folderId: f.folder_id
        });
      }
    }

    return { groups: [...byHash.values()] };
  });

  // ==================== 2. LOSSLESS BATCH RESTORE / EXPORT (ZIP STORE) ====================

  app.post('/api/v1/restore/export-zip', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const parsed = ExportZipSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.badRequest('Invalid export request', parsed.error.flatten());
    }

    const { scope, mediaIds, albumId, folderId } = parsed.data;
    const foldersRes = await db.query<{ id: string; parent_id: string | null; name: string }>(
      'SELECT id, parent_id, name FROM folders WHERE user_id = $1',
      [auth.userId]
    );
    const folderPathMap = buildFolderPathMap(foldersRes.rows);

    let whereSql = 'm.user_id = $1 AND m.deleted_at IS NULL';
    const params: unknown[] = [auth.userId];
    let archivePrefix = 'vault-export';

    if (scope === 'selection') {
      if (!mediaIds || mediaIds.length === 0) {
        throw Errors.badRequest('mediaIds is required for selection export');
      }
      params.push(mediaIds);
      whereSql += ` AND m.id = ANY($${params.length}::uuid[])`;
      archivePrefix = 'vault-selection';
    } else if (scope === 'album') {
      if (!albumId) throw Errors.badRequest('albumId is required for album export');
      const albumRes = await db.query<{ name: string }>(
        'SELECT name FROM albums WHERE id = $1 AND user_id = $2',
        [albumId, auth.userId]
      );
      if (albumRes.rowCount === 0) throw Errors.notFound('Album not found');
      params.push(albumId);
      whereSql += ` AND EXISTS (SELECT 1 FROM album_media am WHERE am.media_id = m.id AND am.album_id = $${params.length})`;
      archivePrefix = `album-${albumRes.rows[0]!.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    } else if (scope === 'folder') {
      if (!folderId) throw Errors.badRequest('folderId is required for folder export');
      if (!folderPathMap.has(folderId)) throw Errors.notFound('Folder not found');
      const descendantIds = collectDescendantFolderIds(folderId, foldersRes.rows);
      params.push(descendantIds);
      whereSql += ` AND m.folder_id = ANY($${params.length}::uuid[])`;
      archivePrefix = `folder-export`;
    } else {
      archivePrefix = 'vault-full-restore';
    }

    const mediaRes = await db.query<{
      id: string;
      original_filename: string;
      size_bytes: string | number;
      sha256: string;
      folder_id: string | null;
      captured_at: string | Date | null;
      created_at: string | Date;
      object_key: string;
      primary_node_id: string | null;
    }>(
      `
      SELECT
        m.id, m.original_filename, m.size_bytes, m.sha256,
        m.folder_id, m.captured_at, m.created_at, so.object_key, so.primary_node_id
      FROM media_files m
      JOIN storage_objects so ON so.media_id = m.id AND so.object_kind = 'original'
      WHERE ${whereSql}
      ORDER BY m.created_at ASC
      `,
      params
    );

    if (mediaRes.rows.length === 0) {
      throw Errors.notFound('No media files matched the export scope');
    }

    // Also include album names in manifest so complete library structure is preserved (PRD 3.4 & 11)
    const albumLinksRes = await db.query<{ media_id: string; album_name: string }>(
      `
      SELECT am.media_id, a.name AS album_name
      FROM album_media am
      JOIN albums a ON a.id = am.album_id
      WHERE a.user_id = $1 AND am.media_id = ANY($2::uuid[])
      `,
      [auth.userId, mediaRes.rows.map((r) => r.id)]
    );
    const albumsByMedia = new Map<string, string[]>();
    for (const row of albumLinksRes.rows) {
      const list = albumsByMedia.get(row.media_id) ?? [];
      list.push(row.album_name);
      albumsByMedia.set(row.media_id, list);
    }

    const entries: ZipStoreEntry[] = [];
    const manifestItems: Array<{
      mediaId: string;
      archivePath: string;
      originalFilename: string;
      sizeBytes: number;
      sha256: string;
      folderPath: string | null;
      albums: string[];
    }> = [];

    for (const row of mediaRes.rows) {
      const adapter =
        storageRegistry.resolveAdapter(row.primary_node_id, 'copy1_primary') ??
        storageRegistry.getPrimary();
      const bytes = await adapter.getObject(row.object_key);
      const folderPath = row.folder_id ? (folderPathMap.get(row.folder_id) ?? null) : null;
      const albums = albumsByMedia.get(row.id) ?? [];
      const archivePath = folderPath
        ? `Folders/${folderPath}/${row.original_filename}`
        : albums.length > 0
          ? `Albums/${albums[0]!.replace(/[\\/:*?"<>|]/g, '_')}/${row.original_filename}`
          : `Library/${row.original_filename}`;

      entries.push({
        path: archivePath,
        data: bytes,
        modifiedAt: new Date(row.captured_at ?? row.created_at)
      });

      manifestItems.push({
        mediaId: row.id,
        archivePath,
        originalFilename: row.original_filename,
        sizeBytes: bytes.length,
        sha256: row.sha256,
        folderPath,
        albums
      });
    }

    const manifestJson = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        scope,
        losslessMode: 'ZIP_STORE_UNCOMPRESSED',
        totalFiles: manifestItems.length,
        files: manifestItems
      },
      null,
      2
    );

    entries.push({
      path: 'restore-manifest.json',
      data: Buffer.from(manifestJson, 'utf8')
    });

    const zipBuffer = buildZipStoreArchive(entries);
    const filename = `${archivePrefix}-${new Date().toISOString().slice(0, 10)}.zip`;

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Content-Length', String(zipBuffer.length));
    reply.header('X-Export-File-Count', String(manifestItems.length));
    reply.header('Cache-Control', 'private, no-store');

    return reply.code(200).send(zipBuffer);
  });

  // ==================== 3. TRASH (SOFT DELETE, RESTORE, MANUAL PERMANENT DELETE) ====================

  app.post('/api/v1/media/:mediaId/trash', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = MediaIdParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid mediaId');

    const settings = await getSystemSettings(db);
    // Note: Retention policy is indefinite manual delete; trash still records optional informational purge_after
    const purgeAfter = new Date(Date.now() + settings.trash_retention_days * 86_400_000).toISOString();

    const moved = await db.transaction(async (tx) => {
      const res = await tx.query<{ id: string }>(
        'UPDATE media_files SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id',
        [params.data.mediaId, auth.userId]
      );
      if (res.rowCount === 0) return false;

      await tx.query(
        `
        INSERT INTO trash_items (user_id, media_id, trashed_at, purge_after)
        VALUES ($1, $2, NOW(), $3)
        ON CONFLICT (media_id) DO UPDATE SET trashed_at = NOW(), purge_after = EXCLUDED.purge_after
        `,
        [auth.userId, params.data.mediaId, purgeAfter]
      );
      return true;
    });

    if (!moved) throw Errors.notFound('Media file not found');
    return { trashed: true, mediaId: params.data.mediaId };
  });

  app.get('/api/v1/trash', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const res = await db.query<{
      media_id: string;
      original_filename: string;
      mime_type: string;
      media_kind: MediaKind;
      size_bytes: string | number;
      sha256: string;
      trashed_at: string | Date;
      purge_after: string | Date | null;
    }>(
      `
      SELECT
        t.media_id, m.original_filename, m.mime_type, m.media_kind,
        m.size_bytes, m.sha256, t.trashed_at, t.purge_after
      FROM trash_items t
      JOIN media_files m ON m.id = t.media_id
      WHERE t.user_id = $1
      ORDER BY t.trashed_at DESC
      `,
      [auth.userId]
    );

    const items: TrashItemSummary[] = res.rows.map((r) => ({
      mediaId: r.media_id,
      originalFilename: r.original_filename,
      mimeType: r.mime_type,
      mediaKind: r.media_kind,
      sizeBytes: Number(r.size_bytes),
      sha256: r.sha256,
      trashedAt: new Date(r.trashed_at).toISOString(),
      purgeAfter: r.purge_after ? new Date(r.purge_after).toISOString() : null
    }));

    return { items };
  });

  app.post('/api/v1/trash/:mediaId/restore', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = MediaIdParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid mediaId');

    const restored = await db.transaction(async (tx) => {
      const del = await tx.query(
        'DELETE FROM trash_items WHERE media_id = $1 AND user_id = $2 RETURNING media_id',
        [params.data.mediaId, auth.userId]
      );
      if (del.rowCount === 0) return false;

      await tx.query(
        'UPDATE media_files SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 AND user_id = $2',
        [params.data.mediaId, auth.userId]
      );
      return true;
    });

    if (!restored) throw Errors.notFound('Item not found in trash');
    return { restored: true, mediaId: params.data.mediaId };
  });

  // Manual permanent delete from trash (removes objects across all configured replicas & reclaims quota)
  app.delete('/api/v1/trash/:mediaId', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = MediaIdParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid mediaId');

    const { deleteTargets, freedBytes } = await db.transaction(async (tx) => {
      const check = await tx.query<{ media_id: string; size_bytes: string | number }>(
        `
        SELECT t.media_id, m.size_bytes
        FROM trash_items t
        JOIN media_files m ON m.id = t.media_id
        WHERE t.media_id = $1 AND t.user_id = $2
        `,
        [params.data.mediaId, auth.userId]
      );
      if (check.rowCount === 0) {
        throw Errors.notFound('Item not found in trash');
      }

      const objs = await tx.query<{
        id: string;
        object_key: string;
        size_bytes: string | number;
        primary_node_id: string | null;
      }>(
        'SELECT id, object_key, size_bytes, primary_node_id FROM storage_objects WHERE media_id = $1 AND user_id = $2',
        [params.data.mediaId, auth.userId]
      );
      const repRows = await tx.query<{
        object_key: string;
        size_bytes: string | number;
        replica_slot: ReplicaSlot;
        storage_node_id: string | null;
      }>(
        `
        SELECT so.object_key, so.size_bytes, rs.replica_slot, rs.storage_node_id
        FROM storage_objects so
        JOIN replica_status rs ON rs.storage_object_id = so.id
        WHERE so.media_id = $1 AND so.user_id = $2
        `,
        [params.data.mediaId, auth.userId]
      );

      const totalFreed = objs.rows.reduce((acc, o) => acc + Number(o.size_bytes), 0);

      for (const rep of repRows.rows) {
        if (rep.storage_node_id) {
          await tx.query(
            'UPDATE storage_nodes SET used_bytes = GREATEST(0, used_bytes - $2), updated_at = NOW() WHERE id = $1',
            [rep.storage_node_id, Number(rep.size_bytes)]
          );
        }
      }

      await tx.query('DELETE FROM file_versions WHERE media_id = $1 AND user_id = $2', [
        params.data.mediaId,
        auth.userId
      ]);
      await tx.query('DELETE FROM trash_items WHERE media_id = $1 AND user_id = $2', [
        params.data.mediaId,
        auth.userId
      ]);
      await tx.query('DELETE FROM media_files WHERE id = $1 AND user_id = $2', [
        params.data.mediaId,
        auth.userId
      ]);
      await tx.query(
        'UPDATE users SET used_bytes = GREATEST(0, used_bytes - $2), updated_at = NOW() WHERE id = $1',
        [auth.userId, totalFreed]
      );

      return {
        deleteTargets: repRows.rows.map((r) => ({
          key: r.object_key,
          slot: r.replica_slot,
          nodeId: r.storage_node_id,
          sizeBytes: Number(r.size_bytes)
        })),
        freedBytes: totalFreed
      };
    });

    for (const target of deleteTargets) {
      const adapter = storageRegistry.resolveAdapter(target.nodeId, target.slot);
      if (adapter) {
        await adapter.deleteObject(target.key).catch(() => {});
      }
      storageRegistry.adjustPoolNodeUsedBytes(target.nodeId, -target.sizeBytes);
    }

    return { permanentlyDeleted: true, mediaId: params.data.mediaId, freedBytes };
  });

  // ==================== 4. FILE VERSIONS (INDEFINITE UNTIL MANUAL DELETE) ====================

  app.get('/api/v1/media/:mediaId/versions', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = MediaIdParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid mediaId');

    const res = await db.query<{
      id: string;
      media_id: string;
      version_number: number;
      sha256: string;
      size_bytes: string | number;
      created_at: string | Date;
    }>(
      `
      SELECT id, media_id, version_number, sha256, size_bytes, created_at
      FROM file_versions
      WHERE media_id = $1 AND user_id = $2
      ORDER BY version_number DESC
      `,
      [params.data.mediaId, auth.userId]
    );

    const versions: FileVersionItem[] = res.rows.map((r) => ({
      id: r.id,
      mediaId: r.media_id,
      versionNumber: r.version_number,
      sha256: r.sha256,
      sizeBytes: Number(r.size_bytes),
      createdAt: new Date(r.created_at).toISOString()
    }));

    return { versions };
  });

  app.delete('/api/v1/media/:mediaId/versions/:versionNumber', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = VersionParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid parameters');

    // PRD 3.6: Never delete the sole remaining version protecting the file!
    const countRes = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM file_versions WHERE media_id = $1 AND user_id = $2',
      [params.data.mediaId, auth.userId]
    );
    const totalVersions = Number(countRes.rows[0]?.count ?? '0');
    if (totalVersions === 0) throw Errors.notFound('Media versions not found');
    if (totalVersions <= 1) {
      throw Errors.badRequest(
        'Cannot delete the sole remaining version protecting this media file. Move the media file to Trash instead.'
      );
    }

    const delRes = await db.query<{ storage_object_id: string }>(
      'DELETE FROM file_versions WHERE media_id = $1 AND user_id = $2 AND version_number = $3 RETURNING storage_object_id',
      [params.data.mediaId, auth.userId, params.data.versionNumber]
    );
    if (delRes.rowCount === 0) throw Errors.notFound('Version not found');

    return { deleted: true, versionNumber: params.data.versionNumber };
  });
}
