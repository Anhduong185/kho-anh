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
import { clearLocalAppPin, hasAppPinConfigured, setLocalAppPin } from '../utils/e2ee';
import { AdminPanel } from './AdminPanel';
import { CloudStorageConfigurator } from './CloudStorageConfigurator';

type AdminTab = 'overview' | 'pool' | 'security';

export function AdminShell() {
  const { user, pendingRecoveryCodes, clearPendingRecoveryCodes, setAppLocked, logout } =
    useAuth();

  const [tab, setTab] = useState<AdminTab>('overview');
  const [poolRefreshKey, setPoolRefreshKey] = useState(0);

  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [events, setEvents] = useState<SecurityEventItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotifications, setShowNotifications] = useState(false);

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
      // ignore notification fetch failure
    }
  }, []);

  const loadAccountSecurity = useCallback(async () => {
    try {
      const [devRes, evRes] = await Promise.all([api.listDevices(), api.securityEvents()]);
      setDevices(devRes.devices);
      setEvents(evRes.events);
    } catch {
      // ignore security overview fetch failure
    }
  }, []);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications, poolRefreshKey]);

  useEffect(() => {
    if (tab === 'security') {
      void loadAccountSecurity();
    }
  }, [tab, loadAccountSecurity]);

  const visibleCodes = pendingRecoveryCodes ?? freshCodes;

  const renderNotificationsButton = () => (
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
      {unreadCount > 0 && <span className="badge-dot">{unreadCount > 9 ? '9+' : unreadCount}</span>}
    </button>
  );

  return (
    <div className="app">
      {/* One-time Recovery Codes Modal */}
      {visibleCodes && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h2 style={{ marginTop: 0 }}>Lưu lại 10 mã khôi phục</h2>
            <p className="muted small">
              Chỉ hiển thị <strong>một lần duy nhất</strong>. Hãy cất ở nơi an toàn ngoài thiết bị quản trị.
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

      {/* Account-Scoped Notifications Sheet */}
      {showNotifications && (
        <div className="modal-backdrop" onClick={() => setShowNotifications(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="panel-head-row">
              <h3>Thông báo hệ thống ({unreadCount} mới)</h3>
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

      <main aria-label="Khu vực Quản trị Hệ thống">
        {tab === 'overview' && (
          <>
            <header className="top">
              <div className="top-row">
                <h1>Tổng quan &amp; Người dùng</h1>
                <span className="admin-badge">ADMIN</span>
                {renderNotificationsButton()}
              </div>
              <p className="hint">
                Khu vực Quản trị Hệ thống · {user?.displayName} ({user?.email})
              </p>
            </header>
            <AdminPanel
              includeStoragePool={false}
              refreshKey={poolRefreshKey}
              currentUserId={user?.id}
            />
          </>
        )}

        {tab === 'pool' && (
          <>
            <header className="top">
              <div className="top-row">
                <h1>Nguồn lưu trữ &amp; Pool</h1>
                <span className="admin-badge">ADMIN</span>
                {renderNotificationsButton()}
              </div>
              <p className="hint">Multi-Cloud Auto-Sharding · Lưu trữ vượt 10 GB · 3 Bản sao</p>
            </header>
            <div className="stack-lg">
              <div className="privacy-banner">
                <strong>Ranh giới quyền riêng tư Admin (PRD 4.3):</strong> Quản trị viên chỉ cấu hình
                node lưu trữ, dung lượng Pool và theo dõi sức khỏe hạ tầng — không thể truy cập tệp
                media cá nhân hay khóa E2EE của bất kỳ User nào.
              </div>
              <CloudStorageConfigurator onUpdated={() => setPoolRefreshKey((k) => k + 1)} />
            </div>
          </>
        )}

        {tab === 'security' && (
          <>
            <header className="top">
              <div className="top-row">
                <h1>Bảo mật &amp; Tài khoản</h1>
                <span className="admin-badge">ADMIN</span>
                {renderNotificationsButton()}
              </div>
              <p className="hint">Tài khoản quản trị · Thiết bị · Mã PIN · Đổi mật khẩu · Máy chủ</p>
            </header>

            {errorMsg && <div className="alert error">{errorMsg}</div>}
            {statusMsg && <div className="alert success">{statusMsg}</div>}

            <section className="panel stack">
              <h3>Thông tin tài khoản quản trị</h3>
              <div className="rows" style={{ margin: 0 }}>
                <div className="row">
                  <strong>{user?.displayName}</strong>
                  <small>{user?.email}</small>
                </div>
                <div className="row">
                  <span>Vai trò hệ thống</span>
                  <div>
                    {(user?.roles ?? []).map((role) => (
                      <span
                        key={role}
                        className={`pill ${role === 'admin' ? 'accent' : 'neutral'}`}
                      >
                        {role}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                Tài khoản quản trị tách biệt hoàn toàn khỏi Kho Ảnh cá nhân và không có quyền truy cập
                ảnh/video hay khóa E2EE của người dùng.
              </p>
              <button
                type="button"
                className="btn-secondary"
                style={{ color: 'var(--danger)' }}
                onClick={() => void logout()}
              >
                Đăng xuất tài khoản
              </button>
            </section>

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
                  Lưu &amp; Kiểm tra kết nối
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
                      setErrorMsg(null);
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
                    setErrorMsg(null);
                    setStatusMsg(null);
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
                            setErrorMsg(null);
                            try {
                              await api.updateDeviceTrust(d.id, !d.isTrusted);
                              await loadAccountSecurity();
                            } catch (err) {
                              setErrorMsg(
                                err instanceof ApiError
                                  ? err.message
                                  : 'Không cập nhật được trạng thái tin cậy thiết bị.'
                              );
                            }
                          }}
                        >
                          {d.isTrusted ? 'Bỏ tin cậy' : 'Tin cậy'}
                        </button>
                        <button
                          type="button"
                          className="btn-small danger"
                          onClick={async () => {
                            setErrorMsg(null);
                            setStatusMsg(null);
                            try {
                              await api.revokeDevice(d.id);
                              setStatusMsg('Đã thu hồi thiết bị.');
                              await loadAccountSecurity();
                            } catch (err) {
                              setErrorMsg(
                                err instanceof ApiError ? err.message : 'Không thể thu hồi thiết bị.'
                              );
                            }
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

      <nav className="nav admin-nav" aria-label="Điều hướng quản trị">
        <button
          type="button"
          aria-label="Tổng quan & Người dùng"
          aria-pressed={tab === 'overview'}
          onClick={() => setTab('overview')}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          Người dùng
        </button>

        <button
          type="button"
          aria-label="Nguồn lưu trữ & Pool"
          aria-pressed={tab === 'pool'}
          onClick={() => setTab('pool')}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
          </svg>
          Kho Pool
        </button>

        <button
          type="button"
          aria-label="Bảo mật & Tài khoản"
          aria-pressed={tab === 'security'}
          onClick={() => setTab('security')}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          Bảo mật
        </button>
      </nav>
    </div>
  );
}
