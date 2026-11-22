-- Keep all existing objects, including retired Copy 3 replicas.
UPDATE system_settings SET value = '2'::jsonb, updated_at = NOW()
WHERE key = 'required_replicas';

UPDATE media_files m
SET upload_state = CASE WHEN EXISTS (
  SELECT 1
  FROM storage_objects so
  JOIN replica_status rs ON rs.storage_object_id = so.id
  WHERE so.media_id = m.id AND so.object_kind = 'original'
    AND rs.replica_slot IN ('copy1_primary', 'copy2_secondary') AND rs.state = 'verified'
  GROUP BY so.id
  HAVING COUNT(*) = 2
) THEN 'verified' ELSE 'insufficient_replicas' END,
updated_at = NOW()
WHERE m.upload_state IN ('verified', 'insufficient_replicas');
