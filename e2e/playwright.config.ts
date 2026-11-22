import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_PORT = Number(process.env.E2E_API_PORT ?? '3101');
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? '5179');
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`;

const E2E_STORAGE_ROOT = path.join(os.tmpdir(), `smb-e2e-storage-${API_PORT}`);
fs.mkdirSync(E2E_STORAGE_ROOT, { recursive: true });

process.env.E2E_API_BASE_URL = API_BASE;
process.env.E2E_WEB_BASE_URL = WEB_BASE;
process.env.E2E_STORAGE_ROOT = E2E_STORAGE_ROOT;

export function detectBrowserChannel(): 'chrome' | 'msedge' {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const exe of candidates) {
    if (fs.existsSync(exe)) {
      return 'chrome';
    }
  }
  return 'msedge';
}

const backendDir = path.resolve(__dirname, '../backend');
const webDir = path.resolve(__dirname, '../apps/web');

function cleanEnv(overrides: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return { ...out, ...overrides };
}

export default defineConfig({
  testDir: path.join(__dirname, 'tests'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: {
    timeout: 10_000
  },
  reporter: [['list']],
  globalSetup: path.join(__dirname, 'globalSetup.ts'),
  globalTeardown: path.join(__dirname, 'globalTeardown.ts'),
  use: {
    baseURL: WEB_BASE,
    channel: detectBrowserChannel(),
    headless: true,
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: [
    {
      command: `"${process.execPath}" ../node_modules/tsx/dist/cli.mjs src/server.ts`,
      cwd: backendDir,
      url: `${API_BASE}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: cleanEnv({
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(API_PORT),
        DATABASE_URL: 'pglite://memory',
        STORAGE_LOCAL_ROOT: E2E_STORAGE_ROOT,
        CORS_ORIGINS: `${WEB_BASE},http://localhost:${WEB_PORT}`,
        JWT_ACCESS_SECRET: 'e2e-access-secret-must-be-at-least-32-chars-long',
        JWT_REFRESH_SECRET: 'e2e-refresh-secret-must-be-at-least-32-chars-long',
        STORAGE_CONFIG_KEY: 'e2e-storage-config-key-at-least-32-chars-long'
        // IMPORTANT: Do NOT set DEFAULT_USER_QUOTA_BYTES so the real application default (>10 GiB) is tested!
      })
    },
    {
      command: `"${process.execPath}" ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      cwd: webDir,
      url: WEB_BASE,
      reuseExistingServer: false,
      timeout: 60_000,
      env: cleanEnv({
        VITE_API_BASE_URL: API_BASE
      })
    }
  ]
});
