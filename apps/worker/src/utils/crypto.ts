const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array<ArrayBuffer> {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(len: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(len));
  crypto.getRandomValues(buf);
  return buf;
}

export function randomHex(byteLength = 32): string {
  return toHex(randomBytes(byteLength));
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  let buf: ArrayBuffer;
  if (typeof data === 'string') {
    const encoded = encoder.encode(data);
    buf = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
  } else if (data instanceof Uint8Array) {
    buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  } else {
    buf = data;
  }
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return toHex(new Uint8Array(hash));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(new Uint8Array(sig));
}

export function constantTimeEqual(
  a: Uint8Array<ArrayBuffer>,
  b: Uint8Array<ArrayBuffer>
): boolean {
  if (a.length !== b.length) return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// Cloudflare Workers Web Crypto supports up to 100,000 PBKDF2 iterations natively in C++
const PBKDF2_ITERS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits'
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERS },
    key,
    256
  );
  return `pbkdf2$${PBKDF2_ITERS}$${toHex(salt)}$${toHex(new Uint8Array(derived))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iters = Math.min(100_000, Math.max(10_000, Number(parts[1]) || PBKDF2_ITERS));
  const salt = fromHex(parts[2]!);
  const expected = fromHex(parts[3]!);
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits'
  ]);
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iters },
      key,
      256
    )
  );
  return constantTimeEqual(derived, expected);
}

export interface JwtClaims {
  sub: string;
  email: string;
  deviceId: string;
  roles: Array<'user' | 'admin'>;
  encryptionMode: 'server_side' | 'e2ee';
  iat: number;
  exp: number;
}

export async function signAccessJwt(
  payload: Omit<JwtClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds = 900
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtClaims = { ...payload, iat: now, exp: now + ttlSeconds };
  const headerPart = toBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payloadPart = toBase64Url(encoder.encode(JSON.stringify(fullPayload)));
  const signingInput = `${headerPart}.${payloadPart}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput)));
  return `${signingInput}.${toBase64Url(sig)}`;
}

export async function verifyAccessJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, sigPart] = parts as [string, string, string];
  const signingInput = `${headerPart}.${payloadPart}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const expectedSig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput))
  );
  const actualSig = fromBase64Url(sigPart);
  if (!constantTimeEqual(expectedSig, actualSig)) return null;
  try {
    const claims = JSON.parse(decoder.decode(fromBase64Url(payloadPart))) as JwtClaims;
    if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export async function generateRecoveryCodes(count = 10): Promise<
  Array<{ plain: string; salt: string; hash: string }>
> {
  const out: Array<{ plain: string; salt: string; hash: string }> = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(12);
    let chars = '';
    for (let j = 0; j < 12; j++) {
      chars += CODE_ALPHABET[raw[j]! % CODE_ALPHABET.length];
    }
    const plain = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
    const salt = randomHex(16);
    const hash = await sha256Hex(`${salt}:${plain.toUpperCase()}`);
    out.push({ plain, salt, hash });
  }
  return out;
}

export async function hashRecoveryCode(plain: string, salt: string): Promise<string> {
  return sha256Hex(`${salt}:${plain.trim().toUpperCase()}`);
}
