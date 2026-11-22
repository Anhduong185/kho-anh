import type { SystemSettingsMap } from '@smb/shared';
import type { DbQueryable } from '../../db/client.js';

export const DEFAULT_SYSTEM_SETTINGS: SystemSettingsMap = {
  upload_network_policy: 'wifi_only',
  retention_policy: 'indefinite_manual_delete',
  trash_retention_days: 30,
  gps_map_enabled: false,
  search_enabled: false,
  sharing_enabled: false,
  registration_enabled: true,
  required_replicas: 2
};

export async function getSystemSettings(db: DbQueryable): Promise<SystemSettingsMap> {
  const res = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM system_settings');
  const merged: Record<string, unknown> = { ...DEFAULT_SYSTEM_SETTINGS };
  for (const row of res.rows) {
    merged[row.key] = row.value;
  }

  return {
    upload_network_policy: 'wifi_only',
    retention_policy: 'indefinite_manual_delete',
    trash_retention_days: Number(merged.trash_retention_days ?? 30),
    gps_map_enabled: false,
    search_enabled: false,
    sharing_enabled: false,
    registration_enabled: Boolean(merged.registration_enabled ?? true),
    required_replicas: DEFAULT_SYSTEM_SETTINGS.required_replicas
  };
}

export async function updateSystemSetting(
  db: DbQueryable,
  key: string,
  value: unknown,
  updatedBy: string
): Promise<void> {
  await db.query(
    `
    INSERT INTO system_settings (key, value, updated_at, updated_by)
    VALUES ($1, $2::jsonb, NOW(), $3)
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by
    `,
    [key, JSON.stringify(value), updatedBy]
  );
}
