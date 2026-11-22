import type { WorkerEnv } from '../env.js';
import { HttpError, jsonResponse, readJson, requireAuth } from '../utils/http.js';

export async function handleOrganizationRoutes(
  request: Request,
  url: URL,
  env: WorkerEnv
): Promise<Response | null> {
  const { pathname } = url;
  const method = request.method;

  // ==================== FOLDERS ====================
  if (method === 'GET' && pathname === '/api/v1/folders') {
    const auth = await requireAuth(request, env);
    const res = await env.DB.prepare(
      `SELECT f.id, f.parent_id, f.name, f.created_at, f.updated_at,
        (SELECT COUNT(*) FROM media_files m WHERE m.folder_id = f.id AND m.user_id = f.user_id AND m.deleted_at IS NULL) AS media_count
       FROM folders f WHERE f.user_id = ? ORDER BY LOWER(f.name) ASC`
    )
      .bind(auth.userId)
      .all<{
        id: string;
        parent_id: string | null;
        name: string;
        media_count: number;
        created_at: string;
        updated_at: string;
      }>();

    return jsonResponse({
      folders: res.results.map((r) => ({
        id: r.id,
        parentId: r.parent_id,
        name: r.name,
        mediaCount: Number(r.media_count),
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }))
    });
  }

  if (method === 'POST' && pathname === '/api/v1/folders') {
    const auth = await requireAuth(request, env);
    const body = await readJson<{ name?: string; parentId?: string | null }>(request);
    const name = (body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'INVALID_NAME', 'Tên thư mục không được để trống');

    const parentId = body.parentId ?? null;
    if (parentId) {
      const parent = await env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
        .bind(parentId, auth.userId)
        .first<{ id: string }>();
      if (!parent) throw new HttpError(404, 'PARENT_NOT_FOUND', 'Thư mục cha không tồn tại');
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO folders (id, user_id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(id, auth.userId, parentId, name, now, now)
      .run();

    return jsonResponse(
      { folder: { id, parentId, name, mediaCount: 0, createdAt: now, updatedAt: now } },
      201
    );
  }

  const folderDelMatch = pathname.match(/^\/api\/v1\/folders\/([^/]+)$/);
  if (method === 'DELETE' && folderDelMatch) {
    const auth = await requireAuth(request, env);
    const res = await env.DB.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?')
      .bind(folderDelMatch[1]!, auth.userId)
      .run();
    if (!res.meta.changes) {
      throw new HttpError(404, 'FOLDER_NOT_FOUND', 'Không tìm thấy thư mục');
    }
    return jsonResponse({ deleted: true });
  }

  // ==================== ALBUMS ====================
  if (method === 'GET' && pathname === '/api/v1/albums') {
    const auth = await requireAuth(request, env);
    const res = await env.DB.prepare(
      `SELECT a.id, a.folder_id, a.name, a.cover_media_id, a.created_at, a.updated_at,
        (SELECT COUNT(*) FROM album_media am JOIN media_files m ON m.id = am.media_id WHERE am.album_id = a.id AND m.deleted_at IS NULL) AS media_count
       FROM albums a WHERE a.user_id = ? ORDER BY LOWER(a.name) ASC`
    )
      .bind(auth.userId)
      .all<{
        id: string;
        folder_id: string | null;
        name: string;
        cover_media_id: string | null;
        media_count: number;
        created_at: string;
        updated_at: string;
      }>();

    return jsonResponse({
      albums: res.results.map((r) => ({
        id: r.id,
        folderId: r.folder_id,
        name: r.name,
        coverMediaId: r.cover_media_id,
        mediaCount: Number(r.media_count),
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }))
    });
  }

  if (method === 'POST' && pathname === '/api/v1/albums') {
    const auth = await requireAuth(request, env);
    const body = await readJson<{ name?: string; folderId?: string | null }>(request);
    const name = (body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'INVALID_NAME', 'Tên album không được để trống');

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const folderId = body.folderId ?? null;
    if (folderId) {
      const f = await env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
        .bind(folderId, auth.userId)
        .first<{ id: string }>();
      if (!f) throw new HttpError(404, 'FOLDER_NOT_FOUND', 'Thư mục không tồn tại');
    }
    await env.DB.prepare(
      'INSERT INTO albums (id, user_id, folder_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(id, auth.userId, folderId, name, now, now)
      .run();

    return jsonResponse(
      {
        album: {
          id,
          folderId,
          name,
          coverMediaId: null,
          mediaCount: 0,
          createdAt: now,
          updatedAt: now
        }
      },
      201
    );
  }

  const albumDelMatch = pathname.match(/^\/api\/v1\/albums\/([^/]+)$/);
  if (method === 'DELETE' && albumDelMatch) {
    const auth = await requireAuth(request, env);
    const res = await env.DB.prepare('DELETE FROM albums WHERE id = ? AND user_id = ?')
      .bind(albumDelMatch[1]!, auth.userId)
      .run();
    if (!res.meta.changes) {
      throw new HttpError(404, 'ALBUM_NOT_FOUND', 'Không tìm thấy album');
    }
    return jsonResponse({ deleted: true });
  }

  const albumMediaAddMatch = pathname.match(/^\/api\/v1\/albums\/([^/]+)\/media$/);
  if (method === 'POST' && albumMediaAddMatch) {
    const auth = await requireAuth(request, env);
    const albumId = albumMediaAddMatch[1]!;
    const body = await readJson<{ mediaIds?: string[] }>(request);
    const album = await env.DB.prepare('SELECT id FROM albums WHERE id = ? AND user_id = ?')
      .bind(albumId, auth.userId)
      .first<{ id: string }>();
    if (!album) throw new HttpError(404, 'ALBUM_NOT_FOUND', 'Không tìm thấy album');

    const now = new Date().toISOString();
    let added = 0;
    for (const mid of body.mediaIds ?? []) {
      const m = await env.DB.prepare(
        'SELECT id FROM media_files WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
      )
        .bind(mid, auth.userId)
        .first<{ id: string }>();
      if (m) {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO album_media (album_id, media_id, added_at) VALUES (?, ?, ?)'
        )
          .bind(albumId, mid, now)
          .run();
        added++;
      }
    }
    return jsonResponse({ added });
  }

  const albumMediaDelMatch = pathname.match(/^\/api\/v1\/albums\/([^/]+)\/media\/([^/]+)$/);
  if (method === 'DELETE' && albumMediaDelMatch) {
    const auth = await requireAuth(request, env);
    const album = await env.DB.prepare('SELECT id FROM albums WHERE id = ? AND user_id = ?')
      .bind(albumMediaDelMatch[1]!, auth.userId)
      .first<{ id: string }>();
    if (!album) throw new HttpError(404, 'ALBUM_NOT_FOUND', 'Không tìm thấy album');
    await env.DB.prepare('DELETE FROM album_media WHERE album_id = ? AND media_id = ?')
      .bind(albumMediaDelMatch[1]!, albumMediaDelMatch[2]!)
      .run();
    return jsonResponse({ removed: true });
  }

  // ==================== TAGS ====================
  if (method === 'GET' && pathname === '/api/v1/tags') {
    const auth = await requireAuth(request, env);
    const res = await env.DB.prepare(
      `SELECT t.id, t.name, t.created_at,
        (SELECT COUNT(*) FROM media_tags mt JOIN media_files m ON m.id = mt.media_id WHERE mt.tag_id = t.id AND m.deleted_at IS NULL) AS media_count
       FROM tags t WHERE t.user_id = ? ORDER BY LOWER(t.name) ASC`
    )
      .bind(auth.userId)
      .all<{ id: string; name: string; created_at: string; media_count: number }>();

    return jsonResponse({
      tags: res.results.map((r) => ({
        id: r.id,
        name: r.name,
        mediaCount: Number(r.media_count),
        createdAt: r.created_at
      }))
    });
  }

  if (method === 'POST' && pathname === '/api/v1/tags') {
    const auth = await requireAuth(request, env);
    const body = await readJson<{ name?: string }>(request);
    const name = (body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'INVALID_NAME', 'Tên thẻ không được để trống');

    const existing = await env.DB.prepare(
      'SELECT id, name, created_at FROM tags WHERE user_id = ? AND LOWER(name) = ?'
    )
      .bind(auth.userId, name.toLowerCase())
      .first<{ id: string; name: string; created_at: string }>();
    if (existing) {
      return jsonResponse({
        tag: { id: existing.id, name: existing.name, createdAt: existing.created_at }
      });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, auth.userId, name, now)
      .run();
    return jsonResponse({ tag: { id, name, createdAt: now } }, 201);
  }

  const tagAttachMatch = pathname.match(/^\/api\/v1\/media\/([^/]+)\/tags$/);
  if (method === 'POST' && tagAttachMatch) {
    const auth = await requireAuth(request, env);
    const body = await readJson<{ tagId?: string }>(request);
    if (!body.tagId) throw new HttpError(400, 'MISSING_TAG', 'Thiếu tagId');
    const [m, t] = await Promise.all([
      env.DB.prepare('SELECT id FROM media_files WHERE id = ? AND user_id = ?')
        .bind(tagAttachMatch[1]!, auth.userId)
        .first<{ id: string }>(),
      env.DB.prepare('SELECT id FROM tags WHERE id = ? AND user_id = ?')
        .bind(body.tagId, auth.userId)
        .first<{ id: string }>()
    ]);
    if (!m || !t) throw new HttpError(404, 'NOT_FOUND', 'Không tìm thấy tệp hoặc thẻ');
    await env.DB.prepare('INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?, ?)')
      .bind(m.id, t.id)
      .run();
    return jsonResponse({ attached: true });
  }

  const tagDetachMatch = pathname.match(/^\/api\/v1\/media\/([^/]+)\/tags\/([^/]+)$/);
  if (method === 'DELETE' && tagDetachMatch) {
    const auth = await requireAuth(request, env);
    const m = await env.DB.prepare('SELECT id FROM media_files WHERE id = ? AND user_id = ?')
      .bind(tagDetachMatch[1]!, auth.userId)
      .first<{ id: string }>();
    if (!m) throw new HttpError(404, 'NOT_FOUND', 'Không tìm thấy tệp');
    await env.DB.prepare('DELETE FROM media_tags WHERE media_id = ? AND tag_id = ?')
      .bind(tagDetachMatch[1]!, tagDetachMatch[2]!)
      .run();
    return jsonResponse({ detached: true });
  }

  return null;
}
