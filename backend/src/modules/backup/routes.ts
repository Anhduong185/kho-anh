import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  classifyMediaFormat,
  extractFileExtension,
  type CompleteUploadResponse,
  type DuplicateCheckResult,
  type InitUploadResponse,
  type MediaKind,
  type MediaUploadState,
  type PresignPartResponse,
  type UploadSessionStatusResponse
} from '@smb/shared';
import type { AppConfig } from '../../config/env.js';
import type { DbClient } from '../../db/client.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import type { StorageRegistry } from '../../storage/registry.js';
import { sha256Hex } from '../../utils/crypto.js';
import { AppError, Errors } from '../../utils/errors.js';
import { hydrateMediaItems, type MediaRow } from '../media/routes.js';
import { getSystemSettings } from '../settings/service.js';

const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MiB default chunk size
const MIN_CHUNK_SIZE = 64 * 1024; // 64 KiB (useful for weak Wi-Fi & fast tests)
const MAX_CHUNK_SIZE = 16 * 1024 * 1024; // 16 MiB
const SESSION_TTL_HOURS = 48;

const Sha256Schema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{64}$/, 'sha256 must be a valid 64-character hex digest')
  .transform((v) => v.toLowerCase());

const CheckDuplicatesSchema = z.object({
  items: z
    .array(
      z.object({
        clientRef: z.string().min(1).max(128),
        sha256: Sha256Schema,
        sizeBytes: z.number().int().positive(),
        originalFilename: z.string().min(1).max(512)
      })
    )
    .min(1)
    .max(200)
});

const InitUploadSchema = z.object({
  originalFilename: z.string().trim().min(1).max(512),
  mimeType: z.string().trim().max(255).optional().default('application/octet-stream'),
  sizeBytes: z.number().int().positive(),
  sha256: Sha256Schema,
  networkType: z.enum(['wifi', 'cellular', 'unknown']),
  chunkSizeBytes: z.number().int().min(MIN_CHUNK_SIZE).max(MAX_CHUNK_SIZE).optional(),
  capturedAt: z.string().datetime().nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  encryptedFileKey: z.string().max(4096).nullable().optional(),
  encryptionIv: z.string().max(512).nullable().optional(),
  allowDuplicate: z.boolean().optional().default(false)
});

const SessionParamSchema = z.object({
  sessionId: z.string().uuid()
});

const PartParamSchema = z.object({
  sessionId: z.string().uuid(),
  partNumber: z.coerce.number().int().min(1).max(10000)
});

interface UploadedPartRecord {
  partNumber: number;
  sizeBytes: number;
  etag: string;
  sha256: string;
}

interface UploadSessionRow {
  id: string;
  user_id: string;
  device_id: string;
  storage_node_id: string | null;
  storage_upload_id: string;
  object_key: string;
  original_filename: string;
  mime_type: string;
  media_kind: MediaKind;
  expected_size_bytes: string | number;
  expected_sha256: string;
  chunk_size_bytes: number;
  total_parts: number;
  uploaded_parts: UploadedPartRecord[];
  bytes_uploaded: string | number;
  captured_at: string | Date | null;
  width: number | null;
  height: number | null;
  duration_ms: string | number | null;
  metadata: Record<string, unknown>;
  encrypted_file_key: string | null;
  encryption_iv: string | null;
  status: 'uploading' | 'verifying' | 'completed' | 'aborted' | 'failed';
  media_id: string | null;
  error_message: string | null;
  expires_at: string | Date;
}

function parseParts(raw: unknown): UploadedPartRecord[] {
  if (Array.isArray(raw)) {
    return raw as UploadedPartRecord[];
  }
  return [];
}

export function registerBackupRoutes(
  app: FastifyInstance,
  db: DbClient,
  config: AppConfig,
  storageRegistry: StorageRegistry
) {
  const authenticate = createAuthMiddleware(db, config);

  // 1. Tenant-scoped duplicate & resumable session pre-check (NEVER cross-account!)
  app.post('/api/v1/uploads/check-duplicates', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const parsed = CheckDuplicatesSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.badRequest('Invalid duplicate check payload', parsed.error.flatten());
    }

    const hashes = [...new Set(parsed.data.items.map((i) => i.sha256))];

    const [existingMediaRes, activeSessionRes] = await Promise.all([
      db.query<{
        id: string;
        sha256: string;
        original_filename: string;
        size_bytes: string | number;
        created_at: string | Date;
      }>(
        `
        SELECT id, sha256, original_filename, size_bytes, created_at
        FROM media_files
        WHERE user_id = $1 AND sha256 = ANY($2::text[]) AND deleted_at IS NULL
        ORDER BY created_at ASC
        `,
        [auth.userId, hashes]
      ),
      db.query<UploadSessionRow>(
        `
        SELECT *
        FROM upload_sessions
        WHERE user_id = $1 AND expected_sha256 = ANY($2::text[]) AND status = 'uploading' AND expires_at > NOW()
        ORDER BY created_at DESC
        `,
        [auth.userId, hashes]
      )
    ]);

    const mediaByHash = new Map<string, (typeof existingMediaRes.rows)[number]>();
    for (const row of existingMediaRes.rows) {
      if (!mediaByHash.has(row.sha256)) {
        mediaByHash.set(row.sha256, row);
      }
    }

    const sessionByKey = new Map<string, UploadSessionRow>();
    for (const sess of activeSessionRes.rows) {
      const k = `${sess.expected_sha256}:${Number(sess.expected_size_bytes)}`;
      if (!sessionByKey.has(k)) {
        sessionByKey.set(k, sess);
      }
    }

    const results: DuplicateCheckResult[] = parsed.data.items.map((item) => {
      const resumable = sessionByKey.get(`${item.sha256}:${item.sizeBytes}`);
      if (resumable) {
        const parts = parseParts(resumable.uploaded_parts);
        return {
          clientRef: item.clientRef,
          status: 'resumable',
          resumableSession: {
            sessionId: resumable.id,
            chunkSizeBytes: resumable.chunk_size_bytes,
            totalParts: resumable.total_parts,
            uploadedPartNumbers: parts.map((p) => p.partNumber).sort((a, b) => a - b),
            bytesUploaded: Number(resumable.bytes_uploaded)
          }
        };
      }

      const dup = mediaByHash.get(item.sha256);
      if (dup) {
        return {
          clientRef: item.clientRef,
          status: 'duplicate',
          duplicateOf: {
            mediaId: dup.id,
            originalFilename: dup.original_filename,
            sizeBytes: Number(dup.size_bytes),
            createdAt: new Date(dup.created_at).toISOString()
          }
        };
      }

      return {
        clientRef: item.clientRef,
        status: 'new'
      };
    });

    return { results };
  });

  // 2. Initialize or Resume a Multipart Upload Session
  app.post('/api/v1/uploads/init', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const parsed = InitUploadSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.badRequest('Invalid upload initialization payload', parsed.error.flatten());
    }

    const body = parsed.data;

    // Enforce confirmed policy: Wi-Fi only!
    if (body.networkType !== 'wifi') {
      throw new AppError(
        403,
        'WIFI_REQUIRED',
        'Upload blocked: system policy only allows media backup over Wi-Fi.'
      );
    }

    // Enforce PRD 2.3 & 2.4: Images & Videos only (including RAW/HEIC/ProRes)
    const mediaKind = classifyMediaFormat(body.originalFilename, body.mimeType);
    if (!mediaKind) {
      throw new AppError(
        400,
        'UNSUPPORTED_MEDIA_TYPE',
        `File "${body.originalFilename}" is not a supported photo or video format.`
      );
    }

    // Check active resumable upload session first (supports seamless resume after crash/disconnect)
    const activeRes = await db.query<UploadSessionRow>(
      `
      SELECT *
      FROM upload_sessions
      WHERE user_id = $1
        AND expected_sha256 = $2
        AND expected_size_bytes = $3
        AND status = 'uploading'
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [auth.userId, body.sha256, body.sizeBytes]
    );

    const existingSession = activeRes.rows[0];
    if (existingSession) {
      const parts = parseParts(existingSession.uploaded_parts);
      const response: InitUploadResponse = {
        status: 'ready',
        resumed: true,
        sessionId: existingSession.id,
        chunkSizeBytes: existingSession.chunk_size_bytes,
        totalParts: existingSession.total_parts,
        uploadedPartNumbers: parts.map((p) => p.partNumber).sort((a, b) => a - b),
        bytesUploaded: Number(existingSession.bytes_uploaded)
      };
      return reply.code(200).send(response);
    }

    // Check duplicate in user's own vault (never cross-account, never auto-deletes)
    if (!body.allowDuplicate) {
      const dupRes = await db.query<{
        id: string;
        original_filename: string;
        size_bytes: string | number;
        created_at: string | Date;
      }>(
        `
        SELECT id, original_filename, size_bytes, created_at
        FROM media_files
        WHERE user_id = $1 AND sha256 = $2 AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
        `,
        [auth.userId, body.sha256]
      );

      const dup = dupRes.rows[0];
      if (dup) {
        const response: InitUploadResponse = {
          status: 'duplicate',
          duplicateOf: {
            mediaId: dup.id,
            originalFilename: dup.original_filename,
            sizeBytes: Number(dup.size_bytes),
            createdAt: new Date(dup.created_at).toISOString()
          }
        };
        return reply.code(200).send(response);
      }
    }

    // Check user quota BEFORE allocating storage
    const userRes = await db.query<{ quota_bytes: string | number; used_bytes: string | number }>(
      'SELECT quota_bytes, used_bytes FROM users WHERE id = $1',
      [auth.userId]
    );
    const quotaRow = userRes.rows[0]!;
    if (Number(quotaRow.used_bytes) + body.sizeBytes > Number(quotaRow.quota_bytes)) {
      throw new AppError(
        413,
        'QUOTA_EXCEEDED',
        'Storage quota exceeded. Please free up space or request a quota increase from the administrator.'
      );
    }

    const chunkSizeBytes = body.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE;
    const totalParts = Math.ceil(body.sizeBytes / chunkSizeBytes);
    if (totalParts < 1 || totalParts > 10000) {
      throw Errors.badRequest(
        `Chunk size ${chunkSizeBytes} produces ${totalParts} parts (must be between 1 and 10000)`
      );
    }

    const ext = extractFileExtension(body.originalFilename);
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const objectId = crypto.randomUUID();
    const objectKey = `${auth.userId}/originals/${yyyy}/${mm}/${objectId}${ext ? `.${ext}` : ''}`;

    const selectedTarget = storageRegistry.selectTargetForWrite('copy1_primary', body.sizeBytes);
    if (!selectedTarget) {
      throw new AppError(
        507,
        'POOL_CAPACITY_EXHAUSTED',
        'Tất cả kho lưu trữ trong Pool Copy 1 đã đầy. Hãy thêm kho Cloud mới trong mục Quản trị hệ thống.'
      );
    }

    const primaryStorage = selectedTarget.adapter;
    const { uploadId } = await primaryStorage.createMultipartUpload(objectKey, body.mimeType);
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();

    const insertRes = await db.query<{ id: string }>(
      `
      INSERT INTO upload_sessions (
        user_id, device_id, storage_node_id, storage_upload_id, object_key,
        original_filename, mime_type, media_kind,
        expected_size_bytes, expected_sha256, chunk_size_bytes, total_parts,
        captured_at, width, height, duration_ms, metadata,
        encrypted_file_key, encryption_iv, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20)
      RETURNING id
      `,
      [
        auth.userId,
        auth.deviceId,
        selectedTarget.nodeId,
        uploadId,
        objectKey,
        body.originalFilename,
        body.mimeType || 'application/octet-stream',
        mediaKind,
        body.sizeBytes,
        body.sha256,
        chunkSizeBytes,
        totalParts,
        body.capturedAt ?? null,
        body.width ?? null,
        body.height ?? null,
        body.durationMs ?? null,
        JSON.stringify(body.metadata ?? {}),
        body.encryptedFileKey ?? null,
        body.encryptionIv ?? null,
        expiresAt
      ]
    );

    const response: InitUploadResponse = {
      status: 'ready',
      resumed: false,
      sessionId: insertRes.rows[0]!.id,
      chunkSizeBytes,
      totalParts,
      uploadedPartNumbers: [],
      bytesUploaded: 0
    };

    return reply.code(201).send(response);
  });

  // 3. Inspect Resumable Session Status
  app.get('/api/v1/uploads/:sessionId', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = SessionParamSchema.safeParse(request.params);
    if (!params.success) {
      throw Errors.badRequest('Invalid sessionId');
    }

    const res = await db.query<UploadSessionRow>(
      'SELECT * FROM upload_sessions WHERE id = $1 AND user_id = $2',
      [params.data.sessionId, auth.userId]
    );

    const sess = res.rows[0];
    if (!sess) {
      throw Errors.notFound('Upload session not found');
    }

    const parts = parseParts(sess.uploaded_parts);
    const response: UploadSessionStatusResponse = {
      sessionId: sess.id,
      status: sess.status,
      originalFilename: sess.original_filename,
      expectedSizeBytes: Number(sess.expected_size_bytes),
      expectedSha256: sess.expected_sha256,
      chunkSizeBytes: sess.chunk_size_bytes,
      totalParts: sess.total_parts,
      uploadedPartNumbers: parts.map((p) => p.partNumber).sort((a, b) => a - b),
      bytesUploaded: Number(sess.bytes_uploaded),
      mediaId: sess.media_id,
      errorMessage: sess.error_message
    };
    return response;
  });

  // 4. Upload One Binary Chunk (Idempotent & Resumable, with optional per-part SHA-256)
  app.put(
    '/api/v1/uploads/:sessionId/parts/:partNumber',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const auth = request.auth!;
      const params = PartParamSchema.safeParse(request.params);
      if (!params.success) {
        throw Errors.badRequest('Invalid sessionId or partNumber');
      }

      const { sessionId, partNumber } = params.data;
      const chunkBuffer = Buffer.isBuffer(request.body)
        ? request.body
        : request.body instanceof Uint8Array
          ? Buffer.from(request.body)
          : null;

      if (!chunkBuffer || chunkBuffer.length === 0) {
        throw Errors.badRequest('Chunk body must be non-empty binary (application/octet-stream)');
      }

      const sessRes = await db.query<UploadSessionRow>(
        'SELECT * FROM upload_sessions WHERE id = $1 AND user_id = $2',
        [sessionId, auth.userId]
      );
      const sess = sessRes.rows[0];
      if (!sess) {
        throw Errors.notFound('Upload session not found');
      }
      if (sess.status !== 'uploading') {
        throw Errors.conflict(`Upload session is already in "${sess.status}" state`);
      }
      if (new Date(sess.expires_at).getTime() <= Date.now()) {
        throw Errors.conflict('Upload session has expired');
      }
      if (partNumber > sess.total_parts) {
        throw Errors.badRequest(`partNumber ${partNumber} exceeds totalParts ${sess.total_parts}`);
      }
      if (chunkBuffer.length > sess.chunk_size_bytes) {
        throw Errors.badRequest(
          `Chunk size ${chunkBuffer.length} exceeds session chunkSizeBytes ${sess.chunk_size_bytes}`
        );
      }

      const partSha256 = sha256Hex(chunkBuffer);
      const declaredPartSha = request.headers['x-part-sha256'];
      if (typeof declaredPartSha === 'string' && declaredPartSha.trim().toLowerCase() !== partSha256) {
        throw new AppError(
          422,
          'PART_CHECKSUM_MISMATCH',
          `Chunk ${partNumber} SHA-256 mismatch: expected ${declaredPartSha}, got ${partSha256}`
        );
      }

      const primaryStorage =
        storageRegistry.resolveAdapter(sess.storage_node_id, 'copy1_primary') ??
        storageRegistry.getPrimary();
      const uploaded = await primaryStorage.uploadPart(
        sess.object_key,
        sess.storage_upload_id,
        partNumber,
        chunkBuffer
      );

      // Atomic idempotent part update in DB
      const updatedStats = await db.transaction(async (tx) => {
        const currentRes = await tx.query<{ uploaded_parts: UploadedPartRecord[] }>(
          'SELECT uploaded_parts FROM upload_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE',
          [sessionId, auth.userId]
        );
        const existingParts = parseParts(currentRes.rows[0]?.uploaded_parts);
        const filtered = existingParts.filter((p) => p.partNumber !== partNumber);
        filtered.push({
          partNumber,
          sizeBytes: chunkBuffer.length,
          etag: uploaded.etag,
          sha256: partSha256
        });
        filtered.sort((a, b) => a.partNumber - b.partNumber);
        const bytesUploaded = filtered.reduce((acc, p) => acc + p.sizeBytes, 0);

        await tx.query(
          `
          UPDATE upload_sessions
          SET uploaded_parts = $2::jsonb,
              bytes_uploaded = $3,
              updated_at = NOW()
          WHERE id = $1
          `,
          [sessionId, JSON.stringify(filtered), bytesUploaded]
        );

        return {
          partNumber,
          etag: uploaded.etag,
          partSha256,
          uploadedPartCount: filtered.length,
          totalParts: sess.total_parts,
          bytesUploaded
        };
      });

      return reply.code(200).send(updatedStats);
    }
  );

  // 4b. Direct-to-Cloud S3 Presigned Upload Part URL (bypasses 512 MB backend RAM on Render Free!)
  app.post(
    '/api/v1/uploads/:sessionId/parts/:partNumber/presign',
    { preHandler: [authenticate] },
    async (request): Promise<PresignPartResponse> => {
      const auth = request.auth!;
      const params = PartParamSchema.safeParse(request.params);
      if (!params.success) throw Errors.badRequest('Invalid sessionId or partNumber');

      const { sessionId, partNumber } = params.data;
      const sessRes = await db.query<UploadSessionRow>(
        'SELECT * FROM upload_sessions WHERE id = $1 AND user_id = $2',
        [sessionId, auth.userId]
      );
      const sess = sessRes.rows[0];
      if (!sess) throw Errors.notFound('Upload session not found');
      if (sess.status !== 'uploading') {
        throw Errors.conflict(`Upload session is in "${sess.status}" state`);
      }
      if (partNumber > sess.total_parts) {
        throw Errors.badRequest(`partNumber ${partNumber} exceeds totalParts ${sess.total_parts}`);
      }

      const primary =
        storageRegistry.resolveAdapter(sess.storage_node_id, 'copy1_primary') ??
        storageRegistry.getPrimary();
      const expiresInSeconds = 900;
      const uploadUrl = await primary.getPresignedUploadPartUrl(
        sess.object_key,
        sess.storage_upload_id,
        partNumber,
        expiresInSeconds
      );

      if (!uploadUrl) {
        return { mode: 'api_chunk', uploadUrl: null, expiresInSeconds };
      }

      return { mode: 'presigned_s3', uploadUrl, expiresInSeconds };
    }
  );

  // 4c. Confirm Direct-to-Cloud S3 Uploaded Part ETag
  app.post(
    '/api/v1/uploads/:sessionId/parts/:partNumber/confirm',
    { preHandler: [authenticate] },
    async (request) => {
      const auth = request.auth!;
      const params = PartParamSchema.safeParse(request.params);
      if (!params.success) throw Errors.badRequest('Invalid sessionId or partNumber');

      const body = z
        .object({
          etag: z.string().trim().min(1).max(255),
          sizeBytes: z.number().int().positive(),
          partSha256: Sha256Schema
        })
        .safeParse(request.body);
      if (!body.success) throw Errors.badRequest('Invalid part confirmation payload', body.error.flatten());

      const { sessionId, partNumber } = params.data;
      const sessRes = await db.query<UploadSessionRow>(
        'SELECT * FROM upload_sessions WHERE id = $1 AND user_id = $2',
        [sessionId, auth.userId]
      );
      const sess = sessRes.rows[0];
      if (!sess) throw Errors.notFound('Upload session not found');
      if (sess.status !== 'uploading') {
        throw Errors.conflict(`Upload session is in "${sess.status}" state`);
      }

      const cleanEtag = body.data.etag.replace(/"/g, '');
      const stats = await db.transaction(async (tx) => {
        const curRes = await tx.query<{ uploaded_parts: UploadedPartRecord[] }>(
          'SELECT uploaded_parts FROM upload_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE',
          [sessionId, auth.userId]
        );
        const existingParts = parseParts(curRes.rows[0]?.uploaded_parts);
        const filtered = existingParts.filter((p) => p.partNumber !== partNumber);
        filtered.push({
          partNumber,
          sizeBytes: body.data.sizeBytes,
          etag: cleanEtag,
          sha256: body.data.partSha256
        });
        filtered.sort((a, b) => a.partNumber - b.partNumber);
        const bytesUploaded = filtered.reduce((acc, p) => acc + p.sizeBytes, 0);

        await tx.query(
          'UPDATE upload_sessions SET uploaded_parts = $2::jsonb, bytes_uploaded = $3, updated_at = NOW() WHERE id = $1',
          [sessionId, JSON.stringify(filtered), bytesUploaded]
        );
        return {
          partNumber,
          etag: cleanEtag,
          uploadedPartCount: filtered.length,
          totalParts: sess.total_parts,
          bytesUploaded
        };
      });

      return stats;
    }
  );

  // 5. Complete Multipart Upload & Strictly Verify Bit-for-Bit Size + SHA-256
  app.post('/api/v1/uploads/:sessionId/complete', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const params = SessionParamSchema.safeParse(request.params);
    if (!params.success) {
      throw Errors.badRequest('Invalid sessionId');
    }

    const { sessionId } = params.data;
    const sessRes = await db.query<UploadSessionRow>(
      'SELECT * FROM upload_sessions WHERE id = $1 AND user_id = $2',
      [sessionId, auth.userId]
    );
    const sess = sessRes.rows[0];
    if (!sess) {
      throw Errors.notFound('Upload session not found');
    }

    if (sess.status === 'completed' && sess.media_id) {
      // Idempotent completion response
      const settings = await getSystemSettings(db);
      const mediaRes = await db.query<MediaRow>(
        'SELECT * FROM media_files WHERE id = $1 AND user_id = $2',
        [sess.media_id, auth.userId]
      );
      const hydrated = await hydrateMediaItems(db, mediaRes.rows, settings.required_replicas);
      return reply.code(200).send({
        media: hydrated[0]!,
        integrityVerified: true,
        replicaNotice:
          hydrated[0]!.verifiedReplicaCount >= settings.required_replicas
            ? `Đã xác minh đủ ${settings.required_replicas} bản sao an toàn.`
            : `File gốc đã xác minh SHA-256 trên Copy 1 (${hydrated[0]!.verifiedReplicaCount}/${settings.required_replicas} bản sao). Chưa đánh dấu đủ ${settings.required_replicas} bản sao.`
      } satisfies CompleteUploadResponse);
    }

    if (sess.status !== 'uploading') {
      throw Errors.conflict(`Cannot complete upload session in "${sess.status}" state`);
    }

    const uploadedParts = parseParts(sess.uploaded_parts);
    const presentSet = new Set(uploadedParts.map((p) => p.partNumber));
    const missingPartNumbers: number[] = [];
    for (let i = 1; i <= sess.total_parts; i++) {
      if (!presentSet.has(i)) {
        missingPartNumbers.push(i);
      }
    }
    if (missingPartNumbers.length > 0) {
      throw new AppError(400, 'INCOMPLETE_UPLOAD', 'Cannot complete upload while chunks are missing', {
        missingPartNumbers
      });
    }

    await db.query("UPDATE upload_sessions SET status = 'verifying', updated_at = NOW() WHERE id = $1", [
      sessionId
    ]);

    const primaryStorage =
      storageRegistry.resolveAdapter(sess.storage_node_id, 'copy1_primary') ??
      storageRegistry.getPrimary();
    let verifiedSize = 0;
    let verifiedSha256 = '';

    try {
      await primaryStorage.completeMultipartUpload(
        sess.object_key,
        sess.storage_upload_id,
        uploadedParts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
      );

      const digestInfo = await primaryStorage.computeObjectSha256(sess.object_key);
      verifiedSize = digestInfo.sizeBytes;
      verifiedSha256 = digestInfo.sha256;
    } catch (err) {
      await db.query(
        "UPDATE upload_sessions SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1",
        [sessionId, (err as Error).message]
      );
      throw err;
    }

    const expectedSize = Number(sess.expected_size_bytes);
    if (verifiedSize !== expectedSize || verifiedSha256 !== sess.expected_sha256) {
      await primaryStorage.deleteObject(sess.object_key).catch(() => {});
      const reason = `Integrity check failed: expected size=${expectedSize} sha256=${sess.expected_sha256}, actual size=${verifiedSize} sha256=${verifiedSha256}`;
      await db.query(
        "UPDATE upload_sessions SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1",
        [sessionId, reason]
      );
      throw new AppError(422, 'CHECKSUM_MISMATCH', reason);
    }

    const settings = await getSystemSettings(db);
    const requiredReplicas = settings.required_replicas;
    // PRD 1.2 & 3.1: Only mark 'verified' when required replicas are satisfied; otherwise 'insufficient_replicas'
    const finalUploadState: MediaUploadState =
      requiredReplicas <= 1 ? 'verified' : 'insufficient_replicas';

    const mediaId = await db.transaction(async (tx) => {
      // Re-verify quota inside transaction to prevent concurrent overshoot
      const quotaRes = await tx.query<{ quota_bytes: string | number; used_bytes: string | number }>(
        'SELECT quota_bytes, used_bytes FROM users WHERE id = $1 FOR UPDATE',
        [auth.userId]
      );
      const q = quotaRes.rows[0]!;
      if (Number(q.used_bytes) + verifiedSize > Number(q.quota_bytes)) {
        await primaryStorage.deleteObject(sess.object_key).catch(() => {});
        throw new AppError(413, 'QUOTA_EXCEEDED', 'Storage quota exceeded during finalization');
      }

      const mediaInsert = await tx.query<{ id: string }>(
        `
        INSERT INTO media_files (
          user_id, source_device_id, original_filename, mime_type, media_kind,
          size_bytes, sha256, encryption_mode, encrypted_file_key, encryption_iv,
          upload_state, captured_at, width, height, duration_ms, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
        RETURNING id
        `,
        [
          auth.userId,
          auth.deviceId,
          sess.original_filename,
          sess.mime_type,
          sess.media_kind,
          verifiedSize,
          verifiedSha256,
          auth.encryptionMode,
          sess.encrypted_file_key,
          sess.encryption_iv,
          finalUploadState,
          sess.captured_at ? new Date(sess.captured_at).toISOString() : null,
          sess.width,
          sess.height,
          sess.duration_ms !== null ? Number(sess.duration_ms) : null,
          JSON.stringify(sess.metadata ?? {})
        ]
      );
      const createdMediaId = mediaInsert.rows[0]!.id;

      const objInsert = await tx.query<{ id: string }>(
        `
        INSERT INTO storage_objects (user_id, media_id, object_kind, object_key, size_bytes, sha256, primary_node_id)
        VALUES ($1, $2, 'original', $3, $4, $5, $6)
        RETURNING id
        `,
        [auth.userId, createdMediaId, sess.object_key, verifiedSize, verifiedSha256, sess.storage_node_id]
      );
      const storageObjectId = objInsert.rows[0]!.id;

      // Primary replica verified
      await tx.query(
        `
        INSERT INTO replica_status (
          storage_object_id, replica_slot, storage_node_id, provider, bucket, state, verified_sha256, last_verified_at
        )
        VALUES ($1, 'copy1_primary', $2, $3, $4, 'verified', $5, NOW())
        `,
        [
          storageObjectId,
          sess.storage_node_id,
          primaryStorage.provider,
          primaryStorage.bucket,
          verifiedSha256
        ]
      );

      if (sess.storage_node_id) {
        await tx.query(
          'UPDATE storage_nodes SET used_bytes = used_bytes + $2, updated_at = NOW() WHERE id = $1',
          [sess.storage_node_id, verifiedSize]
        );
      }

      const sec = storageRegistry.getAdapter('copy2_secondary');
      await tx.query(
        `
        INSERT INTO replica_status (storage_object_id, replica_slot, provider, bucket, state)
        VALUES ($1, 'copy2_secondary', $2, $3, 'pending')
        `,
        [storageObjectId, sec?.provider ?? 'unconfigured', sec?.bucket ?? 'pending']
      );

      // Version 1 (indefinite retention until manual delete)
      await tx.query(
        `
        INSERT INTO file_versions (user_id, media_id, version_number, storage_object_id, sha256, size_bytes)
        VALUES ($1, $2, 1, $3, $4, $5)
        `,
        [auth.userId, createdMediaId, storageObjectId, verifiedSha256, verifiedSize]
      );

      await tx.query('UPDATE users SET used_bytes = used_bytes + $2, updated_at = NOW() WHERE id = $1', [
        auth.userId,
        verifiedSize
      ]);

      await tx.query(
        "UPDATE upload_sessions SET status = 'completed', media_id = $2, updated_at = NOW() WHERE id = $1",
        [sessionId, createdMediaId]
      );

      await tx.query(
        `
        INSERT INTO notifications (user_id, category, title, body)
        VALUES ($1, 'backup_success', $2, $3)
        `,
        [
          auth.userId,
          `Đã sao lưu ${sess.original_filename}`,
          finalUploadState === 'verified'
            ? 'File gốc đã xác minh SHA-256 và đạt đủ số bản sao theo chính sách.'
            : `File gốc đã xác minh SHA-256 trên Copy 1 (1/${requiredReplicas} bản sao — đang chờ nhân bản thêm).`
        ]
      );

      return createdMediaId;
    });

    storageRegistry.adjustPoolNodeUsedBytes(sess.storage_node_id, verifiedSize);

    const mediaRes = await db.query<MediaRow>(
      'SELECT * FROM media_files WHERE id = $1 AND user_id = $2',
      [mediaId, auth.userId]
    );

    const hydrated = await hydrateMediaItems(db, mediaRes.rows, requiredReplicas);
    const response: CompleteUploadResponse = {
      media: hydrated[0]!,
      integrityVerified: true,
      replicaNotice:
        finalUploadState === 'verified'
          ? `Đã xác minh đủ ${requiredReplicas} bản sao an toàn.`
          : `File gốc đã xác minh SHA-256 trên Copy 1 (1/${requiredReplicas} bản sao). Chưa đánh dấu đủ ${requiredReplicas} bản sao.`
    };

    return reply.code(200).send(response);
  });

  // 6. Abort Incomplete Upload Session cleanly
  app.delete('/api/v1/uploads/:sessionId', { preHandler: [authenticate] }, async (request) => {
    const auth = request.auth!;
    const params = SessionParamSchema.safeParse(request.params);
    if (!params.success) {
      throw Errors.badRequest('Invalid sessionId');
    }

    const res = await db.query<UploadSessionRow>(
      'SELECT * FROM upload_sessions WHERE id = $1 AND user_id = $2',
      [params.data.sessionId, auth.userId]
    );
    const sess = res.rows[0];
    if (!sess) {
      throw Errors.notFound('Upload session not found');
    }
    if (sess.status === 'completed') {
      throw Errors.conflict('Cannot abort an already completed upload session');
    }

    const primaryStorage =
      storageRegistry.resolveAdapter(sess.storage_node_id, 'copy1_primary') ??
      storageRegistry.getPrimary();
    await primaryStorage.abortMultipartUpload(sess.object_key, sess.storage_upload_id).catch(() => {});
    await db.query("UPDATE upload_sessions SET status = 'aborted', updated_at = NOW() WHERE id = $1", [
      sess.id
    ]);

    return { aborted: true, sessionId: sess.id };
  });
}
