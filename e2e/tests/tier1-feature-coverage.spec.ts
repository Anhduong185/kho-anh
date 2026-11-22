import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { VaultApiClient } from '../helpers/api-client.js';
import {
  assertMobileLayoutHealthy,
  COLOR_SCHEMES,
  MOBILE_VIEWPORTS
} from '../helpers/layout-audit.js';
import {
  makeValidJpegWithExif,
  makeValidMp4,
  makeValidPng,
  sha256Hex
} from '../helpers/media-fixtures.js';
import { startMockCloudServers } from '../helpers/mock-cloud.js';
import {
  getNativeAssets,
  getNativeCallLog,
  getSavedToGallery,
  injectVaultNativeMock
} from '../helpers/native-mock.js';
import { startIsolatedStack } from '../helpers/stack.js';
import {
  findAdminUserContainer,
  loadBootstrapCreds,
  loginViaUi,
  openAdminConsole,
  registerViaUi,
  uniqueEmail,
  uploadFileViaWebUi
} from '../helpers/ui-auth.js';

const TEN_GIB = 10 * 1024 * 1024 * 1024; // 10737418240

async function readDownloadBuffer(download: import('@playwright/test').Download): Promise<Buffer> {
  const filePath = await download.path();
  if (!filePath) {
    throw new Error('Playwright download path was null');
  }
  return fs.readFileSync(filePath);
}

// ============================================================================
// FEATURE AREA A: Mobile UI & Viewport Responsiveness (R2, F8) — 6 Tests
// ============================================================================
test.describe('Tier 1 — Area A: Mobile UI & Viewport Responsiveness (R2, F8)', () => {
  test('A1: Auth screens (Login / Register / Recover) pass mobile matrix 360x800, 390x844, 412x915 x light/dark', async ({
    page
  }) => {
    for (const vp of MOBILE_VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const scheme of COLOR_SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/');

        await page.getByRole('tablist').getByRole('button', { name: 'Đăng nhập', exact: true }).click();
        await assertMobileLayoutHealthy(page, { colorScheme: scheme });

        await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
        await assertMobileLayoutHealthy(page, { colorScheme: scheme });

        await page.getByRole('button', { name: 'Khôi phục', exact: true }).click();
        await assertMobileLayoutHealthy(page, { colorScheme: scheme });
      }
    }
  });

  test('A2: Library screen keeps "Ngày chụp" sort control unclipped across 360x800, 390x844, 412x915 x light/dark', async ({
    page
  }) => {
    const email = uniqueEmail('ui-lib');
    const password = 'UserPass!2026';
    await registerViaUi(page, { displayName: 'UI Library', email, password });

    // Upload 1 PNG so library has content + timeline
    await uploadFileViaWebUi(page, {
      filename: 'lib-audit.png',
      mimeType: 'image/png',
      bytes: makeValidPng(10)
    });

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' }).click();
    await expect(page.locator('.tile').first()).toBeVisible();

    for (const vp of MOBILE_VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const scheme of COLOR_SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme });
        await assertMobileLayoutHealthy(page, { checkSortChip: true, colorScheme: scheme });
      }
    }
  });

  test('A3: Albums Hub screen passes mobile viewport matrix across light and dark modes', async ({
    page
  }) => {
    const email = uniqueEmail('ui-album');
    await registerViaUi(page, { displayName: 'UI Album', email, password: 'UserPass!2026' });

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Album' }).click();
    await expect(page.getByRole('heading', { name: 'Album' })).toBeVisible();

    for (const vp of MOBILE_VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const scheme of COLOR_SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme });
        await assertMobileLayoutHealthy(page, { colorScheme: scheme });
      }
    }
  });

  test('A4: Vault Hub, Backup, Restore & Security screens pass mobile viewport matrix', async ({ page }) => {
    const email = uniqueEmail('ui-vault');
    await registerViaUi(page, { displayName: 'UI Vault', email, password: 'UserPass!2026' });

    const nav = page.locator('nav[aria-label="Điều hướng"]');
    for (const vp of MOBILE_VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.emulateMedia({ colorScheme: vp.width === 390 ? 'dark' : 'light' });
      const activeScheme = vp.width === 390 ? 'dark' : 'light';

      // Vault home
      await nav.getByRole('button', { name: 'Kho' }).click();
      await assertMobileLayoutHealthy(page, { colorScheme: activeScheme });

      // Backup sub-screen
      await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();
      await assertMobileLayoutHealthy(page, { colorScheme: activeScheme });
      await page.getByRole('button', { name: 'Quay lại' }).click();

      // Restore/Trash sub-screen
      await page.getByRole('button', { name: /Khôi phục, Trùng lặp & Thùng rác/ }).click();
      await assertMobileLayoutHealthy(page, { colorScheme: activeScheme });
      await page.getByRole('button', { name: 'Quay lại' }).click();

      // Security sub-screen
      await page.getByRole('button', { name: /Thiết bị, PIN, Mật khẩu & Máy chủ/ }).click();
      await assertMobileLayoutHealthy(page, { colorScheme: activeScheme });
      await page.getByRole('button', { name: 'Quay lại' }).click();
    }
  });

  test('A5: Fullscreen Photo Viewer and Info Sheet fit cleanly in mobile viewports (light & dark)', async ({
    page
  }) => {
    const email = uniqueEmail('ui-viewer');
    await registerViaUi(page, { displayName: 'UI Viewer', email, password: 'UserPass!2026' });
    await uploadFileViaWebUi(page, {
      filename: 'viewer-mobile-photo.png',
      mimeType: 'image/png',
      bytes: makeValidPng(22)
    });

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' }).click();
    await page.locator('.tile').first().click();
    await expect(page.locator('.viewer-overlay')).toBeVisible();

    for (const vp of MOBILE_VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const scheme of COLOR_SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme });
        await assertMobileLayoutHealthy(page, { colorScheme: scheme });

        // Open Info Sheet
        await page.getByRole('button', { name: 'Thông tin ảnh' }).click();
        await expect(page.locator('.viewer-sheet')).toBeVisible();
        await assertMobileLayoutHealthy(page, { colorScheme: scheme });
        await page.getByRole('button', { name: 'Xong' }).click();
      }
    }
  });

  test('A6: Admin Console fits cleanly on mobile viewports (360x800, 390x844, 412x915) without horizontal overflow', async ({
    page
  }) => {
    const admin = loadBootstrapCreds();
    await loginViaUi(page, { email: admin.adminEmail, password: admin.adminPassword });
    await openAdminConsole(page);

    for (const vp of MOBILE_VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const scheme of COLOR_SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme });
        await assertMobileLayoutHealthy(page, { colorScheme: scheme });
      }
    }
  });
});

// ============================================================================
// FEATURE AREA B: Device Gallery, Web Fallback & Download (R3, F9–F12) — 5 Tests
// ============================================================================
test.describe('Tier 1 — Area B: Device Gallery, Web Fallback & Download (R3, F9–F12)', () => {
  test('B1: Web fallback uploads via <input type="file"> and downloads original bytes matching SHA-256', async ({
    page
  }) => {
    const email = uniqueEmail('web-fallback');
    await registerViaUi(page, { displayName: 'Web Fallback', email, password: 'UserPass!2026' });

    const originalPng = makeValidPng(33);
    const expectedSha = sha256Hex(originalPng);

    await uploadFileViaWebUi(page, {
      filename: 'web-fallback-photo.png',
      mimeType: 'image/png',
      bytes: originalPng
    });

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' }).click();
    await page.locator('.tile').first().click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Tải file gốc' }).click()
    ]);

    expect(download.suggestedFilename()).toBe('web-fallback-photo.png');
    const downloadedBytes = await readDownloadBuffer(download);
    expect(sha256Hex(downloadedBytes)).toBe(expectedSha);
    expect(downloadedBytes.equals(originalPng)).toBe(true);
  });

  test('B2: Native bridge mock requests media permissions and scans Camera & Screenshots albums', async ({
    page
  }) => {
    const camImg = makeValidJpegWithExif(1, 'PhoneCam');
    const shotImg = makeValidPng(2);
    await injectVaultNativeMock(page, {
      assets: [
        {
          assetId: 'asset-cam-1',
          albumId: 'camera',
          albumName: 'Camera',
          filename: 'IMG_0001.jpg',
          mimeType: 'image/jpeg',
          mediaKind: 'image',
          bytes: camImg
        },
        {
          assetId: 'asset-shot-1',
          albumId: 'screenshots',
          albumName: 'Screenshots',
          filename: 'Screenshot_001.png',
          mimeType: 'image/png',
          mediaKind: 'image',
          bytes: shotImg
        }
      ]
    });

    const email = uniqueEmail('native-scan');
    await registerViaUi(page, { displayName: 'Native Scan', email, password: 'UserPass!2026' });
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();

    // Expect native gallery scan UI (M4) to discover albums & items
    await expect(page.getByText(/Camera/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Screenshots/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('IMG_0001.jpg')).toBeVisible();
    await expect(page.getByText('Screenshot_001.png')).toBeVisible();
    const thumbnails = page.locator('.device-preview-grid img');
    await expect(thumbnails).toHaveCount(2);
    await expect.poll(() => thumbnails.evaluateAll((images) =>
      images.every((image) => (image as HTMLImageElement).naturalWidth > 0)
    )).toBe(true);

    const calls = await getNativeCallLog(page);
    const methods = calls.map((c) => c.method);
    expect(methods).toContain('checkAndRequestMediaPermissions');
    expect(methods).toContain('listDeviceAlbums');
    expect(methods).toContain('scanDeviceMedia');

    // Hold the first Camera scan so Screenshots can finish before it.
    await page.evaluate(() => {
      type Scan = (options: { albumId?: string }) => Promise<unknown>;
      const win = window as typeof window & {
        __VAULT_NATIVE_MOCK__: { scanDeviceMedia: Scan };
        releaseCameraScan?: () => void;
      };
      const bridge = win.__VAULT_NATIVE_MOCK__;
      const scan = bridge.scanDeviceMedia.bind(bridge);
      bridge.scanDeviceMedia = async (options) => {
        if (options.albumId !== 'camera') return scan(options);
        if (win.releaseCameraScan) throw new Error('Không đọc được album Camera');
        const result = await scan(options);
        await new Promise<void>((resolve) => { win.releaseCameraScan = resolve; });
        return result;
      };
    });

    const camera = page.getByRole('button', { name: 'Camera (1)' });
    const screenshots = page.getByRole('button', { name: 'Screenshots (1)' });
    await camera.click();
    await page.waitForFunction(() => 'releaseCameraScan' in window);
    await expect(page.getByText('Screenshot_001.png')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Sao lưu \d+ mục chưa sao lưu/ })).toBeDisabled();
    await screenshots.click();
    await expect(page.getByText('Screenshot_001.png')).toBeVisible();

    await page.evaluate(async () => {
      (window as typeof window & { releaseCameraScan: () => void }).releaseCameraScan();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await expect(screenshots).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('IMG_0001.jpg')).toHaveCount(0);

    await camera.click();
    await expect(page.getByText('Không đọc được album Camera')).toBeVisible();
    await expect(page.getByText('Screenshot_001.png')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Sao lưu \d+ mục chưa sao lưu/ })).toBeDisabled();
  });

  test('B3: Native gallery sync diffs via check-duplicates to distinguish "Đã sao lưu" vs "Chưa sao lưu"', async ({
    page
  }) => {
    const backedUpBytes = makeValidJpegWithExif(11, 'AlreadySaved');
    const pendingBytes = makeValidPng(12);

    const api = new VaultApiClient();
    const email = uniqueEmail('native-diff');
    const password = 'UserPass!2026';
    await api.register({
      email,
      password,
      displayName: 'Native Diff',
      encryptionMode: 'server_side'
    });
    // Pre-upload asset 1 directly via API
    await api.uploadFile({
      filename: 'IMG_BACKED_UP.jpg',
      mimeType: 'image/jpeg',
      bytes: backedUpBytes
    });

    await injectVaultNativeMock(page, {
      assets: [
        {
          assetId: 'asset-backed',
          albumId: 'camera',
          albumName: 'Camera',
          filename: 'IMG_BACKED_UP.jpg',
          mimeType: 'image/jpeg',
          mediaKind: 'image',
          bytes: backedUpBytes
        },
        {
          assetId: 'asset-pending',
          albumId: 'camera',
          albumName: 'Camera',
          filename: 'IMG_PENDING.png',
          mimeType: 'image/png',
          mediaKind: 'image',
          bytes: pendingBytes
        }
      ]
    });

    await loginViaUi(page, { email, password });
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();

    await expect(page.getByText('IMG_BACKED_UP.jpg')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('IMG_PENDING.png')).toBeVisible({ timeout: 10_000 });

    const backedCard = page.locator('.queue-card, .device-row, li, tr').filter({ hasText: 'IMG_BACKED_UP.jpg' }).first();
    const pendingCard = page.locator('.queue-card, .device-row, li, tr').filter({ hasText: 'IMG_PENDING.png' }).first();

    await expect(backedCard.getByText(/Đã sao lưu/)).toBeVisible();
    await expect(pendingCard.getByText(/Chưa sao lưu/)).toBeVisible();
  });

  test('B4a: Native upload stops before sending a part if Wi-Fi drops while reading it', async ({ page }) => {
    await injectVaultNativeMock(page, {
      assets: [{
        assetId: 'wifi-drop',
        albumId: 'camera',
        albumName: 'Camera',
        filename: 'wifi-drop.png',
        mimeType: 'image/png',
        mediaKind: 'image',
        bytes: makeValidPng(22)
      }]
    });
    await registerViaUi(page, {
      displayName: 'Wi-Fi Drops',
      email: uniqueEmail('wifi-drop'),
      password: 'UserPass!2026'
    });
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();
    const backup = page.getByRole('button', { name: 'Sao lưu 1 mục chưa sao lưu' });
    await expect(backup).toBeEnabled();

    await page.evaluate(() => {
      const win = window as typeof window & {
        __VAULT_NATIVE_MOCK__: { readAssetSlice: (input: unknown) => Promise<unknown> };
        __VAULT_NATIVE_MOCK_STATE__: {
          setNetwork: (network: { connected: boolean; type: 'cellular'; isWifi: boolean }) => void;
        };
      };
      const bridge = win.__VAULT_NATIVE_MOCK__;
      const read = bridge.readAssetSlice.bind(bridge);
      bridge.readAssetSlice = async (input) => {
        const result = await read(input);
        win.__VAULT_NATIVE_MOCK_STATE__.setNetwork({ connected: true, type: 'cellular', isWifi: false });
        return result;
      };
    });
    const partUploads: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT') partUploads.push(request.url());
    });

    await backup.click();
    await expect(page.getByText(/Không có kết nối Wi-Fi — Đã tạm khóa sao lưu/)).toBeVisible();
    await expect(backup).toBeDisabled();
    expect(partUploads).toEqual([]);
  });

  test('B4: Native mock Wi-Fi backup reads slices & SHA-256 and uploads unbacked media to vault', async ({
    page
  }) => {
    const newPhoto = makeValidJpegWithExif(21, 'WifiUploadCam');

    await injectVaultNativeMock(page, {
      network: { connected: true, type: 'wifi', isWifi: true },
      assets: [
        {
          assetId: 'asset-wifi-1',
          albumId: 'camera',
          albumName: 'Camera',
          filename: 'IMG_WIFI_BACKUP.jpg',
          mimeType: 'image/jpeg',
          mediaKind: 'image',
          bytes: newPhoto
        }
      ]
    });

    const email = uniqueEmail('native-wifi-up');
    await registerViaUi(page, { displayName: 'Native Wi-Fi', email, password: 'UserPass!2026' });
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();

    await expect(page.getByText('IMG_WIFI_BACKUP.jpg')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Sao lưu.*chưa sao lưu|Bắt đầu sao lưu/i }).first().click();

    const wifiCard = page
      .locator('.queue-card, .device-row, li, tr')
      .filter({ hasText: 'IMG_WIFI_BACKUP.jpg' })
      .first();
    await expect(wifiCard.getByText(/Đã sao lưu|Đã xác minh gốc/)).toBeVisible({ timeout: 15_000 });

    const api = new VaultApiClient();
    await api.login({ email, password: 'UserPass!2026' });
    const mediaList = await api.listMedia();
    expect(mediaList.status).toBe(200);
    expect(mediaList.data.items.some((m) => m.originalFilename === 'IMG_WIFI_BACKUP.jpg')).toBe(true);

    const calls = await getNativeCallLog(page);
    const methods = calls.map((c) => c.method);
    expect(methods).toContain('getNetworkStatus');
    expect(methods).toContain('computeAssetSha256');
    expect(methods).toContain('readAssetSlice');
  });

  test('B5: Native mock lossless download saves directly via saveOriginalToGallery with matching SHA-256', async ({
    page
  }) => {
    const originalJpeg = makeValidJpegWithExif(44, 'GallerySaveCam');
    const expectedSha = sha256Hex(originalJpeg);

    const api = new VaultApiClient();
    const email = uniqueEmail('native-save');
    const password = 'UserPass!2026';
    await api.register({
      email,
      password,
      displayName: 'Native Save',
      encryptionMode: 'server_side'
    });
    await api.uploadFile({
      filename: 'SAVE_TO_GALLERY.jpg',
      mimeType: 'image/jpeg',
      bytes: originalJpeg
    });

    await injectVaultNativeMock(page, {
      network: { connected: true, type: 'wifi', isWifi: true },
      assets: []
    });

    await loginViaUi(page, { email, password });
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' }).click();
    await page.locator('.tile').first().click();

    await page.getByRole('button', { name: 'Tải file gốc' }).click();

    await expect
      .poll(async () => (await getSavedToGallery(page)).length, { timeout: 10_000 })
      .toBe(1);

    const saved = await getSavedToGallery(page);
    expect(saved[0]!.filename).toBe('SAVE_TO_GALLERY.jpg');
    expect(saved[0]!.mimeType).toBe('image/jpeg');
    expect(saved[0]!.mediaKind).toBe('image');
    expect(saved[0]!.sha256).toBe(expectedSha);
    expect(saved[0]!.sizeBytes).toBe(originalJpeg.length);
  });
});

// ============================================================================
// FEATURE AREA C: Auth & RBAC Separation (R4, F5, F6) — 5 Tests
// ============================================================================
test.describe('Tier 1 — Area C: Auth & RBAC Separation (R4, F5, F6)', () => {
  test('C1: Public UI & API registration creates User role only with no role selection UI', async ({
    page
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Tạo tài khoản' }).click();

    // Ensure no role picker or admin role selector exists on public registration page
    await expect(page.locator('select[name="role"], input[name="role"], input[name="isAdmin"]')).toHaveCount(0);
    await expect(page.getByText(/tự động nhận vai trò quản trị/i)).toHaveCount(0);

    const email = uniqueEmail('public-reg');
    await registerViaUi(page, { displayName: 'Public User', email, password: 'UserPass!2026' });

    const api = new VaultApiClient();
    const loginRes = await api.login({ email, password: 'UserPass!2026' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.data.user.roles).toEqual(['user']);
  });

  test('C2: Post-login User routes directly to personal UserVaultShell (Thư viện, Album, Kho) with no Admin link', async ({
    page
  }) => {
    const email = uniqueEmail('user-shell');
    await registerViaUi(page, { displayName: 'Vault User', email, password: 'UserPass!2026' });

    const nav = page.locator('nav[aria-label="Điều hướng"]');
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Thư viện' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Album' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Kho' })).toBeVisible();

    await nav.getByRole('button', { name: 'Kho' }).click();
    await expect(page.getByRole('button', { name: /Quản lý Multi-Cloud Pool/ })).toHaveCount(0);
  });

  test('C3: Post-login Admin routes directly to dedicated AdminShell with NO personal Thư viện/Album views', async ({
    page
  }) => {
    const admin = loadBootstrapCreds();
    await loginViaUi(page, { email: admin.adminEmail, password: admin.adminPassword });

    // Dedicated AdminShell should be visible immediately without entering Kho -> Admin link
    await expect(page.getByText(/Ranh giới quyền riêng tư Admin/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Quản lý tài khoản/)).toBeVisible();

    // Admin must NOT have personal media tabs (Thư viện / Album)
    await expect(page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' })).toHaveCount(0);
    await expect(page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Album' })).toHaveCount(0);
  });

  test('C4: Regular User is rejected with 403 across all Admin APIs', async () => {
    const api = new VaultApiClient();
    await api.register({
      email: uniqueEmail('rbac-user'),
      password: 'UserPass!2026',
      displayName: 'RBAC User',
      encryptionMode: 'server_side'
    });

    const admin = loadBootstrapCreds();
    const endpoints: Array<[string, string, unknown?]> = [
      ['GET', '/api/v1/admin/overview'],
      ['GET', '/api/v1/admin/users'],
      ['PATCH', `/api/v1/admin/users/${admin.adminUserId}`, { quotaBytes: TEN_GIB * 2 }],
      ['GET', '/api/v1/admin/settings'],
      ['PATCH', '/api/v1/admin/settings', { registration_enabled: false }],
      ['GET', '/api/v1/admin/storage/pool'],
      ['POST', '/api/v1/admin/storage/pool/test', { name: 'x', slot: 'copy1_primary', provider: 'local', capacityBytes: 1000 }],
      ['POST', '/api/v1/admin/storage/pool/nodes', { name: 'x', slot: 'copy1_primary', provider: 'local', capacityBytes: 1000, localRoot: '/tmp/x' }],
      ['DELETE', '/api/v1/admin/storage/pool/nodes/00000000-0000-4000-8000-000000000000'],
      ['POST', '/api/v1/admin/storage/migrate', { fromNodeId: '00000000-0000-4000-8000-000000000000', toNodeId: '00000000-0000-4000-8000-000000000001' }],
      ['POST', '/api/v1/admin/replication/run'],
      ['GET', '/api/v1/admin/integrity/summary'],
      ['POST', '/api/v1/admin/integrity/scan']
    ];

    for (const [method, pathUrl, body] of endpoints) {
      const res = await api.rawRequest(method, pathUrl, body);
      expect(res.status, `Expected 403 for ${method} ${pathUrl}`).toBe(403);
    }
  });

  test('C5: Admin is blocked (403/404) from User personal media/stream/download/verify and Admin users omits E2EE secrets', async () => {
    const userApi = new VaultApiClient();
    await userApi.register({
      email: uniqueEmail('victim-user'),
      password: 'UserPass!2026',
      displayName: 'Victim User',
      encryptionMode: 'e2ee',
      e2eeKeySalt: 'dGVzdC1zYWx0LTE2Ynl0ZXM=',
      e2eeEncryptedMasterKey: 'dGVzdC1lbmNyeXB0ZWQtbWFzdGVyLWtleQ==',
      e2eeKdfParams: { algorithm: 'PBKDF2', iterations: 310000 }
    });

    const upload = await userApi.uploadFile({
      filename: 'private-user-photo.png',
      mimeType: 'image/png',
      bytes: makeValidPng(55),
      encryptedFileKey: 'wrapped-key',
      encryptionIv: 'iv-1234'
    });
    const mediaId = upload.completeRes!.data.media.id;

    const admin = loadBootstrapCreds();
    const adminApi = new VaultApiClient(admin.apiBaseUrl, admin.adminAccessToken);

    const streamRes = await adminApi.streamMedia(mediaId);
    expect([403, 404]).toContain(streamRes.status);

    const dlRes = await adminApi.downloadMedia(mediaId);
    expect([403, 404]).toContain(dlRes.status);

    const verifyRes = await adminApi.verifyMedia(mediaId);
    expect([403, 404]).toContain(verifyRes.status);

    const usersRes = await adminApi.adminUsers();
    expect(usersRes.status).toBe(200);
    const serialized = JSON.stringify(usersRes.data);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('password_hash');
    expect(serialized).not.toContain('e2eeKeySalt');
    expect(serialized).not.toContain('e2eeEncryptedMasterKey');
    expect(serialized).not.toContain('dGVzdC1lbmNyeXB0ZWQtbWFzdGVyLWtleQ==');
  });
});

// ============================================================================
// FEATURE AREA D: >10 GB Quota & Multi-Cloud Storage Pool (R5, F1–F4, F7) — 5 Tests
// ============================================================================
test.describe('Tier 1 — Area D: >10 GB Quota & Multi-Cloud Storage Pool (R5, F1–F4, F7)', () => {
  test('D1: Default quotaBytes for new accounts is strictly > 10 GiB (10737418240 bytes)', async () => {
    const api = new VaultApiClient();
    const reg = await api.register({
      email: uniqueEmail('quota-default'),
      password: 'UserPass!2026',
      displayName: 'Default Quota User',
      encryptionMode: 'server_side'
    });
    expect(reg.status).toBe(201);
    expect(reg.data.user.quotaBytes).toBeGreaterThan(TEN_GIB);

    const me = await api.me();
    expect(me.status).toBe(200);
    expect(me.data.user.quotaBytes).toBeGreaterThan(TEN_GIB);
  });

  test('D2: Admin updates User quotaBytes via API and Admin UI quota editor', async ({ page }) => {
    const userApi = new VaultApiClient();
    const targetEmail = uniqueEmail('quota-edit');
    const reg = await userApi.register({
      email: targetEmail,
      password: 'UserPass!2026',
      displayName: 'Quota Target',
      encryptionMode: 'server_side'
    });
    const userId = reg.data.user.id;

    // 1. API quota update (50 GiB)
    const admin = loadBootstrapCreds();
    const adminApi = new VaultApiClient(admin.apiBaseUrl, admin.adminAccessToken);
    const fiftyGib = 50 * 1024 * 1024 * 1024;
    const patchRes = await adminApi.adminUpdateUser(userId, { quotaBytes: fiftyGib });
    expect(patchRes.status).toBe(200);

    const meAfterApi = await userApi.me();
    expect(meAfterApi.data.user.quotaBytes).toBe(fiftyGib);

    // 2. Admin UI per-user quota editor (F7)
    await loginViaUi(page, { email: admin.adminEmail, password: admin.adminPassword });
    await openAdminConsole(page);

    const userRow = findAdminUserContainer(page, targetEmail);
    await expect(userRow).toBeVisible();

    const editQuotaBtn = userRow.getByRole('button', { name: /Chỉnh quota/i });
    if (await editQuotaBtn.isVisible().catch(() => false)) {
      await editQuotaBtn.click();
    }
    const quotaInput = userRow.locator('input[type="number"], input[aria-label*="quota" i], input[aria-label*="hạn mức" i]').first();
    await expect(quotaInput).toBeVisible();
    await quotaInput.fill('250');
    await userRow.getByRole('button', { name: /Lưu|Cập nhật/i }).click();

    await expect
      .poll(async () => (await userApi.me()).data.user.quotaBytes, { timeout: 10_000 })
      .toBe(250 * 1024 * 1024 * 1024);
  });

  test('D3: POST /admin/storage/pool/test executes real live S3 and WebDAV write/read/delete probes', async () => {
    const mock = await startMockCloudServers();
    try {
      const admin = loadBootstrapCreds();
      const adminApi = new VaultApiClient(admin.apiBaseUrl, admin.adminAccessToken);

      const s3Probe = await adminApi.adminTestPoolDraft({
        name: 'Probe S3',
        slot: 'copy1_primary',
        provider: 'minio',
        capacityBytes: 20 * 1024 * 1024 * 1024,
        endpoint: mock.s3Endpoint,
        region: 'us-east-1',
        bucket: 'probe-s3-bucket',
        accessKeyId: mock.s3AccessKey,
        secretAccessKey: mock.s3SecretKey,
        forcePathStyle: true
      });
      expect(s3Probe.status).toBe(200);
      expect(s3Probe.data.result.ok).toBe(true);
      expect(s3Probe.data.result.checks).toEqual({ write: true, readVerify: true, delete: true });
      expect(mock.s3Requests.length).toBeGreaterThanOrEqual(3);

      const davProbe = await adminApi.adminTestPoolDraft({
        name: 'Probe WebDAV',
        slot: 'copy1_primary',
        provider: 'infinicloud_webdav',
        capacityBytes: 20 * 1024 * 1024 * 1024,
        endpoint: mock.webdavEndpoint,
        bucket: 'probe-dav-dir',
        accessKeyId: mock.webdavUsername,
        secretAccessKey: mock.webdavPassword
      });
      expect(davProbe.status).toBe(200);
      expect(davProbe.data.result.ok).toBe(true);
      expect(davProbe.data.result.checks).toEqual({ write: true, readVerify: true, delete: true });
      expect(mock.webdavRequests.length).toBeGreaterThanOrEqual(3);
    } finally {
      await mock.close();
    }
  });

  test('D4: Adding S3 + WebDAV nodes aggregates Storage Pool capacity strictly > 10 GB', async () => {
    const stack = await startIsolatedStack();
    const mock = await startMockCloudServers();
    try {
      await stack.client.register({
        email: uniqueEmail('pool-admin'),
        password: 'AdminPass!2026',
        displayName: 'Pool Admin',
        encryptionMode: 'server_side'
      });

      const s3Node = await stack.client.adminCreatePoolNode({
        name: 'Mock S3 15GB',
        slot: 'copy1_primary',
        provider: 'cloudflare_r2',
        priority: 10,
        capacityBytes: 15 * 1024 * 1024 * 1024,
        endpoint: mock.s3Endpoint,
        region: 'auto',
        bucket: 'pool-r2',
        accessKeyId: mock.s3AccessKey,
        secretAccessKey: mock.s3SecretKey,
        forcePathStyle: true
      });
      expect(s3Node.status).toBe(201);

      const davNode = await stack.client.adminCreatePoolNode({
        name: 'Mock WebDAV 20GB',
        slot: 'copy1_primary',
        provider: 'infinicloud_webdav',
        priority: 20,
        capacityBytes: 20 * 1024 * 1024 * 1024,
        endpoint: mock.webdavEndpoint,
        bucket: 'pool-dav',
        accessKeyId: mock.webdavUsername,
        secretAccessKey: mock.webdavPassword
      });
      expect(davNode.status).toBe(201);

      const poolRes = await stack.client.adminGetStoragePool();
      expect(poolRes.status).toBe(200);
      expect(poolRes.data.nodes.length).toBe(2);
      expect(poolRes.data.summary.bySlot.copy1_primary!.totalCapacityBytes).toBe(
        35 * 1024 * 1024 * 1024
      );
      expect(poolRes.data.summary.grandTotalCapacityBytes).toBeGreaterThan(TEN_GIB);
    } finally {
      await mock.close();
      await stack.close();
    }
  });

  test('D5: Real write, read, delete & auto-sharding across Local + Mock S3 + Mock WebDAV pool nodes', async () => {
    const stack = await startIsolatedStack();
    const mock = await startMockCloudServers();
    const extraLocalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smb-e2e-pool-local-'));
    try {
      await stack.client.register({
        email: uniqueEmail('shard-admin'),
        password: 'AdminPass!2026',
        displayName: 'Shard Admin',
        encryptionMode: 'server_side'
      });

      // Local node: 10 KB (priority 1)
      const localNode = await stack.client.adminCreatePoolNode({
        name: 'Local Small 10KB',
        slot: 'copy1_primary',
        provider: 'local',
        priority: 1,
        capacityBytes: 10 * 1024,
        localRoot: extraLocalRoot
      });
      expect(localNode.status).toBe(201);

      // S3 node: 10 KB (priority 2)
      const s3Node = await stack.client.adminCreatePoolNode({
        name: 'S3 Small 10KB',
        slot: 'copy1_primary',
        provider: 'minio',
        priority: 2,
        capacityBytes: 10 * 1024,
        endpoint: mock.s3Endpoint,
        region: 'us-east-1',
        bucket: 'shard-s3',
        accessKeyId: mock.s3AccessKey,
        secretAccessKey: mock.s3SecretKey,
        forcePathStyle: true
      });
      expect(s3Node.status).toBe(201);

      // WebDAV node: 100 KB (priority 3)
      const davNode = await stack.client.adminCreatePoolNode({
        name: 'WebDAV 100KB',
        slot: 'copy1_primary',
        provider: 'webdav_custom',
        priority: 3,
        capacityBytes: 100 * 1024,
        endpoint: mock.webdavEndpoint,
        bucket: 'shard-dav',
        accessKeyId: mock.webdavUsername,
        secretAccessKey: mock.webdavPassword
      });
      expect(davNode.status).toBe(201);

      // Upload 3 x ~6 KB files so each fills a node and spills to next node
      const file1 = makeValidPng(101, 5800);
      const file2 = makeValidPng(102, 5800);
      const file3 = makeValidPng(103, 5800);
      expect(file1.length).toBeGreaterThan(5500);
      expect(file1.length).toBeLessThan(9500);

      const u1 = await stack.client.uploadFile({ filename: 'shard1.png', mimeType: 'image/png', bytes: file1 });
      const u2 = await stack.client.uploadFile({ filename: 'shard2.png', mimeType: 'image/png', bytes: file2 });
      const u3 = await stack.client.uploadFile({ filename: 'shard3.png', mimeType: 'image/png', bytes: file3 });

      expect(u1.completeRes!.status).toBe(200);
      expect(u2.completeRes!.status).toBe(200);
      expect(u3.completeRes!.status).toBe(200);

      // Verify bytes landed across Local, S3, and WebDAV
      const localFiles = fs
        .readdirSync(extraLocalRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile());
      expect(localFiles.length).toBeGreaterThanOrEqual(1);
      expect(mock.s3Objects.size).toBe(1);
      expect(mock.webdavObjects.size).toBe(1);

      // Download all 3 bit-for-bit
      const d1 = await stack.client.downloadMedia(u1.completeRes!.data.media.id);
      const d2 = await stack.client.downloadMedia(u2.completeRes!.data.media.id);
      const d3 = await stack.client.downloadMedia(u3.completeRes!.data.media.id);
      expect(d1.rawBytes.equals(file1)).toBe(true);
      expect(d2.rawBytes.equals(file2)).toBe(true);
      expect(d3.rawBytes.equals(file3)).toBe(true);
    } finally {
      await mock.close();
      await stack.close();
      fs.rmSync(extraLocalRoot, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// FEATURE AREA E: PRD Core Invariants (R1, F1, F5, F12) — 5 Tests
// ============================================================================
test.describe('Tier 1 — Area E: PRD Core Invariants (R1, F1, F5, F12)', () => {
  test('E1: 1-way backup invariant — trashing & deleting from vault never removes device gallery assets', async ({
    page
  }) => {
    const devPhoto = makeValidPng(71);
    await injectVaultNativeMock(page, {
      assets: [
        {
          assetId: 'dev-keep-1',
          albumId: 'camera',
          albumName: 'Camera',
          filename: 'KEEP_ON_DEVICE.png',
          mimeType: 'image/png',
          mediaKind: 'image',
          bytes: devPhoto
        }
      ]
    });

    const email = uniqueEmail('oneway-prd');
    await registerViaUi(page, { displayName: 'OneWay PRD', email, password: 'UserPass!2026' });

    // Upload via web or native
    await uploadFileViaWebUi(page, {
      filename: 'KEEP_ON_DEVICE.png',
      mimeType: 'image/png',
      bytes: devPhoto
    });

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' }).click();
    await page.locator('.tile').first().click();
    await page.getByRole('button', { name: 'Thông tin ảnh' }).click();
    await page.getByRole('button', { name: 'Chuyển vào Thùng rác' }).click();

    await expect(page.locator('.tile')).toHaveCount(0);

    // Device mock gallery asset MUST remain completely untouched
    const deviceAssets = await getNativeAssets(page);
    expect(deviceAssets).toHaveLength(1);
    expect(deviceAssets[0]!.assetId).toBe('dev-keep-1');
  });

  test('E2: 100% original bytes & EXIF APP1 metadata preserved bit-for-bit on download', async () => {
    const api = new VaultApiClient();
    await api.register({
      email: uniqueEmail('exif-prd'),
      password: 'UserPass!2026',
      displayName: 'EXIF PRD',
      encryptionMode: 'server_side'
    });

    const jpegWithExif = makeValidJpegWithExif(88, 'CanonEOSR5');
    const expectedSha = sha256Hex(jpegWithExif);
    const up = await api.uploadFile({
      filename: 'IMG_EXIF.jpg',
      mimeType: 'image/jpeg',
      bytes: jpegWithExif
    });
    const mediaId = up.completeRes!.data.media.id;

    const dl = await api.downloadMedia(mediaId);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('x-content-sha256')).toBe(expectedSha);
    expect(dl.rawBytes.equals(jpegWithExif)).toBe(true);
    expect(dl.rawBytes.includes(Buffer.from('CanonEOSR5'))).toBe(true);
    expect(dl.rawBytes.includes(Buffer.from('Exif\0\0'))).toBe(true);
  });

  test('E3: E2EE mode stores ciphertext on server and decrypts exact original bytes on client unlock', async ({
    page
  }) => {
    const email = uniqueEmail('e2ee-roundtrip');
    const password = 'UserPass!2026';
    const e2eePass = 'SuperSecretE2EE!2026';
    const originalPng = makeValidPng(91);
    const originalSha = sha256Hex(originalPng);

    await registerViaUi(page, {
      displayName: 'E2EE User',
      email,
      password,
      encryptionMode: 'e2ee',
      e2eePassphrase: e2eePass
    });

    await uploadFileViaWebUi(page, {
      filename: 'secret-e2ee.png',
      mimeType: 'image/png',
      bytes: originalPng
    });

    // Verify via API that server holds ciphertext (server SHA != original plaintext SHA)
    const api = new VaultApiClient();
    await api.login({ email, password });
    const mediaList = await api.listMedia();
    expect(mediaList.data.items.length).toBe(1);
    const mediaId = mediaList.data.items[0]!.id;
    const serverDl = await api.downloadMedia(mediaId);
    expect(serverDl.status).toBe(200);
    expect(serverDl.rawBytes.equals(originalPng)).toBe(false);
    expect(sha256Hex(serverDl.rawBytes)).not.toBe(originalSha);

    // Reload browser (clears volatile Master Key), re-login, unlock E2EE, and download decrypted original
    await page.evaluate(() => localStorage.clear());
    await loginViaUi(page, { email, password });
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Khóa giải mã E2EE/ }).click();
    await page.getByLabel('Mật khẩu khóa E2EE').fill(e2eePass);
    await page.getByRole('button', { name: 'Mở khóa', exact: true }).click();
    await expect(page.getByText(/Đã mở khóa/)).toBeVisible();

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' }).click();
    await page.locator('.tile').first().click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Tải file gốc' }).click()
    ]);
    const decryptedBytes = await readDownloadBuffer(download);
    expect(sha256Hex(decryptedBytes)).toBe(originalSha);
    expect(decryptedBytes.equals(originalPng)).toBe(true);
  });

  test('E4: PRD policy locks indefinite retention, wifi_only, and disables search/sharing/GPS map', async ({
    page
  }) => {
    const api = new VaultApiClient();
    const email = uniqueEmail('prd-flags');
    const password = 'UserPass!2026';
    await api.register({ email, password, displayName: 'PRD Flags', encryptionMode: 'server_side' });

    const me = await api.me();
    expect(me.status).toBe(200);
    expect(me.data.policies.uploadNetworkPolicy).toBe('wifi_only');
    expect(me.data.policies.retentionPolicy).toBe('indefinite_manual_delete');
    expect(me.data.policies.gpsMapEnabled).toBe(false);
    expect(me.data.policies.searchEnabled).toBe(false);
    expect(me.data.policies.sharingEnabled).toBe(false);

    // Check UI does not expose Search, Share, or GPS map controls
    await loginViaUi(page, { email, password });
    await expect(page.locator('input[type="search"], input[placeholder*="Tìm kiếm" i]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Chia sẻ|Share|Bản đồ GPS/i })).toHaveCount(0);
  });

  test('E5: Strict per-tenant isolation — User B receives 404 on User A media/devices and never sees User A duplicates', async () => {
    const userA = new VaultApiClient();
    await userA.register({
      email: uniqueEmail('tenant-a'),
      password: 'UserPass!2026',
      displayName: 'Tenant A',
      encryptionMode: 'server_side'
    });
    const privateMp4 = makeValidMp4(99);
    const privateSha = sha256Hex(privateMp4);
    const up = await userA.uploadFile({
      filename: 'tenant-a-video.mp4',
      mimeType: 'video/mp4',
      bytes: privateMp4
    });
    const mediaA = up.completeRes!.data.media.id;
    const devicesA = await userA.listDevices();
    const deviceA = devicesA.data.devices[0]!.id;

    const userB = new VaultApiClient();
    await userB.register({
      email: uniqueEmail('tenant-b'),
      password: 'UserPass!2026',
      displayName: 'Tenant B',
      encryptionMode: 'server_side'
    });

    expect((await userB.streamMedia(mediaA)).status).toBe(404);
    expect((await userB.downloadMedia(mediaA)).status).toBe(404);
    expect((await userB.verifyMedia(mediaA)).status).toBe(404);
    expect((await userB.trashMedia(mediaA)).status).toBe(404);
    expect((await userB.revokeDevice(deviceA)).status).toBe(404);

    // Cross-tenant duplicate check MUST return 'new' (never leak User A's SHA-256)
    const dupRes = await userB.checkDuplicates([
      {
        clientRef: 'probe-1',
        sha256: privateSha,
        sizeBytes: privateMp4.length,
        originalFilename: 'tenant-a-video.mp4'
      }
    ]);
    expect(dupRes.status).toBe(200);
    expect(dupRes.data.results[0]!.status).toBe('new');
  });
});
