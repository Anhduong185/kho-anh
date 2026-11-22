import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AlbumItem, FolderItem, TagItem } from '@smb/shared';
import type { AppConfig } from '../../config/env.js';
import type { DbClient } from '../../db/client.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import { Errors } from '../../utils/errors.js';

const UuidParamSchema = z.object({ id: z.string().uuid() });

const CreateFolderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().uuid().nullable().optional()
});

const PatchFolderSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  parentId: z.string().uuid().nullable().optional()
});

const CreateAlbumSchema = z.object({
  name: z.string().trim().min(1).max(120),
  folderId: z.string().uuid().nullable().optional(),
  coverMediaId: z.string().uuid().nullable().optional()
});

const PatchAlbumSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  folderId: z.string().uuid().nullable().optional(),
  coverMediaId: z.string().uuid().nullable().optional()
});

const AlbumMediaBodySchema = z.object({
  mediaIds: z.array(z.string().uuid()).min(1).max(200)
});

const CreateTagSchema = z.object({
  name: z.string().trim().min(1).max(64)
});

const MediaTagBodySchema = z.object({
  tagId: z.string().uuid()
});

export function registerOrganizationRoutes(app: FastifyInstance, db: DbClient, config: AppConfig) {
  const authenticate = createAuthMiddleware(db, config);

  // ==================== FOLDERS (Multi-level) ====================

  app.get('/api/v1/folders', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const res = await db.query<{
      id: string;
      parent_id: string | null;
      name: string;
      media_count: string;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `
      SELECT
        f.id, f.parent_id, f.name, f.created_at, f.updated_at,
        (SELECT COUNT(*)::text FROM media_files m WHERE m.folder_id = f.id AND m.user_id = f.user_id AND m.deleted_at IS NULL) AS media_count
      FROM folders f
      WHERE f.user_id = $1
      ORDER BY LOWER(f.name) ASC
      `,
      [auth.userId]
    );

    const folders: FolderItem[] = res.rows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      name: r.name,
      mediaCount: Number(r.media_count),
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString()
    }));

    return { folders };
  });

  app.post('/api/v1/folders', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const parsed = CreateFolderSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.badRequest('Invalid folder payload', parsed.error.flatten());
    }

    const { name, parentId = null } = parsed.data;
    if (parentId) {
      const parent = await db.query<{ id: string }>(
        'SELECT id FROM folders WHERE id = $1 AND user_id = $2',
        [parentId, auth.userId]
      );
      if (parent.rowCount === 0) {
        throw Errors.notFound('Parent folder not found');
      }
    }

    const res = await db.query<{
      id: string;
      parent_id: string | null;
      name: string;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `
      INSERT INTO folders (user_id, parent_id, name)
      VALUES ($1, $2, $3)
      RETURNING id, parent_id, name, created_at, updated_at
      `,
      [auth.userId, parentId, name]
    );
    const row = res.rows[0]!;
    const folder: FolderItem = {
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      mediaCount: 0,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
    return reply.code(201).send({ folder });
  });

  app.patch('/api/v1/folders/:id', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = UuidParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid folder id');

    const body = PatchFolderSchema.safeParse(request.body);
    if (!body.success) throw Errors.badRequest('Invalid folder update', body.error.flatten());

    const folderId = params.data.id;
    const existing = await db.query<{ id: string; parent_id: string | null; name: string }>(
      'SELECT id, parent_id, name FROM folders WHERE id = $1 AND user_id = $2',
      [folderId, auth.userId]
    );
    if (existing.rowCount === 0) throw Errors.notFound('Folder not found');

    let nextParentId = existing.rows[0]!.parent_id;
    if (body.data.parentId !== undefined) {
      if (body.data.parentId === folderId) {
        throw Errors.badRequest('Folder cannot be its own parent');
      }
      if (body.data.parentId !== null) {
        // Verify parent belongs to user and prevent parent-child cycles
        const allFolders = await db.query<{ id: string; parent_id: string | null }>(
          'SELECT id, parent_id FROM folders WHERE user_id = $1',
          [auth.userId]
        );
        const parentMap = new Map(allFolders.rows.map((f) => [f.id, f.parent_id]));
        if (!parentMap.has(body.data.parentId)) {
          throw Errors.notFound('Target parent folder not found');
        }
        let cursor: string | null | undefined = body.data.parentId;
        while (cursor) {
          if (cursor === folderId) {
            throw Errors.badRequest('Cannot move a folder inside one of its descendants');
          }
          cursor = parentMap.get(cursor) ?? null;
        }
      }
      nextParentId = body.data.parentId;
    }

    const nextName = body.data.name ?? existing.rows[0]!.name;
    await db.query(
      'UPDATE folders SET name = $3, parent_id = $4, updated_at = NOW() WHERE id = $1 AND user_id = $2',
      [folderId, auth.userId, nextName, nextParentId]
    );

    return { updated: true, id: folderId, name: nextName, parentId: nextParentId };
  });

  app.delete('/api/v1/folders/:id', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = UuidParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid folder id');

    // Deleting a folder NEVER deletes original media files (ON DELETE SET NULL on media_files.folder_id)
    const res = await db.query('DELETE FROM folders WHERE id = $1 AND user_id = $2 RETURNING id', [
      params.data.id,
      auth.userId
    ]);
    if (res.rowCount === 0) throw Errors.notFound('Folder not found');
    return { deleted: true, id: params.data.id };
  });

  // ==================== ALBUMS ====================

  app.get('/api/v1/albums', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const res = await db.query<{
      id: string;
      folder_id: string | null;
      name: string;
      cover_media_id: string | null;
      fallback_cover_id: string | null;
      media_count: string;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `
      SELECT
        a.id, a.folder_id, a.name, a.cover_media_id, a.created_at, a.updated_at,
        (
          SELECT COUNT(*)::text
          FROM album_media am
          JOIN media_files m ON m.id = am.media_id
          WHERE am.album_id = a.id AND m.user_id = a.user_id AND m.deleted_at IS NULL
        ) AS media_count,
        (
          SELECT am.media_id
          FROM album_media am
          JOIN media_files m ON m.id = am.media_id
          WHERE am.album_id = a.id AND m.user_id = a.user_id AND m.deleted_at IS NULL
          ORDER BY am.added_at DESC
          LIMIT 1
        ) AS fallback_cover_id
      FROM albums a
      WHERE a.user_id = $1
      ORDER BY LOWER(a.name) ASC
      `,
      [auth.userId]
    );

    const albums: AlbumItem[] = res.rows.map((r) => ({
      id: r.id,
      folderId: r.folder_id,
      name: r.name,
      coverMediaId: r.cover_media_id ?? r.fallback_cover_id,
      mediaCount: Number(r.media_count),
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString()
    }));

    return { albums };
  });

  app.post('/api/v1/albums', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const parsed = CreateAlbumSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.badRequest('Invalid album payload', parsed.error.flatten());

    const { name, folderId = null, coverMediaId = null } = parsed.data;
    if (folderId) {
      const f = await db.query('SELECT id FROM folders WHERE id = $1 AND user_id = $2', [
        folderId,
        auth.userId
      ]);
      if (f.rowCount === 0) throw Errors.notFound('Folder not found');
    }
    if (coverMediaId) {
      const m = await db.query(
        'SELECT id FROM media_files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
        [coverMediaId, auth.userId]
      );
      if (m.rowCount === 0) throw Errors.notFound('Cover media not found');
    }

    const res = await db.query<{
      id: string;
      folder_id: string | null;
      name: string;
      cover_media_id: string | null;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `
      INSERT INTO albums (user_id, folder_id, name, cover_media_id)
      VALUES ($1, $2, $3, $4)
      RETURNING id, folder_id, name, cover_media_id, created_at, updated_at
      `,
      [auth.userId, folderId, name, coverMediaId]
    );
    const row = res.rows[0]!;
    return reply.code(201).send({
      album: {
        id: row.id,
        folderId: row.folder_id,
        name: row.name,
        coverMediaId: row.cover_media_id,
        mediaCount: 0,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
      } satisfies AlbumItem
    });
  });

  app.patch('/api/v1/albums/:id', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = UuidParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid album id');
    const body = PatchAlbumSchema.safeParse(request.body);
    if (!body.success) throw Errors.badRequest('Invalid album update', body.error.flatten());

    const existing = await db.query<{
      id: string;
      name: string;
      folder_id: string | null;
      cover_media_id: string | null;
    }>('SELECT id, name, folder_id, cover_media_id FROM albums WHERE id = $1 AND user_id = $2', [
      params.data.id,
      auth.userId
    ]);
    if (existing.rowCount === 0) throw Errors.notFound('Album not found');

    const cur = existing.rows[0]!;
    const nextName = body.data.name ?? cur.name;
    const nextFolderId = body.data.folderId !== undefined ? body.data.folderId : cur.folder_id;
    const nextCover = body.data.coverMediaId !== undefined ? body.data.coverMediaId : cur.cover_media_id;

    if (nextFolderId) {
      const f = await db.query('SELECT id FROM folders WHERE id = $1 AND user_id = $2', [
        nextFolderId,
        auth.userId
      ]);
      if (f.rowCount === 0) throw Errors.notFound('Target folder not found');
    }
    if (body.data.coverMediaId) {
      const m = await db.query(
        'SELECT id FROM media_files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
        [body.data.coverMediaId, auth.userId]
      );
      if (m.rowCount === 0) throw Errors.notFound('Cover media not found');
    }

    await db.query(
      'UPDATE albums SET name = $3, folder_id = $4, cover_media_id = $5, updated_at = NOW() WHERE id = $1 AND user_id = $2',
      [params.data.id, auth.userId, nextName, nextFolderId, nextCover]
    );
    return { updated: true, id: params.data.id };
  });

  app.delete('/api/v1/albums/:id', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = UuidParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid album id');

    // Deleting an album NEVER deletes original media files
    const res = await db.query('DELETE FROM albums WHERE id = $1 AND user_id = $2 RETURNING id', [
      params.data.id,
      auth.userId
    ]);
    if (res.rowCount === 0) throw Errors.notFound('Album not found');
    return { deleted: true, id: params.data.id };
  });

  app.post('/api/v1/albums/:id/media', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = UuidParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid album id');
    const body = AlbumMediaBodySchema.safeParse(request.body);
    if (!body.success) throw Errors.badRequest('Invalid mediaIds payload', body.error.flatten());

    const albumRes = await db.query('SELECT id FROM albums WHERE id = $1 AND user_id = $2', [
      params.data.id,
      auth.userId
    ]);
    if (albumRes.rowCount === 0) throw Errors.notFound('Album not found');

    // Only attach media owned by current user
    const ownedRes = await db.query<{ id: string }>(
      'SELECT id FROM media_files WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL',
      [auth.userId, body.data.mediaIds]
    );

    let added = 0;
    for (const row of ownedRes.rows) {
      const ins = await db.query(
        'INSERT INTO album_media (album_id, media_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [params.data.id, row.id]
      );
      if (ins.rowCount > 0) added++;
    }

    return { added, albumId: params.data.id };
  });

  app.delete('/api/v1/albums/:id/media/:mediaId', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = z
      .object({ id: z.string().uuid(), mediaId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid parameters');

    const albumRes = await db.query('SELECT id FROM albums WHERE id = $1 AND user_id = $2', [
      params.data.id,
      auth.userId
    ]);
    if (albumRes.rowCount === 0) throw Errors.notFound('Album not found');

    await db.query('DELETE FROM album_media WHERE album_id = $1 AND media_id = $2', [
      params.data.id,
      params.data.mediaId
    ]);
    return { removed: true };
  });

  // ==================== TAGS ====================

  app.get('/api/v1/tags', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const res = await db.query<{
      id: string;
      name: string;
      media_count: string;
      created_at: string | Date;
    }>(
      `
      SELECT
        t.id, t.name, t.created_at,
        (
          SELECT COUNT(*)::text
          FROM media_tags mt
          JOIN media_files m ON m.id = mt.media_id
          WHERE mt.tag_id = t.id AND m.user_id = t.user_id AND m.deleted_at IS NULL
        ) AS media_count
      FROM tags t
      WHERE t.user_id = $1
      ORDER BY LOWER(t.name) ASC
      `,
      [auth.userId]
    );

    const tags: TagItem[] = res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      mediaCount: Number(r.media_count),
      createdAt: new Date(r.created_at).toISOString()
    }));
    return { tags };
  });

  app.post('/api/v1/tags', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const parsed = CreateTagSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.badRequest('Invalid tag payload', parsed.error.flatten());

    const existing = await db.query<{ id: string; name: string; created_at: string | Date }>(
      'SELECT id, name, created_at FROM tags WHERE user_id = $1 AND LOWER(name) = LOWER($2)',
      [auth.userId, parsed.data.name]
    );
    if (existing.rowCount > 0) {
      const r = existing.rows[0]!;
      return reply.code(200).send({
        tag: { id: r.id, name: r.name, mediaCount: 0, createdAt: new Date(r.created_at).toISOString() }
      });
    }

    const res = await db.query<{ id: string; name: string; created_at: string | Date }>(
      'INSERT INTO tags (user_id, name) VALUES ($1, $2) RETURNING id, name, created_at',
      [auth.userId, parsed.data.name]
    );
    const r = res.rows[0]!;
    return reply.code(201).send({
      tag: { id: r.id, name: r.name, mediaCount: 0, createdAt: new Date(r.created_at).toISOString() }
    });
  });

  app.delete('/api/v1/tags/:id', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = UuidParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid tag id');

    const res = await db.query('DELETE FROM tags WHERE id = $1 AND user_id = $2 RETURNING id', [
      params.data.id,
      auth.userId
    ]);
    if (res.rowCount === 0) throw Errors.notFound('Tag not found');
    return { deleted: true };
  });

  app.post('/api/v1/media/:id/tags', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = UuidParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid mediaId');
    const body = MediaTagBodySchema.safeParse(request.body);
    if (!body.success) throw Errors.badRequest('Invalid tagId', body.error.flatten());

    const [mediaRes, tagRes] = await Promise.all([
      db.query('SELECT id FROM media_files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [
        params.data.id,
        auth.userId
      ]),
      db.query('SELECT id FROM tags WHERE id = $1 AND user_id = $2', [body.data.tagId, auth.userId])
    ]);
    if (mediaRes.rowCount === 0) throw Errors.notFound('Media file not found');
    if (tagRes.rowCount === 0) throw Errors.notFound('Tag not found');

    await db.query('INSERT INTO media_tags (media_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      params.data.id,
      body.data.tagId
    ]);
    return { attached: true };
  });

  app.delete('/api/v1/media/:id/tags/:tagId', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = z
      .object({ id: z.string().uuid(), tagId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid parameters');

    const mediaRes = await db.query('SELECT id FROM media_files WHERE id = $1 AND user_id = $2', [
      params.data.id,
      auth.userId
    ]);
    if (mediaRes.rowCount === 0) throw Errors.notFound('Media file not found');

    await db.query('DELETE FROM media_tags WHERE media_id = $1 AND tag_id = $2', [
      params.data.id,
      params.data.tagId
    ]);
    return { detached: true };
  });
}
