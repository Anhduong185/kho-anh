import type { Page } from '@playwright/test';

export interface MockNativeAssetInput {
  assetId: string;
  albumId: string;
  albumName: string;
  filename: string;
  mimeType: string;
  mediaKind: 'image' | 'video';
  bytes: Buffer;
  capturedAt?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface MockNetworkStatus {
  connected: boolean;
  type: 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown';
  isWifi: boolean;
}

export interface MockPermissionStatus {
  granted: boolean;
  accessLevel: 'all' | 'limited' | 'denied';
}

export interface VaultMediaMockOptions {
  network?: MockNetworkStatus;
  permission?: MockPermissionStatus;
  assets: MockNativeAssetInput[];
}

export interface SavedToGalleryRecord {
  assetId: string;
  filename: string;
  mimeType: string;
  mediaKind: 'image' | 'video';
  dataBase64: string;
  sha256: string;
  sizeBytes: number;
}

export interface NativeMockCallRecord {
  method: string;
  args: unknown;
}

export async function injectVaultNativeMock(page: Page, opts: VaultMediaMockOptions): Promise<void> {
  const serializedAssets = opts.assets.map((a) => ({
    assetId: a.assetId,
    albumId: a.albumId,
    albumName: a.albumName,
    filename: a.filename,
    mimeType: a.mimeType,
    mediaKind: a.mediaKind,
    dataBase64: a.bytes.toString('base64'),
    sizeBytes: a.bytes.length,
    capturedAt: a.capturedAt ?? '2026-11-22T05:00:00.000Z',
    width: a.width ?? (a.mediaKind === 'image' ? 4 : 1280),
    height: a.height ?? (a.mediaKind === 'image' ? 4 : 720),
    durationMs: a.durationMs ?? (a.mediaKind === 'video' ? 1500 : undefined)
  }));

  const initialNetwork: MockNetworkStatus = opts.network ?? {
    connected: true,
    type: 'wifi',
    isWifi: true
  };
  const initialPermission: MockPermissionStatus = opts.permission ?? {
    granted: true,
    accessLevel: 'all'
  };

  await page.addInitScript(
    ({ assetsInput, networkInput, permissionInput }) => {
      function b64ToBytes(b64: string): Uint8Array {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
          out[i] = bin.charCodeAt(i);
        }
        return out;
      }

      function bytesToB64(bytes: Uint8Array): string {
        let bin = '';
        for (let i = 0; i < bytes.length; i++) {
          bin += String.fromCharCode(bytes[i]!);
        }
        return btoa(bin);
      }

      async function sha256HexBrowser(bytes: Uint8Array): Promise<string> {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
        const arr = new Uint8Array(digest);
        let hex = '';
        for (let i = 0; i < arr.length; i++) {
          hex += arr[i]!.toString(16).padStart(2, '0');
        }
        return hex;
      }

      const assetBytesMap = new Map<string, Uint8Array>();
      for (const a of assetsInput) {
        assetBytesMap.set(a.assetId, b64ToBytes(a.dataBase64));
      }

      const state = {
        network: { ...networkInput },
        permission: { ...permissionInput },
        assets: assetsInput.map((a) => ({
          id: a.assetId,
          assetId: a.assetId,
          albumId: a.albumId,
          albumName: a.albumName,
          filename: a.filename,
          mimeType: a.mimeType,
          mediaKind: a.mediaKind,
          sizeBytes: a.sizeBytes,
          capturedAt: a.capturedAt,
          width: a.width,
          height: a.height,
          durationMs: a.durationMs
        })),
        savedToGallery: [] as Array<{
          assetId: string;
          filename: string;
          mimeType: string;
          mediaKind: 'image' | 'video';
          dataBase64: string;
          sha256: string;
          sizeBytes: number;
        }>,
        callLog: [] as Array<{ method: string; args: unknown }>
      };

      const plugin = {
        async getNetworkStatus() {
          state.callLog.push({ method: 'getNetworkStatus', args: null });
          return { ...state.network };
        },

        async checkAndRequestMediaPermissions() {
          state.callLog.push({ method: 'checkAndRequestMediaPermissions', args: null });
          return { ...state.permission };
        },

        async listDeviceAlbums() {
          state.callLog.push({ method: 'listDeviceAlbums', args: null });
          const counts = new Map<string, { id: string; name: string; count: number }>();
          for (const item of state.assets) {
            const cur = counts.get(item.albumId);
            if (cur) {
              cur.count += 1;
            } else {
              counts.set(item.albumId, { id: item.albumId, name: item.albumName, count: 1 });
            }
          }
          return { albums: [...counts.values()] };
        },

        async scanDeviceMedia(scanOpts?: { albumId?: string; limit?: number; offset?: number }) {
          state.callLog.push({ method: 'scanDeviceMedia', args: scanOpts ?? {} });
          const albumId = scanOpts?.albumId;
          const filtered =
            albumId && albumId !== 'all'
              ? state.assets.filter((a) => a.albumId === albumId)
              : state.assets;
          const offset = Math.max(0, scanOpts?.offset ?? 0);
          const limit = Math.max(1, scanOpts?.limit ?? filtered.length);
          const items = filtered.slice(offset, offset + limit);
          return { items, total: filtered.length };
        },

        async getAssetThumbnail(req: { assetId: string }) {
          state.callLog.push({ method: 'getAssetThumbnail', args: req });
          if (!assetBytesMap.has(req.assetId)) return {};
          const canvas = document.createElement('canvas');
          canvas.width = 16;
          canvas.height = 16;
          const dataBase64 = canvas.toDataURL('image/jpeg').split(',')[1];
          return { dataBase64 };
        },

        async computeAssetSha256(req: { assetId: string }) {
          state.callLog.push({ method: 'computeAssetSha256', args: req });
          const bytes = assetBytesMap.get(req.assetId);
          if (!bytes) {
            throw new Error(`Mock native asset not found: ${req.assetId}`);
          }
          const sha256 = await sha256HexBrowser(bytes);
          return { sha256, sizeBytes: bytes.length };
        },

        async readAssetSlice(req: { assetId: string; offset: number; length: number }) {
          state.callLog.push({ method: 'readAssetSlice', args: req });
          const bytes = assetBytesMap.get(req.assetId);
          if (!bytes) {
            throw new Error(`Mock native asset not found: ${req.assetId}`);
          }
          const start = Math.max(0, req.offset);
          const end = Math.min(bytes.length, start + Math.max(0, req.length));
          const slice = bytes.subarray(start, end);
          return {
            dataBase64: bytesToB64(slice),
            bytesRead: slice.length
          };
        },

        async saveOriginalToGallery(req: {
          filename: string;
          mimeType: string;
          mediaKind: 'image' | 'video';
          dataBase64: string;
        }) {
          state.callLog.push({
            method: 'saveOriginalToGallery',
            args: { filename: req.filename, mimeType: req.mimeType, mediaKind: req.mediaKind }
          });
          const bytes = b64ToBytes(req.dataBase64);
          const sha256 = await sha256HexBrowser(bytes);
          const assetId = `saved-${state.savedToGallery.length + 1}`;
          state.savedToGallery.push({
            assetId,
            filename: req.filename,
            mimeType: req.mimeType,
            mediaKind: req.mediaKind,
            dataBase64: req.dataBase64,
            sha256,
            sizeBytes: bytes.length
          });
          return { saved: true, assetId };
        }
      };

      const win = window as unknown as Record<string, unknown>;
      win.__VAULT_NATIVE_MOCK__ = plugin;
      win.__VAULT_NATIVE_MOCK_STATE__ = {
        setNetwork(next: Partial<MockNetworkStatus>) {
          state.network = { ...state.network, ...next };
        },
        setPermission(next: Partial<MockPermissionStatus>) {
          state.permission = { ...state.permission, ...next };
        },
        getSavedToGallery() {
          return [...state.savedToGallery];
        },
        getAssets() {
          return [...state.assets];
        },
        getCallLog() {
          return [...state.callLog];
        }
      };
    },
    { assetsInput: serializedAssets, networkInput: initialNetwork, permissionInput: initialPermission }
  );
}

export async function setMockNetwork(page: Page, status: MockNetworkStatus): Promise<void> {
  await page.evaluate((s) => {
    const win = window as unknown as {
      __VAULT_NATIVE_MOCK_STATE__?: { setNetwork: (n: MockNetworkStatus) => void };
    };
    win.__VAULT_NATIVE_MOCK_STATE__?.setNetwork(s);
  }, status);
}

export async function getSavedToGallery(page: Page): Promise<SavedToGalleryRecord[]> {
  return page.evaluate(() => {
    const win = window as unknown as {
      __VAULT_NATIVE_MOCK_STATE__?: { getSavedToGallery: () => SavedToGalleryRecord[] };
    };
    return win.__VAULT_NATIVE_MOCK_STATE__?.getSavedToGallery() ?? [];
  });
}

export async function getNativeAssets(page: Page): Promise<Array<{ assetId: string; filename: string }>> {
  return page.evaluate(() => {
    const win = window as unknown as {
      __VAULT_NATIVE_MOCK_STATE__?: { getAssets: () => Array<{ assetId: string; filename: string }> };
    };
    return win.__VAULT_NATIVE_MOCK_STATE__?.getAssets() ?? [];
  });
}

export async function getNativeCallLog(page: Page): Promise<NativeMockCallRecord[]> {
  return page.evaluate(() => {
    const win = window as unknown as {
      __VAULT_NATIVE_MOCK_STATE__?: { getCallLog: () => NativeMockCallRecord[] };
    };
    return win.__VAULT_NATIVE_MOCK_STATE__?.getCallLog() ?? [];
  });
}
