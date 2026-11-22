import React, { useCallback, useEffect, useState } from 'react';
import type {
  CloudStorageProvider,
  CreateOrUpdateStorageNodeRequest,
  GoogleDriveOAuthConfigView,
  PoolCapacitySummary,
  ReplicaSlot,
  StorageNodeView,
  StorageProtocol,
  StorageProviderPreset,
  TestStorageTargetResponse
} from '@smb/shared';
import { api, ApiError } from '../api/client';
import { formatBytes } from '../utils/e2ee';

const SLOT_TITLES: Record<ReplicaSlot, string> = {
  copy1_primary: 'Copy 1 (Kho chính)',
  copy2_secondary: 'Copy 2 (Dự phòng)',
  copy3_offsite: 'Copy 3 (Dữ liệu cũ)'
};

const GIB = 1024 * 1024 * 1024;
const MAX_CAPACITY_GB = 100 * 1024; // 102,400 GiB (100 TiB)
const NATIVE_R2_NODE_ID = 'cf-r2-native';

function safeFormatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  return formatBytes(bytes);
}

function inferProtocol(
  provider: CloudStorageProvider,
  preset?: StorageProviderPreset
): StorageProtocol {
  if (preset) return preset.protocol;
  if (provider === 'local') return 'local';
  if (provider === 'google_drive') return 'gdrive';
  if (
    provider === 'infinicloud_webdav' ||
    provider === 'koofr_webdav' ||
    provider === 'webdav_custom'
  ) {
    return 'webdav';
  }
  return 's3';
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function CloudStorageConfigurator({ onUpdated }: { onUpdated?: () => void }) {
  const [nodes, setNodes] = useState<StorageNodeView[]>([]);
  const [summary, setSummary] = useState<PoolCapacitySummary | null>(null);
  const [presets, setPresets] = useState<StorageProviderPreset[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);

  const [name, setName] = useState('Oracle Always Free VM MinIO');
  const [slot, setSlot] = useState<ReplicaSlot>('copy1_primary');
  const [provider, setProvider] = useState<CloudStorageProvider>('oracle_vm_minio');
  const [capacityGbInput, setCapacityGbInput] = useState<string>('180');
  const [priorityInput, setPriorityInput] = useState<string>('10');
  const [endpoint, setEndpoint] = useState('https://minio.your-oci-domain.com');
  const [region, setRegion] = useState('ap-singapore-1');
  const [bucket, setBucket] = useState('vault-photos');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [forcePathStyle, setForcePathStyle] = useState(true);
  const [localRoot, setLocalRoot] = useState('./data/pool-node-1');

  const [testing, setTesting] = useState(false);
  const [testingNodeId, setTestingNodeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<TestStorageTargetResponse | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [deleteError, setDeleteError] = useState<{ nodeId: string; text: string } | null>(null);

  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editSlot, setEditSlot] = useState<ReplicaSlot>('copy1_primary');
  const [editCapacityGb, setEditCapacityGb] = useState('100');
  const [editPriority, setEditPriority] = useState('10');
  const [editEnabled, setEditEnabled] = useState(true);
  const [editEndpoint, setEditEndpoint] = useState('');
  const [editRegion, setEditRegion] = useState('auto');
  const [editBucket, setEditBucket] = useState('');
  const [editAccessKeyId, setEditAccessKeyId] = useState('');
  const [editSecretAccessKey, setEditSecretAccessKey] = useState('');
  const [editForcePathStyle, setEditForcePathStyle] = useState(true);
  const [editLocalRoot, setEditLocalRoot] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [migrateSource, setMigrateSource] = useState<ReplicaSlot>('copy1_primary');
  const [migrateTarget, setMigrateTarget] = useState<ReplicaSlot>('copy2_secondary');
  const [migrating, setMigrating] = useState(false);

  // Google Drive 1-Click OAuth state
  const [gdConfig, setGdConfig] = useState<GoogleDriveOAuthConfigView | null>(null);
  const [showGdConfigForm, setShowGdConfigForm] = useState(false);
  const [gdClientId, setGdClientId] = useState('');
  const [gdClientSecret, setGdClientSecret] = useState('');
  const [gdSlot, setGdSlot] = useState<ReplicaSlot>('copy1_primary');
  const [gdFolderName, setGdFolderName] = useState('kho-anh-vault');
  const [gdPriority, setGdPriority] = useState('1');
  const [gdBusy, setGdBusy] = useState(false);
  const [refreshingGdNodeId, setRefreshingGdNodeId] = useState<string | null>(null);

  const loadPool = useCallback(async () => {
    try {
      const [res, gdCfg] = await Promise.all([
        api.adminGetStoragePool(),
        api.adminGetGoogleDriveConfig().catch(() => null)
      ]);
      setNodes(res.nodes);
      setSummary(res.summary);
      setPresets(res.presets);
      if (gdCfg) {
        setGdConfig(gdCfg);
        setGdClientId((prev) => prev || gdCfg.clientId);
      }
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Không tải được dữ liệu Multi-Cloud Storage Pool'
      });
    }
  }, []);

  useEffect(() => {
    void loadPool();
  }, [loadPool]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as {
        type?: string;
        ok?: boolean;
        message?: string;
      } | null;
      if (!data || data.type !== 'kho-anh-gdrive-oauth') return;
      setFeedback({
        type: data.ok ? 'success' : 'error',
        text: data.message || (data.ok ? 'Đã kết nối Google Drive thành công.' : 'Kết nối Google Drive thất bại.')
      });
      if (data.ok) {
        void loadPool();
        onUpdated?.();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadPool, onUpdated]);

  const handleSaveGdConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setGdBusy(true);
    setFeedback(null);
    try {
      const saved = await api.adminSaveGoogleDriveConfig({
        clientId: gdClientId.trim(),
        ...(gdClientSecret.trim() ? { clientSecret: gdClientSecret.trim() } : {})
      });
      setGdConfig(saved);
      setGdClientSecret('');
      setShowGdConfigForm(false);
      setFeedback({
        type: 'success',
        text: 'Đã lưu cấu hình Google OAuth 2.0. Bây giờ bạn có thể bấm "+ Kết nối Google Drive" để gắn 1 hoặc nhiều tài khoản (15 GB – 5 TB).'
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Không lưu được cấu hình Google OAuth'
      });
    } finally {
      setGdBusy(false);
    }
  };

  const handleConnectGoogleDrive = async () => {
    setGdBusy(true);
    setFeedback(null);
    try {
      const prio = Math.max(1, Math.floor(Number(gdPriority) || 1));
      const { authUrl } = await api.adminStartGoogleDriveOAuth({
        slot: gdSlot,
        folderName: gdFolderName.trim() || 'kho-anh-vault',
        priority: prio,
        openerOrigin: window.location.origin
      });
      const popup = window.open(authUrl, 'kho_anh_gdrive_oauth', 'width=540,height=680,noopener=no');
      if (!popup) {
        window.location.href = authUrl;
      }
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Không khởi tạo được phiên đăng nhập Google Drive'
      });
    } finally {
      setGdBusy(false);
    }
  };

  const handleRefreshGdQuota = async (node: StorageNodeView) => {
    setRefreshingGdNodeId(node.id);
    setFeedback(null);
    try {
      const res = await api.adminRefreshGoogleDriveQuota(node.id);
      setFeedback({
        type: 'success',
        text: `Đã đồng bộ dung lượng thật cho ${res.driveQuota.email}: còn trống ${safeFormatBytes(res.driveQuota.freeBytes)} / ${safeFormatBytes(res.driveQuota.limitBytes)}.`
      });
      await loadPool();
      onUpdated?.();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Không đồng bộ được dung lượng Google Drive'
      });
    } finally {
      setRefreshingGdNodeId(null);
    }
  };

  const selectedPreset = presets.find((p) => p.provider === provider);
  const activeProtocol: StorageProtocol = inferProtocol(provider, selectedPreset);

  const applyPreset = (nextProvider: CloudStorageProvider) => {
    const p = presets.find((x) => x.provider === nextProvider);
    setProvider(nextProvider);
    setTestResult(null);
    if (p) {
      setName(p.label);
      setCapacityGbInput(String(p.suggestedCapacityGb));
      setEndpoint(p.endpointTemplate);
      setRegion(p.defaultRegion);
      setBucket(p.protocol === 'webdav' ? 'vault-photos' : 'vault-photos-pool');
      if (p.protocol === 'local') {
        setLocalRoot('./data/pool-extra');
      }
    }
  };

  const validateAndBuildDraftPayload = ():
    | { ok: true; payload: CreateOrUpdateStorageNodeRequest }
    | { ok: false; error: string } => {
    const capGb = Number(capacityGbInput.trim());
    if (!capacityGbInput.trim() || !Number.isFinite(capGb) || capGb <= 0 || capGb > MAX_CAPACITY_GB) {
      return {
        ok: false,
        error: 'Hạn mức dung lượng kho (GB) phải là số hợp lệ > 0 và tối đa 102.400 GB.'
      };
    }

    const prio = Number(priorityInput.trim());
    if (!priorityInput.trim() || !Number.isInteger(prio) || prio < 1 || prio > 9999) {
      return {
        ok: false,
        error: 'Độ ưu tiên phải là số nguyên từ 1 đến 9999.'
      };
    }

    const capacityBytes = Math.round(capGb * GIB);
    if (!Number.isInteger(capacityBytes) || capacityBytes <= 0) {
      return {
        ok: false,
        error: 'Giá trị dung lượng tính theo byte không hợp lệ.'
      };
    }

    if (activeProtocol === 'local') {
      if (!localRoot.trim()) {
        return { ok: false, error: 'Đường dẫn thư mục Local Root không được để trống.' };
      }
    } else {
      if (!endpoint.trim() || !isValidHttpUrl(endpoint.trim())) {
        return {
          ok: false,
          error: 'Endpoint URL không hợp lệ (cần bắt đầu bằng https:// hoặc http://).'
        };
      }
      if (!bucket.trim()) {
        return {
          ok: false,
          error:
            activeProtocol === 'webdav'
              ? 'Thư mục gốc trên WebDAV không được để trống.'
              : 'Tên Bucket không được để trống.'
        };
      }
    }

    return {
      ok: true,
      payload: {
        name: name.trim() || selectedPreset?.label || 'Cloud Node',
        slot,
        provider,
        enabled: true,
        priority: prio,
        capacityBytes,
        endpoint: activeProtocol === 'local' ? '' : endpoint.trim(),
        region: activeProtocol === 'local' ? 'local' : region.trim() || 'auto',
        bucket: bucket.trim() || 'vault-photos',
        accessKeyId: activeProtocol === 'local' ? '' : accessKeyId.trim(),
        secretAccessKey: activeProtocol === 'local' ? '' : secretAccessKey.trim(),
        forcePathStyle,
        localRoot: activeProtocol === 'local' ? localRoot.trim() : ''
      }
    };
  };

  const handleTestDraft = async () => {
    setTestResult(null);
    setFeedback(null);
    const validated = validateAndBuildDraftPayload();
    if (!validated.ok) {
      setFeedback({ type: 'error', text: validated.error });
      return;
    }

    setTesting(true);
    try {
      const { result } = await api.adminTestPoolNodeDraft(validated.payload);
      setTestResult(result);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Kiểm tra kết nối thất bại'
      });
    } finally {
      setTesting(false);
    }
  };

  const handleCreateNode = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    const validated = validateAndBuildDraftPayload();
    if (!validated.ok) {
      setFeedback({ type: 'error', text: validated.error });
      return;
    }

    setSaving(true);
    try {
      const res = await api.adminCreatePoolNode(validated.payload);
      setFeedback({
        type: 'success',
        text: `Đã thêm "${res.node.name}" (+${safeFormatBytes(res.node.capacityBytes)}) vào ${SLOT_TITLES[res.node.slot]}. Khóa bí mật đã mã hóa AES-256-GCM.`
      });
      setShowAddForm(false);
      setAccessKeyId('');
      setSecretAccessKey('');
      setTestResult(null);
      await loadPool();
      onUpdated?.();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Không thể thêm kho vào Pool'
      });
    } finally {
      setSaving(false);
    }
  };

  const startEditNode = (node: StorageNodeView) => {
    if (editingNodeId === node.id) {
      setEditingNodeId(null);
      setEditError(null);
      return;
    }
    const gb = Math.round((node.capacityBytes / GIB) * 100) / 100;
    setEditingNodeId(node.id);
    setEditName(node.name);
    setEditSlot(node.slot);
    setEditCapacityGb(gb > 0 ? String(gb) : '100');
    setEditPriority(String(node.priority));
    setEditEnabled(node.enabled);
    setEditEndpoint(node.endpoint);
    setEditRegion(node.region || 'auto');
    setEditBucket(node.bucket);
    setEditAccessKeyId('');
    setEditSecretAccessKey('');
    setEditForcePathStyle(node.forcePathStyle);
    setEditLocalRoot(node.localRoot);
    setEditError(null);
  };

  const handleSaveEditNode = async (e: React.FormEvent, node: StorageNodeView) => {
    e.preventDefault();
    setEditError(null);
    setFeedback(null);

    const capGb = Number(editCapacityGb.trim());
    if (!editCapacityGb.trim() || !Number.isFinite(capGb) || capGb <= 0 || capGb > MAX_CAPACITY_GB) {
      setEditError('Hạn mức dung lượng kho (GB) phải là số hợp lệ > 0 và tối đa 102.400 GB.');
      return;
    }

    const prio = Number(editPriority.trim());
    if (!editPriority.trim() || !Number.isInteger(prio) || prio < 1 || prio > 9999) {
      setEditError('Độ ưu tiên phải là số nguyên từ 1 đến 9999.');
      return;
    }

    const capacityBytes = Math.round(capGb * GIB);
    if (!Number.isInteger(capacityBytes) || capacityBytes <= 0) {
      setEditError('Giá trị dung lượng tính theo byte không hợp lệ.');
      return;
    }
    const isNativeR2 = node.id === NATIVE_R2_NODE_ID;

    let patch: Partial<CreateOrUpdateStorageNodeRequest>;
    if (isNativeR2) {
      patch = {
        name: editName.trim() || node.name,
        priority: prio,
        capacityBytes,
        enabled: editEnabled
      };
    } else if (node.protocol === 'local') {
      if (!editLocalRoot.trim()) {
        setEditError('Đường dẫn thư mục Local Root không được để trống.');
        return;
      }
      patch = {
        name: editName.trim() || node.name,
        slot: editSlot,
        priority: prio,
        capacityBytes,
        enabled: editEnabled,
        bucket: editBucket.trim() || node.bucket,
        localRoot: editLocalRoot.trim()
      };
    } else {
      if (!editEndpoint.trim() || !isValidHttpUrl(editEndpoint.trim())) {
        setEditError('Endpoint URL không hợp lệ (cần bắt đầu bằng https:// hoặc http://).');
        return;
      }
      if (!editBucket.trim()) {
        setEditError('Bucket / Thư mục gốc không được để trống.');
        return;
      }
      patch = {
        name: editName.trim() || node.name,
        slot: editSlot,
        priority: prio,
        capacityBytes,
        enabled: editEnabled,
        endpoint: editEndpoint.trim(),
        bucket: editBucket.trim(),
        region: node.protocol === 's3' ? editRegion.trim() || 'auto' : node.region,
        forcePathStyle: node.protocol === 's3' ? editForcePathStyle : false
      };
      if (editAccessKeyId.trim()) {
        patch.accessKeyId = editAccessKeyId.trim();
      }
      if (editSecretAccessKey.trim()) {
        patch.secretAccessKey = editSecretAccessKey.trim();
      }
    }

    setEditSaving(true);
    try {
      const res = await api.adminUpdatePoolNode(node.id, patch);
      setEditingNodeId(null);
      setEditError(null);
      setFeedback({
        type: 'success',
        text: `Đã cập nhật "${res.node.name}" (${safeFormatBytes(res.node.capacityBytes)}, ưu tiên #${res.node.priority}).`
      });
      await loadPool();
      onUpdated?.();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Không cập nhật được cấu hình kho';
      setEditError(msg);
      setFeedback({ type: 'error', text: msg });
    } finally {
      setEditSaving(false);
    }
  };

  const handleTestSavedNode = async (node: StorageNodeView) => {
    setTestingNodeId(node.id);
    setFeedback(null);
    try {
      const { result } = await api.adminTestPoolNode(node.id);
      const checksText = `Ghi: ${result.checks.write ? '✓' : '✕'} · Đọc SHA-256: ${result.checks.readVerify ? '✓' : '✕'} · Xóa probe: ${result.checks.delete ? '✓' : '✕'}`;
      setFeedback({
        type: result.ok ? 'success' : 'error',
        text: `${node.name}: ${result.ok ? 'Kết nối OK' : 'Lỗi'} (${result.latencyMs} ms) — ${result.message} (${checksText})`
      });
      await loadPool();
      onUpdated?.();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Kiểm tra kết nối thất bại'
      });
    } finally {
      setTestingNodeId(null);
    }
  };

  const handleToggleNode = async (node: StorageNodeView) => {
    setSaving(true);
    setFeedback(null);
    try {
      const nextEnabled = !node.enabled;
      await api.adminUpdatePoolNode(node.id, { enabled: nextEnabled });
      setFeedback({
        type: 'success',
        text: nextEnabled
          ? `Đã bật lại kho "${node.name}".`
          : `Đã tạm tắt kho "${node.name}".`
      });
      await loadPool();
      onUpdated?.();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Không cập nhật được trạng thái kho'
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteNode = async (node: StorageNodeView) => {
    if (node.id === NATIVE_R2_NODE_ID) return;
    if (!window.confirm(`Gỡ kho "${node.name}" khỏi Storage Pool?`)) return;
    setSaving(true);
    setFeedback(null);
    setDeleteError(null);
    try {
      await api.adminDeletePoolNode(node.id);
      setFeedback({ type: 'success', text: `Đã gỡ "${node.name}" khỏi Pool.` });
      if (editingNodeId === node.id) {
        setEditingNodeId(null);
      }
      await loadPool();
      onUpdated?.();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'NODE_NOT_EMPTY' || err.status === 409
            ? `Không thể gỡ "${node.name}" (${err.code || '409'}): ${err.message}`
            : err.message
          : 'Không thể gỡ kho';
      setFeedback({ type: 'error', text: msg });
      setDeleteError({ nodeId: node.id, text: msg });
    } finally {
      setSaving(false);
    }
  };

  const handleMigrate = async () => {
    setMigrating(true);
    setFeedback(null);
    try {
      const { result } = await api.adminMigrateStorage(migrateSource, migrateTarget);
      let text = `Migration ${result.sourceSlot} → ${result.targetSlot}: đã chuyển & xác minh SHA-256 cho ${result.migratedCount} file (bỏ qua ${result.skippedAlreadyVerified}, lỗi ${result.failedCount}).`;
      if (result.failedCount > 0 && result.failures.length > 0) {
        const preview = result.failures
          .slice(0, 3)
          .map((f) => `${f.objectKey}: ${f.error}`)
          .join(' | ');
        text += ` Chi tiết lỗi: ${preview}`;
      }
      setFeedback({
        type: result.failedCount === 0 ? 'success' : 'error',
        text
      });
      await loadPool();
      onUpdated?.();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Lỗi chạy migration'
      });
    } finally {
      setMigrating(false);
    }
  };

  const activeSlots = ['copy1_primary', 'copy2_secondary'] as const;
  const protectedFreeBytes = summary
    ? Math.min(...activeSlots.map((s) => summary.bySlot[s].totalFreeBytes))
    : 0;

  return (
    <section className="panel stack">
      <div className="panel-head-row">
        <div>
          <h3>Multi-Cloud Storage Pool (Ghép kho S3 + WebDAV + R2 → vượt 10 GB)</h3>
          <p className="muted small">
            Tự động phân mảnh thông minh (Auto-Sharding): khi một kho cloud đầy, file mới tự chuyển sang
            kho kế tiếp trong cùng Pool mà không làm gián đoạn sao lưu.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary btn-compact"
          onClick={() => {
            setShowAddForm((v) => !v);
            setTestResult(null);
          }}
        >
          {showAddForm ? 'Đóng form' : '+ Thêm kho Cloud / WebDAV / NAS'}
        </button>
      </div>

      {/* Google Drive 1-Click OAuth Panel (15 GB – 5 TB+) */}
      <div className="queue-card" style={{ borderColor: 'var(--accent)' }}>
        <div className="queue-top">
          <div>
            <strong>Google Drive / Google One (15 GB – 5 TB+)</strong>{' '}
            <span className={`pill ${gdConfig?.configured ? 'ok' : 'warn'}`}>
              {gdConfig?.configured ? 'Đã sẵn sàng OAuth' : 'Cần nhập Client ID 1 lần'}
            </span>
            <div className="muted tiny" style={{ marginTop: 4 }}>
              Chỉ Admin đăng nhập Google 1 lần (quyền <code>drive.file</code> trong thư mục riêng{' '}
              <code>{gdFolderName}</code>). Người dùng app sao lưu sẽ tự chuyển file vào tài khoản Google Drive của bạn.
            </div>
          </div>
          <div className="media-row-actions">
            <button
              type="button"
              className="btn-small"
              onClick={() => setShowGdConfigForm((v) => !v)}
            >
              {showGdConfigForm ? 'Ẩn cấu hình OAuth' : 'Cài đặt OAuth'}
            </button>
            <button
              type="button"
              className="btn-primary btn-compact"
              disabled={gdBusy || !gdConfig?.configured}
              onClick={() => void handleConnectGoogleDrive()}
            >
              {gdBusy ? 'Đang mở Google...' : '+ Kết nối Google Drive'}
            </button>
          </div>
        </div>

        {gdConfig?.configured && !showGdConfigForm && (
          <div className="two-col" style={{ marginTop: 10 }}>
            <label className="field">
              <span>Nhóm kho khi thêm Google Drive</span>
              <select
                className="sort-select"
                value={gdSlot}
                onChange={(e) => setGdSlot(e.target.value as ReplicaSlot)}
              >
                <option value="copy1_primary">Copy 1 — Kho chính (cộng dồn dung lượng)</option>
                <option value="copy2_secondary">Copy 2 — Dự phòng (tùy chọn)</option>
              </select>
            </label>
            <div className="two-col">
              <label className="field">
                <span>Thư mục trên Drive</span>
                <input
                  type="text"
                  value={gdFolderName}
                  onChange={(e) => setGdFolderName(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Độ ưu tiên (1 = ghi trước R2)</span>
                <input
                  type="number"
                  min={1}
                  max={9999}
                  value={gdPriority}
                  onChange={(e) => setGdPriority(e.target.value)}
                />
              </label>
            </div>
          </div>
        )}

        {(showGdConfigForm || !gdConfig?.configured) && (
          <form className="cloud-editor-form" style={{ marginTop: 10 }} onSubmit={(e) => void handleSaveGdConfig(e)}>
            <div className="muted tiny">
              Trên{' '}
              <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                Google Cloud Console
              </a>
              : bật <strong>Google Drive API</strong> → OAuth Consent Screen chọn <strong>Publish App</strong> (để không hết hạn 7 ngày) → tạo <strong>OAuth Client ID (Web application)</strong> với Authorized redirect URI:
              <div style={{ marginTop: 4 }}>
                <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>
                  {gdConfig?.redirectUri || `${window.location.origin}/api/v1/admin/storage/pool/google-drive/oauth/callback`}
                </code>
              </div>
            </div>
            <div className="two-col">
              <label className="field">
                <span>Google OAuth Client ID</span>
                <input
                  type="text"
                  required
                  placeholder="123456789-abc.apps.googleusercontent.com"
                  value={gdClientId}
                  onChange={(e) => setGdClientId(e.target.value)}
                />
              </label>
              <label className="field">
                <span>
                  Google OAuth Client Secret {gdConfig?.hasClientSecret ? '(đã lưu — để trống nếu giữ nguyên)' : ''}
                </span>
                <input
                  type="password"
                  required={!gdConfig?.hasClientSecret}
                  placeholder="GOCSPX-..."
                  value={gdClientSecret}
                  onChange={(e) => setGdClientSecret(e.target.value)}
                />
              </label>
            </div>
            <div className="media-row-actions">
              <button type="submit" className="btn-primary btn-compact" disabled={gdBusy}>
                {gdBusy ? 'Đang lưu...' : 'Lưu Google OAuth Credentials'}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Pool Capacity Grand Total & Slot Dashboard */}
      {summary && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="queue-card">
            <div className="queue-top">
              <strong>Dung lượng trống ước tính cho đủ 2 bản</strong>
              <span className="pill ok">{safeFormatBytes(protectedFreeBytes)}</span>
            </div>
            <div className="muted small">
              Tính theo hạn mức đã khai báo trong Pool của nhóm còn ít chỗ hơn. Mỗi file phải vừa trong một kho của mỗi nhóm.
            </div>
          </div>

          <div className="stats-grid pool-slots">
            {activeSlots.map((s) => {
              const st = summary.bySlot[s];
              const pct = Math.min(100, Math.max(0, st.percentOfGoal));
              return (
                <div key={s} className="stat-card">
                  <div className="quota-label" style={{ marginBottom: 4 }}>
                    <span>{SLOT_TITLES[s]}</span>
                    <span>{st.activeNodeCount} kho</span>
                  </div>
                  <strong style={{ fontSize: '1.1rem' }}>
                    {safeFormatBytes(st.totalCapacityBytes)} / {safeFormatBytes(summary.targetGoalBytes)}
                  </strong>
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="muted tiny">
                    Đã dùng: {safeFormatBytes(st.totalUsedBytes)} · Còn trống:{' '}
                    {safeFormatBytes(st.totalFreeBytes)} ({st.percentOfGoal}% mục tiêu{' '}
                    {safeFormatBytes(summary.targetGoalBytes)})
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="privacy-banner" style={{ fontSize: '0.86rem' }}>
        <strong>Gợi ý:</strong> Dùng Cloudflare R2 cho Copy 1, Backblaze B2 và OCI Object Storage cho
        Copy 2. Kho đầy sẽ chuyển sang kho tiếp theo trong cùng nhóm. Dùng hai nhà cung cấp độc lập
        cho hai bản; Copy 3 cũ chỉ giữ để phục hồi.
      </div>

      {feedback && <div className={`alert ${feedback.type}`}>{feedback.text}</div>}

      {/* Add Cloud / WebDAV / Local Node Form */}
      {showAddForm && (
        <form onSubmit={handleCreateNode} className="queue-card" style={{ gap: 12 }}>
          <h4 style={{ margin: 0 }}>Thêm kho lưu trữ mới vào Storage Pool</h4>

          <div className="two-col">
            <label className="field">
              <span>Nhà cung cấp (S3 · WebDAV · Local)</span>
              <select
                className="sort-select"
                value={provider}
                onChange={(e) => applyPreset(e.target.value as CloudStorageProvider)}
              >
                {presets.map((p) => (
                  <option key={p.provider} value={p.provider}>
                    [{p.protocol.toUpperCase()}] {p.label} (~{p.suggestedCapacityGb} GB)
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Gắn vào bản sao (Replica Pool)</span>
              <select
                className="sort-select"
                value={slot}
                onChange={(e) => setSlot(e.target.value as ReplicaSlot)}
              >
                <option value="copy1_primary">Copy 1 — Kho chính (Primary Pool)</option>
                <option value="copy2_secondary">Copy 2 — Dự phòng (Secondary Pool)</option>
              </select>
            </label>
          </div>

          {selectedPreset && (
            <div className="muted small">
              <strong>{selectedPreset.label}:</strong> {selectedPreset.freeTier}. {selectedPreset.notes}{' '}
              {selectedPreset.requiresCard ? '(Cần thẻ xác minh)' : '(Không cần thẻ)'}
            </div>
          )}

          <div className="two-col">
            <label className="field">
              <span>Tên gợi nhớ cho kho này</span>
              <input
                type="text"
                name="pool_node_name"
                autoComplete="off"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="VD: InfiniCLOUD 20GB #1"
              />
            </label>

            <div className="two-col">
              <label className="field">
                <span>Hạn mức dung lượng kho (GB)</span>
                <input
                  type="number"
                  min={0.1}
                  max={MAX_CAPACITY_GB}
                  step="any"
                  required
                  value={capacityGbInput}
                  onChange={(e) => setCapacityGbInput(e.target.value)}
                />
              </label>

              <label className="field">
                <span>Độ ưu tiên (nhỏ chạy trước)</span>
                <input
                  type="number"
                  min={1}
                  max={9999}
                  step={1}
                  required
                  value={priorityInput}
                  onChange={(e) => setPriorityInput(e.target.value)}
                />
              </label>
            </div>
          </div>

          {activeProtocol === 'local' ? (
            <div className="two-col">
              <label className="field">
                <span>Đường dẫn thư mục trên ổ đĩa (Local Root)</span>
                <input
                  type="text"
                  required
                  value={localRoot}
                  onChange={(e) => setLocalRoot(e.target.value)}
                  placeholder="VD: D:\VaultPhotos_Pool1 hoặc ./data/pool1"
                />
              </label>
              <label className="field">
                <span>Nhãn ổ lưu trữ</span>
                <input
                  type="text"
                  value={bucket}
                  onChange={(e) => setBucket(e.target.value)}
                  placeholder="local-pool-1"
                />
              </label>
            </div>
          ) : (
            <>
              <div className="two-col">
                <label className="field">
                  <span>{activeProtocol === 'webdav' ? 'WebDAV Endpoint URL' : 'S3 Endpoint URL'}</span>
                  <input
                    type="url"
                    required
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    placeholder={selectedPreset?.endpointTemplate}
                  />
                </label>

                <label className="field">
                  <span>
                    {activeProtocol === 'webdav' ? 'Thư mục gốc trên WebDAV' : 'Tên Bucket (Private)'}
                  </span>
                  <input
                    type="text"
                    required
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    placeholder="vault-photos"
                  />
                </label>
              </div>

              <div className="two-col">
                <label className="field">
                  <span>{activeProtocol === 'webdav' ? 'WebDAV Username / User ID' : 'Access Key ID'}</span>
                  <input
                    type="text"
                    name="pool_access_key"
                    autoComplete="off"
                    required
                    value={accessKeyId}
                    onChange={(e) => setAccessKeyId(e.target.value)}
                    placeholder={
                      activeProtocol === 'webdav' ? 'Nhập User ID / Email WebDAV' : 'Nhập Access Key ID'
                    }
                  />
                </label>

                <label className="field">
                  <span>
                    {activeProtocol === 'webdav'
                      ? 'WebDAV App Password (mã hóa AES-256-GCM)'
                      : 'Secret Access Key (mã hóa AES-256-GCM)'}
                  </span>
                  <input
                    type="password"
                    name="pool_secret_key"
                    autoComplete="new-password"
                    required
                    value={secretAccessKey}
                    onChange={(e) => setSecretAccessKey(e.target.value)}
                    placeholder={
                      activeProtocol === 'webdav' ? 'Nhập App Password WebDAV' : 'Nhập Secret Access Key'
                    }
                  />
                </label>
              </div>

              {activeProtocol === 's3' && (
                <div className="two-col">
                  <label className="field">
                    <span>Region</span>
                    <input
                      type="text"
                      value={region}
                      onChange={(e) => setRegion(e.target.value)}
                      placeholder={selectedPreset?.defaultRegion}
                    />
                  </label>
                  <label className="wifi-confirm-box checkbox-field-align">
                    <input
                      type="checkbox"
                      checked={forcePathStyle}
                      onChange={(e) => setForcePathStyle(e.target.checked)}
                    />
                    <span>Bật <code>forcePathStyle</code> (R2/B2/OCI/MinIO)</span>
                  </label>
                </div>
              )}
            </>
          )}

          {testResult && (
            <div className={`alert ${testResult.ok ? 'success' : 'error'}`} style={{ marginBottom: 0 }}>
              <strong>
                {testResult.ok ? 'Kết nối OK' : 'Kết nối thất bại'} ({testResult.latencyMs} ms):
              </strong>{' '}
              {testResult.message} (Ghi: {testResult.checks.write ? '✓' : '✕'} · Đọc SHA-256:{' '}
              {testResult.checks.readVerify ? '✓' : '✕'} · Xóa probe:{' '}
              {testResult.checks.delete ? '✓' : '✕'})
            </div>
          )}

          <div className="modal-actions">
            <button
              type="button"
              className="btn-secondary"
              disabled={testing || saving}
              onClick={() => void handleTestDraft()}
            >
              {testing ? 'Đang test Ghi/Đọc/SHA-256...' : 'Kiểm tra kết nối trước khi lưu'}
            </button>
            <button type="submit" className="btn-primary" disabled={saving || testing}>
              {saving ? 'Đang thêm vào Pool...' : 'Lưu & Gắn vào Pool ngay'}
            </button>
          </div>
        </form>
      )}

      {/* Active Pool Nodes List */}
      {nodes.length === 0 ? (
        <div className="queue-card">
          <div className="muted small">
            Chưa có kho nào được gắn vào <strong>Multi-Cloud Storage Pool</strong> (hệ thống đang tạm dùng
            ổ đĩa cục bộ mặc định <code>./data/storage</code> cho Copy 1). Bấm{' '}
            <strong>+ Thêm kho Cloud / WebDAV / NAS</strong> ở trên để bắt đầu ghép các kho cloud vào Pool
            vượt 10 GB.
          </div>
        </div>
      ) : (
        <div className="replica-list">
          {nodes.map((node) => {
            const pct = Math.min(
              100,
              Math.max(0, Math.round((node.usedBytes / Math.max(1, node.capacityBytes)) * 100))
            );
            const isNativeR2 = node.id === NATIVE_R2_NODE_ID;
            const isEditing = editingNodeId === node.id;
            const isTestingThis = testingNodeId === node.id;

            return (
              <div key={node.id} className="queue-card">
                <div className="queue-top">
                  <div className="node-card-main">
                    <strong>{node.name}</strong>{' '}
                    <span className="pill accent">{SLOT_TITLES[node.slot]}</span>
                    <span className="pill neutral">{node.protocol.toUpperCase()}</span>
                    <span className={`pill ${node.enabled ? 'ok' : 'warn'}`}>
                      {node.enabled ? `Đang bật (Ưu tiên #${node.priority})` : 'Đang tạm tắt'}
                    </span>
                    <div className="muted tiny" style={{ marginTop: 4 }}>
                      {node.provider} · {node.bucket || node.localRoot}
                      {node.accessKeyIdPreview ? ` · Key: ${node.accessKeyIdPreview}` : ''}
                    </div>
                  </div>
                  <div className="media-row-actions">
                    {node.provider === 'google_drive' && (
                      <button
                        type="button"
                        className="btn-small"
                        disabled={refreshingGdNodeId === node.id}
                        onClick={() => void handleRefreshGdQuota(node)}
                      >
                        {refreshingGdNodeId === node.id ? 'Đang đồng bộ...' : 'Đồng bộ GB thật'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-small"
                      disabled={isTestingThis || testingNodeId !== null}
                      onClick={() => void handleTestSavedNode(node)}
                    >
                      {isTestingThis ? 'Đang test...' : 'Kiểm tra'}
                    </button>
                    <button
                      type="button"
                      className={`btn-small ${isEditing ? 'active' : ''}`}
                      disabled={saving || editSaving}
                      onClick={() => startEditNode(node)}
                    >
                      {isEditing ? 'Đóng sửa' : 'Chỉnh sửa'}
                    </button>
                    <button
                      type="button"
                      className="btn-small"
                      disabled={saving}
                      onClick={() => void handleToggleNode(node)}
                    >
                      {node.enabled ? 'Tạm tắt' : 'Bật lại'}
                    </button>
                    {isNativeR2 ? (
                      <span className="pill neutral">Mặc định hệ thống</span>
                    ) : (
                      <button
                        type="button"
                        className="btn-small danger"
                        disabled={saving}
                        onClick={() => void handleDeleteNode(node)}
                      >
                        Gỡ kho
                      </button>
                    )}
                  </div>
                </div>

                <div className="quota-label" style={{ marginBottom: 0 }}>
                  <span>
                    Đã dùng {safeFormatBytes(node.usedBytes)} / {safeFormatBytes(node.capacityBytes)}
                  </span>
                  <span>
                    Còn trống {safeFormatBytes(node.freeBytes)} ({pct}%)
                  </span>
                </div>
                <div className="progress-track">
                  <div
                    className={`progress-fill ${pct >= 100 ? 'danger' : pct >= 85 ? 'warn' : ''}`.trim()}
                    style={{ width: `${pct}%` }}
                  />
                </div>

                {node.lastTestAt && (
                  <div className="muted tiny">
                    Kiểm tra gần nhất ({new Date(node.lastTestAt).toLocaleString('vi-VN')}):{' '}
                    <strong>{node.lastTestOk ? 'OK' : 'Lỗi'}</strong> — {node.lastTestMessage}
                  </div>
                )}

                {deleteError && deleteError.nodeId === node.id && (
                  <div className="alert error" style={{ margin: 0 }}>
                    {deleteError.text}
                  </div>
                )}

                {isEditing && (
                  <form
                    className="cloud-editor-form"
                    onSubmit={(e) => void handleSaveEditNode(e, node)}
                  >
                    <div className="two-col">
                      <label className="field">
                        <span>Tên hiển thị kho</span>
                        <input
                          type="text"
                          required
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                        />
                      </label>
                      <div className="two-col">
                        <label className="field">
                          <span>Hạn mức dung lượng (GB)</span>
                          <input
                            type="number"
                            min={0.1}
                            max={MAX_CAPACITY_GB}
                            step="any"
                            required
                            value={editCapacityGb}
                            onChange={(e) => setEditCapacityGb(e.target.value)}
                          />
                        </label>
                        <label className="field">
                          <span>Độ ưu tiên</span>
                          <input
                            type="number"
                            min={1}
                            max={9999}
                            step={1}
                            required
                            value={editPriority}
                            onChange={(e) => setEditPriority(e.target.value)}
                          />
                        </label>
                      </div>
                    </div>

                    <label className="wifi-confirm-box">
                      <input
                        type="checkbox"
                        checked={editEnabled}
                        onChange={(e) => setEditEnabled(e.target.checked)}
                      />
                      <span>Kích hoạt kho này trong Storage Pool</span>
                    </label>

                    {isNativeR2 ? (
                      <div className="muted tiny">
                        Node <code>cf-r2-native</code> dùng binding Cloudflare R2 mặc định; có thể
                        nâng hạn mức GB, tên gợi nhớ, độ ưu tiên và trạng thái bật/tắt tại đây.
                      </div>
                    ) : node.protocol === 'local' ? (
                      <div className="two-col">
                        <label className="field">
                          <span>Bản sao (Replica Pool)</span>
                          <select
                            className="sort-select"
                            value={editSlot}
                            onChange={(e) => setEditSlot(e.target.value as ReplicaSlot)}
                          >
                            <option value="copy1_primary">Copy 1 — Kho chính</option>
                            <option value="copy2_secondary">Copy 2 — Dự phòng</option>
                            {node.slot === 'copy3_offsite' && <option value="copy3_offsite">Copy 3 — Dữ liệu cũ</option>}
                          </select>
                        </label>
                        <label className="field">
                          <span>Đường dẫn thư mục (Local Root)</span>
                          <input
                            type="text"
                            required
                            value={editLocalRoot}
                            onChange={(e) => setEditLocalRoot(e.target.value)}
                          />
                        </label>
                      </div>
                    ) : (
                      <>
                        <div className="two-col">
                          <label className="field">
                            <span>Bản sao (Replica Pool)</span>
                            <select
                              className="sort-select"
                              value={editSlot}
                              onChange={(e) => setEditSlot(e.target.value as ReplicaSlot)}
                            >
                              <option value="copy1_primary">Copy 1 — Kho chính</option>
                              <option value="copy2_secondary">Copy 2 — Dự phòng</option>
                              {node.slot === 'copy3_offsite' && <option value="copy3_offsite">Copy 3 — Dữ liệu cũ</option>}
                            </select>
                          </label>
                          <label className="field">
                            <span>
                              {node.protocol === 'webdav' ? 'WebDAV Endpoint URL' : 'S3 Endpoint URL'}
                            </span>
                            <input
                              type="url"
                              required
                              value={editEndpoint}
                              onChange={(e) => setEditEndpoint(e.target.value)}
                            />
                          </label>
                        </div>

                        <div className="two-col">
                          <label className="field">
                            <span>
                              {node.protocol === 'webdav'
                                ? 'Thư mục gốc trên WebDAV'
                                : 'Tên Bucket (Private)'}
                            </span>
                            <input
                              type="text"
                              required
                              value={editBucket}
                              onChange={(e) => setEditBucket(e.target.value)}
                            />
                          </label>
                          {node.protocol === 's3' && (
                            <label className="field">
                              <span>Region</span>
                              <input
                                type="text"
                                value={editRegion}
                                onChange={(e) => setEditRegion(e.target.value)}
                              />
                            </label>
                          )}
                        </div>

                        <div className="two-col">
                          <label className="field">
                            <span>
                              {node.protocol === 'webdav'
                                ? 'WebDAV Username mới (để trống nếu giữ nguyên)'
                                : 'Access Key ID mới (để trống nếu giữ nguyên)'}
                            </span>
                            <input
                              type="text"
                              autoComplete="off"
                              value={editAccessKeyId}
                              onChange={(e) => setEditAccessKeyId(e.target.value)}
                              placeholder={
                                node.accessKeyIdPreview
                                  ? `Giữ nguyên (${node.accessKeyIdPreview})`
                                  : 'Để trống nếu giữ nguyên'
                              }
                            />
                          </label>
                          <label className="field">
                            <span>
                              {node.protocol === 'webdav'
                                ? 'WebDAV Password mới (để trống nếu giữ nguyên)'
                                : 'Secret Access Key mới (để trống nếu giữ nguyên)'}
                            </span>
                            <input
                              type="password"
                              autoComplete="new-password"
                              value={editSecretAccessKey}
                              onChange={(e) => setEditSecretAccessKey(e.target.value)}
                              placeholder="Để trống nếu giữ nguyên Secret/Password cũ"
                            />
                          </label>
                        </div>

                        {node.protocol === 's3' && (
                          <label className="wifi-confirm-box">
                            <input
                              type="checkbox"
                              checked={editForcePathStyle}
                              onChange={(e) => setEditForcePathStyle(e.target.checked)}
                            />
                            <span>Bật <code>forcePathStyle</code></span>
                          </label>
                        )}
                      </>
                    )}

                    {editError && <div className="alert error" style={{ margin: 0 }}>{editError}</div>}

                    <div className="modal-actions">
                      <button
                        type="button"
                        className="btn-small"
                        disabled={editSaving}
                        onClick={() => {
                          setEditingNodeId(null);
                          setEditError(null);
                        }}
                      >
                        Hủy
                      </button>
                      <button type="submit" className="btn-primary btn-compact" disabled={editSaving}>
                        {editSaving ? 'Đang lưu...' : 'Lưu thay đổi'}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Provider Migration Helper */}
      <div className="queue-card">
        <strong>Chuyển dữ liệu giữa các Pool (Provider Migration — PRD 8.4)</strong>
        <div className="inline-form">
          <select
            className="sort-select"
            value={migrateSource}
            onChange={(e) => setMigrateSource(e.target.value as ReplicaSlot)}
          >
            <option value="copy1_primary">Nguồn: Copy 1 Pool</option>
            <option value="copy2_secondary">Nguồn: Copy 2 Pool</option>
            <option value="copy3_offsite">Nguồn: Copy 3 Pool</option>
          </select>
          <span className="migration-arrow muted">→</span>
          <select
            className="sort-select"
            value={migrateTarget}
            onChange={(e) => setMigrateTarget(e.target.value as ReplicaSlot)}
          >
            <option value="copy2_secondary">Đích: Copy 2 Pool</option>
            <option value="copy1_primary">Đích: Copy 1 Pool</option>
          </select>
          <button
            type="button"
            className="btn-secondary"
            disabled={migrating || migrateSource === migrateTarget}
            onClick={() => void handleMigrate()}
          >
            {migrating ? 'Đang migration...' : 'Chạy Migration có SHA-256'}
          </button>
        </div>
      </div>
    </section>
  );
}
