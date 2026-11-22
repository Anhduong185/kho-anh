import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';
import type { BootstrapAdminState } from '../globalSetup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function uniqueEmail(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${rand}@vault.local`;
}

export function loadBootstrapCreds(): BootstrapAdminState {
  const filePath = path.resolve(__dirname, '../.state/bootstrap.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as BootstrapAdminState;
}

export async function registerViaUi(
  page: Page,
  opts: {
    displayName: string;
    email: string;
    password: string;
    encryptionMode?: 'server_side' | 'e2ee';
    e2eePassphrase?: string;
  }
): Promise<{ recoveryCodes: string[] }> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Tạo tài khoản' }).click();

  await page.getByLabel('Tên hiển thị').fill(opts.displayName);
  await page.getByLabel('Email').fill(opts.email);
  await page.getByLabel('Mật khẩu').fill(opts.password);

  if (opts.encryptionMode === 'e2ee') {
    await page.locator('input[name="encryptionMode"][value="e2ee"]').check();
    await page.getByLabel(/Mật khẩu khóa kho E2EE/).fill(opts.e2eePassphrase ?? 'E2eePassphrase!2026');
  } else {
    await page.locator('input[name="encryptionMode"][value="server_side"]').check();
  }

  await page.getByRole('button', { name: /Tạo tài khoản & nhận mã khôi phục/ }).click();

  // Recovery codes modal should appear with 10 codes
  const modalHeading = page.getByRole('heading', { name: /Lưu lại 10 mã khôi phục/ });
  await expect(modalHeading).toBeVisible({ timeout: 15_000 });
  const codes = await page.locator('.codes-grid code').allTextContents();
  expect(codes.length).toBe(10);

  await page.getByRole('button', { name: 'Tôi đã lưu an toàn' }).click();
  await expect(modalHeading).toBeHidden();

  return { recoveryCodes: codes.map((c) => c.trim()) };
}

export async function loginViaUi(
  page: Page,
  opts: { email: string; password: string }
): Promise<void> {
  await page.goto('/');
  const loginTab = page.getByRole('tablist').getByRole('button', { name: 'Đăng nhập', exact: true });
  if (await loginTab.isVisible()) {
    await loginTab.click();
  }
  await page.getByLabel('Email').fill(opts.email);
  await page.getByLabel('Mật khẩu').fill(opts.password);
  await page.locator('form').getByRole('button', { name: /^Đăng nhập/ }).click();
  await expect(page.locator('.auth-card')).toBeHidden({ timeout: 15_000 });
}

export async function openAdminConsole(page: Page): Promise<void> {
  const adminHeading = page.getByText(/Ranh giới quyền riêng tư Admin|Quản lý tài khoản|Multi-Cloud Storage Pool/).first();
  const khoBtn = page.locator('nav[aria-label="Điều hướng"]').getByRole('button', { name: 'Kho' });
  await expect(adminHeading.or(khoBtn)).toBeVisible({ timeout: 15_000 });
  if (await adminHeading.isVisible().catch(() => false)) {
    return;
  }
  if (await khoBtn.isVisible().catch(() => false)) {
    await khoBtn.click();
    await page.getByRole('button', { name: /\+ Quản lý Multi-Cloud Pool/ }).click();
  }
  await expect(adminHeading).toBeVisible({ timeout: 15_000 });
}

export function findAdminUserContainer(page: Page, email: string): Locator {
  return page.locator('tr, .queue-card, .device-row, .policy-row, .user-card').filter({ hasText: email }).first();
}

export async function uploadFileViaWebUi(
  page: Page,
  opts: { filename: string; mimeType: string; bytes: Buffer }
): Promise<void> {
  const nav = page.locator('nav[aria-label="Điều hướng"]');
  await nav.getByRole('button', { name: 'Kho' }).click();
  await page.getByRole('button', { name: /Tải ảnh & video lên kho/ }).click();

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: opts.filename,
    mimeType: opts.mimeType,
    buffer: opts.bytes
  });

  await page.getByRole('button', { name: 'Bắt đầu sao lưu hàng đợi' }).click();
  await expect(page.getByText('Đã xác minh gốc').first()).toBeVisible({ timeout: 15_000 });
}
