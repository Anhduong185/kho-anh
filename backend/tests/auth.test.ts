import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';

describe('Auth, Token Rotation & Account Recovery', () => {
  let ctx: BuiltApp;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      JWT_ACCESS_SECRET: 'test-access-secret-must-be-at-least-32-chars',
      JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-at-least-32-chars'
    });
    ctx = await buildApp({ config, enableLogger: false });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('registers first user as bootstrap admin + user and returns 10 recovery codes', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'owner@example.com',
        password: 'StrongPassword!123',
        displayName: 'Vault Owner',
        encryptionMode: 'server_side',
        deviceName: 'iPhone 16 Pro',
        platform: 'ios'
      }
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe('owner@example.com');
    expect(body.user.roles).toEqual(['admin', 'user']);
    expect(body.user.encryptionMode).toBe('server_side');
    expect(body.device.platform).toBe('ios');
    expect(body.tokens.accessToken).toBeTypeOf('string');
    expect(body.tokens.refreshToken).toBeTypeOf('string');
    expect(body.recoveryCodes).toHaveLength(10);

    // Duplicate registration should return 409
    const dup = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'OWNER@example.com',
        password: 'StrongPassword!123',
        displayName: 'Duplicate',
        encryptionMode: 'server_side'
      }
    });
    expect(dup.statusCode).toBe(409);
  });

  it('rotates refresh tokens and revokes the entire token family on reuse attack', async () => {
    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'owner@example.com',
        password: 'StrongPassword!123',
        deviceName: 'Windows PC',
        platform: 'windows'
      }
    });
    expect(loginRes.statusCode).toBe(200);
    const initialRefresh = loginRes.json().tokens.refreshToken as string;

    // First refresh succeeds and issues a new token
    const refresh1 = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: initialRefresh }
    });
    expect(refresh1.statusCode).toBe(200);
    const secondRefresh = refresh1.json().tokens.refreshToken as string;
    expect(secondRefresh).not.toBe(initialRefresh);

    // Reusing the already-rotated token triggers family revocation
    const reuseAttempt = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: initialRefresh }
    });
    expect(reuseAttempt.statusCode).toBe(401);

    // Even the newer token from the compromised family is now revoked
    const afterReuse = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: secondRefresh }
    });
    expect(afterReuse.statusCode).toBe(401);
  });

  it('recovers E2EE account with single-use recovery code and flags E2EE vault unlock requirement', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'e2ee-user@example.com',
        password: 'InitialPassword!123',
        displayName: 'E2EE User',
        encryptionMode: 'e2ee',
        e2eeKeySalt: 'c2FsdC1iYXNlNjQ=',
        e2eeEncryptedMasterKey: 'ZW5jcnlwdGVkLW1hc3Rlci1rZXktY2lwaGVydGV4dA==',
        e2eeKdfParams: { algorithm: 'PBKDF2', hash: 'SHA-256', iterations: 600000 }
      }
    });
    expect(reg.statusCode).toBe(201);
    const regBody = reg.json();
    expect(regBody.user.roles).toEqual(['user']);
    expect(regBody.user.e2eeConfigured).toBe(true);

    const code = regBody.recoveryCodes[0] as string;

    const recoverRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/recover',
      payload: {
        email: 'e2ee-user@example.com',
        recoveryCode: code,
        newPassword: 'ResetPassword!456'
      }
    });
    expect(recoverRes.statusCode).toBe(200);
    const recBody = recoverRes.json();
    expect(recBody.recovered).toBe(true);
    expect(recBody.remainingRecoveryCodes).toBe(9);
    // PRD 4.1: login recovery does NOT auto-recover E2EE decryption key
    expect(recBody.e2eeVaultUnlockRequired).toBe(true);

    // Same code cannot be reused
    const reuseCode = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/recover',
      payload: {
        email: 'e2ee-user@example.com',
        recoveryCode: code,
        newPassword: 'AnotherPassword!789'
      }
    });
    expect(reuseCode.statusCode).toBe(401);

    // New password works and returns client-wrapped E2EE key bundle
    const loginNew = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'e2ee-user@example.com',
        password: 'ResetPassword!456'
      }
    });
    expect(loginNew.statusCode).toBe(200);
    expect(loginNew.json().e2eeKeyBundle.encryptedMasterKey).toBe(
      'ZW5jcnlwdGVkLW1hc3Rlci1rZXktY2lwaGVydGV4dA=='
    );
  });

  it('immediately blocks access token when device is revoked', async () => {
    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'owner@example.com',
        password: 'StrongPassword!123',
        deviceName: 'Stolen Phone',
        platform: 'ios'
      }
    });
    const { tokens, device } = loginRes.json();

    const beforeRevoke = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${tokens.accessToken}` }
    });
    expect(beforeRevoke.statusCode).toBe(200);

    const revokeRes = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${device.id}`,
      headers: { authorization: `Bearer ${tokens.accessToken}` }
    });
    expect(revokeRes.statusCode).toBe(200);

    const afterRevoke = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${tokens.accessToken}` }
    });
    expect(afterRevoke.statusCode).toBe(401);
  });
});
