import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { VaultApiClient } from '../helpers/api-client.js';
import { assertMobileLayoutHealthy } from '../helpers/layout-audit.js';
import {
  makeValidJpegWithExif,
  makeValidMp4,
  makeValidPng,
  sha256Hex
} from '../helpers/media-fixtures.js';
import { startMockCloudServers } from '../helpers/mock-cloud.js';
import {
  getNativeAssets,
  getSavedToGallery,
  injectVaultNativeMock
} from '../helpers/native-mock.js';
import {
  findAdminUserContainer,
  loadBootstrapCreds,
  loginViaUi,
  openAdminConsole,
  registerViaUi,
  uniqueEmail
} from '../helpers/ui-auth.js';

const TEN_GIB = 10 * 1024 * 1024 * 1024;

test.describe('Tier 4 — Real-World End-to-End Application Workflows', () => {
  test('Scenario 1: Daily Mobile Family Photo Backup Workflow (Scan Camera + Screenshots -> Diff -> Wi-Fi -> Backup -> View -> Save to Gallery -> Trash & Restore -> Device Untouched)', async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const camPhoto1 = makeValidJpegWithExif(401, 'iPhone15Pro');
    const camVideo1 = makeValidMp4(402);
    const shotPhoto1 = makeValidPng(403);

    await injectVaultNativeMock(page, {
      network: { connected: true, type: 'wifi', isWifi: true },
      assets: [
        {
          assetId: 'fam-cam-1',
          albumId: 'camera',
          albumName: 'Camera',
          filename: 'FAMILY_DINNER.jpg',
          mimeType: 'image/jpeg',
          mediaKind: 'image',
          bytes: camPhoto1
        },
        {
          assetId: 'fam-cam-2',
          albumId: 'camera',
          albumName: 'Camera',
          filename: 'BABY_STEPS.mp4',
          mimeType: 'video/mp4',
          mediaKind: 'video',
          bytes: camVideo1
        },
        {
          assetId: 'fam-shot-1',
          albumId: 'screenshots',
          albumName: 'Screenshots',
          filename: 'RECEIPT_SHOT.png',
          mimeType: 'image/png',
          mediaKind: 'image',
          bytes: shotPhoto1
        }
      ]
    });

    const email = uniqueEmail('rw-family');
    await registerViaUi(page, { displayName: 'Family User', email, password: 'UserPass!2026' });

    // Open Backup screen -> scan Camera & Screenshots -> see Chưa sao lưu
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();
    await expect(page.getByText('FAMILY_DINNER.jpg')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('RECEIPT_SHOT.png')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Chưa sao lưu/).first()).toBeVisible();

    // Backup over Wi-Fi
    await page.getByRole('button', { name: /Sao lưu.*chưa sao lưu|Bắt đầu sao lưu/i }).first().click();
    await expect(page.getByText(/Đã sao lưu|Đã xác minh gốc/).first()).toBeVisible({ timeout: 20_000 });

    // View in Thư viện & audit mobile layout ("Ngày chụp" unclipped)
    await page.getByRole('button', { name: 'Quay lại' }).click();
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' }).click();
    await assertMobileLayoutHealthy(page, { checkSortChip: true });
    await expect(page.locator('.tile')).toHaveCount(3);

    // Open photo in Viewer -> Save original directly to Gallery -> verify SHA-256
    await page.locator('.tile[aria-label="FAMILY_DINNER.jpg"]').click();
    await page.getByRole('button', { name: 'Tải file gốc' }).click();
    await expect
      .poll(async () => (await getSavedToGallery(page)).length, { timeout: 10_000 })
      .toBe(1);
    const saved = await getSavedToGallery(page);
    expect(saved[0]!.sha256).toBe(sha256Hex(camPhoto1));

    // Trash item in vault & restore it from Thùng rác -> device gallery assets remain 3 untouched
    await page.getByRole('button', { name: 'Thông tin ảnh' }).click();
    await page.getByRole('button', { name: 'Chuyển vào Thùng rác' }).click();
    await expect(page.locator('.tile')).toHaveCount(2);

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Khôi phục, Trùng lặp & Thùng rác/ }).click();
    const restoreBtn = page.getByRole('button', { name: 'Khôi phục' }).first();
    await expect(restoreBtn).toBeVisible({ timeout: 10_000 });
    await restoreBtn.click();
    await expect(page.getByRole('heading', { name: 'Thùng rác (0)' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Quay lại' }).click();

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' }).click();
    await expect(page.locator('.tile')).toHaveCount(3);
    expect(await getNativeAssets(page)).toHaveLength(3);
  });

  test('Scenario 2: Admin Multi-Cloud Pool Expansion (>10 GB) & Quota Provisioning Workflow', async ({
    page
  }) => {
    const mock = await startMockCloudServers();
    const userApi = new VaultApiClient();
    const admin = loadBootstrapCreds();
    const adminApi = new VaultApiClient(admin.apiBaseUrl, admin.adminAccessToken);
    let uploadedMediaId: string | null = null;
    try {
      const userEmail = uniqueEmail('rw-pool-user');
      const userReg = await userApi.register({
        email: userEmail,
        password: 'UserPass!2026',
        displayName: 'Pool Consumer',
        encryptionMode: 'server_side'
      });
      // Confirm default quota > 10 GiB
      expect(userReg.data.user.quotaBytes).toBeGreaterThan(TEN_GIB);

      await loginViaUi(page, { email: admin.adminEmail, password: admin.adminPassword });
      await openAdminConsole(page);

      const poolTabBtn = page.locator('nav[aria-label="Điều hướng quản trị"]').getByRole('button', { name: /Nguồn lưu trữ & Pool/ });
      if (await poolTabBtn.isVisible().catch(() => false)) {
        await poolTabBtn.click();
      }

      // Add Mock S3 node (20 GB) via Admin Pool UI
      await page.getByRole('button', { name: /\+ Thêm kho Cloud/ }).click();
      await page.locator('select').first().selectOption('minio');
      await page.locator('input[name="pool_node_name"]').fill('RW Mock S3 20GB');
      await page.getByLabel('Hạn mức dung lượng kho (GB)').fill('20');
      await page.getByLabel('S3 Endpoint URL').fill(mock.s3Endpoint);
      await page.getByLabel('Tên Bucket (Private)').fill('rw-s3-bucket');
      await page.locator('input[name="pool_access_key"]').fill(mock.s3AccessKey);
      await page.locator('input[name="pool_secret_key"]').fill(mock.s3SecretKey);
      await page.getByRole('button', { name: 'Kiểm tra kết nối trước khi lưu' }).click();
      await expect(page.getByText(/Kết nối OK/)).toBeVisible({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Lưu & Gắn vào Pool ngay' }).click();
      await expect(page.getByText('RW Mock S3 20GB', { exact: true })).toBeVisible({ timeout: 10_000 });

      // Add Mock WebDAV node (30 GB) via Admin Pool UI
      await page.getByRole('button', { name: /\+ Thêm kho Cloud/ }).click();
      await page.locator('select').first().selectOption('infinicloud_webdav');
      await page.locator('input[name="pool_node_name"]').fill('RW Mock WebDAV 30GB');
      await page.getByLabel('Hạn mức dung lượng kho (GB)').fill('30');
      await page.getByLabel('WebDAV Endpoint URL').fill(mock.webdavEndpoint);
      await page.getByLabel('Thư mục gốc trên WebDAV').fill('rw-dav-folder');
      await page.locator('input[name="pool_access_key"]').fill(mock.webdavUsername);
      await page.locator('input[name="pool_secret_key"]').fill(mock.webdavPassword);
      await page.getByRole('button', { name: 'Kiểm tra kết nối trước khi lưu' }).click();
      await expect(page.getByText(/Kết nối OK/)).toBeVisible({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Lưu & Gắn vào Pool ngay' }).click();
      await expect(page.getByText('RW Mock WebDAV 30GB', { exact: true })).toBeVisible({ timeout: 10_000 });

      // Raise User quota via Admin UI quota editor
      const usersTabBtn = page.locator('nav[aria-label="Điều hướng quản trị"]').getByRole('button', { name: /Tổng quan & Người dùng/ });
      if (await usersTabBtn.isVisible().catch(() => false)) {
        await usersTabBtn.click();
      }
      const userRow = findAdminUserContainer(page, userEmail);
      await expect(userRow).toBeVisible();
      const editQuotaBtn = userRow.getByRole('button', { name: /Chỉnh quota/i });
      if (await editQuotaBtn.isVisible().catch(() => false)) {
        await editQuotaBtn.click();
      }
      const quotaInput = userRow.locator('input[type="number"], input[aria-label*="quota" i], input[aria-label*="hạn mức" i]').first();
      await quotaInput.fill('200');
      await userRow.getByRole('button', { name: /Lưu|Cập nhật/i }).click();

      await expect
        .poll(async () => (await userApi.me()).data.user.quotaBytes, { timeout: 10_000 })
        .toBe(200 * 1024 * 1024 * 1024);

      // Verify pool aggregate > 10 GB and User upload/stream works across pool
      const poolSummary = await adminApi.adminGetStoragePool();
      expect(poolSummary.data.summary.grandTotalCapacityBytes).toBeGreaterThan(TEN_GIB);

      const sample = makeValidPng(420, 1024);
      const up = await userApi.uploadFile({
        filename: 'rw-pooled.png',
        mimeType: 'image/png',
        bytes: sample
      });
      expect(up.completeRes!.status).toBe(200);
      uploadedMediaId = up.completeRes!.data.media.id;
      const dl = await userApi.downloadMedia(uploadedMediaId);
      expect(dl.rawBytes.equals(sample)).toBe(true);
    } finally {
      // Clean up temporary media and ephemeral mock nodes from the shared server before closing mock servers
      if (uploadedMediaId) {
        await userApi.trashMedia(uploadedMediaId).catch(() => {});
        await userApi.permanentDeleteTrash(uploadedMediaId).catch(() => {});
      }
      const poolRes = await adminApi.adminGetStoragePool().catch(() => null);
      for (const n of poolRes?.data?.nodes ?? []) {
        if (n.name === 'RW Mock S3 20GB' || n.name === 'RW Mock WebDAV 30GB') {
          await adminApi.adminUpdatePoolNode(n.id, { enabled: false }).catch(() => {});
          await adminApi.adminDeletePoolNode(n.id).catch(() => {});
        }
      }
      await mock.close();
    }
  });

  test('Scenario 3: Multi-Tenant Privacy & PRD Compliance Audit Workflow', async ({ page }) => {
    const userA = new VaultApiClient();
    const emailA = uniqueEmail('rw-priv-a');
    await userA.register({
      email: emailA,
      password: 'UserPass!2026',
      displayName: 'Privacy Owner A',
      encryptionMode: 'e2ee',
      e2eeKeySalt: 'c2FsdC1h',
      e2eeEncryptedMasterKey: 'bWFzdGVyLWE=',
      e2eeKdfParams: { iterations: 310000 }
    });
    const secretA = makeValidPng(430);
    const upA = await userA.uploadFile({
      filename: 'top-secret-a.png',
      mimeType: 'image/png',
      bytes: secretA,
      encryptedFileKey: 'key-a',
      encryptionIv: 'iv-a'
    });
    const mediaA = upA.completeRes!.data.media.id;
    const devA = (await userA.listDevices()).data.devices[0]!.id;

    // User B probes User A's resources
    const userB = new VaultApiClient();
    await userB.register({
      email: uniqueEmail('rw-priv-b'),
      password: 'UserPass!2026',
      displayName: 'Curious User B',
      encryptionMode: 'server_side'
    });
    expect((await userB.streamMedia(mediaA)).status).toBe(404);
    expect((await userB.downloadMedia(mediaA)).status).toBe(404);
    expect((await userB.verifyMedia(mediaA)).status).toBe(404);
    expect((await userB.revokeDevice(devA)).status).toBe(404);

    // Admin probes User A's media & E2EE material
    const admin = loadBootstrapCreds();
    const adminApi = new VaultApiClient(admin.apiBaseUrl, admin.adminAccessToken);
    expect((await adminApi.streamMedia(mediaA)).status).toBe(404);
    expect((await adminApi.downloadMedia(mediaA)).status).toBe(404);
    expect((await adminApi.verifyMedia(mediaA)).status).toBe(404);

    const adminUsersText = JSON.stringify((await adminApi.adminUsers()).data);
    expect(adminUsersText).not.toContain('bWFzdGVyLWE=');
    expect(adminUsersText).not.toContain('c2FsdC1h');

    // Admin logs into UI -> dedicated AdminShell with zero search/share/GPS or personal Thư viện
    await loginViaUi(page, { email: admin.adminEmail, password: admin.adminPassword });
    await expect(page.getByText(/Ranh giới quyền riêng tư Admin/)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' })).toHaveCount(0);
    await expect(page.locator('input[type="search"], input[placeholder*="Tìm kiếm" i]')).toHaveCount(0);
  });

  test('Scenario 4: E2EE Vault Lifecycle & Device Rotation Workflow', async ({ page }) => {
    const email = uniqueEmail('rw-e2ee-life');
    const password = 'UserPass!2026';
    const e2eePass = 'E2eeLifecycle!2026';
    const rawPhoto = makeValidPng(440);
    const expectedSha = sha256Hex(rawPhoto);

    // Device 1: register E2EE and upload photo
    await registerViaUi(page, {
      displayName: 'E2EE Lifecycle',
      email,
      password,
      encryptionMode: 'e2ee',
      e2eePassphrase: e2eePass
    });

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'e2ee-life.png',
      mimeType: 'image/png',
      buffer: rawPhoto
    });
    await page.getByRole('button', { name: 'Bắt đầu sao lưu hàng đợi' }).click();
    await expect(page.getByText('Đã xác minh gốc').first()).toBeVisible({ timeout: 15_000 });

    // Logout from Device 1
    await page.getByRole('button', { name: 'Quay lại' }).click();
    await page.getByRole('button', { name: /Đăng xuất tài khoản/ }).click();

    // Device 2: fresh login (vault locked), unlock with E2EE passphrase, download & verify SHA-256
    await loginViaUi(page, { email, password });
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await expect(page.getByText(/Đang khóa/)).toBeVisible();

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
    expect(sha256Hex(fs.readFileSync(filePath!))).toBe(expectedSha);

    // Revoke old device in Security sub-screen
    await page.getByRole('button', { name: 'Đóng trình xem' }).click();
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Thiết bị, PIN, Mật khẩu & Máy chủ/ }).click();
    const oldDeviceRow = page.locator('.device-row').filter({ hasNotText: 'Hiện tại' }).first();
    await expect(oldDeviceRow).toBeVisible({ timeout: 10_000 });
    const oldRevokeBtn = oldDeviceRow.getByRole('button', { name: 'Thu hồi' });
    await expect(oldRevokeBtn).toHaveCount(1);
    await oldRevokeBtn.click();
    await expect(oldDeviceRow.getByText('Đã thu hồi')).toBeVisible({ timeout: 10_000 });
    await expect(oldRevokeBtn).toHaveCount(0);
  });

  test('Scenario 5: Standard Web Browser Photo Organization & Disaster Recovery Export Workflow', async ({
    page
  }) => {
    const email = uniqueEmail('rw-org-zip');
    const password = 'UserPass!2026';
    await registerViaUi(page, { displayName: 'Org Export User', email, password });

    const photo1 = makeValidPng(451);
    const photo2 = makeValidJpegWithExif(452, 'WebBackupCam');

    // Web upload 2 photos + test duplicate skip
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'org-1.png', mimeType: 'image/png', buffer: photo1 },
      { name: 'org-2.jpg', mimeType: 'image/jpeg', buffer: photo2 }
    ]);
    await page.getByRole('button', { name: 'Bắt đầu sao lưu hàng đợi' }).click();
    await expect(page.getByText('Đã xác minh gốc')).toHaveCount(2, { timeout: 15_000 });

    // Re-upload photo1 -> Phát hiện trùng -> skip
    await page.locator('input[type="file"]').setInputFiles({
      name: 'org-1-dup.png',
      mimeType: 'image/png',
      buffer: photo1
    });
    await page.getByRole('button', { name: 'Bắt đầu sao lưu hàng đợi' }).click();
    await expect(page.getByText('Phát hiện trùng')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Bỏ qua \(Giữ bản đã có\)/ }).click();

    // Create Folder & Album via Albums Hub
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Album' }).click();
    await page.getByRole('button', { name: '+ Thư mục' }).click();
    await page.getByPlaceholder(/Năm 2026/i).fill('Nam_2026');
    await page.getByRole('button', { name: 'Tạo ngay' }).click();
    await expect(page.getByRole('button', { name: /Nam_2026/ })).toBeVisible();

    await page.getByRole('button', { name: '+ Album' }).click();
    await page.getByPlaceholder(/Du lịch/i).fill('Tet_2026');
    await page.getByRole('button', { name: 'Tạo ngay' }).click();
    await expect(page.getByRole('button', { name: /Tet_2026/ })).toBeVisible();

    // Assign folder, album & tag in Library Viewer Info Sheet
    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Thư viện' }).click();
    await page.locator('.tile').first().click();
    await page.getByRole('button', { name: 'Thông tin ảnh' }).click();
    await page.getByPlaceholder('Thêm thẻ mới...').fill('archive-2026');
    await page.getByRole('button', { name: 'Gắn thẻ' }).click();
    await expect(page.getByText('archive-2026')).toBeVisible();
    await page.getByRole('button', { name: 'Xong' }).click();
    await page.getByRole('button', { name: 'Đóng trình xem' }).click();

    // Multi-select export ZIP
    await page.getByRole('button', { name: 'Chọn', exact: true }).click();
    await page.locator('.tile').nth(0).click();
    await page.locator('.tile').nth(1).click();
    const [zipDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Tải ZIP gốc' }).click()
    ]);
    const zipBytes = fs.readFileSync((await zipDownload.path())!);
    // ZIP store archive starts with PK\x03\x04
    expect(zipBytes.subarray(0, 2).toString('ascii')).toBe('PK');

    // Move selection to Trash & permanently delete everything -> verify 0 bytes used & clean trash
    await page.getByRole('button', { name: 'Chọn', exact: true }).click();
    await page.locator('.tile').nth(0).click();
    await page.locator('.tile').nth(1).click();
    page.on('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Thùng rác' }).click();
    await expect(page.locator('.tile')).toHaveCount(0);

    await page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' }).click();
    await page.getByRole('button', { name: /Khôi phục, Trùng lặp & Thùng rác/ }).click();
    await expect(page.getByRole('heading', { name: /Thùng rác/ })).toBeVisible({ timeout: 10_000 });

    const deleteBtns = page.getByRole('button', { name: 'Xóa vĩnh viễn' });
    let count = await deleteBtns.count();
    while (count > 0) {
      await deleteBtns.first().click();
      await expect(deleteBtns).toHaveCount(count - 1, { timeout: 10_000 });
      count = await deleteBtns.count();
    }

    const api = new VaultApiClient();
    await api.login({ email, password });
    const summary = await api.storageSummary();
    expect(summary.data.totalFiles).toBe(0);
    expect(summary.data.trashCount).toBe(0);
    expect(summary.data.usedBytes).toBe(0);
  });
});
