import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NotificationCategory, NotificationItem } from '@smb/shared';
import type { AppConfig } from '../../config/env.js';
import type { DbClient } from '../../db/client.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import { Errors } from '../../utils/errors.js';

export function registerNotificationRoutes(app: FastifyInstance, db: DbClient, config: AppConfig) {
  const authenticate = createAuthMiddleware(db, config);

  app.get('/api/v1/notifications', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const res = await db.query<{
      id: string;
      category: NotificationCategory;
      title: string;
      body: string;
      is_read: boolean;
      created_at: string | Date;
    }>(
      `
      SELECT id, category, title, body, is_read, created_at
      FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 100
      `,
      [auth.userId]
    );

    const notifications: NotificationItem[] = res.rows.map((r) => ({
      id: r.id,
      category: r.category,
      title: r.title,
      body: r.body,
      isRead: r.is_read,
      createdAt: new Date(r.created_at).toISOString()
    }));

    return {
      notifications,
      unreadCount: notifications.filter((n) => !n.isRead).length
    };
  });

  app.patch('/api/v1/notifications/:id/read', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid notification id');

    const res = await db.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2 RETURNING id',
      [params.data.id, auth.userId]
    );
    if (res.rowCount === 0) throw Errors.notFound('Notification not found');
    return { read: true };
  });

  app.post('/api/v1/notifications/read-all', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    await db.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE', [
      auth.userId
    ]);
    return { readAll: true };
  });
}
