import type { WorkerEnv } from '../env.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function getStorageSecretSeed(env: WorkerEnv): string {
  return env.STORAGE_CONFIG_KEY || env.JWT_ACCESS_SECRET;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveSecretKey(seed: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`smb-storage-secret-v1:${seed}`));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, usage);
}

/**
 * Encrypts storage credentials with AES-256-GCM using the exact same wire format
 * (`v1:<ivBase64>:<tagBase64>:<ciphertextBase64>`) as `backend/src/utils/crypto.ts`.
 */
export async function encryptStorageSecret(plaintext: string, seed: string): Promise<string> {
  if (!plaintext) return '';
  const key = await deriveSecretKey(seed, ['encrypt']);
  const iv = new Uint8Array(new ArrayBuffer(12));
  crypto.getRandomValues(iv);
  const encryptedBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    encoder.encode(plaintext)
  );
  const encrypted = new Uint8Array(encryptedBuf);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const tag = encrypted.subarray(encrypted.length - 16);
  return `v1:${toBase64(iv)}:${toBase64(tag)}:${toBase64(ciphertext)}`;
}

/**
 * Decrypts `v1:` AES-256-GCM secrets. Falls back to returning raw string for legacy
 * plaintext rows saved before M1 encryption was enabled.
 */
export async function decryptStorageSecret(encoded: string, seed: string): Promise<string> {
  if (!encoded) return '';
  if (!encoded.startsWith('v1:')) {
    return encoded;
  }
  const parts = encoded.split(':');
  if (parts.length !== 4) {
    throw new Error('Unsupported encrypted storage secret format');
  }
  const iv = fromBase64(parts[1]!);
  const tag = fromBase64(parts[2]!);
  const ciphertext = fromBase64(parts[3]!);
  const combined = new Uint8Array(new ArrayBuffer(ciphertext.length + tag.length));
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);

  const key = await deriveSecretKey(seed, ['decrypt']);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    combined
  );
  return decoder.decode(plainBuf);
}

export function maskAccessKey(accessKeyId: string): string {
  if (!accessKeyId) return '';
  if (accessKeyId.length <= 8) return `${accessKeyId.slice(0, 2)}••••`;
  return `${accessKeyId.slice(0, 4)}••••${accessKeyId.slice(-4)}`;
}
