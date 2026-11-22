import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function globalTeardown(): Promise<void> {
  const apiPort = process.env.E2E_API_PORT ?? '3101';
  const stateDir = path.join(__dirname, '.state');
  const storageRoot =
    process.env.E2E_STORAGE_ROOT ?? path.join(os.tmpdir(), `smb-e2e-storage-${apiPort}`);

  try {
    fs.rmSync(stateDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }

  try {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  } catch {
    // ignore Windows file lock if server is still draining
  }
}
