import type { DevicePlatform, E2eeKeyBundle } from '@smb/shared';
import { sha256Bytes } from './sha256';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function assertWebCrypto(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'WebCrypto AES-GCM yêu cầu chạy qua HTTPS hoặc localhost (Safari tắt SubtleCrypto trên HTTP mạng LAN).'
    );
  }
  return globalThis.crypto.subtle;
}

/**
 * Generates a fresh 256-bit random vault master key and wraps it locally using
 * PBKDF2-SHA256 + AES-GCM-256 derived from the user's vault passphrase.
 */
export async function createClientWrappedE2eeBundle(passphrase: string): Promise<{
  e2eeKeySalt: string;
  e2eeEncryptedMasterKey: string;
  e2eeKdfParams: Record<string, unknown>;
}> {
  const subtle = assertWebCrypto();
  const iterations = 310_000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const rawMasterKey = crypto.getRandomValues(new Uint8Array(32));

  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const wrappingKey = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const encrypted = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawMasterKey)
  );

  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);

  return {
    e2eeKeySalt: toBase64(salt),
    e2eeEncryptedMasterKey: toBase64(combined),
    e2eeKdfParams: {
      algorithm: 'PBKDF2',
      hash: 'SHA-256',
      iterations,
      cipher: 'AES-256-GCM'
    }
  };
}

/**
 * Unlocks the user's account Master Key into volatile memory only (never persisted to storage).
 */
export async function unlockE2eeMasterKey(
  passphrase: string,
  bundle: E2eeKeyBundle
): Promise<CryptoKey> {
  const subtle = assertWebCrypto();
  const salt = fromBase64(bundle.keySalt);
  const combined = fromBase64(bundle.encryptedMasterKey);
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const iterations = Number(bundle.kdfParams?.iterations ?? 310_000);

  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const wrappingKey = await subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  let rawMasterKey: ArrayBuffer;
  try {
    rawMasterKey = await subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      wrappingKey,
      ciphertext as BufferSource
    );
  } catch {
    throw new Error('Sai mật khẩu khóa kho E2EE — không thể giải mã Master Key.');
  }

  return subtle.importKey('raw', rawMasterKey, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt'
  ]);
}

/**
 * Encrypts an original media file with a fresh per-file random AES-256-GCM key,
 * then wraps that file key with the account's unlocked Master Key.
 */
export async function encryptFileForE2ee(
  file: File,
  masterKey: CryptoKey
): Promise<{
  encryptedFile: File;
  encryptedFileKey: string;
  encryptionIv: string;
}> {
  const subtle = assertWebCrypto();
  const rawFileKey = crypto.getRandomValues(new Uint8Array(32));
  const fileKey = await subtle.importKey('raw', rawFileKey, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt'
  ]);
  const fileIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));

  const plainBuffer = await file.arrayBuffer();
  const cipherBuffer = await subtle.encrypt(
    { name: 'AES-GCM', iv: fileIv },
    fileKey,
    plainBuffer
  );

  const wrappedKeyBytes = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, masterKey, rawFileKey)
  );
  const wrappedCombined = new Uint8Array(wrapIv.length + wrappedKeyBytes.length);
  wrappedCombined.set(wrapIv, 0);
  wrappedCombined.set(wrappedKeyBytes, wrapIv.length);

  const encryptedFile = new File([cipherBuffer], file.name, {
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified
  });

  return {
    encryptedFile,
    encryptedFileKey: toBase64(wrappedCombined),
    encryptionIv: toBase64(fileIv)
  };
}

/**
 * Decrypts ciphertext bytes back into the exact 100% original file bytes locally in browser.
 */
export async function decryptBytesFromE2ee(
  ciphertext: Uint8Array,
  encryptedFileKey: string,
  encryptionIv: string,
  masterKey: CryptoKey
): Promise<Uint8Array> {
  const subtle = assertWebCrypto();
  const wrappedCombined = fromBase64(encryptedFileKey);
  const wrapIv = wrappedCombined.subarray(0, 12);
  const wrappedCipher = wrappedCombined.subarray(12);

  const rawFileKey = await subtle.decrypt(
    { name: 'AES-GCM', iv: wrapIv as BufferSource },
    masterKey,
    wrappedCipher as BufferSource
  );
  const fileKey = await subtle.importKey('raw', rawFileKey, { name: 'AES-GCM', length: 256 }, false, [
    'decrypt'
  ]);
  const fileIv = fromBase64(encryptionIv);

  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: fileIv as BufferSource },
    fileKey,
    ciphertext as BufferSource
  );
  return new Uint8Array(plain);
}

// ==================== LOCAL APP PIN LOCK (PRD 4.2) ====================

const APP_PIN_STORAGE_KEY = 'smb_app_pin_v1';

export function hasAppPinConfigured(): boolean {
  return Boolean(localStorage.getItem(APP_PIN_STORAGE_KEY));
}

export function setLocalAppPin(pin: string): void {
  const salt = toBase64(crypto.getRandomValues(new Uint8Array(12)));
  const digest = sha256Bytes(new TextEncoder().encode(`${salt}:${pin}`));
  localStorage.setItem(APP_PIN_STORAGE_KEY, JSON.stringify({ salt, digest }));
}

export function verifyLocalAppPin(pin: string): boolean {
  try {
    const raw = localStorage.getItem(APP_PIN_STORAGE_KEY);
    if (!raw) return true;
    const { salt, digest } = JSON.parse(raw) as { salt: string; digest: string };
    return sha256Bytes(new TextEncoder().encode(`${salt}:${pin}`)) === digest;
  } catch {
    return false;
  }
}

export function clearLocalAppPin(): void {
  localStorage.removeItem(APP_PIN_STORAGE_KEY);
}

export function detectClientDevice(): { platform: DevicePlatform; deviceName: string } {
  const ua = navigator.userAgent;
  const isNative = Boolean(
    (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()
  );
  if (/iPhone|iPad|iPod/i.test(ua)) {
    const model = /iPad/i.test(ua) ? 'iPad' : 'iPhone';
    const isStandalone =
      'standalone' in navigator && Boolean((navigator as { standalone?: boolean }).standalone);
    return {
      platform: 'ios',
      deviceName: isNative ? `${model} (App)` : isStandalone ? `${model} (PWA)` : `${model} (Safari)`
    };
  }
  if (/Android/i.test(ua)) {
    return { platform: 'android', deviceName: isNative ? 'Android App (APK)' : 'Android Browser' };
  }
  if (/Windows/i.test(ua)) {
    return { platform: 'windows', deviceName: 'Windows Browser' };
  }
  return { platform: 'web', deviceName: 'Web Browser' };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** idx;
  return `${val.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}
