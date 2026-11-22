import React, { useState } from 'react';
import type { EncryptionMode } from '@smb/shared';
import {
  api,
  ApiError,
  checkServerHealth,
  getServerBaseUrl,
  isCapacitorNativeApp,
  setServerBaseUrl
} from '../api/client';
import { useAuth } from '../context/AuthContext';
import { createClientWrappedE2eeBundle, detectClientDevice } from '../utils/e2ee';

type AuthMode = 'login' | 'register' | 'recover';

export function AuthPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [encryptionMode, setEncryptionMode] = useState<EncryptionMode>('server_side');
  const [e2eePassphrase, setE2eePassphrase] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [showServerBox, setShowServerBox] = useState(() => isCapacitorNativeApp());
  const [serverInput, setServerInput] = useState(() => getServerBaseUrl());
  const [serverCheckMsg, setServerCheckMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [checkingServer, setCheckingServer] = useState(false);

  const handleSaveAndTestServer = async () => {
    setCheckingServer(true);
    setServerCheckMsg(null);
    setServerBaseUrl(serverInput);
    const res = await checkServerHealth(serverInput);
    setServerCheckMsg({ ok: res.ok, text: res.message });
    setCheckingServer(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setSubmitting(true);

    const detected = detectClientDevice();

    try {
      if (mode === 'login') {
        await login(email, password, detected.deviceName, detected.platform);
      } else if (mode === 'register') {
        let e2eePayload:
          | {
              e2eeKeySalt: string;
              e2eeEncryptedMasterKey: string;
              e2eeKdfParams: Record<string, unknown>;
            }
          | undefined;

        if (encryptionMode === 'e2ee') {
          if (e2eePassphrase.length < 10) {
            throw new Error('Khóa bảo mật E2EE cần tối thiểu 10 ký tự.');
          }
          e2eePayload = await createClientWrappedE2eeBundle(e2eePassphrase);
        }

        await register(
          {
            email,
            password,
            displayName,
            encryptionMode,
            deviceName: detected.deviceName,
            platform: detected.platform,
            ...e2eePayload
          },
          encryptionMode === 'e2ee' ? e2eePassphrase : undefined
        );
      } else {
        const res = await api.recover({
          email,
          recoveryCode,
          newPassword: password
        });
        setInfo(
          `${res.message} (Còn lại ${res.remainingRecoveryCodes} mã khôi phục chưa dùng.)`
        );
        setMode('login');
        setPassword('');
        setRecoveryCode('');
      }
    } catch (err) {
      if (err instanceof ApiError || err instanceof Error) {
        setError(err.message);
      } else {
        setError('Đã có lỗi xảy ra.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-layout">
      <div className="auth-card">
        <div className="brand-header">
          <img src="/icon.svg" alt="Kho Ảnh" className="brand-icon" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1>Kho Ảnh</h1>
            <p className="muted">Sao lưu ảnh & video nguyên bản 100% · Chỉ Wi-Fi</p>
          </div>
          <button
            type="button"
            className="btn-small"
            onClick={() => setShowServerBox((v) => !v)}
            title="Cấu hình địa chỉ máy chủ Backend"
          >
            Server
          </button>
        </div>

        {showServerBox && (
          <div className="server-config-box">
            <label className="field">
              <span>Địa chỉ máy chủ (LAN PC / TV Box / Cloud Render)</span>
              <input
                type="url"
                value={serverInput}
                onChange={(e) => setServerInput(e.target.value)}
                placeholder="VD: http://192.168.1.52:3001 hoặc https://your-api.onrender.com"
              />
            </label>
            <div className="media-row-actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn-small"
                disabled={checkingServer}
                onClick={() => void handleSaveAndTestServer()}
              >
                {checkingServer ? 'Đang kiểm tra...' : 'Lưu & Kiểm tra kết nối'}
              </button>
            </div>
            {serverCheckMsg && (
              <div
                className={`tiny ${serverCheckMsg.ok ? 'ok-text' : 'error-text'}`}
                style={{ marginTop: 6, overflowWrap: 'anywhere' }}
              >
                {serverCheckMsg.text}
              </div>
            )}
          </div>
        )}

        <div className="segmented-tabs" role="tablist">
          <button
            type="button"
            className={mode === 'login' ? 'active' : ''}
            onClick={() => {
              setMode('login');
              setError(null);
            }}
          >
            Đăng nhập
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'active' : ''}
            onClick={() => {
              setMode('register');
              setError(null);
            }}
          >
            Tạo tài khoản
          </button>
          <button
            type="button"
            className={mode === 'recover' ? 'active' : ''}
            onClick={() => {
              setMode('recover');
              setError(null);
            }}
          >
            Khôi phục
          </button>
        </div>

        {error && <div className="alert error">{error}</div>}
        {info && <div className="alert success">{info}</div>}

        <form onSubmit={handleSubmit} className="stack">
          {mode === 'register' && (
            <label className="field">
              <span>Tên hiển thị</span>
              <input
                type="text"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="VD: Đức Anh"
              />
            </label>
          )}

          <label className="field">
            <span>Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>

          {mode === 'recover' && (
            <label className="field">
              <span>Mã khôi phục (dùng 1 lần)</span>
              <input
                type="text"
                required
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                placeholder="XXXX-XXXX-XXXX"
              />
            </label>
          )}

          <label className="field">
            <span>{mode === 'recover' ? 'Mật khẩu đăng nhập mới' : 'Mật khẩu'}</span>
            <input
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Tối thiểu 8 ký tự"
            />
          </label>

          {mode === 'register' && (
            <div className="encryption-picker">
              <span className="field-label">Chế độ mã hóa kho (áp dụng theo tài khoản)</span>
              <div className="radio-cards">
                <label className={`radio-card ${encryptionMode === 'server_side' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="encryptionMode"
                    value="server_side"
                    checked={encryptionMode === 'server_side'}
                    onChange={() => setEncryptionMode('server_side')}
                  />
                  <div>
                    <strong>Server-side Encryption</strong>
                    <p className="muted small">
                      Mã hóa khi lưu trữ. Thuận tiện xem preview/streaming và khôi phục nhanh.
                    </p>
                  </div>
                </label>

                <label className={`radio-card ${encryptionMode === 'e2ee' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="encryptionMode"
                    value="e2ee"
                    checked={encryptionMode === 'e2ee'}
                    onChange={() => setEncryptionMode('e2ee')}
                  />
                  <div>
                    <strong>End-to-End Encryption (E2EE)</strong>
                    <p className="muted small">
                      Mã hóa trên thiết bị trước khi tải lên. Server không có khóa giải mã.
                    </p>
                  </div>
                </label>
              </div>

              {encryptionMode === 'e2ee' && (
                <label className="field" style={{ marginTop: 12 }}>
                  <span>Mật khẩu khóa kho E2EE (tạo & bọc khóa cục bộ trên máy bạn)</span>
                  <input
                    type="password"
                    required
                    minLength={10}
                    value={e2eePassphrase}
                    onChange={(e) => setE2eePassphrase(e.target.value)}
                    placeholder="Tối thiểu 10 ký tự — hãy ghi nhớ cẩn thận!"
                  />
                </label>
              )}
            </div>
          )}

          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting
              ? 'Đang xử lý...'
              : mode === 'login'
                ? 'Đăng nhập'
                : mode === 'register'
                  ? 'Tạo tài khoản & nhận mã khôi phục'
                  : 'Đặt lại mật khẩu'}
          </button>
        </form>

        <p className="footnote muted">
          Đăng ký công khai luôn tạo tài khoản người dùng tiêu chuẩn (<code>user</code>) cho Kho Ảnh cá nhân.
          Mọi kho media đều cô lập tuyệt đối theo tài khoản.
        </p>
      </div>
    </div>
  );
}
