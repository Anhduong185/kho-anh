import type { ExecutionContext, WorkerEnv } from '../../src/env.js';
import worker from '../../src/index.js';
import { applyWorkerMigrations, SqliteD1Database } from './d1SqliteDouble.js';
import { R2MemoryDouble } from './r2MemoryDouble.js';

export interface WorkerHarness {
  db: SqliteD1Database;
  r2: R2MemoryDouble;
  env: WorkerEnv;
  request(path: string, init?: RequestInit & { token?: string }): Promise<Response>;
  json<T = Record<string, unknown>>(
    path: string,
    init?: RequestInit & { token?: string; bodyJson?: unknown }
  ): Promise<{ status: number; data: T; response: Response }>;
  flushWaitUntil(): Promise<void>;
}

export function createWorkerTestHarness(
  envOverrides: Partial<WorkerEnv> = {},
  options?: { skipMigrations?: boolean }
): WorkerHarness {
  const db = new SqliteD1Database();
  if (!options?.skipMigrations) {
    applyWorkerMigrations(db);
  }
  const r2 = new R2MemoryDouble();
  const pendingPromises: Promise<unknown>[] = [];

  const env: WorkerEnv = {
    DB: db,
    VAULT_BUCKET: r2,
    JWT_ACCESS_SECRET: 'worker-test-access-secret-must-be-32-chars!',
    JWT_REFRESH_SECRET: 'worker-test-refresh-secret-must-be-32-chars!',
    STORAGE_CONFIG_KEY: 'worker-test-storage-config-key-32-chars!!',
    CORS_ORIGINS: 'http://localhost:5173',
    ...envOverrides
  };

  const ctx: ExecutionContext = {
    waitUntil(promise: Promise<unknown>) {
      pendingPromises.push(promise);
    },
    passThroughOnException() {
      // no-op
    }
  };

  async function request(
    path: string,
    init: RequestInit & { token?: string } = {}
  ): Promise<Response> {
    const { token, headers: rawHeaders, ...rest } = init;
    const headers = new Headers(rawHeaders);
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    const req = new Request(`http://localhost${path}`, { ...rest, headers });
    return worker.fetch(req, env, ctx);
  }

  async function json<T = Record<string, unknown>>(
    path: string,
    init: RequestInit & { token?: string; bodyJson?: unknown } = {}
  ): Promise<{ status: number; data: T; response: Response }> {
    const { bodyJson, headers: rawHeaders, ...rest } = init;
    const headers = new Headers(rawHeaders);
    let body = rest.body;
    if (bodyJson !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(bodyJson);
    }
    const response = await request(path, { ...rest, headers, body });
    const text = await response.text();
    const data = (text ? JSON.parse(text) : null) as T;
    return { status: response.status, data, response };
  }

  async function flushWaitUntil(): Promise<void> {
    await Promise.allSettled(pendingPromises.splice(0, pendingPromises.length));
  }

  return { db, r2, env, request, json, flushWaitUntil };
}
