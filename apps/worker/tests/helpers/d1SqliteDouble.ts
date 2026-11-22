import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1PreparedStatement } from '../../src/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

type SqliteParam = null | number | bigint | string | Uint8Array;

function normalizeParams(values: unknown[]): SqliteParam[] {
  return values.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
    if (v instanceof Uint8Array) return v;
    return JSON.stringify(v);
  });
}

class SqliteD1PreparedStatement implements D1PreparedStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private params: SqliteParam[] = [];

  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    this.params = normalizeParams(values);
    return this;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) {
      return (row[colName] ?? null) as T | null;
    }
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{
    results: T[];
    success: boolean;
    meta: Record<string, unknown>;
  }> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.params) as T[];
    return { results: rows, success: true, meta: { changes: 0 } };
  }

  async run(): Promise<{ success: boolean; meta: { changes?: number; last_row_id?: number } }> {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.params);
    return {
      success: true,
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid)
      }
    };
  }
}

export class SqliteD1Database implements D1Database {
  readonly sqlite: DatabaseSync;

  constructor(sqlite?: DatabaseSync) {
    this.sqlite = sqlite ?? new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.sqlite, query);
  }

  async batch<T = unknown>(
    statements: D1PreparedStatement[]
  ): Promise<Array<{ results: T[]; success: boolean }>> {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const out: Array<{ results: T[]; success: boolean }> = [];
      for (const s of statements) {
        const res = await s.all<T>();
        out.push({ results: res.results, success: true });
      }
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.sqlite.exec('ROLLBACK');
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }
}

export function applyWorkerMigrations(db: SqliteD1Database, upToFilename?: string): string[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.sqlite.exec(sql);
    applied.push(file);
    if (upToFilename && file === upToFilename) break;
  }
  return applied;
}

export function applyMigrationFile(db: SqliteD1Database, filename: string): void {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
  db.sqlite.exec(sql);
}
