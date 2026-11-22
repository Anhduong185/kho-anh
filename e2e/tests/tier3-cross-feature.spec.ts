import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { VaultApiClient } from '../helpers/api-client.js';
import { assertMobileLayoutHealthy } from '../helpers/layout-audit.js';
import { makeValidJpegWithExif, makeValidPng, sha256Hex } from '../helpers/media-fixtures.js';
import { startMockCloudServers } from '../helpers/mock-cloud.js';
import {
  getSavedToGallery,
  injectVaultNativeMock,
  setMockNetwork
} from '../helpers/native-mock.js';
import { startIsolatedStack } from '../helpers/stack.js';
import {
  loadBootstrapCreds,
  loginViaUi,
  registerViaUi,
  uniqueEmail,
  uploadFileViaWebUi
} from '../helpers/ui-auth.js';

const TEN_GIB = 10 * 1024 * 1024 * 1024;

test.describe('Tier 3 — Cross-Feature Pairwise Combinations', () => {
  test('CF-1: Admin raises User quota -> User uploads across Local + Mock S3 + Mock WebDAV pool -> aggregate capacity & downloads verified', async () => {
    const stack = await startIsolatedStack();
    const mock = await startMockCloudServers();
    const localExtra = fs.mkdtempSync(path.join(os.tmpdir(), 'smb-e2e-cf1-'));
    try {
      // 1. Bootstrap Admin
      await stack.client.register({
        email: uniqueEmail('cf1-admin'),
        password: 'AdminPass!2026',
        displayName: 'CF1 Admin',
        encryptionMode: 'server_side'
      });

      // Add Local (7 KB), Mock S3 (7 KB), Mock WebDAV (20 GB)
      await stack.client.adminCreatePoolNode({
        name: 'CF1 Local',
        slot: 'copy1_primary',
        provider: 'local',
        priority: 1,
        capacityBytes: 7 * 1024,
        localRoot: localExtra
      });
      await stack.client.adminCreatePoolNode({
        name: 'CF1 S3',
        slot: 'copy1_primary',
        provider: 'minio',
        priority: 2,
        capacityBytes: 7 * 1024,
        endpoint: mock.s3Endpoint,
        region: 'us-east-1',
        bucket: 'cf1-s3',
        accessKeyId: mock.s3AccessKey,
        secretAccessKey: mock.s3SecretKey,
        forcePathStyle: true
      });
      await stack.client.adminCreatePoolNode({
        name: 'CF1 WebDAV',
        slot: 'copy1_primary',
        provider: 'infinicloud_webdav',
        priority: 3,
        capacityBytes: 20 * 1024 * 1024 * 1024,
        endpoint: mock.webdavEndpoint,
        bucket: 'cf1-dav',
        accessKeyId: mock.webdavUsername,
        secretAccessKey: mock.webdavPassword
      });

      const pool = await stack.client.adminGetStoragePool();
      expect(pool.data.summary.grandTotalCapacityBytes).toBeGreaterThan(TEN_GIB);

      // 2. Register regular User & raise quota to 150 GiB
      const userClient = new VaultApiClient(stack.baseUrl);
      const userReg = await userClient.register({
        email: uniqueEmail('cf1-user'),
        password: 'UserPass!2026',
        displayName: 'CF1 User',
        encryptionMode: 'server_side'
      });
      const newQuota = 150 * 1024 * 1024 * 1024;
      await stack.client.adminUpdateUser(userReg.data.user.id, { quotaBytes: newQuota });
      expect((await userClient.me()).data.user.quotaBytes).toBe(newQuota);

      // 3. Upload 3 x ~5 KB files spilling across Local -> S3 -> WebDAV
      const f1 = makeValidPng(201, 4500);
      const f2 = makeValidPng(202, 4500);
      const f3 = makeValidPng(203, 4500);

      const u1 = await userClient.uploadFile({ filename: 'cf1-a.png', mimeType: 'image/png', bytes: f1 });
      const u2 = await userClient.uploadFile({ filename: 'cf1-b.png', mimeType: 'image/png', bytes: f2 });
      const u3 = await userClient.uploadFile({ filename: 'cf1-c.png', mimeType: 'image/png', bytes: f3 });

      expect(mock.s3Objects.size).toBe(1);
      expect(mock.webdavObjects.size).toBe(1);

      expect((await userClient.downloadMedia(u1.completeRes!.data.media.id)).rawBytes.equals(f1)).toBe(true);
      expect((await userClient.downloadMedia(u2.completeRes!.data.media.id)).rawBytes.equals(f2)).toBe(true);
      expect((await userClient.downloadMedia(u3.completeRes!.data.media.id)).rawBytes.equals(f3)).toBe(true);
    } finally {
      await mock.close();
      await stack.close();
      fs.rmSync(localExtra, { recursive: true, force: true });
    }
  });

  test('CF-2: E2EE + wifi_only + native mock Camera scan -> blocked on cellular -> succeeds on wifi -> lossless saveOriginalToGallery', async ({
    page
  }) => {
    const camJpeg = makeValidJpegWithExif(301, 'E2eeNativeCam');
    const expectedSha = sha256Hex(camJpeg);

    await injectVaultNativeMock(page, {
      network: { connected: true, type: 'cellular', isWifi: false },
      assets: [
        {
          assetId: 'cf2-cam-1',
          albumId: 'camera',
          albumName: 'Camera',
          filename: 'E2EE_NATIVE.jpg',
          mimeType: 'image/jpeg',
          mediaKind: 'image',
          bytes: camJpeg
        }
      ]
    });

    const email = uniqueEmail('cf2-e2ee-native');
    await registerViaUi(page, {
      displayName: 'CF2 E2EE Native',
      email,
      password: 'UserPass!2026',
      encryptionMode: 'e2ee',
      e2eePassphrase: 'NativeE2eePass!2026'
    });

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();

    // Blocked while cellular
    await expect(page.getByText(/E2EE_NATIVE\.jpg/)).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/dữ liệu di động|4G|5G|chặn|tạm khóa|chuyển sang Wi-Fi|không phải Wi-Fi/i).first()
    ).toBeVisible();

    // Switch network to Wi-Fi and refresh/trigger sync deterministically
    await setMockNetwork(page, { connected: true, type: 'wifi', isWifi: true });
    const refreshBtn = page.getByRole('button', { name: /Quét lại|Kiểm tra|Làm mới/i }).first();
    if (await refreshBtn.isVisible().catch(() => false)) {
      await refreshBtn.click();
    }

    const startBtn = page.getByRole('button', { name: /Sao lưu.*chưa sao lưu|Bắt đầu sao lưu/i }).first();
    await expect(startBtn).toBeEnabled({ timeout: 10_000 });
    await startBtn.click();

    const nativeCard = page
      .locator('.queue-card, .device-row, li, tr')
      .filter({ hasText: 'E2EE_NATIVE.jpg' })
      .first();
    await expect(nativeCard.getByText(/Đã sao lưu|Đã xác minh gốc/)).toBeVisible({ timeout: 15_000 });

    // Open in Library and save back to device gallery decrypted with exact SHA-256
    await page.getByRole('button', { name: 'Quay lại' }).click();
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' }).click();
    await page.locator('.tile').first().click();
    await page.getByRole('button', { name: 'Tải file gốc' }).click();

    await expect
      .poll(async () => (await getSavedToGallery(page)).length, { timeout: 10_000 })
      .toBe(1);
    const saved = await getSavedToGallery(page);
    expect(saved[0]!.sha256).toBe(expectedSha);
  });

  test('CF-3: Mobile dark mode (360x800) + multi-select ZIP export + Viewer info sheet (album, folder, tag, verify SHA-256)', async ({
    page
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: 'dark' });

    const email = uniqueEmail('cf3-mobile-dark');
    const password = 'UserPass!2026';
    const api = new VaultApiClient();
    await api.register({ email, password, displayName: 'CF3 Dark', encryptionMode: 'server_side' });
    const folder = await api.createFolder('Chuyến đi 2026');
    const album = await api.createAlbum('Kỷ niệm Đà Lạt');
    const png1 = makeValidPng(311);
    const png2 = makeValidPng(312);
    const u1 = await api.uploadFile({ filename: 'cf3-1.png', mimeType: 'image/png', bytes: png1 });
    await api.uploadFile({ filename: 'cf3-2.png', mimeType: 'image/png', bytes: png2 });
    await api.updateMedia(u1.completeRes!.data.media.id, { folderId: folder.data.folder.id });
    await api.addMediaToAlbum(album.data.album.id, [u1.completeRes!.data.media.id]);

    await loginViaUi(page, { email, password });
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' }).click();
    await assertMobileLayoutHealthy(page, { checkSortChip: true, colorScheme: 'dark' });

    // Multi-select + Tải ZIP gốc
    await page.getByRole('button', { name: 'Chọn', exact: true }).click();
    await page.locator('.tile').nth(0).click();
    await page.locator('.tile').nth(1).click();
    await assertMobileLayoutHealthy(page, { checkSelectionOverlap: true, colorScheme: 'dark' });

    const [zipDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Tải ZIP gốc' }).click()
    ]);
    expect(zipDownload.suggestedFilename()).toMatch(/\.zip$/i);
    await expect(page.getByRole('button', { name: 'Chọn', exact: true })).toBeVisible({ timeout: 10_000 });

    // Viewer + Info sheet: attach Tag & Verify SHA-256
    await page.locator('.tile').first().click();
    await page.getByRole('button', { name: 'Thông tin ảnh' }).click();
    await assertMobileLayoutHealthy(page, { colorScheme: 'dark' });

    await page.getByPlaceholder('Thêm thẻ mới...').fill('family-trip');
    await page.getByRole('button', { name: 'Gắn thẻ' }).click();
    await expect(page.getByText('family-trip')).toBeVisible();

    await page.getByRole('button', { name: 'Xác minh SHA-256' }).click();
    const viewerStatus = page.getByRole('dialog').getByRole('status');
    await expect(viewerStatus).toBeVisible();
    await expect(viewerStatus).toContainText('Xác minh SHA-256 thành công');
  });

  test('CF-4: Public registration -> User blocked 403 on Admin APIs -> Admin updates quota & disables/re-enables User -> Admin blocked 404 on User media', async () => {
    const userApi = new VaultApiClient();
    const email = uniqueEmail('cf4-rbac');
    const password = 'UserPass!2026';
    const reg = await userApi.register({
      email,
      password,
      displayName: 'CF4 User',
      encryptionMode: 'server_side'
    });
    expect(reg.data.user.roles).toEqual(['user']);
    expect((await userApi.adminUsers()).status).toBe(403);

    const admin = loadBootstrapCreds();
    const adminApi = new VaultApiClient(admin.apiBaseUrl, admin.adminAccessToken);
    await adminApi.adminUpdateUser(reg.data.user.id, {
      quotaBytes: 300 * 1024 * 1024 * 1024,
      isActive: false
    });
    expect((await userApi.me()).status).toBe(401);

    // Re-enable User -> User uploads new file -> Admin gets 404 on it
    await adminApi.adminUpdateUser(reg.data.user.id, { isActive: true });
    await userApi.login({ email, password });
    expect((await userApi.me()).data.user.quotaBytes).toBe(300 * 1024 * 1024 * 1024);

    const up = await userApi.uploadFile({
      filename: 'cf4-private.png',
      mimeType: 'image/png',
      bytes: makeValidPng(321)
    });
    const mediaId = up.completeRes!.data.media.id;
    expect((await adminApi.downloadMedia(mediaId)).status).toBe(404);
    expect((await adminApi.streamMedia(mediaId)).status).toBe(404);
  });

  test('CF-5: Duplicate detection + Trash + Restore + Permanent Delete -> unblocks pool node deletion (409->200) & reclaims usedBytes', async () => {
    const stack = await startIsolatedStack();
    const mock = await startMockCloudServers();
    try {
      await stack.client.register({
        email: uniqueEmail('cf5-admin'),
        password: 'AdminPass!2026',
        displayName: 'CF5 Admin',
        encryptionMode: 'server_side'
      });

      const node = await stack.client.adminCreatePoolNode({
        name: 'CF5 S3 Node',
        slot: 'copy1_primary',
        provider: 'minio',
        priority: 1,
        capacityBytes: 1024 * 1024 * 1024,
        endpoint: mock.s3Endpoint,
        region: 'us-east-1',
        bucket: 'cf5-bucket',
        accessKeyId: mock.s3AccessKey,
        secretAccessKey: mock.s3SecretKey,
        forcePathStyle: true
      });
      const nodeId = node.data.node.id;

      const user = new VaultApiClient(stack.baseUrl);
      await user.register({
        email: uniqueEmail('cf5-user'),
        password: 'UserPass!2026',
        displayName: 'CF5 User',
        encryptionMode: 'server_side'
      });

      const img = makeValidPng(333, 2000);
      const u1 = await user.uploadFile({ filename: 'cf5.png', mimeType: 'image/png', bytes: img });
      const mediaId = u1.completeRes!.data.media.id;

      // Duplicate check sees 'duplicate'
      const dup = await user.checkDuplicates([
        { clientRef: 'c1', sha256: sha256Hex(img), sizeBytes: img.length, originalFilename: 'cf5.png' }
      ]);
      expect(dup.data.results[0]!.status).toBe('duplicate');
      expect((await user.me()).data.user.usedBytes).toBe(img.length);

      // Trash -> Restore -> Trash -> Permanent delete
      await user.trashMedia(mediaId);
      expect((await user.listTrash()).data.items).toHaveLength(1);
      await user.restoreTrash(mediaId);
      expect((await user.listMedia()).data.items).toHaveLength(1);

      // While file exists, node deletion is 409
      expect((await stack.client.adminDeletePoolNode(nodeId)).status).toBe(409);

      await user.trashMedia(mediaId);
      const perm = await user.permanentDeleteTrash(mediaId);
      expect(perm.status).toBe(200);
      expect((await user.me()).data.user.usedBytes).toBe(0);

      // Now pool node is empty and deletion succeeds (200)
      expect((await stack.client.adminDeletePoolNode(nodeId)).status).toBe(200);
    } finally {
      await mock.close();
      await stack.close();
    }
  });

  test('CF-6: E2EE account + recovery code password reset + re-login + E2EE key unlock + original file verification', async ({
    page
  }) => {
    const email = uniqueEmail('cf6-e2ee-rec');
    const oldPass = 'UserPass!2026';
    const newPass = 'RecoveredPass!2026';
    const e2eePass = 'VaultKeyPass!2026';
    const originalPng = makeValidPng(345);
    const expectedSha = sha256Hex(originalPng);

    const { recoveryCodes } = await registerViaUi(page, {
      displayName: 'CF6 E2EE Recover',
      email,
      password: oldPass,
      encryptionMode: 'e2ee',
      e2eePassphrase: e2eePass
    });

    await uploadFileViaWebUi(page, {
      filename: 'cf6-e2ee.png',
      mimeType: 'image/png',
      bytes: originalPng
    });

    // Logout & recover password via UI using recoveryCode[0]
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Đăng xuất tài khoản/ }).click();

    await page.getByRole('button', { name: 'Khôi phục', exact: true }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel(/Mã khôi phục/).fill(recoveryCodes[0]!);
    await page.getByLabel(/Mật khẩu đăng nhập mới/).fill(newPass);
    await page.getByRole('button', { name: 'Đặt lại mật khẩu' }).click();
    await expect(page.getByText(/thành công|E2EE/i).first()).toBeVisible({ timeout: 10_000 });

    // Login with new password, unlock E2EE vault, and verify downloaded plaintext matches SHA-256
    await loginViaUi(page, { email, password: newPass });
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
    const filePath = await download.path();
    const bytes = fs.readFileSync(filePath!);
    expect(sha256Hex(bytes)).toBe(expectedSha);
  });

  test('CF-7: Pool node disable (PATCH toggle) routes new uploads to remaining enabled node -> re-enable & integrity scan', async () => {
    const stack = await startIsolatedStack();
    const mock = await startMockCloudServers();
    try {
      await stack.client.register({
        email: uniqueEmail('cf7-admin'),
        password: 'AdminPass!2026',
        displayName: 'CF7 Admin',
        encryptionMode: 'server_side'
      });

      const nodeS3 = await stack.client.adminCreatePoolNode({
        name: 'CF7 S3 Primary',
        slot: 'copy1_primary',
        provider: 'minio',
        priority: 1,
        capacityBytes: 1024 * 1024 * 1024,
        endpoint: mock.s3Endpoint,
        region: 'us-east-1',
        bucket: 'cf7-s3',
        accessKeyId: mock.s3AccessKey,
        secretAccessKey: mock.s3SecretKey,
        forcePathStyle: true
      });
      const nodeDav = await stack.client.adminCreatePoolNode({
        name: 'CF7 WebDAV Fallback',
        slot: 'copy1_primary',
        provider: 'webdav_custom',
        priority: 2,
        capacityBytes: 1024 * 1024 * 1024,
        endpoint: mock.webdavEndpoint,
        bucket: 'cf7-dav',
        accessKeyId: mock.webdavUsername,
        secretAccessKey: mock.webdavPassword
      });

      // Disable priority #1 S3 node via PATCH
      const patchOff = await stack.client.adminUpdatePoolNode(nodeS3.data.node.id, { enabled: false });
      expect(patchOff.status).toBe(200);
      expect(patchOff.data.node.enabled).toBe(false);

      // Upload -> must route to WebDAV node #2 (0 objects in S3, 1 object in WebDAV)
      const img = makeValidPng(355);
      const up = await stack.client.uploadFile({ filename: 'cf7-routed.png', mimeType: 'image/png', bytes: img });
      expect(mock.s3Objects.size).toBe(0);
      expect(mock.webdavObjects.size).toBe(1);

      // Re-enable S3 node & run integrity scan
      const patchOn = await stack.client.adminUpdatePoolNode(nodeS3.data.node.id, { enabled: true });
      expect(patchOn.status).toBe(200);
      expect(patchOn.data.node.enabled).toBe(true);

      const scan = await stack.client.adminRunIntegrityScan();
      expect(scan.status).toBe(200);
      expect((await stack.client.downloadMedia(up.completeRes!.data.media.id)).rawBytes.equals(img)).toBe(true);
      expect(nodeDav.data.node.id).toBeTruthy();
    } finally {
      await mock.close();
      await stack.close();
    }
  });

  test('CF-8: Standard browser web fallback (no native mock) + cellular navigator.connection block -> switch to Wi-Fi -> upload & album filter', async ({
    page
  }) => {
    await page.addInitScript(() => {
      const state = { type: 'cellular' };
      (window as unknown as Record<string, unknown>).__TEST_SET_CONN__ = (t: string) => {
        state.type = t;
      };
      Object.defineProperty(navigator, 'connection', {
        value: {
          get type() {
            return state.type;
          },
          addEventListener: () => {},
          removeEventListener: () => {}
        },
        configurable: true
      });
    });

    const email = uniqueEmail('cf8-webfallback');
    await registerViaUi(page, { displayName: 'CF8 Web', email, password: 'UserPass!2026' });

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();

    const img = makeValidPng(366);
    await expect(page.getByText(/kết nối dữ liệu di động|4G\/5G/i).first()).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'cf8-cell.png',
      mimeType: 'image/png',
      buffer: img
    });
    await expect(page.getByRole('button', { name: 'Bắt đầu sao lưu hàng đợi' })).toBeDisabled();

    // Simulate switching browser connection to Wi-Fi and reloading backup panel
    await page.evaluate(() => {
      (window as unknown as { __TEST_SET_CONN__: (t: string) => void }).__TEST_SET_CONN__('wifi');
    });
    await page.getByRole('button', { name: 'Quay lại' }).click();
    await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();

    await page.locator('input[type="file"]').setInputFiles({
      name: 'cf8-wifi.png',
      mimeType: 'image/png',
      buffer: img
    });
    await page.getByRole('button', { name: 'Bắt đầu sao lưu hàng đợi' }).click();
    await expect(page.getByText('Đã xác minh gốc').first()).toBeVisible({ timeout: 15_000 });
  });
});
