import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { loadConfig, type AppConfig } from './config/env.js';
import { createDbClient, type DbClient } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { registerAdminRoutes } from './modules/admin/routes.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerBackupRoutes } from './modules/backup/routes.js';
import { registerIntegrityRoutes } from './modules/integrity/routes.js';
import { registerMediaRoutes } from './modules/media/routes.js';
import { registerNotificationRoutes } from './modules/notifications/routes.js';
import { registerOrganizationRoutes } from './modules/organization/routes.js';
import { registerRestoreRoutes } from './modules/restore/routes.js';
import { registerStorageAdminRoutes } from './modules/storage-admin/routes.js';
import { registerUserRoutes } from './modules/users/routes.js';
import { StorageRegistry } from './storage/registry.js';
import { AppError } from './utils/errors.js';

export interface BuildAppOptions {
  config?: AppConfig;
  db?: DbClient;
  enableLogger?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  db: DbClient;
  config: AppConfig;
  storageRegistry: StorageRegistry;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = options.config ?? loadConfig();
  const db = options.db ?? (await createDbClient(config.DATABASE_URL));
  await runMigrations(db);

  const storageRegistry = new StorageRegistry(config);
  await storageRegistry.loadFromDatabase(db);

  const app = Fastify({
    logger: options.enableLogger ?? config.NODE_ENV !== 'test',
    bodyLimit: 20 * 1024 * 1024 // 20 MiB per binary upload chunk
  });

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  });

  const allowedOrigins = config.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Support Chrome / Android WebView Private Network Access (PNA) preflight BEFORE @fastify/cors replies 204
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers['access-control-request-private-network'] === 'true') {
      reply.header('Access-Control-Allow-Private-Network', 'true');
    }
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Part-SHA256', 'Range'],
    exposedHeaders: [
      'X-Content-SHA256',
      'X-Original-Size',
      'X-Export-File-Count',
      'Content-Disposition',
      'Content-Range',
      'ETag'
    ],
    credentials: true
  });

  if (config.NODE_ENV !== 'test') {
    await app.register(rateLimit, {
      max: 120,
      timeWindow: '1 minute'
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {})
        }
      });
    }

    const fastifyErr = error as { statusCode?: number; code?: string; message?: string };
    if (fastifyErr.code === '23505') {
      return reply.code(409).send({
        error: {
          code: 'CONFLICT',
          message: 'A conflicting record already exists'
        }
      });
    }
    if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      return reply.code(fastifyErr.statusCode).send({
        error: {
          code: fastifyErr.code ?? 'REQUEST_ERROR',
          message: fastifyErr.message ?? 'Request error'
        }
      });
    }

    app.log.error(error);
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error'
      }
    });
  });

  app.get('/health', async () => {
    await db.query('SELECT 1');
    return {
      status: 'ok',
      service: 'secure-media-backup-api',
      dbDriver: db.driver,
      timestamp: new Date().toISOString()
    };
  });

  registerAuthRoutes(app, db, config);
  registerUserRoutes(app, db, config);
  registerBackupRoutes(app, db, config, storageRegistry);
  registerMediaRoutes(app, db, config, storageRegistry);
  registerOrganizationRoutes(app, db, config);
  registerRestoreRoutes(app, db, config, storageRegistry);
  registerNotificationRoutes(app, db, config);
  registerAdminRoutes(app, db, config, storageRegistry);
  registerStorageAdminRoutes(app, db, config, storageRegistry);
  registerIntegrityRoutes(app, db, config, storageRegistry);

  app.addHook('onClose', async () => {
    if (!options.db) {
      await db.close();
    }
  });

  return { app, db, config, storageRegistry };
}
