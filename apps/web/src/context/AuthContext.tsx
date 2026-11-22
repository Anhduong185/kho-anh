import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { E2eeKeyBundle, RegisterRequest, UserProfile } from '@smb/shared';
import { api, loadStoredTokens, saveStoredTokens, type MeResponse } from '../api/client';
import { clearLocalAppPin, hasAppPinConfigured, unlockE2eeMasterKey } from '../utils/e2ee';

const E2EE_BUNDLE_STORAGE_KEY = 'smb_e2ee_bundle_v1';

interface AuthContextValue {
  user: UserProfile | null;
  policies: MeResponse['policies'] | null;
  loading: boolean;
  pendingRecoveryCodes: string[] | null;
  clearPendingRecoveryCodes: () => void;
  e2eeKeyBundle: E2eeKeyBundle | null;
  e2eeMasterKey: CryptoKey | null;
  unlockE2eeVault: (passphrase: string) => Promise<void>;
  lockE2eeVault: () => void;
  appLocked: boolean;
  setAppLocked: (locked: boolean) => void;
  login: (
    email: string,
    password: string,
    deviceName?: string,
    platform?: RegisterRequest['platform']
  ) => Promise<void>;
  register: (payload: RegisterRequest, e2eePassphrase?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function loadStoredE2eeBundle(): E2eeKeyBundle | null {
  try {
    const raw = localStorage.getItem(E2EE_BUNDLE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as E2eeKeyBundle) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [policies, setPolicies] = useState<MeResponse['policies'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingRecoveryCodes, setPendingRecoveryCodes] = useState<string[] | null>(null);
  const [e2eeKeyBundle, setE2eeKeyBundle] = useState<E2eeKeyBundle | null>(() =>
    loadStoredE2eeBundle()
  );
  const [e2eeMasterKey, setE2eeMasterKey] = useState<CryptoKey | null>(null);
  const [appLocked, setAppLocked] = useState<boolean>(() => hasAppPinConfigured());

  const refreshProfile = useCallback(async () => {
    const tokens = loadStoredTokens();
    if (!tokens) {
      setUser(null);
      setPolicies(null);
      setLoading(false);
      return;
    }

    try {
      const data = await api.me();
      setUser(data.user);
      setPolicies(data.policies);
    } catch {
      saveStoredTokens(null);
      setUser(null);
      setPolicies(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProfile();
  }, [refreshProfile]);

  const unlockE2eeVault = useCallback(
    async (passphrase: string) => {
      if (!e2eeKeyBundle) {
        throw new Error('Chưa có gói khóa E2EE cục bộ — hãy đăng xuất và đăng nhập lại.');
      }
      const key = await unlockE2eeMasterKey(passphrase, e2eeKeyBundle);
      setE2eeMasterKey(key);
    },
    [e2eeKeyBundle]
  );

  const lockE2eeVault = useCallback(() => {
    setE2eeMasterKey(null);
  }, []);

  const login = useCallback(
    async (
      email: string,
      password: string,
      deviceName?: string,
      platform?: RegisterRequest['platform']
    ) => {
      const res = await api.login({ email, password, deviceName, platform });
      saveStoredTokens(res.tokens);
      if (res.e2eeKeyBundle) {
        localStorage.setItem(E2EE_BUNDLE_STORAGE_KEY, JSON.stringify(res.e2eeKeyBundle));
        setE2eeKeyBundle(res.e2eeKeyBundle);
      } else {
        localStorage.removeItem(E2EE_BUNDLE_STORAGE_KEY);
        setE2eeKeyBundle(null);
      }
      setE2eeMasterKey(null);
      setAppLocked(false);
      const me = await api.me();
      setUser(me.user);
      setPolicies(me.policies);
    },
    []
  );

  const register = useCallback(async (payload: RegisterRequest, e2eePassphrase?: string) => {
    const res = await api.register(payload);
    saveStoredTokens(res.tokens);
    setPendingRecoveryCodes(res.recoveryCodes);

    if (
      payload.encryptionMode === 'e2ee' &&
      payload.e2eeKeySalt &&
      payload.e2eeEncryptedMasterKey
    ) {
      const bundle: E2eeKeyBundle = {
        keySalt: payload.e2eeKeySalt,
        encryptedMasterKey: payload.e2eeEncryptedMasterKey,
        kdfParams: payload.e2eeKdfParams ?? {}
      };
      localStorage.setItem(E2EE_BUNDLE_STORAGE_KEY, JSON.stringify(bundle));
      setE2eeKeyBundle(bundle);
      if (e2eePassphrase) {
        const key = await unlockE2eeMasterKey(e2eePassphrase, bundle).catch(() => null);
        setE2eeMasterKey(key);
      }
    }

    setAppLocked(false);
    const me = await api.me();
    setUser(me.user);
    setPolicies(me.policies);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Ignore network error on logout
    } finally {
      saveStoredTokens(null);
      localStorage.removeItem(E2EE_BUNDLE_STORAGE_KEY);
      clearLocalAppPin();
      setAppLocked(false);
      setUser(null);
      setPolicies(null);
      setE2eeKeyBundle(null);
      setE2eeMasterKey(null);
      setPendingRecoveryCodes(null);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        policies,
        loading,
        pendingRecoveryCodes,
        clearPendingRecoveryCodes: () => setPendingRecoveryCodes(null),
        e2eeKeyBundle,
        e2eeMasterKey,
        unlockE2eeVault,
        lockE2eeVault,
        appLocked,
        setAppLocked,
        login,
        register,
        logout,
        refreshProfile
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
