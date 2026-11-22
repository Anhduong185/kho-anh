-- Raise default per-user quota from 10 GiB (10737418240) to 100 GiB (107374182400)
-- Updates existing accounts still on the legacy 10 GiB default while preserving custom admin-assigned quotas.

ALTER TABLE users ALTER COLUMN quota_bytes SET DEFAULT 107374182400;

UPDATE users
SET quota_bytes = 107374182400,
    updated_at = NOW()
WHERE quota_bytes = 10737418240;
