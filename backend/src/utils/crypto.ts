import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { EncryptionMode, RoleName } from '@smb/shared';

const scryptAsync = promisify(crypto.scrypt);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const saltHex = parts[4];
  const hashHex = parts[5];
  if (!saltHex || !hashHex) {
    return false;
  }
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(12);
    let raw = '';
    for (let j = 0; j < 12; j++) {
      raw += RECOVERY_ALPHABET[bytes[j]! % RECOVERY_ALPHABET.length];
    }
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return codes;
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(code: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const normalized = normalizeRecoveryCode(code);
  const hash = crypto.createHmac('sha256', salt).update(normalized).digest('hex');
  return { salt, hash };
}

export function verifyRecoveryCode(code: string, salt: string, storedHash: string): boolean {
  const normalized = normalizeRecoveryCode(code);
  const actual = crypto.createHmac('sha256', salt).update(normalized).digest();
  const expected = Buffer.from(storedHash, 'hex');
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

export interface AccessTokenPayload {
  sub: string;
  did: string;
  roles: RoleName[];
  enc: EncryptionMode;
  jti: string;
  iat: number;
  exp: number;
}

function base64UrlEncodeJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function base64UrlDecodeJson<T>(segment: string): T {
  const json = Buffer.from(segment, 'base64url').toString('utf8');
  return JSON.parse(json) as T;
}

export function signAccessToken(
  claims: Omit<AccessTokenPayload, 'jti' | 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: AccessTokenPayload = {
    ...claims,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + ttlSeconds
  };
  const header = base64UrlEncodeJson({ alg: 'HS256', typ: 'JWT' });
  const body = base64UrlEncodeJson(payload);
  const signingInput = `${header}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

export function verifyAccessToken(token: string, secret: string): AccessTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [headerSeg, payloadSeg, sigSeg] = parts;
  if (!headerSeg || !payloadSeg || !sigSeg) {
    return null;
  }

  try {
    const header = base64UrlDecodeJson<{ alg?: string; typ?: string }>(headerSeg);
    if (header.alg !== 'HS256' || header.typ !== 'JWT') {
      return null;
    }

    const signingInput = `${headerSeg}.${payloadSeg}`;
    const expectedSig = crypto.createHmac('sha256', secret).update(signingInput).digest();
    const actualSig = Buffer.from(sigSeg, 'base64url');

    if (actualSig.length !== expectedSig.length || !crypto.timingSafeEqual(actualSig, expectedSig)) {
      return null;
    }

    const payload = base64UrlDecodeJson<AccessTokenPayload>(payloadSeg);
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= now || typeof payload.sub !== 'string') {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function deriveSecretBoxKey(seed: string): Buffer {
  return crypto.createHash('sha256').update(`smb-storage-secret-v1:${seed}`).digest();
}

export function encryptServerSecret(plaintext: string, seed: string): string {
  if (!plaintext) return '';
  const key = deriveSecretBoxKey(seed);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptServerSecret(encoded: string, seed: string): string {
  if (!encoded) return '';
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unsupported encrypted secret format');
  }
  const key = deriveSecretBoxKey(seed);
  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const ciphertext = Buffer.from(parts[3]!, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function maskAccessKey(accessKeyId: string): string {
  if (!accessKeyId) return '';
  if (accessKeyId.length <= 8) return `${accessKeyId.slice(0, 2)}••••`;
  return `${accessKeyId.slice(0, 4)}••••${accessKeyId.slice(-4)}`;
}

