// Minimal Cloudflare Workers runtime interfaces matching deployed bindings
// (DB: D1 kho-anh-db, VAULT_BUCKET: R2 kho-anh-vault, ASSETS: Static Assets, JWT secrets)

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }>;
  run(): Promise<{ success: boolean; meta: { changes?: number; last_row_id?: number } }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<Array<{ results: T[]; success: boolean }>>;
}

export interface R2Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

export interface R2HTTPMetadata {
  contentType?: string;
  contentDisposition?: string;
  cacheControl?: string;
}

export interface R2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  httpMetadata?: R2HTTPMetadata;
  range?: { offset: number; length: number };
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

export interface R2MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(partNumber: number, value: ArrayBuffer | ArrayBufferView | ReadableStream | string): Promise<R2UploadedPart>;
  abort(): Promise<void>;
  complete(uploadedParts: R2UploadedPart[]): Promise<R2Object>;
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: { range?: R2Range }): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: { httpMetadata?: R2HTTPMetadata; sha256?: string | ArrayBuffer }
  ): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  createMultipartUpload(key: string, options?: { httpMetadata?: R2HTTPMetadata }): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
  list?(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
}

export interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface WorkerEnv {
  DB: D1Database;
  VAULT_BUCKET?: R2Bucket;
  ASSETS?: Fetcher;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  STORAGE_CONFIG_KEY?: string;
  DEFAULT_USER_QUOTA_BYTES?: string;
  R2_CAPACITY_BYTES?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  CORS_ORIGINS?: string;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface AuthContext {
  userId: string;
  email: string;
  deviceId: string;
  roles: Array<'user' | 'admin'>;
  encryptionMode: 'server_side' | 'e2ee';
}
