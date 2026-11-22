-- Multi-Cloud Storage Pool Nodes (Unlimited S3 + WebDAV + Local Disk nodes per replica slot)
-- Enables pooling multiple cloud accounts/providers together (e.g. >= 400 GB) with automatic capacity-aware sharding.

CREATE TABLE IF NOT EXISTS storage_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  replica_slot TEXT NOT NULL CHECK (replica_slot IN ('copy1_primary', 'copy2_secondary', 'copy3_offsite')),
  provider TEXT NOT NULL CHECK (
    provider IN (
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
    )
  ),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100,
  capacity_bytes BIGINT NOT NULL CHECK (capacity_bytes > 0),
  used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  endpoint TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT 'auto',
  bucket TEXT NOT NULL DEFAULT '',
  access_key_id TEXT NOT NULL DEFAULT '',
  encrypted_secret_access_key TEXT NOT NULL DEFAULT '',
  force_path_style BOOLEAN NOT NULL DEFAULT TRUE,
  local_root TEXT NOT NULL DEFAULT '',
  last_test_ok BOOLEAN,
  last_test_at TIMESTAMPTZ,
  last_test_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_storage_nodes_slot_priority
  ON storage_nodes (replica_slot, enabled, priority ASC, created_at ASC);

-- Track exact cloud node placement for every upload session, storage object, and replica copy
ALTER TABLE upload_sessions
  ADD COLUMN IF NOT EXISTS storage_node_id UUID REFERENCES storage_nodes(id) ON DELETE SET NULL;

ALTER TABLE storage_objects
  ADD COLUMN IF NOT EXISTS primary_node_id UUID REFERENCES storage_nodes(id) ON DELETE SET NULL;

ALTER TABLE replica_status
  ADD COLUMN IF NOT EXISTS storage_node_id UUID REFERENCES storage_nodes(id) ON DELETE SET NULL;

-- Expand allowed providers on legacy single-slot storage_targets table too
ALTER TABLE storage_targets DROP CONSTRAINT IF EXISTS storage_targets_provider_check;
ALTER TABLE storage_targets
  ADD CONSTRAINT storage_targets_provider_check CHECK (
    provider IN (
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
    )
  );
