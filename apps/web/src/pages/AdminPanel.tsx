import React, { useCallback, useEffect, useState } from 'react';
import type { AdminOverview, AdminUserSummary, ReplicaBreakdownItem } from '@smb/shared';
import { api, ApiError } from '../api/client';
import { formatBytes } from '../utils/e2ee';
import { CloudStorageConfigurator } from './CloudStorageConfigurator';

interface AdminPanelProps {
  includeStoragePool?: boolean;
  refreshKey?: number;
  currentUserId?: string;
}

const GIB = 1024 * 1024 * 1024;
const MAX_QUOTA_GB = 100 * 1024; // 100 TiB = 102,400 GiB (matches Worker/Backend MAX_QUOTA_BYTES)
const QUOTA_PRESETS_GB = [
  { label: '20 GB', gb: 20 },
  { label: '50 GB', gb: 50 },
  { label: '100 GB', gb: 100 },
  { label: '250 GB', gb: 250 },
  { label: '500 GB', gb: 500 },
  { label: '1 TB', gb: 1024 }
] as const;

function safeFormatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  return formatBytes(bytes);
}

function formatAdminUserError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const lower = err.message.toLowerCase();
    if (
      err.code === 'SELF_DEACTIVATION_FORBIDDEN' ||
      lower.includes('cannot deactivate their own')
    ) {
      return 'Quản trị viên không thể tự khóa tài khoản của chính mình.';
    }
    if (
      err.code === 'LAST_ADMIN_REQUIRED' ||
      lower.includes('last active administrator')
    ) {
      return 'Không thể vô hiệu hóa tài khoản Admin hoạt động cuối cùng.';
    }
    if (err.status === 403) {
      return 'Bạn không có quyền quản trị để thực hiện thao tác này (403).';
    }
    return err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

export function AdminPanel({
  includeStoragePool = false,
  refreshKey = 0,
  currentUserId
}: AdminPanelProps = {}) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [replicaBreakdown, setReplicaBreakdown] = useState<ReplicaBreakdownItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opsMsg, setOpsMsg] = useState<string | null>(null);
  const [opsDetailError, setOpsDetailError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [editingQuotaUserId, setEditingQuotaUserId] = useState<string | null>(null);
  const [quotaGbInput, setQuotaGbInput] = useState<string>('100');
  const [quotaFormError, setQuotaFormError] = useState<string | null>(null);
  const [userFeedback, setUserFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setError(null);
    try {
      const [ov, us, integ] = await Promise.all([
        api.adminOverview(),
        api.adminUsers(),
        api.adminIntegritySummary()
      ]);
      setOverview(ov);
      setUsers(us.users);
      setReplicaBreakdown(integ.replicaBreakdown);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Không tải được dữ liệu quản trị');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData, refreshKey]);

  const toggleRegistration = async () => {
    if (!overview) return;
    setSaving(true);
    setError(null);
    try {
      await api.adminUpdateSettings({
        registration_enabled: !overview.settings.registration_enabled
      });
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Không cập nhật được cài đặt');
    } finally {
      setSaving(false);
    }
  };

  const toggleUserActive = async (target: AdminUserSummary) => {
    setBusyUserId(target.id);
    setError(null);
    setUserFeedback(null);
    try {
      await api.adminUpdateUser(target.id, { isActive: !target.isActive });
      setUserFeedback({
        type: 'success',
        text: target.isActive
          ? `Đã khóa tài khoản ${target.email}.`
          : `Đã mở khóa tài khoản ${target.email}.`
      });
      await loadData();
    } catch (err) {
      const msg = formatAdminUserError(err, 'Không thể cập nhật trạng thái tài khoản.');
      setUserFeedback({ type: 'error', text: msg });
    } finally {
      setBusyUserId(null);
    }
  };

  const openQuotaEditor = (target: AdminUserSummary) => {
    if (editingQuotaUserId === target.id) {
      setEditingQuotaUserId(null);
      setQuotaFormError(null);
      return;
    }
    const currentGb = Math.round((target.quotaBytes / GIB) * 100) / 100;
    setEditingQuotaUserId(target.id);
    setQuotaGbInput(currentGb > 0 ? String(currentGb) : '100');
    setQuotaFormError(null);
  };

  const handleSaveQuota = async (target: AdminUserSummary) => {
    setQuotaFormError(null);
    setUserFeedback(null);
    const trimmed = quotaGbInput.trim();
    const gb = Number(trimmed);
    if (!trimmed || !Number.isFinite(gb) || gb <= 0) {
      setQuotaFormError('Hạn mức dung lượng phải lớn hơn 0 GB.');
      return;
    }
    if (gb > MAX_QUOTA_GB) {
      setQuotaFormError('Hạn mức tối đa là 102.400 GB (100 TB).');
      return;
    }
    const quotaBytes = Math.round(gb * GIB);
    if (!Number.isInteger(quotaBytes) || quotaBytes <= 0 || quotaBytes > MAX_QUOTA_GB * GIB) {
      setQuotaFormError('Giá trị hạn mức không hợp lệ.');
      return;
    }

    setBusyUserId(target.id);
    try {
      await api.adminUpdateUser(target.id, { quotaBytes });
      setEditingQuotaUserId(null);
      setQuotaFormError(null);
      setUserFeedback({
        type: 'success',
        text: `Đã cập nhật hạn mức cho ${target.email} thành ${safeFormatBytes(quotaBytes)}.`
      });
      await loadData();
    } catch (err) {
      const msg = formatAdminUserError(err, 'Không cập nhật được hạn mức tài khoản.');
      setQuotaFormError(msg);
      setUserFeedback({ type: 'error', text: msg });
    } finally {
      setBusyUserId(null);
    }
  };

  if (loading) {
    return <div className="panel muted">Đang tải bảng điều khiển quản trị...</div>;
  }

  const overviewPct =
    overview && overview.totalQuotaBytes > 0
      ? Math.round((overview.totalUsedBytes / overview.totalQuotaBytes) * 1000) / 10
      : 0;
  const overviewFillClass =
    overviewPct >= 100 ? 'danger' : overviewPct >= 85 ? 'warn' : '';

  return (
    <div className="stack-lg">
      <div className="privacy-banner">
        <strong>Ranh giới quyền riêng tư Admin (PRD 4.3):</strong> Trang này chỉ quản trị tài khoản,
        quota, cấu hình hệ thống và sức khỏe hạ tầng lưu trữ. Admin không có quyền xem ảnh, video,
        album hay khóa E2EE của bất kỳ người dùng nào.
      </div>

      {error && <div className="alert error">{error}</div>}

      {overview && (
        <>
          <div className="stats-grid">
            <div className="stat-card">
              <span className="muted small">Tài khoản hoạt động</span>
              <strong>
                {overview.activeUsers} / {overview.totalUsers}
              </strong>
            </div>
            <div className="stat-card">
              <span className="muted small">Thiết bị đang liên kết</span>
              <strong>{overview.totalDevices}</strong>
            </div>
            <div className="stat-card">
              <span className="muted small">Tổng file đã sao lưu</span>
              <strong>{overview.totalMediaFiles}</strong>
            </div>
            <div className="stat-card">
              <span className="muted small">Dung lượng sử dụng</span>
              <strong>
                {safeFormatBytes(overview.totalUsedBytes)} / {safeFormatBytes(overview.totalQuotaBytes)}
              </strong>
              <div className="progress-track">
                <div
                  className={`progress-fill ${overviewFillClass}`.trim()}
                  style={{ width: `${Math.min(100, Math.max(0, overviewPct))}%` }}
                />
              </div>
              <span className="muted tiny">{overviewPct}% tổng hạn mức đã cấp</span>
            </div>
          </div>

          {includeStoragePool && <CloudStorageConfigurator onUpdated={() => void loadData()} />}

          <section className="panel">
            <div className="panel-head-row">
              <h3>Trạng thái 2 bản sao và tự phục hồi</h3>
              <div className="media-row-actions">
                <button
                  type="button"
                  className="btn-small"
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true);
                    setOpsMsg(null);
                    setOpsDetailError(null);
                    setError(null);
                    try {
                      const { result } = await api.adminRunReplication();
                      setOpsMsg(
                        `Nhân bản xong: ${result.replicatedCopies} bản sao mới, thăng hạng verified cho ${result.promotedToVerified} file (${result.skippedUnconfigured} slot chưa cấu hình cloud).`
                      );
                      if (result.failures.length > 0) {
                        const preview = result.failures
                          .slice(0, 3)
                          .map((f) => `${f.slot}: ${f.error}`)
                          .join(' | ');
                        setOpsDetailError(
                          `Có ${result.failures.length} lỗi nhân bản: ${preview}`
                        );
                      }
                      await loadData();
                    } catch (err) {
                      setError(err instanceof ApiError ? err.message : 'Lỗi chạy nhân bản');
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  Nhân bản sang Copy 2
                </button>
                <button
                  type="button"
                  className="btn-primary btn-compact"
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true);
                    setOpsMsg(null);
                    setOpsDetailError(null);
                    setError(null);
                    try {
                      const { result } = await api.adminRunIntegrityScan();
                      setOpsMsg(
                        `Quét toàn vẹn xong: ${result.scannedReplicas} bản sao (tốt: ${result.healthyReplicas}, hỏng: ${result.corruptedDetected}, thiếu: ${result.missingDetected}, đã tự phục hồi: ${result.healedReplicas}).`
                      );
                      if (result.unrecoverable.length > 0) {
                        const preview = result.unrecoverable
                          .slice(0, 3)
                          .map((u) => `${u.slot}: ${u.reason}`)
                          .join(' | ');
                        setOpsDetailError(
                          `${result.unrecoverable.length} bản sao không thể tự phục hồi: ${preview}`
                        );
                      }
                      await loadData();
                    } catch (err) {
                      setError(err instanceof ApiError ? err.message : 'Lỗi quét toàn vẹn');
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  Quét Bit-Rot &amp; Tự phục hồi
                </button>
              </div>
            </div>
            {opsMsg && <div className="alert success">{opsMsg}</div>}
            {opsDetailError && <div className="alert error">{opsDetailError}</div>}
            <div className="replica-list">
              {overview.storageTargets.map((target) => (
                <div key={target.slot} className="replica-row">
                  <div>
                    <strong>{target.slot}</strong>
                    <div className="muted small">
                      Provider: <code>{target.provider}</code> — {target.message}
                    </div>
                  </div>
                  <span
                    className={`pill ${target.configured ? (target.healthy ? 'ok' : 'danger') : 'warn'}`}
                  >
                    {target.configured ? (target.healthy ? 'Sẵn sàng' : 'Lỗi kết nối') : 'Chưa cấu hình'}
                  </span>
                </div>
              ))}
            </div>
            {replicaBreakdown.length > 0 && (
              <div className="chips-row" style={{ marginTop: 12 }}>
                {replicaBreakdown.map((r) => (
                  <span key={`${r.slot}-${r.state}`} className="pill neutral">
                    {r.slot}: {r.state} ({r.count})
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <h3>Chính sách hệ thống</h3>
            <div className="policy-list">
              <div className="policy-row">
                <span>Chính sách mạng upload</span>
                <span className="pill ok">Chỉ Wi-Fi (wifi_only — khóa cứng)</span>
              </div>
              <div className="policy-row">
                <span>Lưu giữ dữ liệu &amp; phiên bản</span>
                <span className="pill ok">Vô thời hạn · Chỉ xóa thủ công</span>
              </div>
              <div className="policy-row">
                <span>Bản đồ GPS / Tìm kiếm / Chia sẻ</span>
                <span className="pill neutral">Tắt hoàn toàn theo PRD</span>
              </div>
              <div className="policy-row">
                <span>Cho phép đăng ký tài khoản mới</span>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={saving}
                  onClick={toggleRegistration}
                >
                  {overview.settings.registration_enabled
                    ? 'Đang bật (Bấm để tắt)'
                    : 'Đang tắt (Bấm để bật)'}
                </button>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head-row" style={{ marginBottom: 10 }}>
              <h3>Quản lý tài khoản ({users.length})</h3>
              <button
                type="button"
                className="btn-small"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  setUserFeedback(null);
                  try {
                    const res = await api.adminSyncPoolQuota();
                    setUserFeedback({
                      type: 'success',
                      text: `Đã đồng bộ hạn mức của ${res.updatedUsers} tài khoản theo tổng dung lượng Kho chính (${safeFormatBytes(res.quotaBytes)}).`
                    });
                    await loadData();
                  } catch (err) {
                    setUserFeedback({
                      type: 'error',
                      text: err instanceof ApiError ? err.message : 'Không đồng bộ được hạn mức theo Pool'
                    });
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                Đồng bộ hạn mức theo Pool thật
              </button>
            </div>
            {userFeedback && <div className={`alert ${userFeedback.type}`}>{userFeedback.text}</div>}
            <div className="table-wrap">
              <table className="admin-users-table">
                <thead>
                  <tr>
                    <th>Tài khoản</th>
                    <th>Vai trò</th>
                    <th>Mã hóa</th>
                    <th>Dung lượng &amp; Hạn mức</th>
                    <th>Thiết bị</th>
                    <th>Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const usedPct =
                      u.quotaBytes > 0
                        ? Math.round((u.usedBytes / u.quotaBytes) * 1000) / 10
                        : 0;
                    const fillClass =
                      usedPct >= 100 ? 'danger' : usedPct >= 85 ? 'warn' : '';
                    const isEditing = editingQuotaUserId === u.id;
                    const isBusy = busyUserId === u.id;
                    const parsedGb = Number(quotaGbInput);
                    const previewBytes =
                      Number.isFinite(parsedGb) && parsedGb > 0
                        ? Math.round(parsedGb * GIB)
                        : null;

                    return (
                      <tr key={u.id} className="admin-user-row">
                        <td className="admin-user-identity" data-label="Tài khoản">
                          <div>
                            <strong>{u.displayName}</strong>{' '}
                            {currentUserId && u.id === currentUserId && (
                              <span className="pill accent">Bạn</span>
                            )}
                          </div>
                          <div className="muted small">{u.email}</div>
                        </td>
                        <td data-label="Vai trò">
                          {u.roles.map((r) => (
                            <span key={r} className={`pill ${r === 'admin' ? 'accent' : 'neutral'}`}>
                              {r}
                            </span>
                          ))}
                        </td>
                        <td data-label="Mã hóa">
                          <code>{u.encryptionMode}</code>
                        </td>
                        <td className="admin-user-quota" data-label="Dung lượng & Hạn mức">
                          <div className="stack" style={{ gap: 6 }}>
                            <div className="small">
                              {safeFormatBytes(u.usedBytes)} / {safeFormatBytes(u.quotaBytes)} ({usedPct}%)
                            </div>
                            <div className="progress-track">
                              <div
                                className={`progress-fill ${fillClass}`.trim()}
                                style={{ width: `${Math.min(100, Math.max(0, usedPct))}%` }}
                              />
                            </div>
                            <div>
                              <button
                                type="button"
                                className={`btn-small ${isEditing ? 'active' : ''}`}
                                disabled={saving || busyUserId !== null}
                                onClick={() => openQuotaEditor(u)}
                              >
                                {isEditing ? 'Đóng' : 'Chỉnh quota'}
                              </button>
                            </div>
                          </div>

                          {isEditing && (
                            <div className="quota-editor">
                              <div className="chips-row">
                                {QUOTA_PRESETS_GB.map((preset) => (
                                  <button
                                    key={preset.gb}
                                    type="button"
                                    className={`btn-small ${Number(quotaGbInput) === preset.gb ? 'active' : ''}`}
                                    disabled={isBusy}
                                    onClick={() => {
                                      setQuotaGbInput(String(preset.gb));
                                      setQuotaFormError(null);
                                    }}
                                  >
                                    {preset.label}
                                  </button>
                                ))}
                              </div>
                              <div className="quota-input-row">
                                <input
                                  type="number"
                                  min={0.1}
                                  max={MAX_QUOTA_GB}
                                  step="any"
                                  aria-label={`Hạn mức GB cho ${u.email}`}
                                  value={quotaGbInput}
                                  disabled={isBusy}
                                  onChange={(e) => {
                                    setQuotaGbInput(e.target.value);
                                    setQuotaFormError(null);
                                  }}
                                />
                                <span className="muted small">GB</span>
                              </div>
                              {previewBytes !== null && (
                                <div className="tiny muted">
                                  Xem trước: {safeFormatBytes(previewBytes)} (
                                  {previewBytes.toLocaleString('en-US')} bytes)
                                </div>
                              )}
                              {previewBytes !== null && previewBytes < u.usedBytes && (
                                <div className="tiny warn-text">
                                  Cảnh báo: Hạn mức mới nhỏ hơn dung lượng đã dùng (
                                  {safeFormatBytes(u.usedBytes)}).
                                </div>
                              )}
                              {quotaFormError && (
                                <div className="tiny error-text">{quotaFormError}</div>
                              )}
                              <div className="media-row-actions">
                                <button
                                  type="button"
                                  className="btn-primary btn-compact"
                                  disabled={isBusy}
                                  onClick={() => void handleSaveQuota(u)}
                                >
                                  {isBusy ? 'Đang lưu...' : 'Lưu'}
                                </button>
                                <button
                                  type="button"
                                  className="btn-small"
                                  disabled={isBusy}
                                  onClick={() => {
                                    setEditingQuotaUserId(null);
                                    setQuotaFormError(null);
                                  }}
                                >
                                  Hủy
                                </button>
                              </div>
                            </div>
                          )}
                        </td>
                        <td data-label="Thiết bị">{u.deviceCount}</td>
                        <td className="admin-user-status" data-label="Trạng thái">
                          <button
                            type="button"
                            className={`btn-small ${u.isActive ? '' : 'danger'}`}
                            disabled={saving || busyUserId !== null}
                            onClick={() => void toggleUserActive(u)}
                          >
                            {isBusy
                              ? 'Đang xử lý...'
                              : u.isActive
                                ? 'Đang hoạt động'
                                : 'Đã khóa'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
