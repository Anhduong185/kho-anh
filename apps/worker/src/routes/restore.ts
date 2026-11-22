import type { DuplicateGroup, MediaKind, ReplicaSlot } from '@smb/shared';
import type { WorkerEnv } from '../env.js';
import { resolveAdapter } from '../storage/poolRouter.js';
import {
  getSystemSettings,
  HttpError,
  jsonResponse,
  readJson,
  requireAuth
} from '../utils/http.js';
import { buildZipStoreArchive, type ZipStoreEntry } from '../utils/zipStore.js';

const encoder = new TextEncoder();

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
    const p = node.parent_id ? `${resolve(node.parent_id, depth + 1)}/${safeName}` : safeName;
    memo.set(id, p);
    return p;
  };
  for (const f of folders) resolve(f.id);
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

export async function handleRestoreRoutes(
  request: Request,
  url: URL,
  env: WorkerEnv
): Promise<Response | null> {
  const { pathname } = url;
  const method = request.method;

  // GET /api/v1/storage/summary
  if (method === 'GET' && pathname === '/api/v1/storage/summary') {
    const auth = await requireAuth(request, env);
    const settings = await getSystemSettings(env.DB);

    const [userRow, mediaStats, trashStats, dupStats] = await Promise.all([
      env.DB.prepare('SELECT quota_bytes, used_bytes FROM users WHERE id = ?')
        .bind(auth.userId)
        .first<{ quota_bytes: number; used_bytes: number }>(),
      env.DB.prepare(
        `SELECT
          COUNT(*) AS total_files,
          SUM(CASE WHEN media_kind = 'image' THEN 1 ELSE 0 END) AS image_count,
          COALESCE(SUM(CASE WHEN media_kind = 'image' THEN size_bytes ELSE 0 END), 0) AS image_bytes,
          SUM(CASE WHEN media_kind = 'video' THEN 1 ELSE 0 END) AS video_count,
          COALESCE(SUM(CASE WHEN media_kind = 'video' THEN size_bytes ELSE 0 END), 0) AS video_bytes,
          SUM(CASE WHEN upload_state = 'verified' THEN 1 ELSE 0 END) AS verified_safe_count,
          COALESCE(SUM(CASE WHEN upload_state = 'verified' THEN size_bytes ELSE 0 END), 0) AS verified_safe_bytes,
          SUM(CASE WHEN upload_state = 'insufficient_replicas' THEN 1 ELSE 0 END) AS insufficient_replica_count
         FROM media_files WHERE user_id = ? AND deleted_at IS NULL`
      )
        .bind(auth.userId)
        .first<Record<string, number>>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS trash_count, COALESCE(SUM(m.size_bytes), 0) AS trash_bytes
         FROM trash_items t JOIN media_files m ON m.id = t.media_id WHERE t.user_id = ?`
      )
        .bind(auth.userId)
        .first<{ trash_count: number; trash_bytes: number }>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS dup_groups, COALESCE(SUM((cnt - 1) * max_size), 0) AS reclaimable
         FROM (
           SELECT sha256, COUNT(*) AS cnt, MAX(size_bytes) AS max_size
           FROM media_files WHERE user_id = ? AND deleted_at IS NULL
           GROUP BY sha256 HAVING COUNT(*) > 1
         )`
      )
        .bind(auth.userId)
        .first<{ dup_groups: number; reclaimable: number }>()
    ]);

    return jsonResponse({
      quotaBytes: Number(userRow?.quota_bytes ?? 0),
      usedBytes: Number(userRow?.used_bytes ?? 0),
      totalFiles: Number(mediaStats?.total_files ?? 0),
      imageCount: Number(mediaStats?.image_count ?? 0),
      imageBytes: Number(mediaStats?.image_bytes ?? 0),
      videoCount: Number(mediaStats?.video_count ?? 0),
      videoBytes: Number(mediaStats?.video_bytes ?? 0),
      verifiedSafeCount: Number(mediaStats?.verified_safe_count ?? 0),
      verifiedSafeBytes: Number(mediaStats?.verified_safe_bytes ?? 0),
      insufficientReplicaCount: Number(mediaStats?.insufficient_replica_count ?? 0),
      trashCount: Number(trashStats?.trash_count ?? 0),
      trashBytes: Number(trashStats?.trash_bytes ?? 0),
      duplicateGroupCount: Number(dupStats?.dup_groups ?? 0),
      duplicateReclaimableBytes: Number(dupStats?.reclaimable ?? 0),
      requiredReplicas: settings.required_replicas
    });
  }

  // GET /api/v1/storage/duplicates
  if (method === 'GET' && pathname === '/api/v1/storage/duplicates') {
    const auth = await requireAuth(request, env);
    const dupHashes = await env.DB.prepare(
      `SELECT sha256 FROM media_files WHERE user_id = ? AND deleted_at IS NULL
       GROUP BY sha256 HAVING COUNT(*) > 1 LIMIT 100`
    )
      .bind(auth.userId)
      .all<{ sha256: string }>();

    if (dupHashes.results.length === 0) {
      return jsonResponse({ groups: [] });
    }

    const groups: DuplicateGroup[] = [];
    for (const h of dupHashes.results) {
      const filesRes = await env.DB.prepare(
        `SELECT id, original_filename, size_bytes, folder_id, created_at
         FROM media_files WHERE user_id = ? AND sha256 = ? AND deleted_at IS NULL ORDER BY created_at ASC`
      )
        .bind(auth.userId, h.sha256)
        .all<{
          id: string;
          original_filename: string;
          size_bytes: number;
          folder_id: string | null;
          created_at: string;
        }>();
      if (filesRes.results.length > 1) {
        const sizeBytes = Number(filesRes.results[0]!.size_bytes);
        groups.push({
          sha256: h.sha256,
          sizeBytes,
          count: filesRes.results.length,
          reclaimableBytes: (filesRes.results.length - 1) * sizeBytes,
          files: filesRes.results.map((f) => ({
            id: f.id,
            originalFilename: f.original_filename,
            createdAt: f.created_at,
            folderId: f.folder_id
          }))
        });
      }
    }

    return jsonResponse({ groups });
  }

  // POST /api/v1/restore/export-zip (Lossless ZIP STORE across Multi-Cloud Pool)
  if (method === 'POST' && pathname === '/api/v1/restore/export-zip') {
    const auth = await requireAuth(request, env);
    const body = await readJson<{
      scope: 'selection' | 'album' | 'folder' | 'all';
      mediaIds?: string[];
      albumId?: string;
      folderId?: string;
    }>(request);

    const foldersRes = await env.DB.prepare(
      'SELECT id, parent_id, name FROM folders WHERE user_id = ?'
    )
      .bind(auth.userId)
      .all<{ id: string; parent_id: string | null; name: string }>();
    const folderPathMap = buildFolderPathMap(foldersRes.results);

    type ExportRow = {
      id: string;
      original_filename: string;
      size_bytes: number;
      sha256: string;
      folder_id: string | null;
      captured_at: string | null;
      created_at: string;
      object_key: string;
      node_id: string | null;
    };

    let rows: ExportRow[] = [];

    if (body.scope === 'selection' && body.mediaIds?.length) {
      const placeholders = body.mediaIds.map(() => '?').join(',');
      const res = await env.DB.prepare(
        `SELECT m.id, m.original_filename, m.size_bytes, m.sha256, m.folder_id, m.captured_at, m.created_at,
                COALESCE(so.object_key, m.object_key) AS object_key,
                COALESCE(so.primary_node_id, m.storage_node_id) AS node_id
         FROM media_files m
         LEFT JOIN storage_objects so ON so.media_id = m.id AND so.object_kind = 'original'
         WHERE m.user_id = ? AND m.deleted_at IS NULL AND m.id IN (${placeholders})
         ORDER BY m.created_at ASC`
      )
        .bind(auth.userId, ...body.mediaIds)
        .all<ExportRow>();
      rows = res.results;
    } else if (body.scope === 'album' && body.albumId) {
      const res = await env.DB.prepare(
        `SELECT m.id, m.original_filename, m.size_bytes, m.sha256, m.folder_id, m.captured_at, m.created_at,
                COALESCE(so.object_key, m.object_key) AS object_key,
                COALESCE(so.primary_node_id, m.storage_node_id) AS node_id
         FROM media_files m
         JOIN album_media am ON am.media_id = m.id
         LEFT JOIN storage_objects so ON so.media_id = m.id AND so.object_kind = 'original'
         WHERE m.user_id = ? AND m.deleted_at IS NULL AND am.album_id = ?
         ORDER BY m.created_at ASC`
      )
        .bind(auth.userId, body.albumId)
        .all<ExportRow>();
      rows = res.results;
    } else if (body.scope === 'folder' && body.folderId) {
      if (!folderPathMap.has(body.folderId)) {
        throw new HttpError(404, 'FOLDER_NOT_FOUND', 'Không tìm thấy thư mục');
      }
      const descendantIds = collectDescendantFolderIds(body.folderId, foldersRes.results);
      const placeholders = descendantIds.map(() => '?').join(',');
      const res = await env.DB.prepare(
        `SELECT m.id, m.original_filename, m.size_bytes, m.sha256, m.folder_id, m.captured_at, m.created_at,
                COALESCE(so.object_key, m.object_key) AS object_key,
                COALESCE(so.primary_node_id, m.storage_node_id) AS node_id
         FROM media_files m
         LEFT JOIN storage_objects so ON so.media_id = m.id AND so.object_kind = 'original'
         WHERE m.user_id = ? AND m.deleted_at IS NULL AND m.folder_id IN (${placeholders})
         ORDER BY m.created_at ASC`
      )
        .bind(auth.userId, ...descendantIds)
        .all<ExportRow>();
      rows = res.results;
    } else {
      const res = await env.DB.prepare(
        `SELECT m.id, m.original_filename, m.size_bytes, m.sha256, m.folder_id, m.captured_at, m.created_at,
                COALESCE(so.object_key, m.object_key) AS object_key,
                COALESCE(so.primary_node_id, m.storage_node_id) AS node_id
         FROM media_files m
         LEFT JOIN storage_objects so ON so.media_id = m.id AND so.object_kind = 'original'
         WHERE m.user_id = ? AND m.deleted_at IS NULL
         ORDER BY m.created_at ASC LIMIT 200`
      )
        .bind(auth.userId)
        .all<ExportRow>();
      rows = res.results;
    }

    if (rows.length === 0) {
      throw new HttpError(404, 'EMPTY_EXPORT', 'Không có tệp nào khớp phạm vi xuất khôi phục');
    }

    // Guard Worker 128 MB memory limit
    const totalBytes = rows.reduce((acc, r) => acc + Number(r.size_bytes), 0);
    if (totalBytes > 75 * 1024 * 1024) {
      throw new HttpError(
        413,
        'ZIP_BATCH_TOO_LARGE',
        'Gói ZIP vượt quá 75 MB cho 1 lượt xuất trên Cloudflare Workers. Hãy chọn ít mục hơn hoặc tải trực tiếp từng video lớn.'
      );
    }

    const entries: ZipStoreEntry[] = [];
    const manifest: Array<Record<string, unknown>> = [];

    for (const r of rows) {
      const adapter = await resolveAdapter(env, r.node_id, 'copy1_primary');
      if (!adapter) continue;
      const obj = await adapter.get(r.object_key);
      if (!obj) continue;
      const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
      const folderPath = r.folder_id ? (folderPathMap.get(r.folder_id) ?? null) : null;
      const archivePath = folderPath
        ? `Folders/${folderPath}/${r.original_filename}`
        : `Library/${r.original_filename}`;
      entries.push({
        path: archivePath,
        data: bytes,
        modifiedAt: new Date(r.captured_at ?? r.created_at)
      });
      manifest.push({
        mediaId: r.id,
        archivePath,
        originalFilename: r.original_filename,
        sizeBytes: bytes.length,
        sha256: r.sha256,
        folderPath
      });
    }

    if (entries.length === 0) {
      throw new HttpError(404, 'EMPTY_EXPORT', 'Không đọc được tệp nào từ kho lưu trữ');
    }

    entries.push({
      path: 'restore-manifest.json',
      data: encoder.encode(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            scope: body.scope,
            losslessMode: 'ZIP_STORE_UNCOMPRESSED',
            totalFiles: manifest.length,
            files: manifest
          },
          null,
          2
        )
      )
    });

    const zipBytes = buildZipStoreArchive(entries);
    return new Response(zipBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="kho-anh-${body.scope}-${new Date().toISOString().slice(0, 10)}.zip"`,
        'Content-Length': String(zipBytes.length),
        'X-Export-File-Count': String(manifest.length),
        'Cache-Control': 'private, no-store'
      }
    });
  }

  // POST /api/v1/media/:id/trash
  const trashMoveMatch = pathname.match(/^\/api\/v1\/media\/([^/]+)\/trash$/);
  if (method === 'POST' && trashMoveMatch) {
    const auth = await requireAuth(request, env);
    const mediaId = trashMoveMatch[1]!;
    const m = await env.DB.prepare(
      'SELECT id FROM media_files WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    )
      .bind(mediaId, auth.userId)
      .first<{ id: string }>();
    if (!m) throw new HttpError(404, 'MEDIA_NOT_FOUND', 'Không tìm thấy tệp');

    const settings = await getSystemSettings(env.DB);
    const now = new Date().toISOString();
    const purgeAfter = new Date(Date.now() + settings.trash_retention_days * 86_400_000).toISOString();

    await env.DB.batch([
      env.DB.prepare('UPDATE media_files SET deleted_at = ?, updated_at = ? WHERE id = ?').bind(
        now,
        now,
        mediaId
      ),
      env.DB.prepare(
        `INSERT INTO trash_items (id, user_id, media_id, trashed_at, purge_after)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(media_id) DO UPDATE SET trashed_at = excluded.trashed_at, purge_after = excluded.purge_after`
      ).bind(crypto.randomUUID(), auth.userId, mediaId, now, purgeAfter)
    ]);

    return jsonResponse({ trashed: true, mediaId });
  }

  // GET /api/v1/trash
  if (method === 'GET' && pathname === '/api/v1/trash') {
    const auth = await requireAuth(request, env);
    const res = await env.DB.prepare(
      `SELECT t.media_id, m.original_filename, m.mime_type, m.media_kind, m.size_bytes, m.sha256, t.trashed_at, t.purge_after
       FROM trash_items t JOIN media_files m ON m.id = t.media_id
       WHERE t.user_id = ? ORDER BY t.trashed_at DESC`
    )
      .bind(auth.userId)
      .all<{
        media_id: string;
        original_filename: string;
        mime_type: string;
        media_kind: MediaKind;
        size_bytes: number;
        sha256: string;
        trashed_at: string;
        purge_after: string | null;
      }>();

    return jsonResponse({
      items: res.results.map((r) => ({
        mediaId: r.media_id,
        originalFilename: r.original_filename,
        mimeType: r.mime_type,
        mediaKind: r.media_kind,
        sizeBytes: Number(r.size_bytes),
        sha256: r.sha256,
        trashedAt: r.trashed_at,
        purgeAfter: r.purge_after
      }))
    });
  }

  // POST /api/v1/trash/:id/restore
  const trashRestoreMatch = pathname.match(/^\/api\/v1\/trash\/([^/]+)\/restore$/);
  if (method === 'POST' && trashRestoreMatch) {
    const auth = await requireAuth(request, env);
    const mediaId = trashRestoreMatch[1]!;
    const t = await env.DB.prepare('SELECT id FROM trash_items WHERE media_id = ? AND user_id = ?')
      .bind(mediaId, auth.userId)
      .first<{ id: string }>();
    if (!t) throw new HttpError(404, 'TRASH_NOT_FOUND', 'Không tìm thấy mục trong thùng rác');

    await env.DB.batch([
      env.DB.prepare('DELETE FROM trash_items WHERE media_id = ? AND user_id = ?').bind(
        mediaId,
        auth.userId
      ),
      env.DB.prepare(
        'UPDATE media_files SET deleted_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?'
      ).bind(new Date().toISOString(), mediaId, auth.userId)
    ]);
    return jsonResponse({ restored: true, mediaId });
  }

  // DELETE /api/v1/trash/:id (Permanent delete across all replicas + D1 + reclaim quota & node used_bytes)
  const trashDelMatch = pathname.match(/^\/api\/v1\/trash\/([^/]+)$/);
  if (method === 'DELETE' && trashDelMatch) {
    const auth = await requireAuth(request, env);
    const mediaId = trashDelMatch[1]!;
    const row = await env.DB.prepare(
      `SELECT m.id, m.object_key, m.size_bytes, m.storage_node_id
       FROM trash_items t JOIN media_files m ON m.id = t.media_id
       WHERE t.media_id = ? AND t.user_id = ?`
    )
      .bind(mediaId, auth.userId)
      .first<{
        id: string;
        object_key: string;
        size_bytes: number;
        storage_node_id: string | null;
      }>();
    if (!row) throw new HttpError(404, 'TRASH_NOT_FOUND', 'Không tìm thấy mục trong thùng rác');

    const freedBytes = Number(row.size_bytes);
    const repRes = await env.DB.prepare(
      `SELECT so.object_key, so.size_bytes, rs.replica_slot, rs.storage_node_id, rs.state
       FROM storage_objects so
       JOIN replica_status rs ON rs.storage_object_id = so.id
       WHERE so.media_id = ? AND so.user_id = ?`
    )
      .bind(mediaId, auth.userId)
      .all<{
        object_key: string;
        size_bytes: number;
        replica_slot: ReplicaSlot;
        storage_node_id: string | null;
        state: string;
      }>();

    const targets =
      repRes.results.length > 0
        ? repRes.results.map((r) => ({
            objectKey: r.object_key,
            sizeBytes: Number(r.size_bytes),
            slot: r.replica_slot,
            nodeId: r.storage_node_id,
            state: r.state
          }))
        : [
            {
              objectKey: row.object_key,
              sizeBytes: freedBytes,
              slot: 'copy1_primary' as ReplicaSlot,
              nodeId: row.storage_node_id,
              state: 'verified'
            }
          ];

    for (const target of targets) {
      const adapter = await resolveAdapter(env, target.nodeId, target.slot);
      if (adapter) {
        await adapter.delete(target.objectKey).catch(() => {});
      }
    }

    const now = new Date().toISOString();
    const statements = [
      env.DB.prepare('DELETE FROM file_versions WHERE media_id = ? AND user_id = ?').bind(
        mediaId,
        auth.userId
      ),
      env.DB.prepare('DELETE FROM trash_items WHERE media_id = ? AND user_id = ?').bind(
        mediaId,
        auth.userId
      ),
      env.DB.prepare('DELETE FROM media_files WHERE id = ? AND user_id = ?').bind(
        mediaId,
        auth.userId
      ),
      env.DB.prepare(
        'UPDATE users SET used_bytes = MAX(0, used_bytes - ?), updated_at = ? WHERE id = ?'
      ).bind(freedBytes, now, auth.userId)
    ];

    const decrementedNodes = new Map<string, number>();
    for (const target of targets) {
      if (target.nodeId && (target.state === 'verified' || target.state === 'corrupted')) {
        decrementedNodes.set(
          target.nodeId,
          (decrementedNodes.get(target.nodeId) ?? 0) + target.sizeBytes
        );
      }
    }
    for (const [nodeId, decBytes] of decrementedNodes.entries()) {
      statements.push(
        env.DB.prepare(
          'UPDATE storage_nodes SET used_bytes = MAX(0, used_bytes - ?), updated_at = ? WHERE id = ?'
        ).bind(decBytes, now, nodeId)
      );
    }

    await env.DB.batch(statements);
    return jsonResponse({ permanentlyDeleted: true, mediaId, freedBytes });
  }

  // GET /api/v1/media/:id/versions
  const verMatch = pathname.match(/^\/api\/v1\/media\/([^/]+)\/versions$/);
  if (method === 'GET' && verMatch) {
    const auth = await requireAuth(request, env);
    const res = await env.DB.prepare(
      'SELECT id, media_id, version_number, sha256, size_bytes, created_at FROM file_versions WHERE media_id = ? AND user_id = ? ORDER BY version_number DESC'
    )
      .bind(verMatch[1]!, auth.userId)
      .all<{
        id: string;
        media_id: string;
        version_number: number;
        sha256: string;
        size_bytes: number;
        created_at: string;
      }>();

    return jsonResponse({
      versions: res.results.map((r) => ({
        id: r.id,
        mediaId: r.media_id,
        versionNumber: Number(r.version_number),
        sha256: r.sha256,
        sizeBytes: Number(r.size_bytes),
        createdAt: r.created_at
      }))
    });
  }

  return null;
}
