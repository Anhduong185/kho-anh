import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { PGlite } from '@electric-sql/pglite';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface DbQueryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface DbClient extends DbQueryable {
  readonly driver: 'pg' | 'pglite';
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DbQueryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PgPoolAdapter implements DbClient {
  readonly driver = 'pg' as const;
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params);
    return {
      rows: res.rows as T[],
      rowCount: res.rowCount ?? res.rows.length
    };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: DbQueryable) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx: DbQueryable = {
        async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
          const res = await client.query(sql, params);
          return {
            rows: res.rows as R[],
            rowCount: res.rowCount ?? res.rows.length
          };
        }
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PgliteAdapter implements DbClient {
  readonly driver = 'pglite' as const;
  private readonly db: PGlite;

  private constructor(db: PGlite) {
    this.db = db;
  }

  static async open(dataDir: string): Promise<PgliteAdapter> {
    if (dataDir === 'memory' || dataDir === ':memory:') {
      const db = new PGlite();
      await db.waitReady;
      return new PgliteAdapter(db);
    }

    const resolvedDir = path.resolve(dataDir);
    await fs.mkdir(resolvedDir, { recursive: true });
    const db = new PGlite(resolvedDir);
    await db.waitReady;
    return new PgliteAdapter(db);
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.db.query<T>(sql, params);
    return {
      rows: res.rows,
      rowCount: res.rows.length > 0 ? res.rows.length : (res.affectedRows ?? 0)
    };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: DbQueryable) => Promise<T>): Promise<T> {
    return this.db.transaction(async (pgTx) => {
      const tx: DbQueryable = {
        async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
          const res = await pgTx.query<R>(sql, params);
          return {
            rows: res.rows,
            rowCount: res.rows.length > 0 ? res.rows.length : (res.affectedRows ?? 0)
          };
        }
      };
      return fn(tx);
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export async function createDbClient(databaseUrl: string): Promise<DbClient> {
  if (databaseUrl.startsWith('pglite://')) {
    const target = databaseUrl.slice('pglite://'.length) || 'memory';
    return PgliteAdapter.open(target);
  }
  if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
    const client = new PgPoolAdapter(databaseUrl);
    await client.query('SELECT 1');
    return client;
  }
  throw new Error(
    `Unsupported DATABASE_URL protocol. Use "postgresql://..." (Neon/Docker) or "pglite://./data/pgdata" (local dev).`
  );
}
