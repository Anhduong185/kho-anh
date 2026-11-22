-- Secure Media Backup - Initial PostgreSQL Schema (PRD Section 7.1 + Confirmed Decisions)
-- Compatible with PostgreSQL 16+ (Neon, Docker, self-hosted) and PGlite (embedded dev/test).

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1. Users & Account-Level Encryption Mode
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  encryption_mode TEXT NOT NULL CHECK (encryption_mode IN ('server_side', 'e2ee')),
  e2ee_key_salt TEXT,
  e2ee_encrypted_master_key TEXT,
  e2ee_kdf_params JSONB,
  quota_bytes BIGINT NOT NULL DEFAULT 10737418240 CHECK (quota_bytes > 0),
  used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

-- 2. Roles & RBAC
CREATE TABLE IF NOT EXISTS roles (
  id SMALLSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (name IN ('user', 'admin')),
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id SMALLINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role_id)
);

-- 3. Unified Auth Identities (Email/Password, Google, Apple, Telegram, Phone OTP, Passkey)
CREATE TABLE IF NOT EXISTS auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('password', 'google', 'apple', 'telegram', 'phone_otp', 'passkey')),
  provider_subject TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities (user_id);

-- 4. Devices
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'windows', 'web')),
  is_trusted BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices (user_id);

-- Refresh Tokens with Family Rotation
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_family UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens (token_family);

-- Single-Use Recovery Codes (stored salted & hashed)
CREATE TABLE IF NOT EXISTS recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_salt TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes (user_id) WHERE used_at IS NULL;

-- 5. Multi-Level Folders & Albums (Tenant-scoped)
CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_folders_user_parent ON folders (user_id, parent_id);

CREATE TABLE IF NOT EXISTS albums (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  cover_media_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_albums_user ON albums (user_id);

-- 6. Media Files (Original 100% intact, no cross-account deduplication)
CREATE TABLE IF NOT EXISTS media_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video')),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  encryption_mode TEXT NOT NULL CHECK (encryption_mode IN ('server_side', 'e2ee')),
  encrypted_file_key TEXT,
  encryption_iv TEXT,
  upload_state TEXT NOT NULL DEFAULT 'detected' CHECK (
    upload_state IN (
      'detected', 'queued', 'uploading', 'uploaded',
      'verifying', 'verified', 'insufficient_replicas', 'failed'
    )
  ),
  is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
  captured_at TIMESTAMPTZ,
  width INTEGER,
  height INTEGER,
  duration_ms BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenant-scoped duplicate detection index (never cross-account!)
CREATE INDEX IF NOT EXISTS idx_media_files_user_sha256 ON media_files (user_id, sha256) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_media_files_user_timeline ON media_files (user_id, captured_at DESC, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS album_media (
  album_id UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  media_id UUID NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (album_id, media_id)
);

-- 7. Tags & Media-Tag Mapping
CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS media_tags (
  media_id UUID NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (media_id, tag_id)
);

-- 8. Backup Jobs & Items
CREATE TABLE IF NOT EXISTS backup_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  trigger_mode TEXT NOT NULL CHECK (trigger_mode IN ('auto', 'manual')),
  network_type TEXT NOT NULL CHECK (network_type IN ('wifi')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed')),
  total_files INTEGER NOT NULL DEFAULT 0,
  completed_files INTEGER NOT NULL DEFAULT 0,
  failed_files INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backup_jobs_user ON backup_jobs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backup_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_job_id UUID NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id UUID REFERENCES media_files(id) ON DELETE SET NULL,
  local_asset_id TEXT,
  original_filename TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (
    state IN (
      'detected', 'queued', 'uploading', 'uploaded',
      'verifying', 'verified', 'insufficient_replicas', 'failed'
    )
  ),
  upload_session_id TEXT,
  bytes_uploaded BIGINT NOT NULL DEFAULT 0,
  error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backup_items_job ON backup_items (backup_job_id);

-- 9. Storage Objects & 10. Replica Status (3 independent replicas)
CREATE TABLE IF NOT EXISTS storage_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id UUID NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('original', 'preview', 'thumbnail', 'version')),
  object_key TEXT NOT NULL UNIQUE,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_storage_objects_media ON storage_objects (media_id);

CREATE TABLE IF NOT EXISTS replica_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_object_id UUID NOT NULL REFERENCES storage_objects(id) ON DELETE CASCADE,
  replica_slot TEXT NOT NULL CHECK (replica_slot IN ('copy1_primary', 'copy2_secondary', 'copy3_offsite')),
  provider TEXT NOT NULL,
  bucket TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'syncing', 'verified', 'corrupted', 'missing')),
  verified_sha256 TEXT,
  last_verified_at TIMESTAMPTZ,
  error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (storage_object_id, replica_slot)
);

-- 11. File Versions (Indefinite retention until manual delete)
CREATE TABLE IF NOT EXISTS file_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id UUID NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  storage_object_id UUID NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (media_id, version_number)
);

-- 12. Trash Items
CREATE TABLE IF NOT EXISTS trash_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id UUID NOT NULL UNIQUE REFERENCES media_files(id) ON DELETE CASCADE,
  trashed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  purge_after TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_trash_items_user ON trash_items (user_id, trashed_at DESC);

-- 13. Security Events (Minimized operational metadata)
CREATE TABLE IF NOT EXISTS security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events (user_id, created_at DESC);

-- 14. Notifications & System Settings
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (
    category IN (
      'backup_progress', 'backup_success', 'backup_failed',
      'backup_pending', 'device_health', 'security_alert', 'storage_status'
    )
  ),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Seed default RBAC roles
INSERT INTO roles (name, description) VALUES
  ('user', 'Standard account owner with isolated private media vault'),
  ('admin', 'System administrator for infrastructure, quotas, and settings (no personal media access)')
ON CONFLICT (name) DO NOTHING;

-- Seed confirmed system settings (PRD v1.1)
INSERT INTO system_settings (key, value) VALUES
  ('upload_network_policy', '"wifi_only"'::jsonb),
  ('retention_policy', '"indefinite_manual_delete"'::jsonb),
  ('trash_retention_days', '30'::jsonb),
  ('gps_map_enabled', 'false'::jsonb),
  ('search_enabled', 'false'::jsonb),
  ('sharing_enabled', 'false'::jsonb),
  ('registration_enabled', 'true'::jsonb),
  ('required_replicas', '3'::jsonb)
ON CONFLICT (key) DO NOTHING;
