import {
  POOL_TARGET_GOAL_BYTES,
  type CloudStorageProvider,
  type PoolCapacitySummary,
  type ReplicaSlot,
  type StorageNodeView,
  type StorageProtocol,
  type StorageTargetConfigView,
  type StorageTargetStatus
} from '@smb/shared';
import type { WorkerEnv } from '../env.js';
import { decryptStorageSecret, getStorageSecretSeed, maskAccessKey } from './crypto.js';
import { GoogleDriveStorageAdapter } from './googleDriveAdapter.js';
import { R2StorageAdapter, resolveR2CapacityBytes } from './r2Adapter.js';
import { S3SigV4StorageAdapter } from './s3SigV4Adapter.js';
import type { WorkerStorageAdapter } from './types.js';
import { WebDavStorageAdapter } from './webdavAdapter.js';

export const NATIVE_R2_NODE_ID = 'cf-r2-native';
const ALL_SLOTS: ReplicaSlot[] = ['copy1_primary', 'copy2_secondary', 'copy3_offsite'];

export interface StorageNodeDbRow {
  id: string;
  name: string;
  replica_slot: ReplicaSlot;
  provider: CloudStorageProvider;
  enabled: number;
  priority: number;
  capacity_bytes: number;
  used_bytes: number;
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  encrypted_secret_access_key: string;
  force_path_style: number;
  local_root: string;
  last_test_ok: number | null;
  last_test_at: string | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface StorageTargetDbRow {
  slot: ReplicaSlot;
  provider: CloudStorageProvider;
  enabled: number;
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  encrypted_secret_access_key: string;
  force_path_style: number;
  local_root: string;
  last_test_ok: number | null;
  last_test_at: string | null;
  last_test_message: string | null;
  updated_at: string;
}

export interface R2NativeOverride {
  name?: string;
  enabled?: boolean;
  priority?: number;
  capacityBytes?: number;
  lastTestOk?: boolean | null;
  lastTestAt?: string | null;
  lastTestMessage?: string | null;
}

export interface LoadedPoolNode {
  id: string;
  dbNodeId: string | null; // null for virtual cf-r2-native (not in storage_nodes FK table)
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
  adapter: WorkerStorageAdapter | null;
}

export interface SelectedStorageTarget {
  nodeId: string | null; // DB FK-safe storage_nodes.id (null for cf-r2-native or legacy storage_targets)
  virtualNodeId: string | null;
  adapter: WorkerStorageAdapter;
}

export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  source: 'database' | 'env';
}

export async function loadGoogleOAuthCredentials(env: WorkerEnv): Promise<GoogleOAuthCredentials | null> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'google_drive_oauth'")
    .first<{ value: string }>();
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value) as {
        clientId?: string;
        encryptedClientSecret?: string;
      };
      if (parsed.clientId && parsed.encryptedClientSecret) {
        const seed = getStorageSecretSeed(env);
        const clientSecret = await decryptStorageSecret(parsed.encryptedClientSecret, seed);
        if (clientSecret) {
          return {
            clientId: parsed.clientId,
            clientSecret,
            source: 'database'
          };
        }
      }
    } catch {
      // fall through to env
    }
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      source: 'env'
    };
  }
  return null;
}

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

export function buildAdapterFromRecord(
  env: WorkerEnv,
  input: {
    provider: CloudStorageProvider;
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  },
  googleOAuth?: GoogleOAuthCredentials | null
): WorkerStorageAdapter | null {
  const proto = providerProtocol(input.provider);
  if (proto === 'local') {
    return null;
  }
  if (input.provider === 'cloudflare_r2' && input.endpoint === 'cloudflare://VAULT_BUCKET') {
    return env.VAULT_BUCKET ? new R2StorageAdapter(env.VAULT_BUCKET, input.bucket || 'kho-anh-vault') : null;
  }
  if (proto === 'gdrive') {
    if (!input.secretAccessKey) return null;
    let refreshToken = input.secretAccessKey;
    let clientId = googleOAuth?.clientId ?? env.GOOGLE_CLIENT_ID ?? '';
    let clientSecret = googleOAuth?.clientSecret ?? env.GOOGLE_CLIENT_SECRET ?? '';
    if (input.secretAccessKey.startsWith('{')) {
      try {
        const parsed = JSON.parse(input.secretAccessKey) as {
          refreshToken?: string;
          clientId?: string;
          clientSecret?: string;
        };
        if (parsed.refreshToken) refreshToken = parsed.refreshToken;
        if (parsed.clientId) clientId = parsed.clientId;
        if (parsed.clientSecret) clientSecret = parsed.clientSecret;
      } catch {
        // treat as raw refreshToken
      }
    }
    if (!refreshToken || !clientId || !clientSecret) {
      return null;
    }
    return new GoogleDriveStorageAdapter({
      providerLabel: 'google_drive',
      clientId,
      clientSecret,
      refreshToken,
      folderName: input.bucket || 'kho-anh-vault',
      stagingBucket: env.VAULT_BUCKET
    });
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
      password: input.secretAccessKey,
      stagingBucket: env.VAULT_BUCKET
    });
  }
  if (!input.endpoint || !input.bucket || !input.accessKeyId || !input.secretAccessKey) {
    return null;
  }
  return new S3SigV4StorageAdapter({
    providerLabel: input.provider,
    endpoint: input.endpoint,
    region: input.region || 'auto',
    bucket: input.bucket,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    forcePathStyle: input.forcePathStyle
  });
}

export async function loadR2NativeOverride(env: WorkerEnv): Promise<R2NativeOverride> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'r2_native_node'")
    .first<{ value: string }>();
  if (!row?.value) return {};
  try {
    return JSON.parse(row.value) as R2NativeOverride;
  } catch {
    return {};
  }
}

export async function saveR2NativeOverride(
  env: WorkerEnv,
  override: R2NativeOverride,
  updatedBy: string
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, updated_at, updated_by)
     VALUES ('r2_native_node', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  )
    .bind(JSON.stringify(override), now, updatedBy)
    .run();
}

async function computeR2NativeUsedBytes(env: WorkerEnv): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE((SELECT SUM(so.size_bytes) FROM storage_objects so WHERE so.primary_node_id IS NULL), 0) AS primary_used,
       COALESCE((
         SELECT SUM(so.size_bytes)
         FROM replica_status rs
         JOIN storage_objects so ON so.id = rs.storage_object_id
         WHERE rs.replica_slot <> 'copy1_primary'
           AND rs.storage_node_id IS NULL
           AND rs.provider = 'cloudflare_r2'
           AND rs.state = 'verified'
       ), 0) AS replica_used`
  ).first<{ primary_used: number; replica_used: number }>();
  return Number(row?.primary_used ?? 0) + Number(row?.replica_used ?? 0);
}

export async function loadPoolNodes(env: WorkerEnv): Promise<LoadedPoolNode[]> {
  const seed = getStorageSecretSeed(env);
  const [r2Override, r2UsedBytes, customRows, googleOAuth] = await Promise.all([
    loadR2NativeOverride(env),
    computeR2NativeUsedBytes(env),
    env.DB.prepare('SELECT * FROM storage_nodes ORDER BY replica_slot ASC, priority ASC, created_at ASC')
      .all<StorageNodeDbRow>(),
    loadGoogleOAuthCredentials(env)
  ]);

  const r2Capacity = resolveR2CapacityBytes(env, r2Override.capacityBytes);
  const r2Enabled = Boolean(env.VAULT_BUCKET) && (r2Override.enabled ?? true);
  const r2Node: LoadedPoolNode = {
    id: NATIVE_R2_NODE_ID,
    dbNodeId: null,
    name: r2Override.name || 'Cloudflare R2 · kho-anh-vault (Native)',
    slot: 'copy1_primary',
    provider: 'cloudflare_r2',
    protocol: 's3',
    enabled: r2Enabled,
    priority: r2Override.priority ?? 1,
    capacityBytes: r2Capacity,
    usedBytes: r2UsedBytes,
    endpoint: 'cloudflare://VAULT_BUCKET',
    region: 'APAC',
    bucket: 'kho-anh-vault',
    accessKeyId: 'NATIVE_BINDING',
    secretAccessKey: env.VAULT_BUCKET ? 'NATIVE_BINDING' : '',
    forcePathStyle: true,
    localRoot: '',
    lastTestOk: r2Override.lastTestOk ?? (env.VAULT_BUCKET ? true : false),
    lastTestAt: r2Override.lastTestAt ?? new Date().toISOString(),
    lastTestMessage:
      r2Override.lastTestMessage ??
      (env.VAULT_BUCKET
        ? 'Kết nối trực tiếp R2 Binding tại edge Cloudflare (0ms overhead).'
        : 'Chưa bật R2 trên Cloudflare Dashboard.'),
    createdAt: '1970-01-01T00:00:00.000Z',
    adapter: env.VAULT_BUCKET ? new R2StorageAdapter(env.VAULT_BUCKET, 'kho-anh-vault') : null
  };

  const customNodes: LoadedPoolNode[] = [];
  for (const r of customRows.results) {
    let secret = '';
    if (r.encrypted_secret_access_key) {
      try {
        secret = await decryptStorageSecret(r.encrypted_secret_access_key, seed);
      } catch {
        secret = '';
      }
    }
    const adapter = buildAdapterFromRecord(
      env,
      {
        provider: r.provider,
        endpoint: r.endpoint,
        region: r.region,
        bucket: r.bucket,
        accessKeyId: r.access_key_id,
        secretAccessKey: secret,
        forcePathStyle: Boolean(r.force_path_style)
      },
      googleOAuth
    );
    customNodes.push({
      id: r.id,
      dbNodeId: r.id,
      name: r.name,
      slot: r.replica_slot,
      provider: r.provider,
      protocol: providerProtocol(r.provider),
      enabled: Boolean(r.enabled),
      priority: Number(r.priority),
      capacityBytes: Number(r.capacity_bytes),
      usedBytes: Number(r.used_bytes),
      endpoint: r.endpoint,
      region: r.region,
      bucket: r.bucket,
      accessKeyId: r.access_key_id,
      secretAccessKey: secret,
      forcePathStyle: Boolean(r.force_path_style),
      localRoot: r.local_root,
      lastTestOk: r.last_test_ok === null ? null : Boolean(r.last_test_ok),
      lastTestAt: r.last_test_at,
      lastTestMessage: r.last_test_message,
      createdAt: r.created_at,
      adapter
    });
  }

  return [r2Node, ...customNodes];
}

export function toStorageNodeView(n: LoadedPoolNode): StorageNodeView {
  return {
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
    accessKeyIdPreview: n.id === NATIVE_R2_NODE_ID ? 'NATIVE_BINDING' : maskAccessKey(n.accessKeyId),
    hasSecretKey: Boolean(n.secretAccessKey),
    forcePathStyle: n.forcePathStyle,
    localRoot: n.localRoot,
    lastTestOk: n.lastTestOk,
    lastTestAt: n.lastTestAt,
    lastTestMessage: n.lastTestMessage,
    createdAt: n.createdAt
  };
}

export function summarizePool(nodes: LoadedPoolNode[]): PoolCapacitySummary {
  const bySlot = {} as PoolCapacitySummary['bySlot'];
  let grandCap = 0;
  let grandUsed = 0;

  for (const slot of ALL_SLOTS) {
    const slotNodes = nodes.filter((n) => n.slot === slot);
    const activeNodes = slotNodes.filter((n) => n.enabled && n.adapter !== null);
    const cap = activeNodes.reduce((acc, n) => acc + n.capacityBytes, 0);
    const used = activeNodes.reduce((acc, n) => acc + n.usedBytes, 0);
    grandCap += cap;
    grandUsed += used;
    bySlot[slot] = {
      nodeCount: slotNodes.length,
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

export async function buildPoolView(
  env: WorkerEnv
): Promise<{ nodes: StorageNodeView[]; summary: PoolCapacitySummary }> {
  const loaded = await loadPoolNodes(env);
  const sorted = [...loaded].sort(
    (a, b) => a.slot.localeCompare(b.slot) || a.priority - b.priority || a.createdAt.localeCompare(b.createdAt)
  );
  return {
    nodes: sorted.map(toStorageNodeView),
    summary: summarizePool(loaded)
  };
}

async function loadLegacyTargetAdapters(
  env: WorkerEnv
): Promise<Map<ReplicaSlot, { row: StorageTargetDbRow; adapter: WorkerStorageAdapter | null; secret: string }>> {
  const seed = getStorageSecretSeed(env);
  const res = await env.DB.prepare('SELECT * FROM storage_targets').all<StorageTargetDbRow>();
  const map = new Map<
    ReplicaSlot,
    { row: StorageTargetDbRow; adapter: WorkerStorageAdapter | null; secret: string }
  >();
  for (const row of res.results) {
    let secret = '';
    if (row.encrypted_secret_access_key) {
      try {
        secret = await decryptStorageSecret(row.encrypted_secret_access_key, seed);
      } catch {
        secret = '';
      }
    }
    const adapter = buildAdapterFromRecord(env, {
      provider: row.provider,
      endpoint: row.endpoint,
      region: row.region,
      bucket: row.bucket,
      accessKeyId: row.access_key_id,
      secretAccessKey: secret,
      forcePathStyle: Boolean(row.force_path_style)
    });
    map.set(row.slot, { row, adapter, secret });
  }
  return map;
}

/**
 * Capacity-aware Multi-Cloud Auto-Sharding Router:
 * Picks the highest-priority enabled pool node for `slot` with enough remaining space
 * (`capacityBytes - usedBytes >= requiredBytes`). Automatically spills over to the next
 * cloud node when a node fills up!
 */
export async function selectTargetForWrite(
  env: WorkerEnv,
  slot: ReplicaSlot,
  requiredBytes: number
): Promise<SelectedStorageTarget | null> {
  if (slot === 'copy3_offsite') return null;
  const nodes = await loadPoolNodes(env);
  const slotNodes = nodes
    .filter((n) => n.slot === slot && n.enabled && n.adapter !== null)
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));

  for (const candidate of slotNodes) {
    if (candidate.capacityBytes - candidate.usedBytes >= requiredBytes && candidate.adapter) {
      return {
        nodeId: candidate.dbNodeId,
        virtualNodeId: candidate.id,
        adapter: candidate.adapter
      };
    }
  }

  // Fallback to legacy storage_targets if configured for this slot
  const legacyMap = await loadLegacyTargetAdapters(env);
  const legacy = legacyMap.get(slot);
  if (legacy && Boolean(legacy.row.enabled) && legacy.adapter) {
    return {
      nodeId: null,
      virtualNodeId: null,
      adapter: legacy.adapter
    };
  }

  return null;
}

/**
 * Resolves the exact WorkerStorageAdapter holding a specific object.
 * Still resolves disabled nodes (`enabled = false`) as long as credentials are present,
 * so existing data can be read, verified, migrated, and permanently deleted.
 */
export async function resolveAdapter(
  env: WorkerEnv,
  nodeId: string | null | undefined,
  fallbackSlot: ReplicaSlot
): Promise<WorkerStorageAdapter | null> {
  const nodes = await loadPoolNodes(env);
  if (nodeId) {
    const exact = nodes.find((n) => n.id === nodeId);
    if (exact?.adapter) return exact.adapter;
  }

  if (fallbackSlot === 'copy1_primary') {
    if (env.VAULT_BUCKET) {
      return new R2StorageAdapter(env.VAULT_BUCKET, 'kho-anh-vault');
    }
  }

  const slotNodes = nodes
    .filter((n) => n.slot === fallbackSlot && n.enabled && n.adapter !== null)
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  if (slotNodes[0]?.adapter) {
    return slotNodes[0].adapter;
  }

  const anySlotNode = nodes
    .filter((n) => n.slot === fallbackSlot && n.adapter !== null)
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  if (anySlotNode[0]?.adapter) {
    return anySlotNode[0].adapter;
  }

  const legacyMap = await loadLegacyTargetAdapters(env);
  return legacyMap.get(fallbackSlot)?.adapter ?? null;
}

export async function getHealthSummary(env: WorkerEnv): Promise<StorageTargetStatus[]> {
  const [nodes, legacyMap] = await Promise.all([loadPoolNodes(env), loadLegacyTargetAdapters(env)]);
  const results: StorageTargetStatus[] = [];

  for (const slot of ALL_SLOTS) {
    const activePoolNodes = nodes.filter(
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

    const legacy = legacyMap.get(slot);
    if (legacy && Boolean(legacy.row.enabled) && legacy.adapter) {
      const health = await legacy.adapter.healthCheck();
      results.push({
        slot,
        provider: legacy.row.provider,
        configured: true,
        healthy: health.healthy,
        message: health.message
      });
      continue;
    }

    results.push({
      slot,
      provider: legacy?.row.provider ?? 'unconfigured',
      configured: false,
      healthy: false,
      message:
        slot === 'copy1_primary'
          ? 'Chưa bật R2 hoặc kho chính'
          : 'Chưa kết nối kho cloud (hỗ trợ R2, B2, OCI, InfiniCLOUD, Koofr, WebDAV, MinIO)'
    });
  }

  return results;
}

export async function listLegacyTargetViews(env: WorkerEnv): Promise<StorageTargetConfigView[]> {
  const legacyMap = await loadLegacyTargetAdapters(env);
  const r2Ok = Boolean(env.VAULT_BUCKET);

  return ALL_SLOTS.map((slot) => {
    const existing = legacyMap.get(slot);
    if (existing) {
      const r = existing.row;
      return {
        slot,
        provider: r.provider,
        enabled: Boolean(r.enabled),
        configured: Boolean(existing.adapter),
        source: 'database',
        endpoint: r.endpoint,
        region: r.region,
        bucket: r.bucket,
        accessKeyIdPreview: maskAccessKey(r.access_key_id),
        hasSecretKey: Boolean(existing.secret),
        forcePathStyle: Boolean(r.force_path_style),
        localRoot: r.local_root,
        lastTestOk: r.last_test_ok === null ? null : Boolean(r.last_test_ok),
        lastTestAt: r.last_test_at,
        lastTestMessage: r.last_test_message
      };
    }

    if (slot === 'copy1_primary') {
      return {
        slot,
        provider: 'cloudflare_r2',
        enabled: r2Ok,
        configured: r2Ok,
        source: 'env',
        endpoint: 'cloudflare://VAULT_BUCKET',
        region: 'APAC',
        bucket: 'kho-anh-vault',
        accessKeyIdPreview: 'NATIVE_BINDING',
        hasSecretKey: r2Ok,
        forcePathStyle: true,
        localRoot: '',
        lastTestOk: r2Ok,
        lastTestAt: new Date().toISOString(),
        lastTestMessage: r2Ok ? 'Cloudflare R2 Native Binding đang hoạt động' : 'Chưa bật R2'
      };
    }

    return {
      slot,
      provider: slot === 'copy2_secondary' ? 'backblaze_b2' : 'oracle_oci',
      enabled: false,
      configured: false,
      source: 'default',
      endpoint: '',
      region: slot === 'copy2_secondary' ? 'us-west-004' : 'ap-singapore-1',
      bucket: '',
      accessKeyIdPreview: '',
      hasSecretKey: false,
      forcePathStyle: true,
      localRoot: '',
      lastTestOk: null,
      lastTestAt: null,
      lastTestMessage: null
    };
  });
}
