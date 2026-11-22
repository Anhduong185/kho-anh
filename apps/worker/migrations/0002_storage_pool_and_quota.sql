-- M1: Multi-Cloud Storage Pool tracking & >10 GiB Default User Quota (100 GiB)

-- 1. Upgrade existing users still on the legacy 10 GiB default to 100 GiB (preserve custom quotas)
UPDATE users
SET quota_bytes = 107374182400,
    updated_at = datetime('now')
WHERE quota_bytes = 10737418240;

-- 2. Storage Objects & Replica Status (3 independent replica slots + per-node tracking)
CREATE TABLE IF NOT EXISTS storage_objects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('original', 'preview', 'thumbnail', 'version')),
  object_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  primary_node_id TEXT REFERENCES storage_nodes(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_storage_objects_media ON storage_objects (media_id);
CREATE INDEX IF NOT EXISTS idx_storage_objects_primary_node ON storage_objects (primary_node_id);

CREATE TABLE IF NOT EXISTS replica_status (
  id TEXT PRIMARY KEY,
  storage_object_id TEXT NOT NULL REFERENCES storage_objects(id) ON DELETE CASCADE,
  replica_slot TEXT NOT NULL CHECK (replica_slot IN ('copy1_primary', 'copy2_secondary', 'copy3_offsite')),
  storage_node_id TEXT REFERENCES storage_nodes(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  bucket TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'syncing', 'verified', 'corrupted', 'missing')),
  verified_sha256 TEXT,
  last_verified_at TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (storage_object_id, replica_slot)
);

CREATE INDEX IF NOT EXISTS idx_replica_status_slot_state ON replica_status (replica_slot, state);
CREATE INDEX IF NOT EXISTS idx_replica_status_node ON replica_status (storage_node_id);

-- 3. Legacy single-slot storage_targets table for full admin parity
CREATE TABLE IF NOT EXISTS storage_targets (
  slot TEXT PRIMARY KEY CHECK (slot IN ('copy1_primary', 'copy2_secondary', 'copy3_offsite')),
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
  enabled INTEGER NOT NULL DEFAULT 1,
  endpoint TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT 'auto',
  bucket TEXT NOT NULL DEFAULT '',
  access_key_id TEXT NOT NULL DEFAULT '',
  encrypted_secret_access_key TEXT NOT NULL DEFAULT '',
  force_path_style INTEGER NOT NULL DEFAULT 1,
  local_root TEXT NOT NULL DEFAULT '',
  last_test_ok INTEGER,
  last_test_at TEXT,
  last_test_message TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_storage_nodes_slot_priority
  ON storage_nodes (replica_slot, enabled, priority ASC, created_at ASC);

-- 4. Track exact storage_node_id placement across upload_sessions, media_files & file_versions
ALTER TABLE upload_sessions ADD COLUMN storage_node_id TEXT REFERENCES storage_nodes(id) ON DELETE SET NULL;
ALTER TABLE media_files ADD COLUMN storage_node_id TEXT REFERENCES storage_nodes(id) ON DELETE SET NULL;
ALTER TABLE file_versions ADD COLUMN storage_node_id TEXT REFERENCES storage_nodes(id) ON DELETE SET NULL;

-- 5. Backfill existing media_files into storage_objects & replica_status (Copy 1 R2)
INSERT OR IGNORE INTO storage_objects (
  id, user_id, media_id, object_kind, object_key, size_bytes, sha256, primary_node_id, created_at
)
SELECT
  lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(2)) || '-' || hex(randomblob(6))
  ),
  m.user_id,
  m.id,
  'original',
  m.object_key,
  m.size_bytes,
  m.sha256,
  m.storage_node_id,
  m.created_at
FROM media_files m
WHERE NOT EXISTS (
  SELECT 1 FROM storage_objects so
  WHERE so.media_id = m.id AND so.object_kind = 'original'
);

INSERT OR IGNORE INTO replica_status (
  id, storage_object_id, replica_slot, storage_node_id, provider, bucket, state, verified_sha256, last_verified_at, updated_at
)
SELECT
  lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(2)) || '-' || hex(randomblob(6))
  ),
  so.id,
  'copy1_primary',
  so.primary_node_id,
  'cloudflare_r2',
  'kho-anh-vault',
  'verified',
  so.sha256,
  so.created_at,
  so.created_at
FROM storage_objects so
WHERE so.object_kind = 'original'
  AND NOT EXISTS (
    SELECT 1 FROM replica_status rs
    WHERE rs.storage_object_id = so.id AND rs.replica_slot = 'copy1_primary'
  );
