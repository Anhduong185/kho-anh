import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface BootstrapAdminState {
  adminEmail: string;
  adminPassword: string;
  adminDisplayName: string;
  adminUserId: string;
  adminAccessToken: string;
  adminRefreshToken: string;
  recoveryCodes: string[];
  apiBaseUrl: string;
  webBaseUrl: string;
  storageRoot: string;
}

export default async function globalSetup(): Promise<void> {
  const apiPort = process.env.E2E_API_PORT ?? '3101';
  const webPort = process.env.E2E_WEB_PORT ?? '5179';
  const apiBaseUrl = process.env.E2E_API_BASE_URL ?? `http://127.0.0.1:${apiPort}`;
  const webBaseUrl = process.env.E2E_WEB_BASE_URL ?? `http://127.0.0.1:${webPort}`;
  const storageRoot =
    process.env.E2E_STORAGE_ROOT ?? path.join(os.tmpdir(), `smb-e2e-storage-${apiPort}`);

  const adminEmail = 'admin-e2e@vault.local';
  const adminPassword = 'AdminE2ePassword!2026';
  const adminDisplayName = 'E2E Bootstrap Admin';

  // Wait briefly for health just in case
  const healthRes = await fetch(`${apiBaseUrl}/health`);
  if (!healthRes.ok) {
    throw new Error(`E2E globalSetup health check failed: HTTP ${healthRes.status}`);
  }

  // Register bootstrap admin (first user on clean pglite://memory receives ['admin', 'user'])
  const regRes = await fetch(`${apiBaseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: adminEmail,
      password: adminPassword,
      displayName: adminDisplayName,
      encryptionMode: 'server_side',
      deviceName: 'E2E GlobalSetup Runner',
      platform: 'web'
    })
  });

  if (!regRes.ok) {
    const text = await regRes.text();
    throw new Error(`E2E globalSetup failed to seed bootstrap admin (${regRes.status}): ${text}`);
  }

  const data = (await regRes.json()) as {
    user: { id: string; roles: string[] };
    tokens: { accessToken: string; refreshToken: string };
    recoveryCodes: string[];
  };

  if (!data.user.roles.includes('admin')) {
    throw new Error(`Expected bootstrap user to have admin role, got: ${JSON.stringify(data.user.roles)}`);
  }

  const stateDir = path.join(__dirname, '.state');
  fs.mkdirSync(stateDir, { recursive: true });

  const state: BootstrapAdminState = {
    adminEmail,
    adminPassword,
    adminDisplayName,
    adminUserId: data.user.id,
    adminAccessToken: data.tokens.accessToken,
    adminRefreshToken: data.tokens.refreshToken,
    recoveryCodes: data.recoveryCodes,
    apiBaseUrl,
    webBaseUrl,
    storageRoot
  };

  fs.writeFileSync(path.join(stateDir, 'bootstrap.json'), JSON.stringify(state, null, 2), 'utf8');
}
