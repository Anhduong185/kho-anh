import React, { useCallback, useEffect, useState } from 'react';
import type { DeviceInfo, NotificationItem } from '@smb/shared';
import {
  api,
  ApiError,
  checkServerHealth,
  getServerBaseUrl,
  setServerBaseUrl,
  type SecurityEventItem
} from '../api/client';
import { useAuth } from '../context/AuthContext';
import {
  clearLocalAppPin,
  formatBytes,
  hasAppPinConfigured,
  setLocalAppPin
} from '../utils/e2ee';
import { AlbumsHubPanel } from './AlbumsHubPanel';
import { BackupPanel } from './BackupPanel';
import { LibraryPanel, type LibraryFilterContext } from './LibraryPanel';
import { StorageAndRestorePanel } from './StorageAndRestorePanel';

type DockTab = 'library' | 'albums' | 'vault';
type VaultSubScreen = 'home' | 'backup' | 'restore' | 'security';

function safeFormatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  return formatBytes(bytes);
}

export function VaultShell() {
  const {
    user,
    policies,
    pendingRecoveryCodes,
    clearPendingRecoveryCodes,
    e2eeMasterKey,
    unlockE2eeVault,
    lockE2eeVault,
    setAppLocked,
    logout
  } = useAuth();

  const [dockTab, setDockTab] = useState<DockTab>('library');
  const [vaultSub, setVaultSub] = useState<VaultSubScreen>('home');
  const [activeCollection, setActiveCollection] = useState<LibraryFilterContext | null>(null);
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);

  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [events, setEvents] = useState<SecurityEventItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotifications, setShowNotifications] = useState(false);

  const [showE2eeModal, setShowE2eeModal] = useState(false);
  const [e2eeInput, setE2eeInput] = useState('');
  const [e2eeError, setE2eeError] = useState<string | null>(null);
  const [newPin, setNewPin] = useState('');
  const [pinEnabled, setPinEnabled] = useState(() => hasAppPinConfigured());

  const [serverUrlInput, setServerUrlInput] = useState(() => getServerBaseUrl());
  const [serverStatus, setServerStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [regenPassword, setRegenPassword] = useState('');
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);

  const loadNotifications = useCallback(async () => {
    try {
      const res = await api.listNotifications();
      setNotifications(res.notifications);
      setUnreadCount(res.unreadCount);
    } catch {
      // ignore
    }
  }, []);

  const loadVaultOverview = useCallback(async () => {
    try {
      const [devRes, evRes] = await Promise.all([api.listDevices(), api.securityEvents()]);
      setDevices(devRes.devices);
      setEvents(evRes.events);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications, libraryRefreshKey]);

  useEffect(() => {
    if (dockTab === 'vault') {
      void loadVaultOverview();
    }
  }, [dockTab, vaultSub, loadVaultOverview]);

  const handleUnlockE2ee = async (e: React.FormEvent) => {
    e.preventDefault();
    setE2eeError(null);
    try {
      await unlockE2eeVault(e2eeInput);
      setE2eeInput('');
      setShowE2eeModal(false);
    } catch (err) {
      setE2eeError(err instanceof Error ? err.message : 'Không mở khóa được kho E2EE');
    }
  };

  const visibleCodes = pendingRecoveryCodes ?? freshCodes;
  const usedBytes = user?.usedBytes ?? 0;
  const quotaBytes = user?.quotaBytes ?? 0;
  const usedPct = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10) : 0;

  return (
    <div className="app">
      {/* One-time Recovery Codes Modal */}
      {visibleCodes && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h2 style={{ marginTop: 0 }}>Lưu lại 10 mã khôi phục</h2>
            <p className="muted small">
              Chỉ hiển thị <strong>một lần duy nhất</strong>. Hãy cất ở nơi an toàn ngoài điện thoại.
              {user?.encryptionMode === 'e2ee' &&
                ' Với tài khoản E2EE, mã này khôi phục quyền đăng nhập, không thay thế mật khẩu giải mã kho.'}
            </p>
            <div className="codes-grid">
              {visibleCodes.map((code) => (
                <code key={code}>{code}</code>
              ))}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void navigator.clipboard?.writeText(visibleCodes.join('\n'))}
              >
                Sao chép
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  clearPendingRecoveryCodes();
                  setFreshCodes(null);
                }}
              >
                Tôi đã lưu an toàn
              </button>
            </div>
          </div>
        </div>
      )}

      {/* E2EE Unlock Modal */}
      {showE2eeModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h2 style={{ marginTop: 0 }}>Mở khóa kho E2EE</h2>
            <p className="muted small">
              Khóa giải mã chỉ lưu tạm trong bộ nhớ thiết bị — máy chủ không bao giờ nhận mật khẩu này.
            </p>
            {e2eeError && <div className="alert error">{e2eeError}</div>}
            <form onSubmit={handleUnlockE2ee} className="stack">
              <label className="field">
                <span>Mật khẩu khóa E2EE</span>
                <input
                  type="password"
                  autoFocus
                  required
                  value={e2eeInput}
                  onChange={(e) => setE2eeInput(e.target.value)}
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowE2eeModal(false)}>
                  Đóng
                </button>
                <button type="submit" className="btn-primary">
                  Mở khóa
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Notifications Sheet */}
      {showNotifications && (
        <div className="modal-backdrop" onClick={() => setShowNotifications(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="panel-head-row">
              <h3>Thông báo ({unreadCount} mới)</h3>
              <div className="media-row-actions">
                <button
                  type="button"
                  className="btn-small"
                  onClick={async () => {
                    await api.markAllNotificationsRead();
                    await loadNotifications();
                  }}
                >
                  Đọc hết
                </button>
                <button type="button" className="btn-small" onClick={() => setShowNotifications(false)}>
                  ✕
                </button>
              </div>
            </div>
            <div className="device-list" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
              {notifications.length === 0 ? (
                <p className="muted small">Chưa có thông báo nào.</p>
              ) : (
                notifications.map((n) => (
                  <div key={n.id} className="queue-card" style={{ opacity: n.isRead ? 0.68 : 1 }}>
                    <div className="queue-top">
                      <strong>{n.title}</strong>
                      <span className="pill neutral">{n.category}</span>
                    </div>
                    <p className="muted small" style={{ margin: 0 }}>
                      {n.body}
                    </p>
                    <div className="muted tiny">{new Date(n.createdAt).toLocaleString('vi-VN')}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <main aria-label="Nội dung">
        {/* TAB 1: THƯ VIỆN (Kho Ảnh) */}
        {dockTab === 'library' && (
          <LibraryPanel
            refreshKey={libraryRefreshKey}
            filterContext={activeCollection}
            onClearFilterContext={
              activeCollection
                ? () => {
                    setActiveCollection(null);
                    setDockTab('albums');
                  }
                : undefined
            }
            onGoToUpload={() => {
              setDockTab('vault');
              setVaultSub('backup');
            }}
          />
        )}

        {/* TAB 2: ALBUM */}
        {dockTab === 'albums' && (
          <AlbumsHubPanel
            refreshKey={libraryRefreshKey}
            onOpenCollection={(ctx) => {
              setActiveCollection(ctx);
              setDockTab('library');
            }}
            onChanged={() => setLibraryRefreshKey((k) => k + 1)}
          />
        )}

        {/* TAB 3: KHO LƯU TRỮ (exact kho-anh.html grouped rows hub + drill-down screens) */}
        {dockTab === 'vault' && vaultSub === 'home' && (
          <>
            <header className="top">
              <div className="top-row">
                <h1>Kho lưu trữ</h1>
                <button
                  type="button"
                  className="round"
                  aria-label="Thông báo"
                  onClick={() => {
                    setShowNotifications(true);
                    void loadNotifications();
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                  </svg>
                  {unreadCount > 0 && (
                    <span className="badge-dot">{unreadCount > 9 ? '9+' : unreadCount}</span>
                  )}
                </button>
              </div>
              <p className="hint">{user?.email}</p>
            </header>

            {/* Primary Backup Action Group */}
            <div className="group-label">Sao lưu &amp; Khôi phục</div>
            <div className="rows vault-actions">
              <button type="button" className="row-btn vault-backup-action" onClick={() => setVaultSub('backup')}>
                <div>
                  <strong>Tải ảnh &amp; video lên kho</strong>
                  <div className="tiny muted">Giữ nguyên tệp gốc · Chỉ qua Wi-Fi</div>
                </div>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 16V4m-4 4 4-4 4 4M5 15v5h14v-5" />
                </svg>
              </button>
              <button type="button" className="row-btn" onClick={() => setVaultSub('restore')}>
                <div>
                  <strong>Khôi phục, Trùng lặp &amp; Thùng rác</strong>
                  <div className="tiny muted">Xuất ZIP không nén giữ cấu trúc thư mục</div>
                </div>
                <span className="row-right">Mở ›</span>
              </button>
            </div>

            {/* User-only account storage & encryption/policy summary */}
            <div className="group-label">Dung lượng &amp; Chính sách kho cá nhân</div>
            <div className="rows">
              <div className="row">
                <div>
                  <strong>Hạn mức tài khoản</strong>
                  <div className="tiny muted">
                    Đã dùng {safeFormatBytes(usedBytes)} trên {safeFormatBytes(quotaBytes)} ({usedPct}%)
                  </div>
                </div>
              </div>
              <div className="row">
                <strong>Chế độ mã hóa</strong>
                <small>
                  {user?.encryptionMode === 'e2ee'
                    ? 'E2EE (Khóa trên thiết bị)'
                    : 'Server-side Encryption'}
                </small>
              </div>
              <div className="row">
                <strong>Chính sách sao lưu</strong>
                <small>
                  {policies?.uploadNetworkPolicy === 'wifi_only' ? 'Chỉ Wi-Fi' : 'Chỉ Wi-Fi'} · Lưu giữ vô
                  thời hạn
                </small>
              </div>
            </div>

            {/* Security, E2EE, PIN, Devices & Server URL */}
            <div className="group-label">Bảo mật & Thiết bị</div>
            <div className="rows">
              {user?.encryptionMode === 'e2ee' && (
                <button
                  type="button"
                  className="row-btn"
                  onClick={() => (e2eeMasterKey ? lockE2eeVault() : setShowE2eeModal(true))}
                >
                  <strong>Khóa giải mã E2EE</strong>
                  <span className="row-right">
                    {e2eeMasterKey ? 'Đã mở khóa (Bấm để khóa)' : 'Đang khóa — Mở ›'}
                  </span>
                </button>
              )}
              <button type="button" className="row-btn" onClick={() => setVaultSub('security')}>
                <div>
                  <strong>Thiết bị, PIN, Mật khẩu & Máy chủ</strong>
                  <div className="tiny muted">
                    {devices.filter((d) => !d.revokedAt).length} thiết bị hoạt động ·{' '}
                    {pinEnabled ? 'Đã bật PIN' : 'Chưa đặt PIN'}
                  </div>
                </div>
                <span className="row-right">Mở ›</span>
              </button>
              <button type="button" className="row-btn" onClick={() => void logout()}>
                <strong style={{ color: 'var(--danger)' }}>Đăng xuất tài khoản</strong>
                <span className="row-right">›</span>
              </button>
            </div>
          </>
        )}

        {/* VAULT SUB-SCREEN: BACKUP */}
        {dockTab === 'vault' && vaultSub === 'backup' && (
          <>
            <header className="top">
              <div className="top-row">
                <button
                  type="button"
                  className="round"
                  aria-label="Quay lại"
                  onClick={() => setVaultSub('home')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m15 5-7 7 7 7" />
                  </svg>
                </button>
                <h1>Sao lưu</h1>
              </div>
              <p className="hint">Nguyên bản 100% · Chỉ Wi-Fi · Kiểm tra SHA-256</p>
            </header>
            <BackupPanel onUploadCompleted={() => setLibraryRefreshKey((k) => k + 1)} />
          </>
        )}

        {/* VAULT SUB-SCREEN: RESTORE & STORAGE */}
        {dockTab === 'vault' && vaultSub === 'restore' && (
          <>
            <header className="top">
              <div className="top-row">
                <button
                  type="button"
                  className="round"
                  aria-label="Quay lại"
                  onClick={() => setVaultSub('home')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m15 5-7 7 7 7" />
                  </svg>
                </button>
                <h1>Khôi phục</h1>
              </div>
              <p className="hint">Xuất ZIP không nén · Trùng lặp · Thùng rác</p>
            </header>
            <StorageAndRestorePanel onChanged={() => setLibraryRefreshKey((k) => k + 1)} />
          </>
        )}

        {/* VAULT SUB-SCREEN: SECURITY, DEVICES, PIN & SERVER URL */}
        {dockTab === 'vault' && vaultSub === 'security' && (
          <>
            <header className="top">
              <div className="top-row">
                <button
                  type="button"
                  className="round"
                  aria-label="Quay lại"
                  onClick={() => setVaultSub('home')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m15 5-7 7 7 7" />
                  </svg>
                </button>
                <h1>Bảo mật</h1>
              </div>
              <p className="hint">Thiết bị · Mã PIN · Đổi mật khẩu · Máy chủ</p>
            </header>

            {errorMsg && <div className="alert error">{errorMsg}</div>}
            {statusMsg && <div className="alert success">{statusMsg}</div>}

            <section className="panel stack">
              <h3>Địa chỉ Máy chủ (LAN / TV Box / Cloud)</h3>
              <div className="inline-form">
                <input
                  type="url"
                  value={serverUrlInput}
                  onChange={(e) => setServerUrlInput(e.target.value)}
                  placeholder="VD: http://192.168.1.52:3001"
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={async () => {
                    setServerBaseUrl(serverUrlInput);
                    const res = await checkServerHealth(serverUrlInput);
                    setServerStatus({ ok: res.ok, text: res.message });
                  }}
                >
                  Lưu & Kiểm tra kết nối
                </button>
              </div>
              {serverStatus && (
                <div className={`small ${serverStatus.ok ? 'ok-text' : 'error-text'}`}>
                  {serverStatus.text}
                </div>
              )}
            </section>

            <section className="panel stack">
              <h3>Khóa ứng dụng bằng PIN</h3>
              {pinEnabled ? (
                <div className="media-row-actions">
                  <span className="pill ok">Đang bật PIN</span>
                  <button type="button" className="btn-small" onClick={() => setAppLocked(true)}>
                    Khóa ngay
                  </button>
                  <button
                    type="button"
                    className="btn-small danger"
                    onClick={() => {
                      clearLocalAppPin();
                      setPinEnabled(false);
                      setStatusMsg('Đã tắt mã PIN trên thiết bị này.');
                    }}
                  >
                    Tắt PIN
                  </button>
                </div>
              ) : (
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (newPin.length < 4) {
                      setErrorMsg('Mã PIN cần tối thiểu 4 ký tự.');
                      return;
                    }
                    setLocalAppPin(newPin);
                    setPinEnabled(true);
                    setNewPin('');
                    setStatusMsg('Đã bật khóa PIN cục bộ.');
                  }}
                >
                  <input
                    type="password"
                    inputMode="numeric"
                    minLength={4}
                    maxLength={12}
                    placeholder="Nhập mã PIN mới (4–12 số)"
                    value={newPin}
                    onChange={(e) => setNewPin(e.target.value)}
                  />
                  <button type="submit" className="btn-primary">
                    Bật khóa PIN
                  </button>
                </form>
              )}
            </section>

            <section className="panel stack">
              <h3>Thiết bị đang liên kết ({devices.length})</h3>
              <div className="device-list">
                {devices.map((d) => (
                  <div key={d.id} className="device-row">
                    <div>
                      <strong>{d.deviceName}</strong>{' '}
                      {d.isCurrent && <span className="pill accent">Hiện tại</span>}
                      {d.isTrusted && !d.revokedAt && <span className="pill ok">Tin cậy</span>}
                      {d.revokedAt && <span className="pill danger">Đã thu hồi</span>}
                      <div className="muted tiny">
                        {d.platform} · {new Date(d.createdAt).toLocaleString('vi-VN')}
                      </div>
                    </div>
                    {!d.revokedAt && (
                      <div className="media-row-actions">
                        <button
                          type="button"
                          className="btn-small"
                          onClick={async () => {
                            await api.updateDeviceTrust(d.id, !d.isTrusted);
                            await loadVaultOverview();
                          }}
                        >
                          {d.isTrusted ? 'Bỏ tin cậy' : 'Tin cậy'}
                        </button>
                        <button
                          type="button"
                          className="btn-small danger"
                          onClick={async () => {
                            await api.revokeDevice(d.id);
                            setStatusMsg('Đã thu hồi thiết bị.');
                            await loadVaultOverview();
                          }}
                        >
                          Thu hồi
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="panel stack">
              <h3>Đổi mật khẩu đăng nhập</h3>
              <form
                className="stack"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setErrorMsg(null);
                  setStatusMsg(null);
                  try {
                    await api.changePassword(currentPassword, newPassword);
                    setCurrentPassword('');
                    setNewPassword('');
                    setStatusMsg('Đã đổi mật khẩu thành công.');
                  } catch (err) {
                    setErrorMsg(err instanceof ApiError ? err.message : 'Đổi mật khẩu thất bại');
                  }
                }}
              >
                <label className="field">
                  <span>Mật khẩu hiện tại</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Mật khẩu mới</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </label>
                <button type="submit" className="btn-primary">
                  Cập nhật mật khẩu
                </button>
              </form>
            </section>

            <section className="panel stack">
              <h3>Tạo lại 10 mã khôi phục</h3>
              <form
                className="inline-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setErrorMsg(null);
                  try {
                    const res = await api.regenerateRecoveryCodes(regenPassword);
                    setFreshCodes(res.recoveryCodes);
                    setRegenPassword('');
                  } catch (err) {
                    setErrorMsg(err instanceof ApiError ? err.message : 'Sai mật khẩu hiện tại');
                  }
                }}
              >
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  placeholder="Nhập mật khẩu hiện tại"
                  value={regenPassword}
                  onChange={(e) => setRegenPassword(e.target.value)}
                />
                <button type="submit" className="btn-secondary">
                  Sinh 10 mã mới
                </button>
              </form>
            </section>

            <div className="group-label">Nhật ký bảo mật gần đây</div>
            <div className="rows">
              {events.map((ev) => (
                <div key={ev.id} className="row">
                  <code>{ev.eventType}</code>
                  <small>{new Date(ev.createdAt).toLocaleString('vi-VN')}</small>
                </div>
              ))}
            </div>
          </>
        )}
      </main>

      {/* EXACT kho-anh.html FLOATING 3-TAB PILL DOCK */}
      <nav className="nav" aria-label="Điều hướng">
        <button
          type="button"
          aria-pressed={dockTab === 'library'}
          onClick={() => {
            setDockTab('library');
            setActiveCollection(null);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="m4 16 5-5 4 4 3-3 4 4" />
            <circle cx="15.5" cy="8.5" r="1" />
          </svg>
          Thư viện
        </button>

        <button
          type="button"
          aria-pressed={dockTab === 'albums'}
          onClick={() => {
            setDockTab('albums');
            setActiveCollection(null);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="6" width="14" height="14" rx="3" />
            <path d="M3 16V6a3 3 0 0 1 3-3h10m-7 12 3-3 4 4" />
          </svg>
          Album
        </button>

        <button
          type="button"
          aria-pressed={dockTab === 'vault'}
          onClick={() => {
            setDockTab('vault');
            setVaultSub('home');
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 18a4 4 0 0 1-1-8 7 7 0 0 1 13-1 4.5 4.5 0 0 1 0 9z" />
          </svg>
          Kho
        </button>
      </nav>
    </div>
  );
}

export { VaultShell as UserVaultShell };
