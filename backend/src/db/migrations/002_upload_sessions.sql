-- Phase 2: Resumable Multipart Upload Sessions & Backup Support

CREATE TABLE IF NOT EXISTS upload_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  backup_job_id UUID REFERENCES backup_jobs(id) ON DELETE SET NULL,
  storage_upload_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video')),
  expected_size_bytes BIGINT NOT NULL CHECK (expected_size_bytes > 0),
  expected_sha256 TEXT NOT NULL,
  chunk_size_bytes INTEGER NOT NULL CHECK (chunk_size_bytes >= 65536),
  total_parts INTEGER NOT NULL CHECK (total_parts >= 1 AND total_parts <= 10000),
  uploaded_parts JSONB NOT NULL DEFAULT '[]'::jsonb,
  bytes_uploaded BIGINT NOT NULL DEFAULT 0 CHECK (bytes_uploaded >= 0),
  captured_at TIMESTAMPTZ,
  width INTEGER,
  height INTEGER,
  duration_ms BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  encrypted_file_key TEXT,
  encryption_iv TEXT,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (
    status IN ('uploading', 'verifying', 'completed', 'aborted', 'failed')
  ),
  media_id UUID REFERENCES media_files(id) ON DELETE SET NULL,
  error_message TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_user_resume
  ON upload_sessions (user_id, expected_sha256, expected_size_bytes)
  WHERE status = 'uploading';

CREATE INDEX IF NOT EXISTS idx_upload_sessions_user_created
  ON upload_sessions (user_id, created_at DESC);
