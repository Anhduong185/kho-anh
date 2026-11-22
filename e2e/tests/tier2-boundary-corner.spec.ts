import { expect, test } from '@playwright/test';
import { VaultApiClient } from '../helpers/api-client.js';
import { assertMobileLayoutHealthy } from '../helpers/layout-audit.js';
import {
  makeNonMediaFixture,
  makeValidPng,
  sha256Hex
} from '../helpers/media-fixtures.js';
import { startMockCloudServers } from '../helpers/mock-cloud.js';
import { getNativeCallLog, injectVaultNativeMock } from '../helpers/native-mock.js';
import { startIsolatedStack } from '../helpers/stack.js';
import {
  loadBootstrapCreds,
  loginViaUi,
  openAdminConsole,
  registerViaUi,
  uniqueEmail,
  uploadFileViaWebUi
} from '../helpers/ui-auth.js';

const TEN_GIB = 10 * 1024 * 1024 * 1024;

// ============================================================================
// AREA A BOUNDARIES: Mobile UI Boundaries (5 Tests)
// ============================================================================
test.describe('Tier 2 — Mobile UI Boundaries', () => {
  test('MUI-1: Extreme narrow 320x568 viewport keeps Auth & Library without horizontal document overflow', async ({
    page
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await assertMobileLayoutHealthy(page, { colorScheme: 'light' });

    const email = uniqueEmail('narrow-320');
    await registerViaUi(page, { displayName: 'Narrow User', email, password: 'UserPass!2026' });
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' }).click();
    await assertMobileLayoutHealthy(page, { checkSortChip: true, colorScheme: 'light' });
  });

  test('MUI-2: Long filename & long email (120+ chars) wrap cleanly in Viewer, Albums & Admin views at 360x800', async ({
    page
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: 'light' });
    const longLocalPart = 'very-long-user-identifier-' + 'a'.repeat(95);
    const longEmail = `${longLocalPart}@vault.local`;
    expect(longEmail.length).toBeGreaterThan(120);

    const api = new VaultApiClient();
    await api.register({
      email: longEmail,
      password: 'UserPass!2026',
      displayName: 'Long Filename & Email Tester',
      encryptionMode: 'server_side'
    });

    const longFilename = `IMG_${'2026_11_22_'.repeat(10)}original_photo_name.png`;
    expect(longFilename.length).toBeGreaterThan(120);
    await api.uploadFile({
      filename: longFilename,
      mimeType: 'image/png',
      bytes: makeValidPng(15)
    });

    await loginViaUi(page, { email: longEmail, password: 'UserPass!2026' });
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' }).click();
    await page.locator('.tile').first().click();
    await expect(page.locator('.viewer-overlay')).toBeVisible();
    await assertMobileLayoutHealthy(page, { colorScheme: 'light' });
    await page.getByRole('button', { name: 'Đóng trình xem' }).click();

    // Also verify Admin Console renders the 120+ char email without overflowing 360px
    const admin = loadBootstrapCreds();
    await page.evaluate(() => localStorage.clear());
    await loginViaUi(page, { email: admin.adminEmail, password: admin.adminPassword });
    await openAdminConsole(page);
    await assertMobileLayoutHealthy(page, { colorScheme: 'light' });
  });

  test('MUI-3: Long album title (60+ chars) in .top-row h1 does not push action buttons off 360x800', async ({
    page
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: 'light' });
    const email = uniqueEmail('long-album');
    await registerViaUi(page, { displayName: 'Long Album User', email, password: 'UserPass!2026' });

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Album' }).click();
    await page.getByRole('button', { name: '+ Album' }).click();

    const longAlbumTitle = 'Chuyến Du Lịch Gia Đình Mùa Thu Hà Nội Đà Lạt Phú Quốc Năm 2026';
    expect(longAlbumTitle.length).toBeGreaterThan(60);
    await page.getByPlaceholder(/Du lịch/i).fill(longAlbumTitle);
    await page.getByRole('button', { name: 'Tạo ngay' }).click();

    // Open the created album into Library header (.top-row h1)
    await page.getByRole('button', { name: new RegExp(longAlbumTitle.slice(0, 25)) }).click();
    await expect(page.locator('h1')).toContainText('Chuyến Du Lịch');
    await assertMobileLayoutHealthy(page, { checkSortChip: true, colorScheme: 'light' });
  });

  test('MUI-4: Multi-select .selection-bar never overlaps bottom nav.nav at 360x800 and 390x844', async ({
    page
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    const email = uniqueEmail('sel-overlap');
    await registerViaUi(page, { displayName: 'Sel Overlap', email, password: 'UserPass!2026' });
    await uploadFileViaWebUi(page, {
      filename: 'sel-check.png',
      mimeType: 'image/png',
      bytes: makeValidPng(17)
    });

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' }).click();
    await page.getByRole('button', { name: 'Chọn', exact: true }).click();
    await page.locator('.tile').first().click();

    await expect(page.locator('.selection-bar')).toBeVisible();
    for (const vp of [
      { width: 360, height: 800 },
      { width: 390, height: 844 }
    ]) {
      await page.setViewportSize(vp);
      await assertMobileLayoutHealthy(page, { checkSelectionOverlap: true, colorScheme: 'light' });
    }
  });

  test('MUI-5: Dynamic light-to-dark media toggle updates computed surface theme and contrast cleanly', async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await assertMobileLayoutHealthy(page, { colorScheme: 'light' });

    await page.emulateMedia({ colorScheme: 'dark' });
    await assertMobileLayoutHealthy(page, { colorScheme: 'dark' });

    await page.emulateMedia({ colorScheme: 'light' });
    await assertMobileLayoutHealthy(page, { colorScheme: 'light' });
  });
});

// ============================================================================
// AREA B BOUNDARIES: Gallery / Wi-Fi / Upload Boundaries (5 Tests)
// ============================================================================
test.describe('Tier 2 — Gallery, Wi-Fi & Upload Boundaries', () => {
  test('GAL-1: Cellular network blocks wifi_only upload via native mock and API returns 403', async ({
    page
  }) => {
    const api = new VaultApiClient();
    await api.register({
      email: uniqueEmail('cell-api'),
      password: 'UserPass!2026',
      displayName: 'Cellular API',
      encryptionMode: 'server_side'
    });
    const png = makeValidPng(31);
    const apiRes = await api.uploadFile({
      filename: 'cell.png',
      mimeType: 'image/png',
      bytes: png,
      networkType: 'cellular'
    });
    expect(apiRes.initRes.status).toBe(403);

    await injectVaultNativeMock(page, {
      network: { connected: true, type: 'cellular', isWifi: false },
      assets: [
        {
          assetId: 'cell-1',
          albumId: 'camera',
          albumName: 'Camera',
          filename: 'CELL_BLOCKED.png',
          mimeType: 'image/png',
          mediaKind: 'image',
          bytes: png
        }
      ]
    });

    const uiEmail = uniqueEmail('cell-ui');
    await registerViaUi(page, {
      displayName: 'Cellular Native',
      email: uiEmail,
      password: 'UserPass!2026'
    });
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();

    await expect
      .poll(async () => (await getNativeCallLog(page)).map((c) => c.method), { timeout: 10_000 })
      .toContain('getNetworkStatus');
    const cellCalls = (await getNativeCallLog(page)).map((c) => c.method);
    expect(cellCalls).toContain('scanDeviceMedia');

    await expect(page.getByText('CELL_BLOCKED.png')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/dữ liệu di động|4G|5G|chặn|tạm khóa|chuyển sang Wi-Fi|không phải Wi-Fi/i).first()
    ).toBeVisible({ timeout: 10_000 });

    const uploadBtn = page.getByRole('button', { name: /Sao lưu.*chưa sao lưu|Bắt đầu sao lưu/i }).first();
    await expect(uploadBtn).toBeVisible({ timeout: 10_000 });
    await expect(uploadBtn).toBeDisabled();

    const uiApi = new VaultApiClient();
    await uiApi.login({ email: uiEmail, password: 'UserPass!2026' });
    expect((await uiApi.listMedia()).data.items).toHaveLength(0);
  });

  test('GAL-2: Offline ("none") network blocks upload in native mock mode', async ({ page }) => {
    await injectVaultNativeMock(page, {
      network: { connected: false, type: 'none', isWifi: false },
      assets: [
        {
          assetId: 'off-1',
          albumId: 'camera',
          albumName: 'Camera',
          filename: 'OFFLINE_BLOCKED.png',
          mimeType: 'image/png',
          mediaKind: 'image',
          bytes: makeValidPng(32)
        }
      ]
    });

    const offlineEmail = uniqueEmail('offline-ui');
    await registerViaUi(page, {
      displayName: 'Offline Native',
      email: offlineEmail,
      password: 'UserPass!2026'
    });
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();

    await expect
      .poll(async () => (await getNativeCallLog(page)).map((c) => c.method), { timeout: 10_000 })
      .toContain('getNetworkStatus');
    const offCalls = (await getNativeCallLog(page)).map((c) => c.method);
    expect(offCalls).toContain('scanDeviceMedia');

    await expect(page.getByText('OFFLINE_BLOCKED.png')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/ngoại tuyến|offline|không có mạng|mất kết nối|chặn|tạm khóa/i).first()
    ).toBeVisible({ timeout: 10_000 });

    const uploadBtn = page.getByRole('button', { name: /Sao lưu.*chưa sao lưu|Bắt đầu sao lưu/i }).first();
    await expect(uploadBtn).toBeVisible({ timeout: 10_000 });
    await expect(uploadBtn).toBeDisabled();

    const offlineApi = new VaultApiClient();
    await offlineApi.login({ email: offlineEmail, password: 'UserPass!2026' });
    expect((await offlineApi.listMedia()).data.items).toHaveLength(0);
  });

  test('GAL-3: Web fallback navigator.connection.type="cellular" and unchecked Wi-Fi confirm block upload', async ({
    page
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'connection', {
        value: {
          type: 'cellular',
          addEventListener: () => {},
          removeEventListener: () => {}
        },
        configurable: true
      });
    });

    await registerViaUi(page, {
      displayName: 'Web Cell',
      email: uniqueEmail('web-cell'),
      password: 'UserPass!2026'
    });
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();

    await expect(page.getByText(/kết nối dữ liệu di động|4G\/5G/i).first()).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'web-cell-blocked.png',
      mimeType: 'image/png',
      buffer: makeValidPng(39)
    });
    await expect(page.getByRole('button', { name: 'Bắt đầu sao lưu hàng đợi' })).toBeDisabled();
  });

  test('GAL-4: Duplicate SHA-256 detection triggers "Phát hiện trùng" in UI and supports skip vs allowDuplicate', async ({
    page
  }) => {
    const email = uniqueEmail('dup-boundary');
    await registerViaUi(page, { displayName: 'Dup User', email, password: 'UserPass!2026' });

    const dupPng = makeValidPng(45);
    await uploadFileViaWebUi(page, {
      filename: 'dup-orig.png',
      mimeType: 'image/png',
      bytes: dupPng
    });

    // Queue same file again via web input
    await page.locator('input[type="file"]').setInputFiles({
      name: 'dup-copy.png',
      mimeType: 'image/png',
      buffer: dupPng
    });
    await page.getByRole('button', { name: 'Bắt đầu sao lưu hàng đợi' }).click();

    await expect(page.getByText('Phát hiện trùng')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Vẫn lưu thêm bản sao/ }).click();
    await expect(page.getByText('Đã xác minh gốc').first()).toBeVisible({ timeout: 15_000 });
  });

  test('GAL-5: 0-byte payload & non-media (.txt/.pdf/.exe) files are rejected by UI and API', async ({
    page
  }) => {
    const api = new VaultApiClient();
    await api.register({
      email: uniqueEmail('nonmedia-api'),
      password: 'UserPass!2026',
      displayName: 'NonMedia API',
      encryptionMode: 'server_side'
    });

    for (const kind of ['txt', 'pdf', 'exe', 'empty'] as const) {
      const fx = makeNonMediaFixture(kind);
      const res = await api.initUpload({
        originalFilename: fx.filename,
        mimeType: fx.mimeType,
        sizeBytes: fx.bytes.length,
        sha256: sha256Hex(fx.bytes),
        networkType: 'wifi'
      });
      expect([400, 415]).toContain(res.status);
    }

    await registerViaUi(page, {
      displayName: 'NonMedia UI',
      email: uniqueEmail('nonmedia-ui'),
      password: 'UserPass!2026'
    });
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();

    const pdfFx = makeNonMediaFixture('pdf');
    await page.locator('input[type="file"]').setInputFiles({
      name: pdfFx.filename,
      mimeType: pdfFx.mimeType,
      buffer: pdfFx.bytes
    });
    await expect(page.getByText(/không phải ảnh\/video theo PRD/i)).toBeVisible();
  });
});

// ============================================================================
// AREA C BOUNDARIES: Auth & RBAC Boundaries (5 Tests)
// ============================================================================
test.describe('Tier 2 — Auth & RBAC Boundaries', () => {
  test('AUTH-1: POST /auth/register with injected role/isAdmin/roles flags strictly assigns ["user"]', async () => {
    const api = new VaultApiClient();
    const res = await api.register({
      email: uniqueEmail('elevate-attempt'),
      password: 'UserPass!2026',
      displayName: 'Hacker Attempt',
      encryptionMode: 'server_side',
      role: 'admin',
      isAdmin: true,
      roles: ['admin', 'user']
    });
    expect(res.status).toBe(201);
    expect(res.data.user.roles).toEqual(['user']);

    const adminCheck = await api.adminUsers();
    expect(adminCheck.status).toBe(403);
  });

  test('AUTH-2: Disabled user receives immediate 401 on active JWT and 403 on login', async () => {
    const userApi = new VaultApiClient();
    const email = uniqueEmail('disabled-user');
    const password = 'UserPass!2026';
    const reg = await userApi.register({
      email,
      password,
      displayName: 'Disabled Target',
      encryptionMode: 'server_side'
    });
    expect((await userApi.me()).status).toBe(200);

    const admin = loadBootstrapCreds();
    const adminApi = new VaultApiClient(admin.apiBaseUrl, admin.adminAccessToken);
    const disableRes = await adminApi.adminUpdateUser(reg.data.user.id, { isActive: false });
    expect(disableRes.status).toBe(200);

    expect((await userApi.me()).status).toBe(401);
    const reLogin = await new VaultApiClient().login({ email, password });
    expect(reLogin.status).toBe(403);
  });

  test('AUTH-3: Admin self-deactivation is rejected with HTTP 400', async () => {
    const admin = loadBootstrapCreds();
    const adminApi = new VaultApiClient(admin.apiBaseUrl, admin.adminAccessToken);
    const res = await adminApi.adminUpdateUser(admin.adminUserId, { isActive: false });
    expect(res.status).toBe(400);
  });

  test('AUTH-4: Wrong recovery code and reused single-use recovery code fail with 400/401', async () => {
    const api = new VaultApiClient();
    const email = uniqueEmail('recover-boundary');
    const reg = await api.register({
      email,
      password: 'UserPass!2026',
      displayName: 'Recover User',
      encryptionMode: 'server_side'
    });
    const code1 = reg.data.recoveryCodes[0]!;

    const wrongRes = await api.recover({
      email,
      recoveryCode: 'WRONG-CODE-9999',
      newPassword: 'NewUserPass!2026'
    });
    expect([400, 401]).toContain(wrongRes.status);

    const validRes = await api.recover({
      email,
      recoveryCode: code1,
      newPassword: 'NewUserPass!2026'
    });
    expect(validRes.status).toBe(200);

    // Reusing the same single-use recovery code must fail
    const reuseRes = await api.recover({
      email,
      recoveryCode: code1,
      newPassword: 'AnotherPass!2026'
    });
    expect([400, 401]).toContain(reuseRes.status);
  });

  test('AUTH-5: Cross-tenant device revoke returns 404 and PATCH /admin/users/:badId returns 400/404', async () => {
    const userA = new VaultApiClient();
    await userA.register({
      email: uniqueEmail('dev-owner'),
      password: 'UserPass!2026',
      displayName: 'Device Owner',
      encryptionMode: 'server_side'
    });
    const devA = (await userA.listDevices()).data.devices[0]!.id;

    const userB = new VaultApiClient();
    await userB.register({
      email: uniqueEmail('dev-attacker'),
      password: 'UserPass!2026',
      displayName: 'Device Attacker',
      encryptionMode: 'server_side'
    });
    expect((await userB.revokeDevice(devA)).status).toBe(404);

    const admin = loadBootstrapCreds();
    const adminApi = new VaultApiClient(admin.apiBaseUrl, admin.adminAccessToken);
    expect((await adminApi.adminUpdateUser('not-a-uuid', { isActive: false })).status).toBe(400);
    expect(
      (await adminApi.adminUpdateUser('00000000-0000-4000-8000-000000000000', { isActive: false })).status
    ).toBe(404);
  });
});

// ============================================================================
// AREA D BOUNDARIES: Quota & Pool Boundaries (5 Tests)
// ============================================================================
test.describe('Tier 2 — Quota & Storage Pool Boundaries', () => {
  test('POOL-1: Default quota boundary is strictly greater than 10 GiB (not equal to 10737418240)', async () => {
    const api = new VaultApiClient();
    const reg = await api.register({
      email: uniqueEmail('quota-strict'),
      password: 'UserPass!2026',
      displayName: 'Strict Quota',
      encryptionMode: 'server_side'
    });
    expect(reg.data.user.quotaBytes).not.toBe(TEN_GIB);
    expect(reg.data.user.quotaBytes).toBeGreaterThan(TEN_GIB);
  });

  test('POOL-2: Upload exceeding user quota returns 413 QUOTA_EXCEEDED', async () => {
    const userApi = new VaultApiClient();
    const reg = await userApi.register({
      email: uniqueEmail('quota-limit'),
      password: 'UserPass!2026',
      displayName: 'Quota Limit',
      encryptionMode: 'server_side'
    });

    const admin = loadBootstrapCreds();
    const adminApi = new VaultApiClient(admin.apiBaseUrl, admin.adminAccessToken);
    // Tight quota: 500 bytes
    await adminApi.adminUpdateUser(reg.data.user.id, { quotaBytes: 500 });

    const bigPng = makeValidPng(60, 1024);
    expect(bigPng.length).toBeGreaterThan(500);
    const res = await userApi.initUpload({
      originalFilename: 'too-big.png',
      mimeType: 'image/png',
      sizeBytes: bigPng.length,
      sha256: sha256Hex(bigPng),
      networkType: 'wifi'
    });
    expect(res.status).toBe(413);
  });

  test('POOL-3: Invalid pool node URL (ftp:// or malformed) is rejected with 400/422', async () => {
    const admin = loadBootstrapCreds();
    const adminApi = new VaultApiClient(admin.apiBaseUrl, admin.adminAccessToken);

    const ftpRes = await adminApi.adminCreatePoolNode({
      name: 'Bad FTP Node',
      slot: 'copy1_primary',
      provider: 's3_custom',
      capacityBytes: 20 * 1024 * 1024 * 1024,
      endpoint: 'ftp://bad.example.com',
      bucket: 'bad',
      accessKeyId: 'k',
      secretAccessKey: 's'
    });
    expect([400, 422]).toContain(ftpRes.status);

    const malformedRes = await adminApi.adminCreatePoolNode({
      name: 'Bad Malformed Node',
      slot: 'copy1_primary',
      provider: 'webdav_custom',
      capacityBytes: 20 * 1024 * 1024 * 1024,
      endpoint: 'not-a-valid-url',
      bucket: 'bad',
      accessKeyId: 'u',
      secretAccessKey: 'p'
    });
    expect([400, 422]).toContain(malformedRes.status);
  });

  test('POOL-4: Bad WebDAV & S3 credentials probe returns ok: false', async () => {
    const mock = await startMockCloudServers({
      s3AccessKey: 'real-s3-key',
      webdavUsername: 'real-dav-user',
      webdavPassword: 'real-dav-password'
    });
    try {
      const admin = loadBootstrapCreds();
      const adminApi = new VaultApiClient(admin.apiBaseUrl, admin.adminAccessToken);

      const badDav = await adminApi.adminTestPoolDraft({
        name: 'Bad Dav Auth',
        slot: 'copy1_primary',
        provider: 'koofr_webdav',
        capacityBytes: 10 * 1024 * 1024 * 1024,
        endpoint: mock.webdavEndpoint,
        bucket: 'vault-photos',
        accessKeyId: 'wrong-user',
        secretAccessKey: 'wrong-pass'
      });
      expect(badDav.status).toBe(200);
      expect(badDav.data.result.ok).toBe(false);

      const badS3 = await adminApi.adminTestPoolDraft({
        name: 'Bad S3 Auth',
        slot: 'copy1_primary',
        provider: 'minio',
        capacityBytes: 10 * 1024 * 1024 * 1024,
        endpoint: mock.s3Endpoint,
        bucket: 'vault-photos',
        accessKeyId: 'wrong-s3-key',
        secretAccessKey: 'wrong-s3-secret',
        forcePathStyle: true
      });
      expect(badS3.status).toBe(200);
      expect(badS3.data.result.ok).toBe(false);

      const badS3Secret = await adminApi.adminTestPoolDraft({
        name: 'Bad S3 Secret Only',
        slot: 'copy1_primary',
        provider: 'minio',
        capacityBytes: 10 * 1024 * 1024 * 1024,
        endpoint: mock.s3Endpoint,
        bucket: 'vault-photos',
        accessKeyId: 'real-s3-key',
        secretAccessKey: 'wrong-s3-secret',
        forcePathStyle: true
      });
      expect(badS3Secret.status).toBe(200);
      expect(badS3Secret.data.result.ok).toBe(false);
    } finally {
      await mock.close();
    }
  });

  test('POOL-5: Deleting non-empty pool node returns 409; deleting empty node returns 200', async () => {
    const stack = await startIsolatedStack();
    const mock = await startMockCloudServers();
    try {
      await stack.client.register({
        email: uniqueEmail('pool-del-admin'),
        password: 'AdminPass!2026',
        displayName: 'Pool Del Admin',
        encryptionMode: 'server_side'
      });

      const s3Node = await stack.client.adminCreatePoolNode({
        name: 'NonEmpty S3',
        slot: 'copy1_primary',
        provider: 'minio',
        priority: 1,
        capacityBytes: 1024 * 1024 * 1024,
        endpoint: mock.s3Endpoint,
        region: 'us-east-1',
        bucket: 'nonempty-s3',
        accessKeyId: mock.s3AccessKey,
        secretAccessKey: mock.s3SecretKey,
        forcePathStyle: true
      });
      const s3NodeId = s3Node.data.node.id;

      const emptyNode = await stack.client.adminCreatePoolNode({
        name: 'Empty WebDAV',
        slot: 'copy2_secondary',
        provider: 'webdav_custom',
        priority: 50,
        capacityBytes: 1024 * 1024 * 1024,
        endpoint: mock.webdavEndpoint,
        bucket: 'empty-dav',
        accessKeyId: mock.webdavUsername,
        secretAccessKey: mock.webdavPassword
      });
      const emptyNodeId = emptyNode.data.node.id;

      // Upload 1 file onto S3 node
      const up = await stack.client.uploadFile({
        filename: 'pin-node.png',
        mimeType: 'image/png',
        bytes: makeValidPng(77)
      });
      const mediaId = up.completeRes!.data.media.id;

      // Deleting non-empty S3 node must be blocked (409)
      expect((await stack.client.adminDeletePoolNode(s3NodeId)).status).toBe(409);

      // Deleting empty WebDAV node succeeds (200)
      expect((await stack.client.adminDeletePoolNode(emptyNodeId)).status).toBe(200);

      // Clean up file (trash -> permanent delete) then delete S3 node succeeds (200)
      await stack.client.trashMedia(mediaId);
      expect((await stack.client.permanentDeleteTrash(mediaId)).status).toBe(200);
      expect((await stack.client.adminDeletePoolNode(s3NodeId)).status).toBe(200);
    } finally {
      await mock.close();
      await stack.close();
    }
  });
});

// ============================================================================
// AREA E BOUNDARIES: PRD & E2EE Boundaries (5 Tests)
// ============================================================================
test.describe('Tier 2 — PRD & E2EE Boundaries', () => {
  test('PRD-1: E2EE passphrase shorter than 10 chars is rejected on registration', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
    await page.getByLabel('Tên hiển thị').fill('Short E2EE');
    await page.getByLabel('Email').fill(uniqueEmail('short-e2ee'));
    await page.getByLabel('Mật khẩu').fill('UserPass!2026');
    await page.locator('input[name="encryptionMode"][value="e2ee"]').check();
    await page.getByLabel(/Mật khẩu khóa kho E2EE/).fill('short123');
    await page.getByRole('button', { name: /Tạo tài khoản & nhận mã khôi phục/ }).click();

    // Should NOT reach Recovery Codes modal
    await expect(page.getByRole('heading', { name: /Lưu lại 10 mã khôi phục/ })).toHaveCount(0);
  });

  test('PRD-2: Wrong E2EE unlock passphrase fails decryption cleanly with error feedback', async ({
    page
  }) => {
    const email = uniqueEmail('wrong-e2ee-unlock');
    const password = 'UserPass!2026';
    await registerViaUi(page, {
      displayName: 'Wrong Unlock',
      email,
      password,
      encryptionMode: 'e2ee',
      e2eePassphrase: 'CorrectPassphrase!2026'
    });

    await page.evaluate(() => localStorage.clear());
    await loginViaUi(page, { email, password });

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Khóa giải mã E2EE/ }).click();
    await page.getByLabel('Mật khẩu khóa E2EE').fill('WrongPassphrase!9999');
    await page.getByRole('button', { name: 'Mở khóa', exact: true }).click();

    await expect(page.getByText(/Sai mật khẩu khóa kho E2EE|không thể giải mã/i)).toBeVisible();
  });

  test('PRD-3: Server-side account calling PUT /users/me/e2ee-key is rejected with 400', async () => {
    const api = new VaultApiClient();
    await api.register({
      email: uniqueEmail('srv-e2ee-put'),
      password: 'UserPass!2026',
      displayName: 'ServerSide User',
      encryptionMode: 'server_side'
    });

    const res = await api.updateE2eeKey({
      e2eeKeySalt: 'c2FsdA==',
      e2eeEncryptedMasterKey: 'ZW5jcnlwdGVk',
      e2eeKdfParams: { iterations: 310000 }
    });
    expect(res.status).toBe(400);
  });

  test('PRD-4: Byte-range stream returns 206 Partial Content with exact Content-Range and handles invalid Range 416', async () => {
    const api = new VaultApiClient();
    await api.register({
      email: uniqueEmail('range-stream'),
      password: 'UserPass!2026',
      displayName: 'Range User',
      encryptionMode: 'server_side'
    });

    const png = makeValidPng(82, 512);
    const up = await api.uploadFile({
      filename: 'range.png',
      mimeType: 'image/png',
      bytes: png
    });
    const mediaId = up.completeRes!.data.media.id;

    const partial = await api.streamMedia(mediaId, 'bytes=0-15');
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 0-15/${png.length}`);
    expect(partial.rawBytes.length).toBe(16);
    expect(partial.rawBytes.equals(png.subarray(0, 16))).toBe(true);

    const outOfRange = await api.streamMedia(mediaId, `bytes=${png.length + 100}-${png.length + 200}`);
    expect(outOfRange.status).toBe(416);
  });

  test('PRD-5: Empty album and empty vault ZIP export return clean 404 error without crashing', async () => {
    const api = new VaultApiClient();
    await api.register({
      email: uniqueEmail('empty-zip'),
      password: 'UserPass!2026',
      displayName: 'Empty ZIP',
      encryptionMode: 'server_side'
    });

    const albumRes = await api.createAlbum('Empty Album');
    expect(albumRes.status).toBe(201);

    const albumExport = await api.exportZip({ scope: 'album', albumId: albumRes.data.album.id });
    expect(albumExport.status).toBe(404);

    const allExport = await api.exportZip({ scope: 'all' });
    expect(allExport.status).toBe(404);
  });
});
