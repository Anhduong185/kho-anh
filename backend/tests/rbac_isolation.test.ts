import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';

describe('RBAC, Multi-User Isolation & Admin Privacy Boundary', () => {
  let ctx: BuiltApp;
  let adminToken: string;
  let userAToken: string;
  let userADeviceId: string;
  let userBToken: string;
  let userBId: string;
  let userBDeviceId: string;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      JWT_ACCESS_SECRET: 'test-access-secret-must-be-at-least-32-chars',
      JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-at-least-32-chars'
    });
    ctx = await buildApp({ config, enableLogger: false });

    const adminReg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'admin@example.com',
        password: 'AdminPassword!123',
        displayName: 'Sys Admin',
        encryptionMode: 'server_side',
        deviceName: 'Admin Desktop',
        platform: 'windows'
      }
    });
    adminToken = adminReg.json().tokens.accessToken;

    const regA = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'alice@example.com',
        password: 'AlicePassword!123',
        displayName: 'Alice',
        encryptionMode: 'e2ee',
        e2eeKeySalt: 'YWxpY2Utc2FsdA==',
        e2eeEncryptedMasterKey: 'YWxpY2Utc2VjcmV0LWJ1bmRsZQ==',
        deviceName: 'Alice iPhone',
        platform: 'ios'
      }
    });
    userAToken = regA.json().tokens.accessToken;
    userADeviceId = regA.json().device.id;

    const regB = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'bob@example.com',
        password: 'BobPassword!123',
        displayName: 'Bob',
        encryptionMode: 'server_side',
        deviceName: 'Bob Android',
        platform: 'android'
      }
    });
    userBToken = regB.json().tokens.accessToken;
    userBId = regB.json().user.id;
    userBDeviceId = regB.json().device.id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('prevents User A from listing or revoking User B devices (strict tenant isolation)', async () => {
    const devicesA = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${userAToken}` }
    });
    expect(devicesA.statusCode).toBe(200);
    const listA = devicesA.json().devices as Array<{ id: string }>;
    expect(listA.map((d) => d.id)).toEqual([userADeviceId]);
    expect(listA.some((d) => d.id === userBDeviceId)).toBe(false);

    // Attempting to revoke User B's device returns 404 (no cross-tenant leakage)
    const crossRevoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${userBDeviceId}`,
      headers: { authorization: `Bearer ${userAToken}` }
    });
    expect(crossRevoke.statusCode).toBe(404);

    // User B's session remains completely unaffected
    const checkB = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${userBToken}` }
    });
    expect(checkB.statusCode).toBe(200);
  });

  it('blocks non-admin users from all admin endpoints with 403', async () => {
    const endpoints = [
      { method: 'GET' as const, url: '/api/v1/admin/overview' },
      { method: 'GET' as const, url: '/api/v1/admin/users' },
      { method: 'GET' as const, url: '/api/v1/admin/settings' }
    ];

    for (const ep of endpoints) {
      const res = await ctx.app.inject({
        method: ep.method,
        url: ep.url,
        headers: { authorization: `Bearer ${userAToken}` }
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('allows Admin to manage infrastructure/settings while strictly preserving user privacy boundary', async () => {
    const overviewRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(overviewRes.statusCode).toBe(200);
    const overview = overviewRes.json();
    expect(overview.totalUsers).toBe(3);
    expect(overview.settings.upload_network_policy).toBe('wifi_only');
    expect(overview.settings.retention_policy).toBe('indefinite_manual_delete');
    expect(overview.settings.gps_map_enabled).toBe(false);
    expect(overview.settings.search_enabled).toBe(false);
    expect(overview.settings.sharing_enabled).toBe(false);
    expect(overview.storageTargets).toHaveLength(3);

    // Admin users list exposes ONLY management metadata, never password hashes or E2EE key material
    const usersRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(usersRes.statusCode).toBe(200);
    const rawJson = JSON.stringify(usersRes.json());
    expect(rawJson).not.toContain('e2eeEncryptedMasterKey');
    expect(rawJson).not.toContain('YWxpY2Utc2VjcmV0LWJ1bmRsZQ==');
    expect(rawJson).not.toContain('passwordHash');
    expect(rawJson).not.toContain('scrypt$');

    // Admin cannot deactivate themselves
    const selfDisable = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${usersRes.json().users[0].id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { isActive: false }
    });
    expect(selfDisable.statusCode).toBe(400);

    // Admin can disable another user and their token is immediately rejected
    const disableB = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${userBId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { isActive: false }
    });
    expect(disableB.statusCode).toBe(200);

    const bobBlocked = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${userBToken}` }
    });
    expect(bobBlocked.statusCode).toBe(401);
  });
});
