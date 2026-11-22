import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VaultApiClient } from './api-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Could not determine ephemeral port')));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl: string, proc: ChildProcess, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Isolated backend exited prematurely with code ${proc.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for isolated backend at ${baseUrl}/health`);
}

export interface IsolatedStack {
  port: number;
  baseUrl: string;
  storageRoot: string;
  client: VaultApiClient;
  close: () => Promise<void>;
}

/**
 * Spawns a clean-slate backend instance on an ephemeral free port with
 * pglite://memory and an isolated temp STORAGE_LOCAL_ROOT.
 * Does NOT override DEFAULT_USER_QUOTA_BYTES so real defaults (>10 GiB) are tested.
 */
export async function startIsolatedStack(): Promise<IsolatedStack> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smb-e2e-iso-'));
  const backendDir = path.resolve(__dirname, '../../backend');

  const logs: string[] = [];
  const child = spawn(process.execPath, ['../node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
    cwd: backendDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: 'pglite://memory',
      STORAGE_LOCAL_ROOT: storageRoot,
      CORS_ORIGINS: 'http://127.0.0.1:5179,http://localhost:5179',
      JWT_ACCESS_SECRET: 'e2e-isolated-access-secret-at-least-32-chars',
      JWT_REFRESH_SECRET: 'e2e-isolated-refresh-secret-at-least-32-chars',
      STORAGE_CONFIG_KEY: 'e2e-isolated-storage-key-at-least-32-chars'
    }
  });

  child.stdout?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));
  child.stderr?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));

  try {
    await waitForHealth(baseUrl, child, 30_000);
  } catch (err) {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    fs.rmSync(storageRoot, { recursive: true, force: true });
    throw new Error(`${(err as Error).message}\nLogs:\n${logs.join('')}`);
  }

  const close = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.pid) {
            if (process.platform === 'win32') {
              spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            } else {
              child.kill('SIGKILL');
            }
          }
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    try {
      fs.rmSync(storageRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return {
    port,
    baseUrl,
    storageRoot,
    client: new VaultApiClient(baseUrl),
    close
  };
}
