import type {
  CloudStorageProvider,
  PoolCapacitySummary,
  ReplicaSlot,
  StorageNodeView,
  StorageProtocol,
  StorageTargetConfigView,
  StorageTargetStatus
} from '@smb/shared';
import type { AppConfig } from '../config/env.js';
import type { DbQueryable } from '../db/client.js';
import { decryptServerSecret, maskAccessKey } from '../utils/crypto.js';
import { LocalDiskStorageAdapter } from './local-adapter.js';
import { S3StorageAdapter } from './s3-adapter.js';
import type { StorageAdapter } from './types.js';
import { WebDavStorageAdapter } from './webdav-adapter.js';

export const POOL_TARGET_GOAL_BYTES = 400 * 1024 * 1024 * 1024; // 400 GiB target goal

export interface ResolvedTargetRecord {
  slot: ReplicaSlot;
  provider: CloudStorageProvider;
  enabled: boolean;
  source: 'database' | 'env' | 'default';
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  localRoot: string;
  lastTestOk: boolean | null;
  lastTestAt: string | null;
  lastTestMessage: string | null;
  adapter: StorageAdapter | null;
}

export interface StorageTargetRow {
  slot: ReplicaSlot;
  provider: CloudStorageProvider;
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  encrypted_secret_access_key: string;
  force_path_style: boolean;
  local_root: string;
  last_test_ok: boolean | null;
  last_test_at: string | Date | null;
  last_test_message: string | null;
}

export interface StorageNodeRow {
  id: string;
  name: string;
  replica_slot: ReplicaSlot;
  provider: CloudStorageProvider;
  enabled: boolean;
  priority: number;
  capacity_bytes: string | number;
  used_bytes: string | number;
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  encrypted_secret_access_key: string;
  force_path_style: boolean;
  local_root: string;
  last_test_ok: boolean | null;
  last_test_at: string | Date | null;
  last_test_message: string | null;
  created_at: string | Date;
}

export interface ResolvedPoolNode {
  id: string;
  name: string;
  slot: ReplicaSlot;
  provider: CloudStorageProvider;
  protocol: StorageProtocol;
  enabled: boolean;
  priority: number;
  capacityBytes: number;
  usedBytes: number;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  localRoot: string;
  lastTestOk: boolean | null;
  lastTestAt: string | null;
  lastTestMessage: string | null;
  createdAt: string;
  adapter: StorageAdapter | null;
}

const ALL_SLOTS: ReplicaSlot[] = ['copy1_primary', 'copy2_secondary', 'copy3_offsite'];

export function providerProtocol(provider: CloudStorageProvider): StorageProtocol {
  if (provider === 'local') return 'local';
  if (provider === 'google_drive') return 'gdrive';
  if (
    provider === 'infinicloud_webdav' ||
    provider === 'koofr_webdav' ||
    provider === 'webdav_custom'
  ) {
    return 'webdav';
  }
  return 's3';
}

export function getStorageSecretSeed(config: AppConfig): string {
  return config.STORAGE_CONFIG_KEY || config.JWT_ACCESS_SECRET;
}

export function buildAdapterFromRecord(input: {
  slot: ReplicaSlot;
  provider: CloudStorageProvider;
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  localRoot: string;
}): StorageAdapter | null {
  if (!input.enabled) return null;

  const proto = providerProtocol(input.provider);

  if (proto === 'local') {
    if (!input.localRoot) return null;
    return new LocalDiskStorageAdapter(input.localRoot, input.bucket || input.slot);
  }

  if (proto === 'webdav') {
    if (!input.endpoint || !input.accessKeyId || !input.secretAccessKey) {
      return null;
    }
    return new WebDavStorageAdapter({
      providerLabel: input.provider,
      endpoint: input.endpoint,
      basePath: input.bucket || 'vault-photos',
      username: input.accessKeyId,
      password: input.secretAccessKey
    });
  }

  if (!input.endpoint || !input.bucket || !input.accessKeyId || !input.secretAccessKey) {
    return null;
  }

  return new S3StorageAdapter({
    providerLabel: input.provider,
    endpoint: input.endpoint,
    region: input.region || 'auto',
    bucket: input.bucket,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    forcePathStyle: input.forcePathStyle
  });
}

function inferS3Provider(endpoint: string): CloudStorageProvider {
  const lower = endpoint.toLowerCase();
  if (lower.includes('r2.cloudflarestorage.com')) return 'cloudflare_r2';
  if (lower.includes('backblazeb2.com')) return 'backblaze_b2';
  if (lower.includes('oraclecloud.com')) return 'oracle_oci';
  if (lower.includes('minio') || lower.includes(':9000') || lower.includes('localhost')) return 'minio';
  return 's3_custom';
}

export class StorageRegistry {
  private readonly targets = new Map<ReplicaSlot, ResolvedTargetRecord>();
  private readonly poolNodes = new Map<string, ResolvedPoolNode>();
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.initFromEnv(config);
  }

  private initFromEnv(config: AppConfig): void {
    if (
      config.STORAGE_PRIMARY_TYPE === 's3' &&
      config.S3_PRIMARY_ENDPOINT &&
      config.S3_PRIMARY_BUCKET &&
      config.S3_PRIMARY_ACCESS_KEY_ID &&
      config.S3_PRIMARY_SECRET_ACCESS_KEY
    ) {
      this.setRecord({
        slot: 'copy1_primary',
        provider: inferS3Provider(config.S3_PRIMARY_ENDPOINT),
        enabled: true,
        source: 'env',
        endpoint: config.S3_PRIMARY_ENDPOINT,
        region: config.S3_PRIMARY_REGION,
        bucket: config.S3_PRIMARY_BUCKET,
        accessKeyId: config.S3_PRIMARY_ACCESS_KEY_ID,
        secretAccessKey: config.S3_PRIMARY_SECRET_ACCESS_KEY,
        forcePathStyle: config.S3_PRIMARY_FORCE_PATH_STYLE,
        localRoot: '',
        lastTestOk: null,
        lastTestAt: null,
        lastTestMessage: null
      });
    } else {
      this.setRecord({
        slot: 'copy1_primary',
        provider: 'local',
        enabled: true,
        source: 'default',
        endpoint: '',
        region: 'local',
        bucket: 'local-primary',
        accessKeyId: '',
        secretAccessKey: '',
        forcePathStyle: true,
        localRoot: config.STORAGE_LOCAL_ROOT,
        lastTestOk: null,
        lastTestAt: null,
        lastTestMessage: null
      });
    }

    if (
      config.S3_SECONDARY_ENDPOINT &&
      config.S3_SECONDARY_BUCKET &&
      config.S3_SECONDARY_ACCESS_KEY_ID &&
      config.S3_SECONDARY_SECRET_ACCESS_KEY
    ) {
      this.setRecord({
        slot: 'copy2_secondary',
        provider: inferS3Provider(config.S3_SECONDARY_ENDPOINT),
        enabled: true,
        source: 'env',
        endpoint: config.S3_SECONDARY_ENDPOINT,
        region: config.S3_SECONDARY_REGION,
        bucket: config.S3_SECONDARY_BUCKET,
        accessKeyId: config.S3_SECONDARY_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECONDARY_SECRET_ACCESS_KEY,
        forcePathStyle: config.S3_SECONDARY_FORCE_PATH_STYLE,
        localRoot: '',
        lastTestOk: null,
        lastTestAt: null,
        lastTestMessage: null
      });
    } else {
      this.setUnconfigured('copy2_secondary', 'backblaze_b2');
    }

    if (
      config.S3_OFFSITE_ENDPOINT &&
      config.S3_OFFSITE_BUCKET &&
      config.S3_OFFSITE_ACCESS_KEY_ID &&
      config.S3_OFFSITE_SECRET_ACCESS_KEY
    ) {
      this.setRecord({
        slot: 'copy3_offsite',
        provider: inferS3Provider(config.S3_OFFSITE_ENDPOINT),
        enabled: true,
        source: 'env',
        endpoint: config.S3_OFFSITE_ENDPOINT,
        region: config.S3_OFFSITE_REGION,
        bucket: config.S3_OFFSITE_BUCKET,
        accessKeyId: config.S3_OFFSITE_ACCESS_KEY_ID,
        secretAccessKey: config.S3_OFFSITE_SECRET_ACCESS_KEY,
        forcePathStyle: config.S3_OFFSITE_FORCE_PATH_STYLE,
        localRoot: '',
        lastTestOk: null,
        lastTestAt: null,
        lastTestMessage: null
      });
    } else {
      this.setUnconfigured('copy3_offsite', 'oracle_oci');
    }
  }

  private setRecord(rec: Omit<ResolvedTargetRecord, 'adapter'>): void {
    const adapter = buildAdapterFromRecord(rec);
    this.targets.set(rec.slot, { ...rec, adapter });
  }

  private setUnconfigured(slot: ReplicaSlot, suggestedProvider: CloudStorageProvider): void {
    this.targets.set(slot, {
      slot,
      provider: suggestedProvider,
      enabled: false,
      source: 'default',
      endpoint: '',
      region: suggestedProvider === 'backblaze_b2' ? 'us-west-004' : 'ap-singapore-1',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: '',
      forcePathStyle: true,
      localRoot: '',
      lastTestOk: null,
      lastTestAt: null,
      lastTestMessage: null,
      adapter: null
    });
  }

  async loadFromDatabase(db: DbQueryable): Promise<void> {
    const seed = getStorageSecretSeed(this.config);

    // 1. Legacy single-slot targets
    const res = await db.query<StorageTargetRow>('SELECT * FROM storage_targets');
    for (const row of res.rows) {
      this.applyDatabaseRow(row);
    }

    // 2. Multi-Node Pooled Storage Targets (unlimited S3 + WebDAV + Local nodes)
    const nodesRes = await db.query<StorageNodeRow>(
      'SELECT * FROM storage_nodes ORDER BY replica_slot ASC, priority ASC, created_at ASC'
    );
    this.poolNodes.clear();
    for (const row of nodesRes.rows) {
      this.applyPoolNodeRow(row, seed);
    }
  }

  applyDatabaseRow(row: StorageTargetRow): void {
    const seed = getStorageSecretSeed(this.config);
    let secret = '';
    if (row.encrypted_secret_access_key) {
      try {
        secret = decryptServerSecret(row.encrypted_secret_access_key, seed);
      } catch {
        secret = '';
      }
    }

    this.setRecord({
      slot: row.slot,
      provider: row.provider,
      enabled: row.enabled,
      source: 'database',
      endpoint: row.endpoint,
      region: row.region,
      bucket: row.bucket,
      accessKeyId: row.access_key_id,
      secretAccessKey: secret,
      forcePathStyle: row.force_path_style,
      localRoot: row.local_root,
      lastTestOk: row.last_test_ok,
      lastTestAt: row.last_test_at ? new Date(row.last_test_at).toISOString() : null,
      lastTestMessage: row.last_test_message
    });
  }

  applyPoolNodeRow(row: StorageNodeRow, seedOverride?: string): ResolvedPoolNode {
    const seed = seedOverride ?? getStorageSecretSeed(this.config);
    let secret = '';
    if (row.encrypted_secret_access_key) {
      try {
        secret = decryptServerSecret(row.encrypted_secret_access_key, seed);
      } catch {
        secret = '';
      }
    }

    const adapter = buildAdapterFromRecord({
      slot: row.replica_slot,
      provider: row.provider,
      enabled: row.enabled,
      endpoint: row.endpoint,
      region: row.region,
      bucket: row.bucket,
      accessKeyId: row.access_key_id,
      secretAccessKey: secret,
      forcePathStyle: row.force_path_style,
      localRoot: row.local_root
    });

    const resolved: ResolvedPoolNode = {
      id: row.id,
      name: row.name,
      slot: row.replica_slot,
      provider: row.provider,
      protocol: providerProtocol(row.provider),
      enabled: row.enabled,
      priority: row.priority,
      capacityBytes: Number(row.capacity_bytes),
      usedBytes: Number(row.used_bytes),
      endpoint: row.endpoint,
      region: row.region,
      bucket: row.bucket,
      accessKeyId: row.access_key_id,
      secretAccessKey: secret,
      forcePathStyle: row.force_path_style,
      localRoot: row.local_root,
      lastTestOk: row.last_test_ok,
      lastTestAt: row.last_test_at ? new Date(row.last_test_at).toISOString() : null,
      lastTestMessage: row.last_test_message,
      createdAt: new Date(row.created_at).toISOString(),
      adapter
    };

    this.poolNodes.set(row.id, resolved);
    return resolved;
  }

  removePoolNode(nodeId: string): void {
    this.poolNodes.delete(nodeId);
  }

  adjustPoolNodeUsedBytes(nodeId: string | null | undefined, deltaBytes: number): void {
    if (!nodeId) return;
    const node = this.poolNodes.get(nodeId);
    if (!node) return;
    node.usedBytes = Math.max(0, node.usedBytes + deltaBytes);
  }

  resetSlotToDefault(slot: ReplicaSlot): void {
    this.setUnconfigured(slot, slot === 'copy2_secondary' ? 'backblaze_b2' : 'oracle_oci');
  }

  /**
   * Capacity-aware Multi-Cloud Auto-Sharding Router:
   * Picks the highest-priority enabled pool node for `slot` with enough remaining space
   * (`capacityBytes - usedBytes >= requiredBytes`). Automatically spills over to the next
   * cloud bucket/node when a node fills up! Falls back to the legacy single-slot adapter
   * when no multi-node pool entries exist for that slot.
   */
  selectTargetForWrite(
    slot: ReplicaSlot,
    requiredBytes: number
  ): { nodeId: string | null; adapter: StorageAdapter } | null {
    if (slot === 'copy3_offsite') return null;
    const slotNodes = [...this.poolNodes.values()]
      .filter((n) => n.slot === slot && n.enabled && n.adapter !== null)
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));

    if (slotNodes.length > 0) {
      const candidate = slotNodes.find((n) => n.capacityBytes - n.usedBytes >= requiredBytes);
      if (candidate && candidate.adapter) {
        return { nodeId: candidate.id, adapter: candidate.adapter };
      }
      // All configured pool nodes for this slot are full!
      return null;
    }

    const legacy = this.targets.get(slot)?.adapter ?? null;
    return legacy ? { nodeId: null, adapter: legacy } : null;
  }

  /**
   * Resolves the exact StorageAdapter holding a specific object (by `nodeId` if placed in
   * the multi-cloud pool, or fallback slot default adapter for legacy objects).
   */
  resolveAdapter(nodeId: string | null | undefined, fallbackSlot: ReplicaSlot): StorageAdapter | null {
    if (nodeId) {
      const node = this.poolNodes.get(nodeId);
      if (node?.adapter) return node.adapter;
    }
    const slotNodes = [...this.poolNodes.values()].filter(
      (n) => n.slot === fallbackSlot && n.enabled && n.adapter !== null
    );
    if (slotNodes.length > 0) {
      return slotNodes[0]!.adapter;
    }
    return this.targets.get(fallbackSlot)?.adapter ?? null;
  }

  getPoolNode(nodeId: string): ResolvedPoolNode | undefined {
    return this.poolNodes.get(nodeId);
  }

  getPrimary(): StorageAdapter {
    const selected = this.selectTargetForWrite('copy1_primary', 0);
    if (selected) return selected.adapter;
    const primary = this.targets.get('copy1_primary')?.adapter;
    if (!primary) {
      throw new Error('Primary storage adapter is not configured');
    }
    return primary;
  }

  getAdapter(slot: ReplicaSlot): StorageAdapter | null {
    const slotNodes = [...this.poolNodes.values()]
      .filter((n) => n.slot === slot && n.enabled && n.adapter !== null)
      .sort((a, b) => a.priority - b.priority);
    if (slotNodes.length > 0) return slotNodes[0]!.adapter;
    return this.targets.get(slot)?.adapter ?? null;
  }

  getRecord(slot: ReplicaSlot): ResolvedTargetRecord | undefined {
    return this.targets.get(slot);
  }

  registerAdapter(slot: ReplicaSlot, adapter: StorageAdapter): void {
    const existing = this.targets.get(slot);
    this.targets.set(slot, {
      slot,
      provider: existing?.provider ?? 'local',
      enabled: true,
      source: existing?.source ?? 'default',
      endpoint: existing?.endpoint ?? '',
      region: existing?.region ?? 'local',
      bucket: adapter.bucket,
      accessKeyId: existing?.accessKeyId ?? '',
      secretAccessKey: existing?.secretAccessKey ?? '',
      forcePathStyle: existing?.forcePathStyle ?? true,
      localRoot: existing?.localRoot ?? '',
      lastTestOk: existing?.lastTestOk ?? null,
      lastTestAt: existing?.lastTestAt ?? null,
      lastTestMessage: existing?.lastTestMessage ?? null,
      adapter
    });
  }

  listPoolNodeViews(): StorageNodeView[] {
    return [...this.poolNodes.values()]
      .sort(
        (a, b) =>
          a.slot.localeCompare(b.slot) || a.priority - b.priority || a.createdAt.localeCompare(b.createdAt)
      )
      .map((n) => ({
        id: n.id,
        name: n.name,
        slot: n.slot,
        provider: n.provider,
        protocol: n.protocol,
        enabled: n.enabled,
        priority: n.priority,
        capacityBytes: n.capacityBytes,
        usedBytes: n.usedBytes,
        freeBytes: Math.max(0, n.capacityBytes - n.usedBytes),
        endpoint: n.endpoint,
        region: n.region,
        bucket: n.bucket,
        accessKeyIdPreview: maskAccessKey(n.accessKeyId),
        hasSecretKey: Boolean(n.secretAccessKey),
        forcePathStyle: n.forcePathStyle,
        localRoot: n.localRoot,
        lastTestOk: n.lastTestOk,
        lastTestAt: n.lastTestAt,
        lastTestMessage: n.lastTestMessage,
        createdAt: n.createdAt
      }));
  }

  getPoolCapacitySummary(): PoolCapacitySummary {
    const bySlot = {} as PoolCapacitySummary['bySlot'];
    let grandCap = 0;
    let grandUsed = 0;

    for (const slot of ALL_SLOTS) {
      const nodes = [...this.poolNodes.values()].filter((n) => n.slot === slot);
      const activeNodes = nodes.filter((n) => n.enabled && n.adapter !== null);
      const cap = activeNodes.reduce((acc, n) => acc + n.capacityBytes, 0);
      const used = activeNodes.reduce((acc, n) => acc + n.usedBytes, 0);
      grandCap += cap;
      grandUsed += used;
      bySlot[slot] = {
        nodeCount: nodes.length,
        activeNodeCount: activeNodes.length,
        totalCapacityBytes: cap,
        totalUsedBytes: used,
        totalFreeBytes: Math.max(0, cap - used),
        percentOfGoal: Math.min(100, Math.round((cap / POOL_TARGET_GOAL_BYTES) * 1000) / 10)
      };
    }

    return {
      targetGoalBytes: POOL_TARGET_GOAL_BYTES,
      bySlot,
      grandTotalCapacityBytes: grandCap,
      grandTotalUsedBytes: grandUsed
    };
  }

  listConfigViews(): StorageTargetConfigView[] {
    return ALL_SLOTS.map((slot) => {
      const rec = this.targets.get(slot)!;
      return {
        slot: rec.slot,
        provider: rec.provider,
        enabled: rec.enabled,
        configured: Boolean(rec.adapter),
        source: rec.source,
        endpoint: rec.endpoint,
        region: rec.region,
        bucket: rec.bucket,
        accessKeyIdPreview: maskAccessKey(rec.accessKeyId),
        hasSecretKey: Boolean(rec.secretAccessKey),
        forcePathStyle: rec.forcePathStyle,
        localRoot: rec.localRoot,
        lastTestOk: rec.lastTestOk,
        lastTestAt: rec.lastTestAt,
        lastTestMessage: rec.lastTestMessage
      };
    });
  }

  async getHealthSummary(): Promise<StorageTargetStatus[]> {
    const results: StorageTargetStatus[] = [];
    for (const slot of ALL_SLOTS) {
      const activePoolNodes = [...this.poolNodes.values()].filter(
        (n) => n.slot === slot && n.enabled && n.adapter !== null
      );
      if (activePoolNodes.length > 0) {
        const totalGb = (
          activePoolNodes.reduce((a, n) => a + n.capacityBytes, 0) /
          (1024 * 1024 * 1024)
        ).toFixed(1);
        results.push({
          slot,
          provider: `pool (${activePoolNodes.length} kho · ${totalGb} GB)`,
          configured: true,
          healthy: true,
          message: activePoolNodes.map((n) => `${n.name} [${n.provider}]`).join(', ')
        });
        continue;
      }

      const target = this.targets.get(slot);
      if (!target || !target.adapter) {
        results.push({
          slot,
          provider: target?.provider ?? 'unconfigured',
          configured: false,
          healthy: false,
          message: 'Chưa kết nối kho cloud (hỗ trợ R2, B2, OCI, InfiniCLOUD, Koofr, WebDAV, MinIO)'
        });
        continue;
      }
      const health = await target.adapter.healthCheck();
      results.push({
        slot,
        provider: target.provider,
        configured: true,
        healthy: health.healthy,
        message: health.message
      });
    }
    return results;
  }
}
