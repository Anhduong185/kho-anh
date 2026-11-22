import {
  DEFAULT_USER_QUOTA_BYTES,
  type AuthTokens,
  type DeviceInfo,
  type DevicePlatform,
  type E2eeKeyBundle,
  type EncryptionMode,
  type LoginRequest,
  type RecoverAccountRequest,
  type RegisterRequest,
  type UpdateE2eeKeyRequest,
  type UserProfile
} from '@smb/shared';
import type { WorkerEnv } from '../env.js';
import {
  generateRecoveryCodes,
  hashPassword,
  hashRecoveryCode,
  randomHex,
  sha256Hex,
  signAccessJwt,
  verifyPassword
} from '../utils/crypto.js';
import {
  addNotification,
  addSecurityEvent,
  getSystemSettings,
  HttpError,
  jsonResponse,
  readJson,
  requireAuth
} from '../utils/http.js';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  encryption_mode: EncryptionMode;
  e2ee_key_salt: string | null;
  e2ee_encrypted_master_key: string | null;
  e2ee_kdf_params: string | null;
  quota_bytes: number;
  used_bytes: number;
  is_active: number;
  is_admin: number;
  created_at: string;
}

interface DeviceRow {
  id: string;
  user_id: string;
  device_name: string;
  platform: DevicePlatform;
  is_trusted: number;
  last_seen_at: string;
  revoked_at: string | null;
  created_at: string;
}

function toUserProfile(row: UserRow): UserProfile {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    roles: row.is_admin ? ['admin', 'user'] : ['user'],
    encryptionMode: row.encryption_mode,
    e2eeConfigured: Boolean(row.e2ee_encrypted_master_key),
    quotaBytes: Number(row.quota_bytes),
    usedBytes: Number(row.used_bytes),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at
  };
}

function toDeviceInfo(row: DeviceRow, currentDeviceId?: string): DeviceInfo {
  return {
    id: row.id,
    deviceName: row.device_name,
    platform: row.platform,
    isTrusted: Boolean(row.is_trusted),
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    isCurrent: currentDeviceId ? row.id === currentDeviceId : undefined
  };
}

async function issueTokenPair(
  env: WorkerEnv,
  user: UserRow,
  deviceId: string,
  tokenFamily?: string
): Promise<AuthTokens> {
  const roles: Array<'user' | 'admin'> = user.is_admin ? ['admin', 'user'] : ['user'];
  const accessToken = await signAccessJwt(
    {
      sub: user.id,
      email: user.email,
      deviceId,
      roles,
      encryptionMode: user.encryption_mode
    },
    env.JWT_ACCESS_SECRET,
    900
  );

  const rawRefresh = randomHex(32);
  const refreshHash = await sha256Hex(`${env.JWT_REFRESH_SECRET}:${rawRefresh}`);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const family = tokenFamily ?? crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO refresh_tokens (id, user_id, device_id, token_family, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), user.id, deviceId, family, refreshHash, expiresAt, now)
    .run();

  return {
    accessToken,
    refreshToken: rawRefresh,
    accessTokenExpiresIn: 900
  };
}

export async function handleAuthRoutes(
  request: Request,
  url: URL,
  env: WorkerEnv
): Promise<Response | null> {
  const { pathname } = url;
  const method = request.method;

  // POST /api/v1/auth/register
  if (method === 'POST' && pathname === '/api/v1/auth/register') {
    const body = await readJson<RegisterRequest>(request);
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    const displayName = (body.displayName ?? '').trim();
    const encryptionMode: EncryptionMode = body.encryptionMode === 'e2ee' ? 'e2ee' : 'server_side';

    if (!email || !email.includes('@')) {
      throw new HttpError(400, 'INVALID_EMAIL', 'Email không hợp lệ');
    }
    if (password.length < 8) {
      throw new HttpError(400, 'WEAK_PASSWORD', 'Mật khẩu phải có ít nhất 8 ký tự');
    }
    if (!displayName) {
      throw new HttpError(400, 'INVALID_NAME', 'Vui lòng nhập tên hiển thị');
    }

    const settings = await getSystemSettings(env.DB);
    const countRow = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM users').first<{ cnt: number }>();
    const isFirstUser = Number(countRow?.cnt ?? 0) === 0;
    if (!isFirstUser && !settings.registration_enabled) {
      throw new HttpError(403, 'REGISTRATION_DISABLED', 'Quản trị viên đã tạm khóa đăng ký tài khoản mới');
    }

    const existing = await env.DB.prepare('SELECT id FROM users WHERE LOWER(email) = ?')
      .bind(email)
      .first<{ id: string }>();
    if (existing) {
      throw new HttpError(409, 'EMAIL_EXISTS', 'Email này đã được đăng ký');
    }

    if (encryptionMode === 'e2ee' && (!body.e2eeKeySalt || !body.e2eeEncryptedMasterKey)) {
      throw new HttpError(400, 'E2EE_BUNDLE_REQUIRED', 'Tài khoản E2EE cần khóa mã hóa cục bộ');
    }

    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const platform: DevicePlatform =
      body.platform && ['ios', 'android', 'windows', 'web'].includes(body.platform)
        ? body.platform
        : 'web';
    const deviceName = (body.deviceName ?? 'Thiết bị mới').trim().slice(0, 80);
    const envQuota = Number(env.DEFAULT_USER_QUOTA_BYTES ?? 0);
    const defaultQuotaBytes =
      Number.isFinite(envQuota) && envQuota > 0 ? Math.floor(envQuota) : DEFAULT_USER_QUOTA_BYTES;

    // Public registration strictly assigns ['user'] for all non-bootstrap accounts,
    // ignoring any client-supplied role/roles/isAdmin/quotaBytes fields.
    await env.DB.prepare(
      `INSERT INTO users (
        id, email, display_name, password_hash, encryption_mode,
        e2ee_key_salt, e2ee_encrypted_master_key, e2ee_kdf_params,
        quota_bytes, used_bytes, is_active, is_admin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`
    )
      .bind(
        userId,
        email,
        displayName,
        passwordHash,
        encryptionMode,
        body.e2eeKeySalt ?? null,
        body.e2eeEncryptedMasterKey ?? null,
        body.e2eeKdfParams ? JSON.stringify(body.e2eeKdfParams) : null,
        defaultQuotaBytes,
        isFirstUser ? 1 : 0,
        now,
        now
      )
      .run();

    await env.DB.prepare(
      `INSERT INTO devices (id, user_id, device_name, platform, is_trusted, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    )
      .bind(deviceId, userId, deviceName, platform, now, now)
      .run();

    const codes = await generateRecoveryCodes(10);
    await env.DB.batch(
      codes.map((c) =>
        env.DB.prepare(
          'INSERT INTO recovery_codes (id, user_id, code_salt, code_hash, created_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(crypto.randomUUID(), userId, c.salt, c.hash, now)
      )
    );

    const userRow = (await env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<UserRow>())!;
    const devRow = (await env.DB.prepare('SELECT * FROM devices WHERE id = ?')
      .bind(deviceId)
      .first<DeviceRow>())!;

    const tokens = await issueTokenPair(env, userRow, deviceId);
    await addSecurityEvent(env.DB, userId, 'account_registered', {
      platform,
      isFirstAdmin: isFirstUser,
      encryptionMode
    });
    await addNotification(
      env.DB,
      userId,
      'security_alert',
      'Chào mừng đến với Kho Ảnh trên Cloudflare',
      'Hãy lưu lại 10 mã khôi phục ở nơi an toàn. Kho của bạn được cô lập tuyệt đối theo tài khoản.'
    );

    return jsonResponse(
      {
        user: toUserProfile(userRow),
        device: toDeviceInfo(devRow, deviceId),
        tokens,
        recoveryCodes: codes.map((c) => c.plain)
      },
      201
    );
  }

  // POST /api/v1/auth/login
  if (method === 'POST' && pathname === '/api/v1/auth/login') {
    const body = await readJson<LoginRequest>(request);
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';

    const userRow = await env.DB.prepare('SELECT * FROM users WHERE LOWER(email) = ?')
      .bind(email)
      .first<UserRow>();
    if (!userRow || !(await verifyPassword(password, userRow.password_hash))) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không chính xác');
    }
    if (!userRow.is_active) {
      throw new HttpError(403, 'ACCOUNT_DISABLED', 'Tài khoản đang bị tạm khóa');
    }

    const now = new Date().toISOString();
    const deviceId = crypto.randomUUID();
    const platform: DevicePlatform =
      body.platform && ['ios', 'android', 'windows', 'web'].includes(body.platform)
        ? body.platform
        : 'web';
    const deviceName = (body.deviceName ?? 'Thiết bị đăng nhập').trim().slice(0, 80);

    await env.DB.prepare(
      `INSERT INTO devices (id, user_id, device_name, platform, is_trusted, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    )
      .bind(deviceId, userRow.id, deviceName, platform, now, now)
      .run();

    const devRow = (await env.DB.prepare('SELECT * FROM devices WHERE id = ?')
      .bind(deviceId)
      .first<DeviceRow>())!;
    const tokens = await issueTokenPair(env, userRow, deviceId);
    await addSecurityEvent(env.DB, userRow.id, 'login_success', { deviceName, platform });

    let e2eeKeyBundle: E2eeKeyBundle | null = null;
    if (
      userRow.encryption_mode === 'e2ee' &&
      userRow.e2ee_key_salt &&
      userRow.e2ee_encrypted_master_key
    ) {
      e2eeKeyBundle = {
        keySalt: userRow.e2ee_key_salt,
        encryptedMasterKey: userRow.e2ee_encrypted_master_key,
        kdfParams: userRow.e2ee_kdf_params ? (JSON.parse(userRow.e2ee_kdf_params) as Record<string, unknown>) : {}
      };
    }

    return jsonResponse({
      user: toUserProfile(userRow),
      device: toDeviceInfo(devRow, deviceId),
      tokens,
      e2eeKeyBundle
    });
  }

  // POST /api/v1/auth/refresh
  if (method === 'POST' && pathname === '/api/v1/auth/refresh') {
    const body = await readJson<{ refreshToken?: string }>(request);
    const raw = (body.refreshToken ?? '').trim();
    if (!raw) throw new HttpError(400, 'MISSING_REFRESH_TOKEN', 'Thiếu refresh token');

    const tokenHash = await sha256Hex(`${env.JWT_REFRESH_SECRET}:${raw}`);
    const row = await env.DB.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
      .bind(tokenHash)
      .first<{
        id: string;
        user_id: string;
        device_id: string;
        token_family: string;
        expires_at: string;
        revoked_at: string | null;
      }>();

    if (!row) {
      throw new HttpError(401, 'INVALID_REFRESH', 'Phiên đăng nhập không hợp lệ');
    }

    const now = new Date().toISOString();
    if (row.revoked_at) {
      // Refresh reuse detected: revoke entire family
      await env.DB.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_family = ?')
        .bind(now, row.token_family)
        .run();
      await addSecurityEvent(env.DB, row.user_id, 'refresh_token_reuse_detected', {
        tokenFamily: row.token_family
      });
      throw new HttpError(401, 'TOKEN_REUSE_DETECTED', 'Phát hiện dùng lại token, phiên đã bị hủy');
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new HttpError(401, 'REFRESH_EXPIRED', 'Phiên đăng nhập đã hết hạn');
    }

    const userRow = await env.DB.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1')
      .bind(row.user_id)
      .first<UserRow>();
    const devRow = await env.DB.prepare('SELECT id, revoked_at FROM devices WHERE id = ?')
      .bind(row.device_id)
      .first<{ id: string; revoked_at: string | null }>();

    if (!userRow || !devRow || devRow.revoked_at) {
      throw new HttpError(401, 'SESSION_REVOKED', 'Thiết bị hoặc tài khoản đã bị thu hồi');
    }

    const newTokens = await issueTokenPair(env, userRow, row.device_id, row.token_family);
    await env.DB.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?')
      .bind(now, row.id)
      .run();
    await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
      .bind(now, row.device_id)
      .run();

    return jsonResponse({ tokens: newTokens });
  }

  // POST /api/v1/auth/logout
  if (method === 'POST' && pathname === '/api/v1/auth/logout') {
    const auth = await requireAuth(request, env);
    const now = new Date().toISOString();
    await env.DB.prepare(
      'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL'
    )
      .bind(now, auth.userId, auth.deviceId)
      .run();
    return jsonResponse({ loggedOut: true });
  }

  // POST /api/v1/auth/recover
  if (method === 'POST' && pathname === '/api/v1/auth/recover') {
    const body = await readJson<RecoverAccountRequest>(request);
    const email = (body.email ?? '').trim().toLowerCase();
    const code = (body.recoveryCode ?? '').trim().toUpperCase();
    const newPassword = body.newPassword ?? '';

    if (newPassword.length < 8) {
      throw new HttpError(400, 'WEAK_PASSWORD', 'Mật khẩu mới tối thiểu 8 ký tự');
    }
    const userRow = await env.DB.prepare('SELECT * FROM users WHERE LOWER(email) = ?')
      .bind(email)
      .first<UserRow>();
    if (!userRow || !userRow.is_active) {
      throw new HttpError(401, 'RECOVERY_FAILED', 'Email hoặc mã khôi phục không hợp lệ');
    }

    const unused = await env.DB.prepare(
      'SELECT id, code_salt, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL'
    )
      .bind(userRow.id)
      .all<{ id: string; code_salt: string; code_hash: string }>();

    let matchedId: string | null = null;
    for (const c of unused.results) {
      const candidate = await hashRecoveryCode(code, c.code_salt);
      if (candidate === c.code_hash) {
        matchedId = c.id;
        break;
      }
    }
    if (!matchedId) {
      throw new HttpError(401, 'RECOVERY_FAILED', 'Mã khôi phục không đúng hoặc đã dùng');
    }

    const now = new Date().toISOString();
    const newHash = await hashPassword(newPassword);
    await env.DB.batch([
      env.DB.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').bind(now, matchedId),
      env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(
        newHash,
        now,
        userRow.id
      ),
      env.DB.prepare(
        'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
      ).bind(now, userRow.id)
    ]);

    await addSecurityEvent(env.DB, userRow.id, 'account_recovered', {});

    return jsonResponse({
      recovered: true,
      remainingRecoveryCodes: unused.results.length - 1,
      e2eeVaultUnlockRequired: userRow.encryption_mode === 'e2ee',
      message: 'Đặt lại mật khẩu thành công. Bạn có thể đăng nhập lại ngay.'
    });
  }

  // GET /api/v1/users/me
  if (method === 'GET' && pathname === '/api/v1/users/me') {
    const auth = await requireAuth(request, env);
    const userRow = (await env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(auth.userId)
      .first<UserRow>())!;
    const settings = await getSystemSettings(env.DB);
    return jsonResponse({
      user: toUserProfile(userRow),
      policies: {
        uploadNetworkPolicy: settings.upload_network_policy,
        retentionPolicy: settings.retention_policy,
        trashRetentionDays: settings.trash_retention_days,
        gpsMapEnabled: false,
        searchEnabled: false,
        sharingEnabled: false,
        requiredReplicas: settings.required_replicas
      }
    });
  }

  // PATCH /api/v1/users/me/password
  if (method === 'PATCH' && pathname === '/api/v1/users/me/password') {
    const auth = await requireAuth(request, env);
    const body = await readJson<{ currentPassword?: string; newPassword?: string }>(request);
    if (!body.currentPassword || !body.newPassword || body.newPassword.length < 8) {
      throw new HttpError(400, 'INVALID_PASSWORD', 'Mật khẩu mới tối thiểu 8 ký tự');
    }
    const userRow = (await env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(auth.userId)
      .first<UserRow>())!;
    if (!(await verifyPassword(body.currentPassword, userRow.password_hash))) {
      throw new HttpError(401, 'WRONG_PASSWORD', 'Mật khẩu hiện tại không đúng');
    }
    const newHash = await hashPassword(body.newPassword);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(
        newHash,
        now,
        auth.userId
      ),
      env.DB.prepare(
        'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND device_id <> ? AND revoked_at IS NULL'
      ).bind(now, auth.userId, auth.deviceId)
    ]);
    await addSecurityEvent(env.DB, auth.userId, 'password_changed', {});
    return jsonResponse({ updated: true });
  }

  // PUT /api/v1/users/me/e2ee-key
  if (method === 'PUT' && pathname === '/api/v1/users/me/e2ee-key') {
    const auth = await requireAuth(request, env);
    if (auth.encryptionMode !== 'e2ee') {
      throw new HttpError(
        400,
        'E2EE_MODE_REQUIRED',
        'Chỉ tài khoản chế độ E2EE mới cấu hình được khóa mã hóa'
      );
    }
    const body = await readJson<Partial<UpdateE2eeKeyRequest>>(request);
    if (
      typeof body.e2eeKeySalt !== 'string' ||
      body.e2eeKeySalt.length < 8 ||
      body.e2eeKeySalt.length > 512 ||
      typeof body.e2eeEncryptedMasterKey !== 'string' ||
      body.e2eeEncryptedMasterKey.length < 16 ||
      body.e2eeEncryptedMasterKey.length > 4096 ||
      !body.e2eeKdfParams ||
      typeof body.e2eeKdfParams !== 'object' ||
      Array.isArray(body.e2eeKdfParams)
    ) {
      throw new HttpError(400, 'INVALID_E2EE_BUNDLE', 'Gói khóa E2EE không hợp lệ');
    }

    await env.DB.prepare(
      `UPDATE users
       SET e2ee_key_salt = ?, e2ee_encrypted_master_key = ?, e2ee_kdf_params = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(
        body.e2eeKeySalt,
        body.e2eeEncryptedMasterKey,
        JSON.stringify(body.e2eeKdfParams),
        new Date().toISOString(),
        auth.userId
      )
      .run();

    await addSecurityEvent(env.DB, auth.userId, 'e2ee_key_bundle_updated', {});
    return jsonResponse({ configured: true });
  }

  // POST /api/v1/users/me/recovery-codes/regenerate
  if (method === 'POST' && pathname === '/api/v1/users/me/recovery-codes/regenerate') {
    const auth = await requireAuth(request, env);
    const body = await readJson<{ currentPassword?: string }>(request);
    const userRow = (await env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(auth.userId)
      .first<UserRow>())!;
    if (!body.currentPassword || !(await verifyPassword(body.currentPassword, userRow.password_hash))) {
      throw new HttpError(401, 'WRONG_PASSWORD', 'Mật khẩu hiện tại không đúng');
    }
    const now = new Date().toISOString();
    const codes = await generateRecoveryCodes(10);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(auth.userId),
      ...codes.map((c) =>
        env.DB.prepare(
          'INSERT INTO recovery_codes (id, user_id, code_salt, code_hash, created_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(crypto.randomUUID(), auth.userId, c.salt, c.hash, now)
      )
    ]);
    await addSecurityEvent(env.DB, auth.userId, 'recovery_codes_regenerated', {});
    return jsonResponse({ recoveryCodes: codes.map((c) => c.plain) });
  }

  // GET /api/v1/devices
  if (method === 'GET' && pathname === '/api/v1/devices') {
    const auth = await requireAuth(request, env);
    const res = await env.DB.prepare(
      'SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC'
    )
      .bind(auth.userId)
      .all<DeviceRow>();
    return jsonResponse({
      devices: res.results.map((r) => toDeviceInfo(r, auth.deviceId))
    });
  }

  // PATCH /api/v1/devices/:id/trust
  const trustMatch = pathname.match(/^\/api\/v1\/devices\/([^/]+)\/trust$/);
  if (method === 'PATCH' && trustMatch) {
    const auth = await requireAuth(request, env);
    const body = await readJson<{ isTrusted?: boolean }>(request);
    if (typeof body.isTrusted !== 'boolean') {
      throw new HttpError(400, 'INVALID_TRUST_PAYLOAD', 'Thiếu trạng thái tin cậy hợp lệ');
    }
    const deviceId = trustMatch[1]!;
    const res = await env.DB.prepare(
      'UPDATE devices SET is_trusted = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
    )
      .bind(body.isTrusted ? 1 : 0, deviceId, auth.userId)
      .run();
    if (!res.meta.changes) {
      throw new HttpError(404, 'DEVICE_NOT_FOUND', 'Không tìm thấy thiết bị');
    }
    await addSecurityEvent(env.DB, auth.userId, 'device_trust_updated', {
      deviceId,
      isTrusted: body.isTrusted
    });
    return jsonResponse({ updated: true, deviceId, isTrusted: body.isTrusted });
  }

  // DELETE /api/v1/devices/:id
  const devDelMatch = pathname.match(/^\/api\/v1\/devices\/([^/]+)$/);
  if (method === 'DELETE' && devDelMatch) {
    const auth = await requireAuth(request, env);
    const deviceId = devDelMatch[1]!;
    const now = new Date().toISOString();
    const res = await env.DB.prepare(
      'UPDATE devices SET revoked_at = ?, is_trusted = 0 WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
    )
      .bind(now, deviceId, auth.userId)
      .run();
    if (!res.meta.changes) {
      throw new HttpError(404, 'DEVICE_NOT_FOUND', 'Không tìm thấy thiết bị');
    }
    await env.DB.prepare(
      'UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL'
    )
      .bind(now, deviceId, auth.userId)
      .run();
    await addSecurityEvent(env.DB, auth.userId, 'device_revoked', { deviceId });
    return jsonResponse({ revoked: true, deviceId });
  }

  // GET /api/v1/security/events
  if (method === 'GET' && pathname === '/api/v1/security/events') {
    const auth = await requireAuth(request, env);
    const res = await env.DB.prepare(
      'SELECT id, event_type, detail, created_at FROM security_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
    )
      .bind(auth.userId)
      .all<{ id: string; event_type: string; detail: string; created_at: string }>();
    return jsonResponse({
      events: res.results.map((r) => ({
        id: r.id,
        eventType: r.event_type,
        detail: JSON.parse(r.detail || '{}') as Record<string, unknown>,
        createdAt: r.created_at
      }))
    });
  }

  return null;
}
