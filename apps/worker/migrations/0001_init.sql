-- Kho Ảnh — Cloudflare D1 (SQLite) Production Schema
-- Mirrors all PRD v1.1 invariants: 1-way backup, 100% original files, tenant isolation,
-- no search, no sharing, no GPS map, indefinite retention until manual delete, Wi-Fi-only policy.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  encryption_mode TEXT NOT NULL CHECK (encryption_mode IN ('server_side', 'e2ee')),
  e2ee_key_salt TEXT,
  e2ee_encrypted_master_key TEXT,
  e2ee_kdf_params TEXT,
  quota_bytes INTEGER NOT NULL DEFAULT 10737418240,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'windows', 'web')),
  is_trusted INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices (user_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_family TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens (token_family);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_salt TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes (user_id);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_folders_user ON folders (user_id, parent_id);

CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  cover_media_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_albums_user ON albums (user_id);

CREATE TABLE IF NOT EXISTS media_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video')),
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  encryption_mode TEXT NOT NULL CHECK (encryption_mode IN ('server_side', 'e2ee')),
  encrypted_file_key TEXT,
  encryption_iv TEXT,
  upload_state TEXT NOT NULL DEFAULT 'verified',
  is_favorite INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  object_key TEXT NOT NULL UNIQUE,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_user_sha ON media_files (user_id, sha256);
CREATE INDEX IF NOT EXISTS idx_media_user_timeline ON media_files (user_id, deleted_at, captured_at, created_at);

CREATE TABLE IF NOT EXISTS album_media (
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (album_id, media_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS media_tags (
  media_id TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (media_id, tag_id)
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  storage_upload_id TEXT NOT NULL,
  upload_mode TEXT NOT NULL DEFAULT 'single',
  object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video')),
  expected_size_bytes INTEGER NOT NULL,
  expected_sha256 TEXT NOT NULL,
  chunk_size_bytes INTEGER NOT NULL,
  total_parts INTEGER NOT NULL,
  uploaded_parts TEXT NOT NULL DEFAULT '[]',
  bytes_uploaded INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  encrypted_file_key TEXT,
  encryption_iv TEXT,
  status TEXT NOT NULL DEFAULT 'uploading',
  media_id TEXT REFERENCES media_files(id) ON DELETE SET NULL,
  error_message TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_resume ON upload_sessions (user_id, expected_sha256, expected_size_bytes, status);

CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (media_id, version_number)
);

CREATE TABLE IF NOT EXISTS trash_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL UNIQUE REFERENCES media_files(id) ON DELETE CASCADE,
  trashed_at TEXT NOT NULL,
  purge_after TEXT
);

CREATE INDEX IF NOT EXISTS idx_trash_user ON trash_items (user_id, trashed_at);

CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events (user_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, is_read, created_at);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS storage_nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  replica_slot TEXT NOT NULL,
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  capacity_bytes INTEGER NOT NULL,
  used_bytes INTEGER NOT NULL DEFAULT 0,
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES
  ('upload_network_policy', '"wifi_only"', datetime('now')),
  ('retention_policy', '"indefinite_manual_delete"', datetime('now')),
  ('trash_retention_days', '30', datetime('now')),
  ('gps_map_enabled', 'false', datetime('now')),
  ('search_enabled', 'false', datetime('now')),
  ('sharing_enabled', 'false', datetime('now')),
  ('registration_enabled', 'true', datetime('now')),
  ('required_replicas', '1', datetime('now'));
