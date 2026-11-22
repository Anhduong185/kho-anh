import { Capacitor, registerPlugin } from '@capacitor/core';
import type {
  DeviceAlbumInfo,
  MediaKind,
  MediaPermissionStatus,
  NativeMediaAsset,
  VaultMediaBridge,
  VaultNetworkStatus
} from '@smb/shared';

const CapacitorVaultMedia = registerPlugin<VaultMediaBridge>('VaultMedia');

interface WindowWithVaultMock {
  __VAULT_NATIVE_MOCK__?: VaultMediaBridge;
}

function getActiveNativeBridge(): VaultMediaBridge | null {
  if (typeof window !== 'undefined') {
    const mock = (window as unknown as WindowWithVaultMock).__VAULT_NATIVE_MOCK__;
    if (mock) {
      return mock;
    }
  }
  if (Capacitor.isNativePlatform()) {
    return CapacitorVaultMedia;
  }
  return null;
}

export function isNativeMediaBridgeAvailable(): boolean {
  return getActiveNativeBridge() !== null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    let bin = '';
    for (let j = 0; j < sub.length; j++) {
      bin += String.fromCharCode(sub[j]!);
    }
    parts.push(bin);
  }
  return btoa(parts.join(''));
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function getWebNetworkStatus(): VaultNetworkStatus {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { connected: false, type: 'none', isWifi: false };
  }
  const nav =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { connection?: { type?: string } })
      : undefined;
  const connType = nav?.connection?.type;
  if (connType === 'cellular') {
    return { connected: true, type: 'cellular', isWifi: false };
  }
  if (connType === 'wifi') {
    return { connected: true, type: 'wifi', isWifi: true };
  }
  if (connType === 'ethernet') {
    return { connected: true, type: 'ethernet', isWifi: true };
  }
  if (connType === 'none') {
    return { connected: false, type: 'none', isWifi: false };
  }
  return { connected: true, type: 'unknown', isWifi: false };
}

export interface UnifiedVaultMedia extends VaultMediaBridge {
  isNative(): boolean;
  getAssetThumbnail(opts: { assetId: string }): Promise<{ dataBase64?: string }>;
  scanDeviceMedia(opts?: {
    albumId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: NativeMediaAsset[]; total: number }>;
}

export const vaultMedia: UnifiedVaultMedia = {
  isNative(): boolean {
    return getActiveNativeBridge() !== null;
  },

  async getNetworkStatus(): Promise<VaultNetworkStatus> {
    const bridge = getActiveNativeBridge();
    if (bridge) {
      return bridge.getNetworkStatus();
    }
    return getWebNetworkStatus();
  },

  async checkAndRequestMediaPermissions(): Promise<MediaPermissionStatus> {
    const bridge = getActiveNativeBridge();
    if (bridge) {
      return bridge.checkAndRequestMediaPermissions();
    }
    return { granted: false, accessLevel: 'denied' };
  },

  async listDeviceAlbums(): Promise<{ albums: DeviceAlbumInfo[] }> {
    const bridge = getActiveNativeBridge();
    if (bridge) {
      return bridge.listDeviceAlbums();
    }
    return { albums: [] };
  },

  async scanDeviceMedia(opts: {
    albumId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ items: NativeMediaAsset[]; total: number }> {
    const bridge = getActiveNativeBridge();
    if (bridge) {
      return bridge.scanDeviceMedia(opts);
    }
    return { items: [], total: 0 };
  },

  async getAssetThumbnail(opts: { assetId: string }): Promise<{ dataBase64?: string }> {
    return (await getActiveNativeBridge()?.getAssetThumbnail?.(opts)) ?? {};
  },

  async computeAssetSha256(opts: {
    assetId: string;
  }): Promise<{ sha256: string; sizeBytes: number }> {
    const bridge = getActiveNativeBridge();
    if (bridge) {
      return bridge.computeAssetSha256(opts);
    }
    throw new Error('computeAssetSha256 is only supported in native or mock environments.');
  },

  async readAssetSlice(opts: {
    assetId: string;
    offset: number;
    length: number;
  }): Promise<{ dataBase64: string; bytesRead: number }> {
    const bridge = getActiveNativeBridge();
    if (bridge) {
      return bridge.readAssetSlice(opts);
    }
    throw new Error('readAssetSlice is only supported in native or mock environments.');
  },

  async saveOriginalToGallery(opts: {
    filename: string;
    mimeType: string;
    mediaKind: MediaKind;
    dataBase64: string;
  }): Promise<{ saved: boolean; assetId?: string }> {
    const bridge = getActiveNativeBridge();
    if (bridge) {
      return bridge.saveOriginalToGallery(opts);
    }
    const bytes = base64ToBytes(opts.dataBase64);
    const blob = new Blob([bytes as unknown as BlobPart], {
      type: opts.mimeType || 'application/octet-stream'
    });
    triggerBlobDownload(blob, opts.filename);
    return { saved: true };
  }
};
