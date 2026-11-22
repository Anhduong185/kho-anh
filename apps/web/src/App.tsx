import React, { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AdminShell } from './pages/AdminShell';
import { AuthPage } from './pages/AuthPage';
import { VaultShell } from './pages/VaultShell';
import { hasAppPinConfigured, verifyLocalAppPin } from './utils/e2ee';

function AppRoutes() {
  const { user, loading, appLocked, setAppLocked, logout } = useAuth();
  const [privacyBlur, setPrivacyBlur] = useState(false);
  const [pinEntry, setPinEntry] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        setPrivacyBlur(true);
        if (hasAppPinConfigured()) {
          setAppLocked(true);
        }
      } else {
        setPrivacyBlur(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [setAppLocked]);

  if (loading) {
    return (
      <div className="loading-screen">
        <img src="/icon.svg" alt="Vault Photos" className="brand-icon" />
        <p className="muted">Đang kết nối kho bảo mật...</p>
      </div>
    );
  }

  if (!user) {
    return <AuthPage />;
  }

  if (appLocked && hasAppPinConfigured()) {
    const handleUnlockPin = (e: React.FormEvent) => {
      e.preventDefault();
      if (verifyLocalAppPin(pinEntry)) {
        setAppLocked(false);
        setPinEntry('');
        setPinError(null);
      } else {
        setPinError('Sai mã PIN ứng dụng.');
      }
    };

    return (
      <div className="auth-layout">
        <div className="auth-card" style={{ maxWidth: 380 }}>
          <div className="brand-header">
            <img src="/icon.svg" alt="Kho Ảnh" className="brand-icon" />
            <div>
              <h1>Kho Ảnh đang khóa</h1>
              <p className="muted">Nhập mã PIN để tiếp tục</p>
            </div>
          </div>
          {pinError && <div className="alert error">{pinError}</div>}
          <form onSubmit={handleUnlockPin} className="stack">
            <label className="field">
              <span>Mã PIN</span>
              <input
                type="password"
                inputMode="numeric"
                autoFocus
                required
                value={pinEntry}
                onChange={(e) => setPinEntry(e.target.value)}
                placeholder="••••••"
              />
            </label>
            <button type="submit" className="btn-primary">
              Mở khóa
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setPinEntry('');
                setPinError(null);
                void logout();
              }}
            >
              Đăng xuất
            </button>
          </form>
        </div>
      </div>
    );
  }

  const isAdmin = user.roles.includes('admin');

  return (
    <div className={privacyBlur ? 'privacy-blurred' : undefined}>
      {isAdmin ? <AdminShell /> : <VaultShell />}
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
