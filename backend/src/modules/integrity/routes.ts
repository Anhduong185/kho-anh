import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import type { DbClient } from '../../db/client.js';
import { createAuthMiddleware, requireRole } from '../../middleware/auth.js';
import type { StorageRegistry } from '../../storage/registry.js';
import { runIntegrityScanAndHeal, runReplicationCycle } from './service.js';

export function registerIntegrityRoutes(
  app: FastifyInstance,
  db: DbClient,
  config: AppConfig,
  storageRegistry: StorageRegistry
) {
  const authenticate = createAuthMiddleware(db, config);
  const adminGuards = [authenticate, requireRole('admin')];

  app.post('/api/v1/admin/replication/run', { preHandler: adminGuards }, async () => {
    const result = await runReplicationCycle(db, storageRegistry);
    return { result };
  });

  app.post('/api/v1/admin/integrity/scan', { preHandler: adminGuards }, async () => {
    const result = await runIntegrityScanAndHeal(db, storageRegistry);
    return { result };
  });

  // Aggregate replica state overview (strictly infrastructure counts — ZERO personal media exposure)
  app.get('/api/v1/admin/integrity/summary', { preHandler: adminGuards }, async () => {
    const res = await db.query<{
      replica_slot: string;
      state: string;
      count: string;
    }>(`
      SELECT replica_slot, state, COUNT(*)::text AS count
      FROM replica_status
      GROUP BY replica_slot, state
      ORDER BY replica_slot ASC, state ASC
    `);

    return {
      replicaBreakdown: res.rows.map((r) => ({
        slot: r.replica_slot,
        state: r.state,
        count: Number(r.count)
      }))
    };
  });
}
