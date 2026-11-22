import type { IntegrityScanResult, ReplicaSlot, ReplicationRunResult } from '@smb/shared';
import type { DbClient } from '../../db/client.js';
import type { StorageRegistry } from '../../storage/registry.js';
import { getSystemSettings } from '../settings/service.js';

const ALL_SLOTS: ReplicaSlot[] = ['copy1_primary', 'copy2_secondary', 'copy3_offsite'];

/**
 * Phase 6 Replication Engine:
 * Replicates verified original objects from Copy 1 (Primary) to Copy 2 (Secondary),
 * verifying exact SHA-256 on the target and promoting media_files.upload_state
 * from 'insufficient_replicas' -> 'verified' once the required replica count is satisfied.
 */
export async function runReplicationCycle(
  db: DbClient,
  storageRegistry: StorageRegistry
): Promise<ReplicationRunResult> {
  const settings = await getSystemSettings(db);
  const requiredReplicas = settings.required_replicas;

  await db.query(`
    INSERT INTO replica_status (storage_object_id, replica_slot, provider, bucket, state)
    SELECT so.id, 'copy2_secondary', 'unconfigured', 'pending', 'pending'
    FROM storage_objects so
    JOIN media_files m ON m.id = so.media_id
    WHERE so.object_kind = 'original' AND m.deleted_at IS NULL
    ON CONFLICT (storage_object_id, replica_slot) DO NOTHING
  `);

  const pendingRes = await db.query<{
    storage_object_id: string;
    media_id: string;
    user_id: string;
    object_key: string;
    primary_node_id: string | null;
    sha256: string;
    size_bytes: string | number;
    replica_slot: ReplicaSlot;
  }>(`
    SELECT
      so.id AS storage_object_id,
      so.media_id,
      so.user_id,
      so.object_key,
      so.primary_node_id,
      so.sha256,
      so.size_bytes,
      rs.replica_slot
    FROM replica_status rs
    JOIN storage_objects so ON so.id = rs.storage_object_id
    JOIN media_files m ON m.id = so.media_id
    WHERE rs.replica_slot = 'copy2_secondary'
      AND rs.state IN ('pending', 'missing', 'corrupted')
      AND m.deleted_at IS NULL
    ORDER BY so.created_at ASC
    LIMIT 200
  `);

  const touchedMedia = new Set<string>();
  const processedObjects = new Set<string>();
  let replicatedCopies = 0;
  let skippedUnconfigured = 0;
  const failures: ReplicationRunResult['failures'] = [];

  for (const row of pendingRes.rows) {
    processedObjects.add(row.storage_object_id);
    const sizeBytes = Number(row.size_bytes);
    const selectedTarget = storageRegistry.selectTargetForWrite(row.replica_slot, sizeBytes);
    if (!selectedTarget) {
      skippedUnconfigured++;
      continue;
    }

    const targetAdapter = selectedTarget.adapter;
    const primary =
      storageRegistry.resolveAdapter(row.primary_node_id, 'copy1_primary') ??
      storageRegistry.getPrimary();

    try {
      await db.query(
        "UPDATE replica_status SET state = 'syncing', storage_node_id = $3, provider = $4, bucket = $5, updated_at = NOW() WHERE storage_object_id = $1 AND replica_slot = $2",
        [
          row.storage_object_id,
          row.replica_slot,
          selectedTarget.nodeId,
          targetAdapter.provider,
          targetAdapter.bucket
        ]
      );

      const originalBytes = await primary.getObject(row.object_key);
      await targetAdapter.putObject({
        key: row.object_key,
        body: originalBytes,
        expectedSha256: row.sha256
      });

      const verified = await targetAdapter.computeObjectSha256(row.object_key);
      if (verified.sha256 !== row.sha256 || verified.sizeBytes !== sizeBytes) {
        throw new Error(`Post-replication SHA-256 mismatch on ${row.replica_slot}`);
      }

      await db.query(
        `
        UPDATE replica_status
        SET state = 'verified',
            storage_node_id = $3,
            provider = $4,
            bucket = $5,
            verified_sha256 = $6,
            last_verified_at = NOW(),
            error_message = NULL,
            updated_at = NOW()
        WHERE storage_object_id = $1 AND replica_slot = $2
        `,
        [
          row.storage_object_id,
          row.replica_slot,
          selectedTarget.nodeId,
          targetAdapter.provider,
          targetAdapter.bucket,
          verified.sha256
        ]
      );

      if (selectedTarget.nodeId) {
        await db.query(
          'UPDATE storage_nodes SET used_bytes = used_bytes + $2, updated_at = NOW() WHERE id = $1',
          [selectedTarget.nodeId, sizeBytes]
        );
        storageRegistry.adjustPoolNodeUsedBytes(selectedTarget.nodeId, sizeBytes);
      }

      replicatedCopies++;
      touchedMedia.add(row.media_id);
    } catch (err) {
      const msg = (err as Error).message;
      await db.query(
        "UPDATE replica_status SET state = 'missing', error_message = $3, updated_at = NOW() WHERE storage_object_id = $1 AND replica_slot = $2",
        [row.storage_object_id, row.replica_slot, msg]
      );
      failures.push({ storageObjectId: row.storage_object_id, slot: row.replica_slot, error: msg });
    }
  }

  // Promote media items whose verified replica count now satisfies requiredReplicas
  let promotedToVerified = 0;
  for (const mediaId of touchedMedia) {
    const countRes = await db.query<{ verified_count: string }>(
      `
      SELECT COUNT(DISTINCT rs.replica_slot)::text AS verified_count
      FROM storage_objects so
      JOIN replica_status rs ON rs.storage_object_id = so.id
      WHERE so.media_id = $1 AND so.object_kind = 'original' AND rs.state = 'verified'
        AND rs.replica_slot IN ('copy1_primary', 'copy2_secondary')
      `,
      [mediaId]
    );
    const verifiedCount = Number(countRes.rows[0]?.verified_count ?? '0');
    if (verifiedCount >= requiredReplicas) {
      const upd = await db.query(
        "UPDATE media_files SET upload_state = 'verified', updated_at = NOW() WHERE id = $1 AND upload_state <> 'verified' RETURNING id",
        [mediaId]
      );
      if (upd.rowCount > 0) promotedToVerified++;
    }
  }

  return {
    processedObjects: processedObjects.size,
    replicatedCopies,
    skippedUnconfigured,
    promotedToVerified,
    failures
  };
}

/**
 * Phase 6 Bit-Rot Integrity Scanner & Automatic Self-Healing (PRD 8.2 & 11.1):
 * Verifies SHA-256 across all configured replicas; if any replica is corrupted or missing,
 * automatically repairs it from another verified healthy replica and re-verifies SHA-256!
 */
export async function runIntegrityScanAndHeal(
  db: DbClient,
  storageRegistry: StorageRegistry
): Promise<IntegrityScanResult> {
  const objectsRes = await db.query<{
    id: string;
    media_id: string;
    user_id: string;
    object_key: string;
    sha256: string;
    size_bytes: string | number;
  }>(`
    SELECT so.id, so.media_id, so.user_id, so.object_key, so.sha256, so.size_bytes
    FROM storage_objects so
    JOIN media_files m ON m.id = so.media_id
    WHERE so.object_kind = 'original' AND m.deleted_at IS NULL
    ORDER BY so.created_at ASC
  `);

  let scannedReplicas = 0;
  let healthyReplicas = 0;
  let corruptedDetected = 0;
  let missingDetected = 0;
  let healedReplicas = 0;
  const unrecoverable: IntegrityScanResult['unrecoverable'] = [];

  for (const obj of objectsRes.rows) {
    const expectedSize = Number(obj.size_bytes);
    const repNodeRes = await db.query<{ replica_slot: ReplicaSlot; storage_node_id: string | null }>(
      "SELECT replica_slot, storage_node_id FROM replica_status WHERE storage_object_id = $1 AND state NOT IN ('pending', 'syncing')",
      [obj.id]
    );
    const nodeIdBySlot = new Map<ReplicaSlot, string | null>(
      repNodeRes.rows.map((r) => [r.replica_slot, r.storage_node_id])
    );

    const healthySlots: Array<{ slot: ReplicaSlot; nodeId: string | null }> = [];
    const damagedSlots: Array<{ slot: ReplicaSlot; nodeId: string | null; kind: 'missing' | 'corrupted' }> = [];

    for (const slot of ALL_SLOTS) {
      if (slot !== 'copy1_primary' && !nodeIdBySlot.has(slot)) continue;
      const nodeId = nodeIdBySlot.get(slot) ?? null;
      const adapter = storageRegistry.resolveAdapter(nodeId, slot);
      if (!adapter) continue;

      scannedReplicas++;
      try {
        const head = await adapter.headObject(obj.object_key);
        if (!head) {
          missingDetected++;
          damagedSlots.push({ slot, nodeId, kind: 'missing' });
          await db.query(
            "UPDATE replica_status SET state = 'missing', error_message = 'Object missing during integrity scan', updated_at = NOW() WHERE storage_object_id = $1 AND replica_slot = $2",
            [obj.id, slot]
          );
          continue;
        }

        const actual = await adapter.computeObjectSha256(obj.object_key);
        if (actual.sha256 === obj.sha256 && actual.sizeBytes === expectedSize) {
          healthyReplicas++;
          healthySlots.push({ slot, nodeId });
          await db.query(
            "UPDATE replica_status SET state = 'verified', verified_sha256 = $3, last_verified_at = NOW(), error_message = NULL, updated_at = NOW() WHERE storage_object_id = $1 AND replica_slot = $2",
            [obj.id, slot, actual.sha256]
          );
        } else {
          corruptedDetected++;
          damagedSlots.push({ slot, nodeId, kind: 'corrupted' });
          await db.query(
            "UPDATE replica_status SET state = 'corrupted', verified_sha256 = $3, error_message = 'SHA-256 bit-rot detected', updated_at = NOW() WHERE storage_object_id = $1 AND replica_slot = $2",
            [obj.id, slot, actual.sha256]
          );
        }
      } catch {
        missingDetected++;
        damagedSlots.push({ slot, nodeId, kind: 'missing' });
        await db.query(
          "UPDATE replica_status SET state = 'missing', error_message = 'Unable to verify object during integrity scan', updated_at = NOW() WHERE storage_object_id = $1 AND replica_slot = $2",
          [obj.id, slot]
        );
      }
    }

    // Attempt automatic self-healing for any damaged replica using a verified healthy replica
    if (damagedSlots.length > 0 && healthySlots.length > 0) {
      const donor = healthySlots[0]!;
      const donorAdapter = storageRegistry.resolveAdapter(donor.nodeId, donor.slot)!;
      const healthyBytes = await donorAdapter.getObject(obj.object_key);

      for (const damaged of damagedSlots) {
        if (damaged.slot === 'copy3_offsite') continue;
        const targetAdapter = storageRegistry.resolveAdapter(damaged.nodeId, damaged.slot)!;
        try {
          await targetAdapter.putObject({
            key: obj.object_key,
            body: healthyBytes,
            expectedSha256: obj.sha256
          });
          const recheck = await targetAdapter.computeObjectSha256(obj.object_key);
          if (recheck.sha256 === obj.sha256 && recheck.sizeBytes === expectedSize) {
            healedReplicas++;
            await db.query(
              `
              INSERT INTO replica_status (
                storage_object_id, replica_slot, storage_node_id, provider, bucket, state, verified_sha256, last_verified_at, error_message
              )
              VALUES ($1, $2, $3, $4, $5, 'verified', $6, NOW(), NULL)
              ON CONFLICT (storage_object_id, replica_slot) DO UPDATE
                SET state = 'verified',
                    storage_node_id = EXCLUDED.storage_node_id,
                    provider = EXCLUDED.provider,
                    bucket = EXCLUDED.bucket,
                    verified_sha256 = EXCLUDED.verified_sha256,
                    last_verified_at = NOW(),
                    error_message = NULL,
                    updated_at = NOW()
              `,
              [
                obj.id,
                damaged.slot,
                damaged.nodeId,
                targetAdapter.provider,
                targetAdapter.bucket,
                recheck.sha256
              ]
            );
          } else {
            unrecoverable.push({
              storageObjectId: obj.id,
              slot: damaged.slot,
              reason: 'Post-heal SHA-256 verification failed'
            });
          }
        } catch (err) {
          unrecoverable.push({
            storageObjectId: obj.id,
            slot: damaged.slot,
            reason: (err as Error).message
          });
        }
      }
    } else if (damagedSlots.length > 0 && healthySlots.length === 0) {
      for (const d of damagedSlots) {
        unrecoverable.push({
          storageObjectId: obj.id,
          slot: d.slot,
          reason: 'No healthy replica available to self-heal'
        });
      }
    }

    await db.query(
      `UPDATE media_files SET upload_state = CASE WHEN (
         SELECT COUNT(*) FROM replica_status
         WHERE storage_object_id = $1 AND state = 'verified'
           AND replica_slot IN ('copy1_primary', 'copy2_secondary')
       ) = 2 THEN 'verified' ELSE 'insufficient_replicas' END
       WHERE id = $2 AND upload_state IN ('verified', 'insufficient_replicas')`,
      [obj.id, obj.media_id]
    );
  }

  return {
    scannedReplicas,
    healthyReplicas,
    corruptedDetected,
    missingDetected,
    healedReplicas,
    unrecoverable
  };
}
