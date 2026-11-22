-- Dynamic Multi-Cloud Storage Targets (Cloudflare R2, Backblaze B2, Oracle OCI, MinIO, S3, Local Disk)
-- Secret access keys are encrypted at rest with AES-256-GCM before being stored.

CREATE TABLE IF NOT EXISTS storage_targets (
  slot TEXT PRIMARY KEY CHECK (slot IN ('copy1_primary', 'copy2_secondary', 'copy3_offsite')),
  provider TEXT NOT NULL CHECK (
    provider IN ('local', 'cloudflare_r2', 'backblaze_b2', 'oracle_oci', 'minio', 's3_custom')
  ),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);
