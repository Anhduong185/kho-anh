import type { ExecutionContext, WorkerEnv } from './env.js';
import { handleAdminAndNotificationRoutes } from './routes/admin.js';
import { handleAuthRoutes } from './routes/auth.js';
import { handleBackupRoutes } from './routes/backup.js';
import { handleMediaRoutes } from './routes/media.js';
import { handleOrganizationRoutes } from './routes/organization.js';
import { handleRestoreRoutes } from './routes/restore.js';
import { applyCorsHeaders, errorResponse, HttpError, jsonResponse } from './utils/http.js';

async function routeApi(request: Request, url: URL, env: WorkerEnv): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    return jsonResponse({
      status: 'ok',
      service: 'kho-anh-cloudflare-worker',
      dbDriver: 'd1',
      storage: env.VAULT_BUCKET ? 'r2' : 'r2_pending',
      timestamp: new Date().toISOString()
    });
  }

  const handlers = [
    handleAuthRoutes,
    handleBackupRoutes,
    handleMediaRoutes,
    handleOrganizationRoutes,
    handleRestoreRoutes,
    handleAdminAndNotificationRoutes
  ];

  for (const handler of handlers) {
    const res = await handler(request, url, env);
    if (res) return res;
  }

  throw new HttpError(404, 'NOT_FOUND', `Route not found: ${request.method} ${url.pathname}`);
}

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Worker handles /health and /api/*; all static PWA assets are served from Cloudflare Edge ASSETS
    if (url.pathname === '/health' || url.pathname.startsWith('/api/')) {
      try {
        const response = await routeApi(request, url, env);
        return applyCorsHeaders(request, response, env);
      } catch (err) {
        return applyCorsHeaders(request, errorResponse(err), env);
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Kho Ảnh Worker is running. Static assets binding not attached.', {
      status: 200
    });
  }
};
