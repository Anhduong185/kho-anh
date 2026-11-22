import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  CloudStorageProvider,
  ReplicaSlot,
  StorageMigrationResult,
  StorageProtocol,
  TestStorageTargetResponse
} from '@smb/shared';
import type { AppConfig } from '../../config/env.js';
import type { DbClient } from '../../db/client.js';
import { createAuthMiddleware, requireRole } from '../../middleware/auth.js';
import {
  buildAdapterFromRecord,
  getStorageSecretSeed,
  providerProtocol,
  type StorageNodeRow,
  type StorageRegistry,
  type StorageTargetRow
} from '../../storage/registry.js';
import { encryptServerSecret } from '../../utils/crypto.js';
import { Errors } from '../../utils/errors.js';

const SlotParamSchema = z.object({
  slot: z.enum(['copy1_primary', 'copy2_secondary', 'copy3_offsite'])
});

const NodeIdParamSchema = z.object({
  nodeId: z.string().uuid()
});

const ProviderEnum = z.enum([
  'local',
  'cloudflare_r2',
  'backblaze_b2',
  'oracle_oci',
  'oracle_vm_minio',
  'infinicloud_webdav',
  'koofr_webdav',
  'webdav_custom',
  'minio',
  's3_custom'
]);

const SaveTargetSchema = z.object({
  provider: ProviderEnum,
  enabled: z.boolean().optional().default(true),
  endpoint: z.string().trim().max(512).optional().default(''),
  region: z.string().trim().max(128).optional().default('auto'),
  bucket: z.string().trim().max(255).optional().default(''),
  accessKeyId: z.string().trim().max(255).optional().default(''),
  secretAccessKey: z.string().trim().max(512).optional().default(''),
  forcePathStyle: z.boolean().optional().default(true),
  localRoot: z.string().trim().max(512).optional().default('')
});

const CreatePoolNodeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slot: z.enum(['copy1_primary', 'copy2_secondary']),
  provider: ProviderEnum,
  enabled: z.boolean().optional().default(true),
  priority: z.number().int().min(1).max(9999).optional().default(100),
  capacityBytes: z.number().int().positive().max(100 * 1024 * 1024 * 1024 * 1024),
  endpoint: z.string().trim().max(512).optional().default(''),
  region: z.string().trim().max(128).optional().default('auto'),
  bucket: z.string().trim().max(255).optional().default(''),
  accessKeyId: z.string().trim().max(255).optional().default(''),
  secretAccessKey: z.string().trim().max(512).optional().default(''),
  forcePathStyle: z.boolean().optional().default(true),
  localRoot: z.string().trim().max(512).optional().default('')
});

const PatchPoolNodeSchema = CreatePoolNodeSchema.partial().extend({
  slot: SlotParamSchema.shape.slot.optional()
});

const MigrateBodySchema = z.object({
  sourceSlot: z.enum(['copy1_primary', 'copy2_secondary', 'copy3_offsite']),
  targetSlot: z.enum(['copy1_primary', 'copy2_secondary'])
});

export interface CloudProviderPreset {
  provider: CloudStorageProvider;
  protocol: StorageProtocol;
  label: string;
  suggestedCapacityGb: number;
  freeTier: string;
  requiresCard: boolean;
  endpointTemplate: string;
  defaultRegion: string;
  notes: string;
}

export const CLOUD_PROVIDER_PRESETS: CloudProviderPreset[] = [
  {
    provider: 'oracle_vm_minio',
    protocol: 's3',
    label: 'Oracle Cloud Always Free VM + MinIO',
    suggestedCapacityGb: 180,
    freeTier: 'Dung lượng tùy tài nguyên Always Free được cấp; VM nhàn rỗi có thể bị thu hồi',
    requiresCard: true,
    endpointTemplate: 'https://minio.your-oci-domain.com',
    defaultRegion: 'ap-singapore-1',
    notes: 'Không tính vào dung lượng cam kết cho lưu ảnh dài hạn.'
  },
  {
    provider: 'oracle_oci',
    protocol: 's3',
    label: 'Oracle Cloud Object Storage (OCI S3)',
    suggestedCapacityGb: 20,
    freeTier: '20 GB Object Storage miễn phí trọn đời',
    requiresCard: true,
    endpointTemplate: 'https://<NAMESPACE>.compat.objectstorage.<REGION>.oraclecloud.com',
    defaultRegion: 'ap-singapore-1',
    notes: 'Tạo Customer Secret Key trong OCI Console để kết nối qua S3 Compatibility API.'
  },
  {
    provider: 'infinicloud_webdav',
    protocol: 'webdav',
    label: 'InfiniCLOUD (WebDAV)',
    suggestedCapacityGb: 20,
    freeTier: '20 GB miễn phí vĩnh viễn (có thể tăng thêm bằng mã thưởng chính thức)',
    requiresCard: false,
    endpointTemplate: 'https://teracloud.jp/dav',
    defaultRegion: 'jp',
    notes: 'Bật Apps Connection (WebDAV) trong tài khoản InfiniCLOUD để lấy User ID & App Password.'
  },
  {
    provider: 'cloudflare_r2',
    protocol: 's3',
    label: 'Cloudflare R2 (S3)',
    suggestedCapacityGb: 10,
    freeTier: '10 GB miễn phí · Tải xuống/xem video (egress) 0 USD không giới hạn',
    requiresCard: true,
    endpointTemplate: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com',
    defaultRegion: 'auto',
    notes: 'Rất lý tưởng cho ảnh xem thường xuyên vì băng thông tải xuống hoàn toàn miễn phí.'
  },
  {
    provider: 'backblaze_b2',
    protocol: 's3',
    label: 'Backblaze B2 (S3)',
    suggestedCapacityGb: 10,
    freeTier: '10 GB miễn phí · Không cần thẻ tín dụng',
    requiresCard: false,
    endpointTemplate: 'https://s3.<REGION>.backblazeb2.com',
    defaultRegion: 'us-west-004',
    notes: 'Đăng ký nhanh không cần thẻ; nếu mở rộng trả theo dung lượng chỉ ~6.95 USD/TB/tháng.'
  },
  {
    provider: 'koofr_webdav',
    protocol: 'webdav',
    label: 'Koofr (WebDAV)',
    suggestedCapacityGb: 10,
    freeTier: '10 GB miễn phí vĩnh viễn · Không cần thẻ tín dụng',
    requiresCard: false,
    endpointTemplate: 'https://app.koofr.net/dav/Koofr',
    defaultRegion: 'eu',
    notes: 'Cloud châu Âu bảo mật; tạo App Password trong Koofr Settings → Password để kết nối WebDAV.'
  },
  {
    provider: 'webdav_custom',
    protocol: 'webdav',
    label: 'WebDAV khác (Nextcloud · Yandex Disk · Synology/QNAP NAS)',
    suggestedCapacityGb: 10,
    freeTier: 'Yandex Disk 10 GB free · Nextcloud/NAS tùy gói hoặc ổ cứng của bạn',
    requiresCard: false,
    endpointTemplate: 'https://webdav.yandex.com',
    defaultRegion: 'webdav',
    notes: 'Hỗ trợ mọi kho WebDAV chuẩn (Nextcloud, OwnCloud, Yandex Disk, pCloud, NAS tại nhà).'
  },
  {
    provider: 'minio',
    protocol: 's3',
    label: 'MinIO / NAS tự host tại nhà (S3)',
    suggestedCapacityGb: 400,
    freeTier: '200 GB – 4 TB+ (0 USD/tháng, dùng ổ cứng PC/NAS của bạn)',
    requiresCard: false,
    endpointTemplate: 'http://127.0.0.1:9000',
    defaultRegion: 'us-east-1',
    notes: 'Cách bền vững nhất để đạt 400 GB – vài TB không tốn phí thuê hàng tháng.'
  },
  {
    provider: 'local',
    protocol: 'local',
    label: 'Ổ đĩa cục bộ / Ổ cứng gắn ngoài (Local Disk)',
    suggestedCapacityGb: 200,
    freeTier: 'Miễn phí · Lưu trực tiếp trên ổ cứng cục bộ hoặc ổ USB gắn ngoài',
    requiresCard: false,
    endpointTemplate: '',
    defaultRegion: 'local',
    notes: 'Có thể thêm nhiều phân vùng / ổ đĩa khác nhau vào cùng một Pool.'
  },
  {
    provider: 's3_custom',
    protocol: 's3',
    label: 'Nhà cung cấp S3-Compatible khác',
    suggestedCapacityGb: 100,
    freeTier: 'Tùy gói (Wasabi, DigitalOcean Spaces, Garage, Ceph...)',
    requiresCard: false,
    endpointTemplate: 'https://s3.example.com',
    defaultRegion: 'us-east-1',
    notes: 'Tương thích chuẩn AWS S3 v4.'
  }
];

function validateEndpointUrl(endpoint: string): void {
  if (!endpoint) return;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw Errors.badRequest('Endpoint phải là URL hợp lệ (ví dụ: https://s3.us-west-004.backblazeb2.com)');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw Errors.badRequest('Endpoint chỉ hỗ trợ giao thức http:// hoặc https://');
  }
}

export function registerStorageAdminRoutes(
  app: FastifyInstance,
  db: DbClient,
  config: AppConfig,
  storageRegistry: StorageRegistry
) {
  const authenticate = createAuthMiddleware(db, config);
  const adminGuards = [authenticate, requireRole('admin')];

  // =========================================================================
  // MULTI-CLOUD STORAGE POOL API (Unlimited Nodes -> Pool >= 400 GB+)
  // =========================================================================

  app.get('/api/v1/admin/storage/pool', { preHandler: adminGuards }, async () => {
    return {
      nodes: storageRegistry.listPoolNodeViews(),
      summary: storageRegistry.getPoolCapacitySummary(),
      presets: CLOUD_PROVIDER_PRESETS
    };
  });

  // Test unsaved pool node credentials (live Write -> SHA-256 Read -> Delete probe for S3, WebDAV, or Local)
  app.post('/api/v1/admin/storage/pool/test', { preHandler: adminGuards }, async (request) => {
    const parsed = CreatePoolNodeSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.badRequest('Invalid pool node test payload', parsed.error.flatten());
    }
    const input = parsed.data;
    const proto = providerProtocol(input.provider);
    if (proto !== 'local') validateEndpointUrl(input.endpoint);

    const adapter = buildAdapterFromRecord({
      slot: input.slot,
      provider: input.provider,
      enabled: true,
      endpoint: input.endpoint,
      region: input.region || 'auto',
      bucket: input.bucket || 'vault-photos',
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      forcePathStyle: input.forcePathStyle,
      localRoot: input.localRoot
    });

    if (!adapter) {
      return {
        result: {
          ok: false,
          provider: input.provider,
          latencyMs: 0,
          checks: { write: false, readVerify: false, delete: false },
          message: 'Thiếu thông tin kết nối bắt buộc (Endpoint / Username-AccessKey / Password-SecretKey / Bucket hoặc Local Root).'
        } satisfies TestStorageTargetResponse
      };
    }

    const probe = await adapter.runWriteReadDeleteProbe();
    return {
      result: {
        ok: probe.ok,
        provider: input.provider,
        latencyMs: probe.latencyMs,
        checks: probe.checks,
        message: probe.message
      } satisfies TestStorageTargetResponse
    };
  });

  // Add a new Cloud / WebDAV / Local node into the Multi-Cloud Storage Pool
  app.post('/api/v1/admin/storage/pool/nodes', { preHandler: adminGuards }, async (request, reply) => {
    const auth = request.auth!;
    const parsed = CreatePoolNodeSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.badRequest('Invalid pool node payload', parsed.error.flatten());
    }

    const input = parsed.data;
    const proto = providerProtocol(input.provider);
    if (proto === 'local') {
      if (!input.localRoot) throw Errors.badRequest('Cần nhập đường dẫn thư mục (localRoot) cho kho Local Disk.');
    } else {
      validateEndpointUrl(input.endpoint);
      if (!input.endpoint || !input.accessKeyId || !input.secretAccessKey) {
        throw Errors.badRequest(
          proto === 'webdav'
            ? 'Cần nhập đầy đủ WebDAV Endpoint, Username và App Password.'
            : 'Cần nhập đầy đủ Endpoint, Bucket, Access Key ID và Secret Access Key.'
        );
      }
      if (proto === 's3' && !input.bucket) {
        throw Errors.badRequest('Cần nhập tên Bucket cho kho S3.');
      }
    }

    const seed = getStorageSecretSeed(config);
    const encryptedSecret = input.secretAccessKey
      ? encryptServerSecret(input.secretAccessKey, seed)
      : '';

    const res = await db.query<StorageNodeRow>(
      `
      INSERT INTO storage_nodes (
        name, replica_slot, provider, enabled, priority, capacity_bytes,
        endpoint, region, bucket, access_key_id, encrypted_secret_access_key,
        force_path_style, local_root, updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
      `,
      [
        input.name,
        input.slot,
        input.provider,
        input.enabled,
        input.priority,
        input.capacityBytes,
        proto === 'local' ? '' : input.endpoint,
        proto === 'local' ? 'local' : input.region || 'auto',
        input.bucket || (proto === 'webdav' ? 'vault-photos' : input.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')),
        proto === 'local' ? '' : input.accessKeyId,
        encryptedSecret,
        input.forcePathStyle,
        proto === 'local' ? input.localRoot : '',
        auth.userId
      ]
    );

    const row = res.rows[0]!;
    storageRegistry.applyPoolNodeRow(row);

    return reply.code(201).send({
      node: storageRegistry.listPoolNodeViews().find((n) => n.id === row.id)!,
      summary: storageRegistry.getPoolCapacitySummary()
    });
  });

  // Update an existing Pool Node (capacity, priority, enable/disable, or rotate credentials)
  app.patch('/api/v1/admin/storage/pool/nodes/:nodeId', { preHandler: adminGuards }, async (request) => {
    const auth = request.auth!;
    const params = NodeIdParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid nodeId');
    const body = PatchPoolNodeSchema.safeParse(request.body);
    if (!body.success) throw Errors.badRequest('Invalid node update payload', body.error.flatten());

    const existing = storageRegistry.getPoolNode(params.data.nodeId);
    if (!existing) throw Errors.notFound('Storage pool node not found');

    const nextProvider = body.data.provider ?? existing.provider;
    const proto = providerProtocol(nextProvider);
    const nextEndpoint = body.data.endpoint !== undefined ? body.data.endpoint : existing.endpoint;
    if (proto !== 'local') validateEndpointUrl(nextEndpoint);

    const nextAccessKey = body.data.accessKeyId || existing.accessKeyId;
    const nextSecretPlain = body.data.secretAccessKey || existing.secretAccessKey;
    const seed = getStorageSecretSeed(config);
    const encryptedSecret = nextSecretPlain ? encryptServerSecret(nextSecretPlain, seed) : '';

    const res = await db.query<StorageNodeRow>(
      `
      UPDATE storage_nodes
      SET name = $2,
          replica_slot = $3,
          provider = $4,
          enabled = $5,
          priority = $6,
          capacity_bytes = $7,
          endpoint = $8,
          region = $9,
          bucket = $10,
          access_key_id = $11,
          encrypted_secret_access_key = $12,
          force_path_style = $13,
          local_root = $14,
          updated_at = NOW(),
          updated_by = $15
      WHERE id = $1
      RETURNING *
      `,
      [
        params.data.nodeId,
        body.data.name ?? existing.name,
        body.data.slot ?? existing.slot,
        nextProvider,
        body.data.enabled ?? existing.enabled,
        body.data.priority ?? existing.priority,
        body.data.capacityBytes ?? existing.capacityBytes,
        proto === 'local' ? '' : nextEndpoint,
        body.data.region ?? existing.region,
        body.data.bucket ?? existing.bucket,
        proto === 'local' ? '' : nextAccessKey,
        encryptedSecret,
        body.data.forcePathStyle ?? existing.forcePathStyle,
        proto === 'local' ? (body.data.localRoot ?? existing.localRoot) : '',
        auth.userId
      ]
    );

    storageRegistry.applyPoolNodeRow(res.rows[0]!);
    return {
      node: storageRegistry.listPoolNodeViews().find((n) => n.id === params.data.nodeId)!,
      summary: storageRegistry.getPoolCapacitySummary()
    };
  });

  // Test a saved Pool Node live
  app.post('/api/v1/admin/storage/pool/nodes/:nodeId/test', { preHandler: adminGuards }, async (request) => {
    const params = NodeIdParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid nodeId');

    const node = storageRegistry.getPoolNode(params.data.nodeId);
    if (!node || !node.adapter) {
      throw Errors.notFound('Storage pool node not found or disabled');
    }

    const probe = await node.adapter.runWriteReadDeleteProbe();
    await db.query(
      'UPDATE storage_nodes SET last_test_ok = $2, last_test_at = NOW(), last_test_message = $3 WHERE id = $1',
      [node.id, probe.ok, probe.message]
    );
    node.lastTestOk = probe.ok;
    node.lastTestAt = new Date().toISOString();
    node.lastTestMessage = probe.message;

    return {
      result: {
        ok: probe.ok,
        provider: node.provider,
        latencyMs: probe.latencyMs,
        checks: probe.checks,
        message: probe.message
      } satisfies TestStorageTargetResponse
    };
  });

  // Safely remove a Pool Node (blocks removal if active files still live on it!)
  app.delete('/api/v1/admin/storage/pool/nodes/:nodeId', { preHandler: adminGuards }, async (request) => {
    const params = NodeIdParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid nodeId');

    const usageCheck = await db.query<{ cnt: string }>(
      `
      SELECT (
        (SELECT COUNT(*) FROM storage_objects WHERE primary_node_id = $1) +
        (SELECT COUNT(*) FROM replica_status WHERE storage_node_id = $1)
      )::text AS cnt
      `,
      [params.data.nodeId]
    );
    if (Number(usageCheck.rows[0]?.cnt ?? '0') > 0) {
      throw Errors.conflict(
        'Kho này vẫn đang chứa file gốc của người dùng. Hãy tạm tắt nhận file mới hoặc chạy Migration sang kho khác trước khi gỡ.'
      );
    }

    const del = await db.query('DELETE FROM storage_nodes WHERE id = $1 RETURNING id', [params.data.nodeId]);
    if (del.rowCount === 0) throw Errors.notFound('Storage pool node not found');

    storageRegistry.removePoolNode(params.data.nodeId);
    return { removed: true, summary: storageRegistry.getPoolCapacitySummary() };
  });

  // =========================================================================
  // LEGACY SINGLE-SLOT TARGETS & PROVIDER MIGRATION API
  // =========================================================================

  app.get('/api/v1/admin/storage/targets', { preHandler: adminGuards }, async () => {
    return {
      targets: storageRegistry.listConfigViews(),
      presets: CLOUD_PROVIDER_PRESETS
    };
  });

  app.post('/api/v1/admin/storage/targets/:slot/test', { preHandler: adminGuards }, async (request) => {
    const params = SlotParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid storage slot');

    const slot = params.data.slot as ReplicaSlot;
    const rawBody = request.body as Record<string, unknown> | undefined;
    const hasCustomBody = Boolean(rawBody && typeof rawBody.provider === 'string');

    let provider: CloudStorageProvider;
    let adapterToTest;

    if (hasCustomBody) {
      const parsed = SaveTargetSchema.safeParse(rawBody);
      if (!parsed.success) {
        throw Errors.badRequest('Invalid storage target test payload', parsed.error.flatten());
      }
      const input = parsed.data;
      provider = input.provider;
      validateEndpointUrl(input.endpoint);

      const existing = storageRegistry.getRecord(slot);
      const effectiveAccessKey = input.accessKeyId || existing?.accessKeyId || '';
      const effectiveSecretKey = input.secretAccessKey || existing?.secretAccessKey || '';

      adapterToTest = buildAdapterFromRecord({
        slot,
        provider: input.provider,
        enabled: true,
        endpoint: input.endpoint,
        region: input.region || 'auto',
        bucket: input.bucket,
        accessKeyId: effectiveAccessKey,
        secretAccessKey: effectiveSecretKey,
        forcePathStyle: input.forcePathStyle,
        localRoot: input.localRoot || config.STORAGE_LOCAL_ROOT
      });
    } else {
      const existing = storageRegistry.getRecord(slot);
      provider = existing?.provider ?? 'local';
      adapterToTest = storageRegistry.getAdapter(slot);
    }

    if (!adapterToTest) {
      return {
        result: {
          ok: false,
          provider,
          latencyMs: 0,
          checks: { write: false, readVerify: false, delete: false },
          message: 'Thiếu thông tin kết nối bắt buộc (endpoint, bucket, accessKeyId, secretAccessKey hoặc localRoot).'
        } satisfies TestStorageTargetResponse
      };
    }

    const probe = await adapterToTest.runWriteReadDeleteProbe();
    await db.query(
      'UPDATE storage_targets SET last_test_ok = $2, last_test_at = NOW(), last_test_message = $3 WHERE slot = $1',
      [slot, probe.ok, probe.message]
    );
    const rec = storageRegistry.getRecord(slot);
    if (rec && !hasCustomBody) {
      rec.lastTestOk = probe.ok;
      rec.lastTestAt = new Date().toISOString();
      rec.lastTestMessage = probe.message;
    }

    return {
      result: {
        ok: probe.ok,
        provider,
        latencyMs: probe.latencyMs,
        checks: probe.checks,
        message: probe.message
      } satisfies TestStorageTargetResponse
    };
  });

  app.put('/api/v1/admin/storage/targets/:slot', { preHandler: adminGuards }, async (request) => {
    const auth = request.auth!;
    const params = SlotParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid storage slot');
    const body = SaveTargetSchema.safeParse(request.body);
    if (!body.success) throw Errors.badRequest('Invalid storage target configuration', body.error.flatten());

    const slot = params.data.slot as ReplicaSlot;
    const input = body.data;
    const proto = providerProtocol(input.provider);

    if (slot === 'copy1_primary' && !input.enabled) {
      throw Errors.badRequest('Copy 1 (Primary) không thể bị tắt vì đây là kho lưu trữ chính.');
    }

    if (proto !== 'local') {
      validateEndpointUrl(input.endpoint);
      if (input.enabled && !input.endpoint) {
        throw Errors.badRequest('Cần nhập Endpoint cho kho lưu trữ Cloud.');
      }
      if (proto === 's3' && input.enabled && !input.bucket) {
        throw Errors.badRequest('Cần nhập tên Bucket cho kho S3.');
      }
    } else if (input.enabled && !input.localRoot) {
      throw Errors.badRequest('Cần nhập đường dẫn thư mục lưu trữ (localRoot) cho Local Disk.');
    }

    const existing = storageRegistry.getRecord(slot);
    const finalAccessKey = proto === 'local' ? '' : input.accessKeyId || existing?.accessKeyId || '';
    const finalSecretPlain = proto === 'local' ? '' : input.secretAccessKey || existing?.secretAccessKey || '';

    if (proto !== 'local' && input.enabled && (!finalAccessKey || !finalSecretPlain)) {
      throw Errors.badRequest('Cần cung cấp Access Key / Username và Secret Key / Password.');
    }

    const seed = getStorageSecretSeed(config);
    const encryptedSecret = finalSecretPlain ? encryptServerSecret(finalSecretPlain, seed) : '';

    const savedRes = await db.query<StorageTargetRow>(
      `
      INSERT INTO storage_targets (
        slot, provider, enabled, endpoint, region, bucket,
        access_key_id, encrypted_secret_access_key, force_path_style, local_root,
        updated_at, updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11)
      ON CONFLICT (slot) DO UPDATE
        SET provider = EXCLUDED.provider,
            enabled = EXCLUDED.enabled,
            endpoint = EXCLUDED.endpoint,
            region = EXCLUDED.region,
            bucket = EXCLUDED.bucket,
            access_key_id = EXCLUDED.access_key_id,
            encrypted_secret_access_key = EXCLUDED.encrypted_secret_access_key,
            force_path_style = EXCLUDED.force_path_style,
            local_root = EXCLUDED.local_root,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by
      RETURNING *
      `,
      [
        slot,
        input.provider,
        input.enabled,
        proto === 'local' ? '' : input.endpoint,
        proto === 'local' ? 'local' : input.region || 'auto',
        input.bucket || slot,
        finalAccessKey,
        encryptedSecret,
        input.forcePathStyle,
        proto === 'local' ? input.localRoot : '',
        auth.userId
      ]
    );

    storageRegistry.applyDatabaseRow(savedRes.rows[0]!);

    if (slot === 'copy2_secondary' && input.enabled) {
      const adapter = storageRegistry.getAdapter(slot);
      if (adapter) {
        await db.query(
          `
          INSERT INTO replica_status (storage_object_id, replica_slot, provider, bucket, state)
          SELECT so.id, $1, $2, $3, 'pending'
          FROM storage_objects so
          WHERE so.object_kind = 'original'
            AND NOT EXISTS (
              SELECT 1 FROM replica_status rs
              WHERE rs.storage_object_id = so.id AND rs.replica_slot = $1
            )
          `,
          [slot, adapter.provider, adapter.bucket]
        );
      }
    }

    return {
      saved: true,
      target: storageRegistry.listConfigViews().find((t) => t.slot === slot)!
    };
  });

  app.delete('/api/v1/admin/storage/targets/:slot', { preHandler: adminGuards }, async (request) => {
    const params = SlotParamSchema.safeParse(request.params);
    if (!params.success) throw Errors.badRequest('Invalid storage slot');
    if (params.data.slot === 'copy1_primary') {
      throw Errors.badRequest('Không thể gỡ bỏ Copy 1 (Primary). Hãy cập nhật cấu hình mới nếu muốn đổi kho chính.');
    }

    await db.query('DELETE FROM storage_targets WHERE slot = $1', [params.data.slot]);
    storageRegistry.resetSlotToDefault(params.data.slot);
    return { removed: true, slot: params.data.slot };
  });

  app.post('/api/v1/admin/storage/migrate', { preHandler: adminGuards }, async (request) => {
    const parsed = MigrateBodySchema.safeParse(request.body);
    if (!parsed.success) throw Errors.badRequest('Invalid migration request', parsed.error.flatten());

    const { sourceSlot, targetSlot } = parsed.data;
    if (sourceSlot === targetSlot) {
      throw Errors.badRequest('sourceSlot và targetSlot phải khác nhau.');
    }

    const objectsRes = await db.query<{
      id: string;
      object_key: string;
      primary_node_id: string | null;
      sha256: string;
      size_bytes: string | number;
    }>(`
      SELECT so.id, so.object_key, so.primary_node_id, so.sha256, so.size_bytes
      FROM storage_objects so
      JOIN media_files m ON m.id = so.media_id
      WHERE so.object_kind = 'original' AND m.deleted_at IS NULL
      ORDER BY so.created_at ASC
    `);

    let migratedCount = 0;
    let skippedAlreadyVerified = 0;
    const failures: StorageMigrationResult['failures'] = [];

    for (const obj of objectsRes.rows) {
      const expectedSize = Number(obj.size_bytes);
      const sourceAdapter = storageRegistry.resolveAdapter(
        sourceSlot === 'copy1_primary' ? obj.primary_node_id : null,
        sourceSlot
      );
      const targetSelected = storageRegistry.selectTargetForWrite(targetSlot, expectedSize);
      if (!sourceAdapter || !targetSelected) {
        failures.push({ objectKey: obj.object_key, error: 'Source or target storage unavailable or full' });
        continue;
      }

      const targetAdapter = targetSelected.adapter;
      try {
        const existingHead = await targetAdapter.headObject(obj.object_key);
        if (existingHead && existingHead.sizeBytes === expectedSize) {
          const check = await targetAdapter.computeObjectSha256(obj.object_key);
          if (check.sha256 === obj.sha256) {
            skippedAlreadyVerified++;
            await db.query(
              `
              INSERT INTO replica_status (storage_object_id, replica_slot, storage_node_id, provider, bucket, state, verified_sha256, last_verified_at)
              VALUES ($1, $2, $3, $4, $5, 'verified', $6, NOW())
              ON CONFLICT (storage_object_id, replica_slot) DO UPDATE
                SET state = 'verified', storage_node_id = EXCLUDED.storage_node_id,
                    provider = EXCLUDED.provider, bucket = EXCLUDED.bucket,
                    verified_sha256 = EXCLUDED.verified_sha256, last_verified_at = NOW(), error_message = NULL, updated_at = NOW()
              `,
              [obj.id, targetSlot, targetSelected.nodeId, targetAdapter.provider, targetAdapter.bucket, check.sha256]
            );
            continue;
          }
        }

        const bytes = await sourceAdapter.getObject(obj.object_key);
        await targetAdapter.putObject({
          key: obj.object_key,
          body: bytes,
          expectedSha256: obj.sha256
        });

        const verified = await targetAdapter.computeObjectSha256(obj.object_key);
        if (verified.sha256 !== obj.sha256 || verified.sizeBytes !== expectedSize) {
          throw new Error('Post-migration SHA-256 verification mismatch');
        }

        await db.query(
          `
          INSERT INTO replica_status (storage_object_id, replica_slot, storage_node_id, provider, bucket, state, verified_sha256, last_verified_at)
          VALUES ($1, $2, $3, $4, $5, 'verified', $6, NOW())
          ON CONFLICT (storage_object_id, replica_slot) DO UPDATE
            SET state = 'verified', storage_node_id = EXCLUDED.storage_node_id,
                provider = EXCLUDED.provider, bucket = EXCLUDED.bucket,
                verified_sha256 = EXCLUDED.verified_sha256, last_verified_at = NOW(), error_message = NULL, updated_at = NOW()
          `,
          [obj.id, targetSlot, targetSelected.nodeId, targetAdapter.provider, targetAdapter.bucket, verified.sha256]
        );

        if (targetSelected.nodeId) {
          await db.query(
            'UPDATE storage_nodes SET used_bytes = used_bytes + $2, updated_at = NOW() WHERE id = $1',
            [targetSelected.nodeId, expectedSize]
          );
          storageRegistry.adjustPoolNodeUsedBytes(targetSelected.nodeId, expectedSize);
        }
        migratedCount++;
      } catch (err) {
        failures.push({ objectKey: obj.object_key, error: (err as Error).message });
      }
    }

    const result: StorageMigrationResult = {
      sourceSlot,
      targetSlot,
      migratedCount,
      skippedAlreadyVerified,
      failedCount: failures.length,
      failures
    };
    return { result };
  });
}
