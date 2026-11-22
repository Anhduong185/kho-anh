import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbClient } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(db: DbClient): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const appliedRes = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  const appliedSet = new Set(appliedRes.rows.map((row) => row.version));

  const migrationsDir = path.join(__dirname, 'migrations');
  const entries = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const newlyApplied: string[] = [];

  for (const file of entries) {
    if (appliedSet.has(file)) {
      continue;
    }
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await db.exec(sql);
    await db.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [
      file
    ]);
    newlyApplied.push(file);
  }

  return newlyApplied;
}
