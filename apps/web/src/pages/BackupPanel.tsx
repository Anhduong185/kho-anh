import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  classifyMediaFormat,
  type DeviceAlbumInfo,
  type MediaPermissionStatus,
  type NativeMediaAsset,
  type VaultNetworkStatus
} from '@smb/shared';
import { api, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { base64ToBytes, vaultMedia } from '../native/vaultMedia';
import { encryptFileForE2ee, formatBytes } from '../utils/e2ee';
import { sha256Bytes, sha256FileStreaming } from '../utils/sha256';

type QueueStatus =
  | 'queued'
  | 'hashing'
  | 'duplicate_prompt'
  | 'uploading'
  | 'paused'
  | 'verifying'
  | 'done'
  | 'skipped'
  | 'failed';

interface QueueItem {
  id: string;
  file: File;
  mediaKind: 'image' | 'video';
  status: QueueStatus;
  progress: number;
  sha256?: string;
  sessionId?: string;
  resumed?: boolean;
  uploadedParts: number;
  totalParts: number;
  allowDuplicate?: boolean;
  duplicateOf?: { mediaId: string; originalFilename: string; createdAt: string };
  notice?: string;
  error?: string;
}

type NativeSyncState =
  | 'checking'
  | 'backed_up'
  | 'unbacked'
  | 'uploading'
  | 'verifying'
  | 'done'
  | 'failed';

interface NativeGalleryItem {
  asset: NativeMediaAsset;
  mediaKind: 'image' | 'video';
  sha256?: string;
  syncState: NativeSyncState;
  resumable?: boolean;
  progress: number;
  uploadedParts: number;
  totalParts: number;
  notice?: string;
  error?: string;
}

const CHUNK_SIZE_BYTES = 2 * 1024 * 1024; // 2 MiB chunks for resumable upload
const GALLERY_PAGE_SIZE = 50;

interface NetworkConnectionLike {
  type?: string;
  addEventListener?: (name: string, fn: () => void) => void;
  removeEventListener?: (name: string, fn: () => void) => void;
}

function getE2eeSyncedCacheKey(userId: string | undefined): string {
  return `smb_e2ee_synced_hashes_v1:${userId ?? 'anon'}`;
}

function readE2eeSyncedHashes(userId: string | undefined): Set<string> {
  try {
    const raw = localStorage.getItem(getE2eeSyncedCacheKey(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function rememberE2eeSyncedHash(userId: string | undefined, sha256: string): void {
  try {
    const existing = readE2eeSyncedHashes(userId);
    existing.add(sha256);
    const trimmed = [...existing].slice(-500);
    localStorage.setItem(getE2eeSyncedCacheKey(userId), JSON.stringify(trimmed));
  } catch {
    // ignore quota errors
  }
}

function sortNativeForSmartBackup(items: NativeGalleryItem[]): NativeGalleryItem[] {
  // PRD 3.1 Smart Prioritization: prioritize photos / smaller files (<25 MB) before large videos
  return [...items].sort((a, b) => {
    const aSmall = a.asset.sizeBytes < 25 * 1024 * 1024 ? 0 : 1;
    const bSmall = b.asset.sizeBytes < 25 * 1024 * 1024 ? 0 : 1;
    if (aSmall !== bSmall) return aSmall - bSmall;
    if (a.mediaKind !== b.mediaKind) return a.mediaKind === 'image' ? -1 : 1;
    return a.asset.sizeBytes - b.asset.sizeBytes;
  });
}

async function readNativeAssetAllBytes(assetId: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let total = 0;
  while (true) {
    const res = await vaultMedia.readAssetSlice({
      assetId,
      offset,
      length: CHUNK_SIZE_BYTES
    });
    if (!res.bytesRead || !res.dataBase64) break;
    const bytes = base64ToBytes(res.dataBase64);
    if (bytes.length === 0) break;
    chunks.push(bytes);
    offset += bytes.length;
    total += bytes.length;
    if (bytes.length < CHUNK_SIZE_BYTES) break;
  }
  const combined = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    combined.set(chunk, pos);
    pos += chunk.length;
  }
  return combined;
}

function DeviceThumbnail({ assetId, isVideo }: { assetId: string; isVideo: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string>();

  useEffect(() => {
    if (!container.current) return;
    let active = true;
    const load = () => {
      void vaultMedia.getAssetThumbnail({ assetId }).then(({ dataBase64 }) => {
        if (active && dataBase64) setSrc(`data:image/jpeg;base64,${dataBase64}`);
      }).catch(() => {});
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      load();
    }, { rootMargin: '160px' });
    observer.observe(container.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [assetId]);

  return (
    <div ref={container} className="device-thumbnail" aria-hidden="true">
      {src ? (
        <img src={src} alt="" decoding="async" onError={() => setSrc(undefined)} />
      ) : (
        <svg viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <circle cx="9" cy="9" r="1.5" />
          <path d="m4 17 5-5 3 3 3-4 5 6" />
        </svg>
      )}
      {isVideo && <span className="device-thumbnail-kind">▶ Video</span>}
    </div>
  );
}

export function BackupPanel({ onUploadCompleted }: { onUploadCompleted: () => void }) {
  const { user, policies, e2eeMasterKey, refreshProfile } = useAuth();
  const isNativeMode = vaultMedia.isNative();

  // ---- Native Device Gallery State ----
  const [nativeNet, setNativeNet] = useState<VaultNetworkStatus>({
    connected: true,
    type: 'unknown',
    isWifi: false
  });
  const [permission, setPermission] = useState<MediaPermissionStatus | null>(null);
  const [albums, setAlbums] = useState<DeviceAlbumInfo[]>([]);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unbacked' | 'backed_up'>('all');
  const [nativeItems, setNativeItems] = useState<NativeGalleryItem[]>([]);
  const [nativeTotal, setNativeTotal] = useState(0);
  const [rawScanOffset, setRawScanOffset] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [isNativeUploading, setIsNativeUploading] = useState(false);

  // ---- Manual / Web Queue State ----
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [webNet, setWebNet] = useState<VaultNetworkStatus>({
    connected: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
    type: 'unknown',
    isWifi: false
  });
  const [wifiConfirmed, setWifiConfirmed] = useState(true);
  const [rejectedNames, setRejectedNames] = useState<string[]>([]);

  const abortMapRef = useRef<Map<string, AbortController>>(new Map());
  const pausedSetRef = useRef<Set<string>>(new Set());
  const processingRef = useRef(false);
  const nativeProcessingRef = useRef(false);
  const queueRef = useRef<QueueItem[]>([]);
  queueRef.current = queue;
  const nativeItemsRef = useRef<NativeGalleryItem[]>([]);
  nativeItemsRef.current = nativeItems;
  const userIdRef = useRef<string | undefined>(user?.id);
  userIdRef.current = user?.id;
  const scanSeqRef = useRef(0);
  const rawScanOffsetRef = useRef(0);

  const refreshWebNetwork = useCallback(async () => {
    const st = await vaultMedia.getNetworkStatus();
    setWebNet(st);
  }, []);

  useEffect(() => {
    if (isNativeMode) return;
    void refreshWebNetwork();
    const nav = navigator as Navigator & { connection?: NetworkConnectionLike };
    const onUpdate = () => {
      void refreshWebNetwork();
    };
    nav.connection?.addEventListener?.('change', onUpdate);
    window.addEventListener('online', onUpdate);
    window.addEventListener('offline', onUpdate);
    return () => {
      nav.connection?.removeEventListener?.('change', onUpdate);
      window.removeEventListener('online', onUpdate);
      window.removeEventListener('offline', onUpdate);
    };
  }, [isNativeMode, refreshWebNetwork]);

  const updateNativeItem = useCallback((assetId: string, patch: Partial<NativeGalleryItem>) => {
    setNativeItems((prev) =>
      prev.map((it) => (it.asset.assetId === assetId ? { ...it, ...patch } : it))
    );
  }, []);

  const refreshNativeGallery = useCallback(
    async (targetAlbumId: string, append = false) => {
      if (!isNativeMode || nativeProcessingRef.current) return;
      const seq = ++scanSeqRef.current;
      const requestOffset = append ? rawScanOffsetRef.current : 0;
      if (!append) {
        setNativeItems([]);
        setNativeTotal(0);
        rawScanOffsetRef.current = 0;
        setRawScanOffset(0);
      }
      setScanning(true);
      setScanError(null);

      try {
        const net = await vaultMedia.getNetworkStatus();
        if (scanSeqRef.current !== seq) return;
        setNativeNet(net);

        const perm = await vaultMedia.checkAndRequestMediaPermissions();
        if (scanSeqRef.current !== seq) return;
        setPermission(perm);
        if (!perm.granted) {
          setAlbums([]);
          setNativeItems([]);
          setNativeTotal(0);
          rawScanOffsetRef.current = 0;
          setRawScanOffset(0);
          return;
        }

        const [albumRes, scanRes] = await Promise.all([
          vaultMedia.listDeviceAlbums(),
          vaultMedia.scanDeviceMedia({
            albumId: targetAlbumId === 'all' ? undefined : targetAlbumId,
            limit: GALLERY_PAGE_SIZE,
            offset: requestOffset
          })
        ]);
        if (scanSeqRef.current !== seq) return;

        const e2eeCached = readE2eeSyncedHashes(userIdRef.current);
        const mapped: NativeGalleryItem[] = [];

        for (const asset of scanRes.items) {
          const mediaKind = classifyMediaFormat(asset.filename, asset.mimeType);
          if (!mediaKind) continue;

          let sha256: string | undefined;
          let actualSize = asset.sizeBytes;
          try {
            const hashRes = await vaultMedia.computeAssetSha256({ assetId: asset.assetId });
            if (scanSeqRef.current !== seq) return;
            sha256 = hashRes.sha256;
            if (hashRes.sizeBytes > 0) actualSize = hashRes.sizeBytes;
          } catch {
            if (scanSeqRef.current !== seq) return;
            // Keep item visible even if hashing fails for one unreadable asset
          }

          mapped.push({
            asset: { ...asset, sizeBytes: actualSize },
            mediaKind,
            sha256,
            syncState: sha256 && e2eeCached.has(sha256) ? 'backed_up' : 'unbacked',
            progress: sha256 && e2eeCached.has(sha256) ? 100 : 0,
            uploadedParts: 0,
            totalParts: Math.max(1, Math.ceil(actualSize / CHUNK_SIZE_BYTES))
          });
        }

        const itemsToDiff = mapped.filter((m) => m.sha256 && m.syncState !== 'backed_up');
        if (net.connected && itemsToDiff.length > 0) {
          try {
            for (let i = 0; i < itemsToDiff.length; i += GALLERY_PAGE_SIZE) {
              const slice = itemsToDiff.slice(i, i + GALLERY_PAGE_SIZE);
              const diffRes = await api.checkDuplicates(
                slice.map((it) => ({
                  clientRef: it.asset.assetId,
                  sha256: it.sha256!,
                  originalFilename: it.asset.filename,
                  sizeBytes: it.asset.sizeBytes
                }))
              );
              if (scanSeqRef.current !== seq) return;
              const byRef = new Map(diffRes.results.map((r) => [r.clientRef, r]));
              for (const item of slice) {
                const match = byRef.get(item.asset.assetId);
                if (!match) continue;
                if (match.status === 'duplicate') {
                  item.syncState = 'backed_up';
                  item.progress = 100;
                } else if (match.status === 'resumable') {
                  item.syncState = 'unbacked';
                  item.resumable = true;
                  item.notice = 'Có thể tiếp tục phần tải lên dở dang.';
                } else {
                  item.syncState = 'unbacked';
                }
              }
            }
          } catch {
            if (scanSeqRef.current !== seq) return;
            // Offline or server unreachable during checkDuplicates -> keep 'unbacked' gracefully (GAL-2)
          }
        }

        if (scanSeqRef.current !== seq) return;

        const nextRawOffset =
          append && scanRes.items.length === 0
            ? Math.max(requestOffset, scanRes.total)
            : requestOffset + scanRes.items.length;

        setAlbums(albumRes.albums);
        setNativeTotal(scanRes.total);
        rawScanOffsetRef.current = nextRawOffset;
        setRawScanOffset(nextRawOffset);
        setNativeItems((prev) => {
          if (!append) return mapped;
          const seen = new Set(prev.map((p) => p.asset.assetId));
          return [...prev, ...mapped.filter((m) => !seen.has(m.asset.assetId))];
        });
      } catch (err) {
        if (scanSeqRef.current !== seq) return;
        setScanError(err instanceof Error ? err.message : 'Không quét được thư viện ảnh thiết bị.');
      } finally {
        if (scanSeqRef.current === seq) {
          setScanning(false);
        }
      }
    },
    [isNativeMode]
  );

  useEffect(() => {
    if (!isNativeMode) return;
    void refreshNativeGallery('all', false);

    const syncNetworkOnly = () => {
      void vaultMedia.getNetworkStatus().then(setNativeNet).catch(() => {});
    };
    window.addEventListener('online', syncNetworkOnly);
    window.addEventListener('offline', syncNetworkOnly);
    window.addEventListener('focus', syncNetworkOnly);
    return () => {
      ++scanSeqRef.current;
      window.removeEventListener('online', syncNetworkOnly);
      window.removeEventListener('offline', syncNetworkOnly);
      window.removeEventListener('focus', syncNetworkOnly);
    };
  }, [isNativeMode, refreshNativeGallery]);

  // Strict fail-closed on Native Mode: ONLY connected && isWifi is allowed
  const isNativeWifiAllowed = nativeNet.connected && nativeNet.isWifi;

  const nativeNetworkAlertText = useMemo(() => {
    if (!isNativeMode || isNativeWifiAllowed) return null;
    if (nativeNet.type === 'cellular') {
      return 'Đang dùng dữ liệu di động (4G/5G) — Đã chặn sao lưu theo chính sách Chỉ Wi-Fi. Hãy chuyển sang Wi-Fi.';
    }
    if (!nativeNet.connected || nativeNet.type === 'none') {
      return 'Thiết bị đang ngoại tuyến (không có kết nối mạng) — Đã tạm khóa sao lưu.';
    }
    return 'Chưa xác nhận kết nối Wi-Fi — Đã tạm khóa sao lưu theo chính sách Chỉ Wi-Fi.';
  }, [isNativeMode, isNativeWifiAllowed, nativeNet]);

  const requireNativeWifi = useCallback(async () => {
    const net = await vaultMedia.getNetworkStatus();
    setNativeNet(net);
    if (!net.connected || !net.isWifi) {
      throw new Error('Không có kết nối Wi-Fi — Đã tạm khóa sao lưu theo chính sách Chỉ Wi-Fi.');
    }
  }, []);

  const uploadPartsWithPresignFallback = useCallback(
    async (
      sessionId: string,
      totalParts: number,
      doneParts: Set<number>,
      readPartBytes: (partNumber: number, start: number, end: number) => Promise<Uint8Array>,
      totalBytes: number,
      chunkSize: number,
      onPartDone: (uploadedCount: number) => void
    ) => {
      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        if (doneParts.has(partNumber)) continue;

        const start = (partNumber - 1) * chunkSize;
        const end = Math.min(start + chunkSize, totalBytes);
        const chunkBuf = await readPartBytes(partNumber, start, end);
        const partSha = sha256Bytes(chunkBuf);

        let uploaded = false;
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 3; attempt++) {
          await requireNativeWifi();
          try {
            const presign = await api.presignUploadPart(sessionId, partNumber);
            await requireNativeWifi();
            if (presign.mode === 'presigned_s3' && presign.uploadUrl) {
              try {
                const s3Res = await fetch(presign.uploadUrl, {
                  method: 'PUT',
                  body: chunkBuf as unknown as BodyInit
                });
                const etag = s3Res.headers.get('ETag') ?? s3Res.headers.get('etag');
                if (!s3Res.ok || !etag) {
                  throw new Error(`Direct S3 PUT failed (${s3Res.status})`);
                }
                await api.confirmUploadedPart(sessionId, partNumber, {
                  etag,
                  sizeBytes: chunkBuf.length,
                  partSha256: partSha
                });
                uploaded = true;
                break;
              } catch {
                await requireNativeWifi();
                await api.uploadPart(sessionId, partNumber, chunkBuf, partSha);
                uploaded = true;
                break;
              }
            }

            await api.uploadPart(sessionId, partNumber, chunkBuf, partSha);
            uploaded = true;
            break;
          } catch (err) {
            lastErr = err;
            if (attempt < 3) {
              await new Promise((r) => setTimeout(r, 600 * attempt));
            }
          }
        }
        if (!uploaded) throw lastErr;

        doneParts.add(partNumber);
        onPartDone(doneParts.size);
      }
    },
    [requireNativeWifi]
  );

  const runNativeBackup = useCallback(async () => {
    if (!isNativeMode || nativeProcessingRef.current || scanning) return;
    nativeProcessingRef.current = true;
    setIsNativeUploading(true);

    try {
      const candidates = sortNativeForSmartBackup(
        nativeItemsRef.current.filter((it) => it.syncState === 'unbacked' || it.syncState === 'failed')
      );

      for (const item of candidates) {
        try {
          await requireNativeWifi();
        } catch (err) {
          updateNativeItem(item.asset.assetId, {
            syncState: 'failed',
            error: err instanceof Error ? err.message : 'Không xác nhận được kết nối Wi-Fi.'
          });
          break;
        }

        const asset = item.asset;
        try {
          updateNativeItem(asset.assetId, {
            syncState: 'uploading',
            progress: 5,
            error: undefined,
            notice: undefined
          });

          let plaintextSha = item.sha256;
          if (!plaintextSha) {
            const hashRes = await vaultMedia.computeAssetSha256({ assetId: asset.assetId });
            plaintextSha = hashRes.sha256;
          }

          let uploadSha = plaintextSha;
          let uploadSize = asset.sizeBytes;
          let encryptedFileKey: string | null = null;
          let encryptionIv: string | null = null;
          let encryptedBytes: Uint8Array | null = null;

          if (user?.encryptionMode === 'e2ee') {
            if (!e2eeMasterKey) {
              throw new Error(
                'Kho E2EE đang khóa. Hãy mở khóa E2EE ở thanh trên cùng trước khi mã hóa & tải lên.'
              );
            }
            const plainBytes = await readNativeAssetAllBytes(asset.assetId);
            const plainFile = new File([new Uint8Array(plainBytes)], asset.filename, {
              type: asset.mimeType || 'application/octet-stream',
              lastModified: asset.capturedAt ? Date.parse(asset.capturedAt) : Date.now()
            });
            const enc = await encryptFileForE2ee(plainFile, e2eeMasterKey);
            encryptedBytes = new Uint8Array(await enc.encryptedFile.arrayBuffer());
            uploadSha = sha256Bytes(encryptedBytes);
            uploadSize = encryptedBytes.length;
            encryptedFileKey = enc.encryptedFileKey;
            encryptionIv = enc.encryptionIv;
          }

          await requireNativeWifi();
          const initRes = await api.initUpload({
            originalFilename: asset.filename,
            mimeType: asset.mimeType || 'application/octet-stream',
            sizeBytes: uploadSize,
            sha256: uploadSha,
            networkType: 'wifi',
            chunkSizeBytes: CHUNK_SIZE_BYTES,
            capturedAt: asset.capturedAt,
            width: asset.width ?? undefined,
            height: asset.height ?? undefined,
            durationMs: asset.durationMs ?? undefined,
            metadata: {
              sourceAlbum: asset.albumName,
              nativeAssetId: asset.assetId
            },
            encryptedFileKey,
            encryptionIv,
            allowDuplicate: false
          });

          if (initRes.status === 'duplicate') {
            if (user?.encryptionMode === 'e2ee' && plaintextSha) {
              rememberE2eeSyncedHash(user.id, plaintextSha);
            }
            updateNativeItem(asset.assetId, {
              syncState: 'backed_up',
              progress: 100,
              notice: `Đã có bản gốc trong kho (${initRes.duplicateOf?.originalFilename ?? asset.filename}).`
            });
            continue;
          }

          const sessionId = initRes.sessionId!;
          const chunkSize = initRes.chunkSizeBytes!;
          const totalParts = initRes.totalParts!;
          const doneParts = new Set(initRes.uploadedPartNumbers ?? []);

          updateNativeItem(asset.assetId, {
            totalParts,
            uploadedParts: doneParts.size,
            progress: 15 + Math.round((doneParts.size / totalParts) * 80)
          });

          await uploadPartsWithPresignFallback(
            sessionId,
            totalParts,
            doneParts,
            async (_partNumber, start, end) => {
              if (encryptedBytes) {
                return encryptedBytes.subarray(start, end);
              }
              const sliceRes = await vaultMedia.readAssetSlice({
                assetId: asset.assetId,
                offset: start,
                length: end - start
              });
              return base64ToBytes(sliceRes.dataBase64);
            },
            uploadSize,
            chunkSize,
            (uploadedCount) => {
              updateNativeItem(asset.assetId, {
                uploadedParts: uploadedCount,
                progress: 15 + Math.round((uploadedCount / totalParts) * 80)
              });
            }
          );

          updateNativeItem(asset.assetId, { syncState: 'verifying', progress: 97 });
          const completed = await api.completeUpload(sessionId);

          if (user?.encryptionMode === 'e2ee' && plaintextSha) {
            rememberE2eeSyncedHash(user.id, plaintextSha);
          }

          updateNativeItem(asset.assetId, {
            syncState: 'done',
            progress: 100,
            notice: completed.replicaNotice
          });

          await refreshProfile();
          onUploadCompleted();
        } catch (err) {
          const message =
            err instanceof ApiError || err instanceof Error ? err.message : 'Lỗi upload không xác định';
          updateNativeItem(asset.assetId, {
            syncState: 'failed',
            error: message
          });
        }
      }
    } finally {
      nativeProcessingRef.current = false;
      setIsNativeUploading(false);
    }
  }, [
    e2eeMasterKey,
    isNativeMode,
    onUploadCompleted,
    refreshProfile,
    requireNativeWifi,
    scanning,
    updateNativeItem,
    uploadPartsWithPresignFallback,
    user?.encryptionMode,
    user?.id
  ]);

  // ---- Web Fallback & Manual Queue Logic ----
  const updateItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setQueue((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const isWebCellularBlocked = !isNativeMode && webNet.type === 'cellular';
  const isWebOfflineBlocked = !isNativeMode && (!webNet.connected || webNet.type === 'none');
  const effectiveWebNetworkType: 'wifi' | 'cellular' | 'unknown' = isWebCellularBlocked
    ? 'cellular'
    : isWebOfflineBlocked
      ? 'unknown'
      : webNet.isWifi || (webNet.type === 'unknown' && wifiConfirmed)
        ? 'wifi'
        : 'unknown';
  const isWebUploadAllowed = isNativeMode
    ? isNativeWifiAllowed
    : webNet.connected && effectiveWebNetworkType === 'wifi';

  const handleFilesSelected = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const accepted: QueueItem[] = [];
    const rejected: string[] = [];

    for (const file of Array.from(files)) {
      const kind = classifyMediaFormat(file.name, file.type);
      if (!kind) {
        rejected.push(file.name);
        continue;
      }
      accepted.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        file,
        mediaKind: kind,
        status: 'queued',
        progress: 0,
        uploadedParts: 0,
        totalParts: Math.max(1, Math.ceil(file.size / CHUNK_SIZE_BYTES))
      });
    }

    setRejectedNames(rejected);

    if (accepted.length > 0) {
      accepted.sort((a, b) => {
        const aSmall = a.file.size < 25 * 1024 * 1024 ? 0 : 1;
        const bSmall = b.file.size < 25 * 1024 * 1024 ? 0 : 1;
        if (aSmall !== bSmall) return aSmall - bSmall;
        if (a.mediaKind !== b.mediaKind) return a.mediaKind === 'image' ? -1 : 1;
        return a.file.size - b.file.size;
      });
      setQueue((prev) => [...prev, ...accepted]);
    }
  };

  const uploadSingleItem = useCallback(
    async (item: QueueItem) => {
      if (isNativeMode) {
        const net = await vaultMedia.getNetworkStatus();
        setNativeNet(net);
        if (!(net.connected && net.isWifi)) {
          updateItem(item.id, {
            status: 'paused',
            error: 'Đang chặn upload vì chính sách chỉ cho phép sao lưu qua Wi-Fi.'
          });
          return;
        }
      } else if (!isWebUploadAllowed) {
        updateItem(item.id, {
          status: 'paused',
          error: 'Đang chặn upload vì chính sách chỉ cho phép sao lưu qua Wi-Fi.'
        });
        return;
      }

      pausedSetRef.current.delete(item.id);
      const controller = new AbortController();
      abortMapRef.current.set(item.id, controller);

      try {
        let uploadFile = item.file;
        let encryptedFileKey: string | null = null;
        let encryptionIv: string | null = null;

        if (user?.encryptionMode === 'e2ee') {
          if (!e2eeMasterKey) {
            throw new Error(
              'Kho E2EE đang khóa. Hãy mở khóa E2EE ở thanh trên cùng trước khi mã hóa & tải lên.'
            );
          }
          updateItem(item.id, { status: 'hashing', progress: 5, error: undefined });
          const enc = await encryptFileForE2ee(item.file, e2eeMasterKey);
          uploadFile = enc.encryptedFile;
          encryptedFileKey = enc.encryptedFileKey;
          encryptionIv = enc.encryptionIv;
        }

        let sha = item.sha256;
        if (!sha || user?.encryptionMode === 'e2ee') {
          updateItem(item.id, { status: 'hashing', progress: 5, error: undefined });
          sha = await sha256FileStreaming(uploadFile, (pct) => {
            updateItem(item.id, { progress: Math.round(pct * 0.15) });
          });
          updateItem(item.id, { sha256: sha });
        }

        if (pausedSetRef.current.has(item.id)) {
          updateItem(item.id, { status: 'paused' });
          return;
        }

        if (isNativeMode) await requireNativeWifi();
        const initRes = await api.initUpload({
          originalFilename: item.file.name,
          mimeType: item.file.type || 'application/octet-stream',
          sizeBytes: uploadFile.size,
          sha256: sha,
          networkType: 'wifi',
          chunkSizeBytes: CHUNK_SIZE_BYTES,
          capturedAt: item.file.lastModified ? new Date(item.file.lastModified).toISOString() : null,
          encryptedFileKey,
          encryptionIv,
          allowDuplicate: Boolean(item.allowDuplicate)
        });

        if (initRes.status === 'duplicate') {
          updateItem(item.id, {
            status: 'duplicate_prompt',
            duplicateOf: initRes.duplicateOf,
            notice: `Trùng khớp SHA-256 với "${initRes.duplicateOf?.originalFilename}". Không tự xóa.`
          });
          return;
        }

        const sessionId = initRes.sessionId!;
        const chunkSize = initRes.chunkSizeBytes!;
        const totalParts = initRes.totalParts!;
        const doneParts = new Set(initRes.uploadedPartNumbers ?? []);

        updateItem(item.id, {
          status: 'uploading',
          sessionId,
          resumed: Boolean(initRes.resumed),
          totalParts,
          uploadedParts: doneParts.size,
          progress: 15 + Math.round((doneParts.size / totalParts) * 80)
        });

        for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
          if (doneParts.has(partNumber)) continue;
          if (pausedSetRef.current.has(item.id)) {
            updateItem(item.id, { status: 'paused' });
            return;
          }

          const start = (partNumber - 1) * chunkSize;
          const end = Math.min(start + chunkSize, uploadFile.size);
          const chunkBuf = new Uint8Array(await uploadFile.slice(start, end).arrayBuffer());
          const partSha = sha256Bytes(chunkBuf);

          let uploaded = false;
          let lastErr: unknown;
          for (let attempt = 1; attempt <= 3; attempt++) {
            if (isNativeMode) await requireNativeWifi();
            try {
              const presign = await api.presignUploadPart(sessionId, partNumber);
              if (isNativeMode) await requireNativeWifi();
              if (presign.mode === 'presigned_s3' && presign.uploadUrl) {
                try {
                  const s3Res = await fetch(presign.uploadUrl, {
                    method: 'PUT',
                    body: chunkBuf as unknown as BodyInit,
                    signal: controller.signal
                  });
                  const etag = s3Res.headers.get('ETag') ?? s3Res.headers.get('etag');
                  if (!s3Res.ok || !etag) {
                    throw new Error(`Direct S3 PUT failed (${s3Res.status})`);
                  }
                  await api.confirmUploadedPart(sessionId, partNumber, {
                    etag,
                    sizeBytes: chunkBuf.length,
                    partSha256: partSha
                  });
                  uploaded = true;
                  break;
                } catch (s3Err) {
                  if (controller.signal.aborted || pausedSetRef.current.has(item.id)) {
                    throw s3Err;
                  }
                  if (isNativeMode) await requireNativeWifi();
                  await api.uploadPart(sessionId, partNumber, chunkBuf, partSha, controller.signal);
                  uploaded = true;
                  break;
                }
              }

              await api.uploadPart(sessionId, partNumber, chunkBuf, partSha, controller.signal);
              uploaded = true;
              break;
            } catch (err) {
              if (controller.signal.aborted || pausedSetRef.current.has(item.id)) {
                updateItem(item.id, { status: 'paused' });
                return;
              }
              lastErr = err;
              if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 600 * attempt));
              }
            }
          }
          if (!uploaded) throw lastErr;

          doneParts.add(partNumber);
          updateItem(item.id, {
            uploadedParts: doneParts.size,
            progress: 15 + Math.round((doneParts.size / totalParts) * 80)
          });
        }

        updateItem(item.id, { status: 'verifying', progress: 97 });
        const completed = await api.completeUpload(sessionId);

        updateItem(item.id, {
          status: 'done',
          progress: 100,
          notice: completed.replicaNotice
        });

        await refreshProfile();
        onUploadCompleted();
      } catch (err) {
        if (pausedSetRef.current.has(item.id)) {
          updateItem(item.id, { status: 'paused' });
          return;
        }
        const message =
          err instanceof ApiError || err instanceof Error ? err.message : 'Lỗi upload không xác định';
        updateItem(item.id, { status: 'failed', error: message });
      } finally {
        abortMapRef.current.delete(item.id);
      }
    },
    [
      e2eeMasterKey,
      isNativeMode,
      isWebUploadAllowed,
      onUploadCompleted,
      refreshProfile,
      requireNativeWifi,
      updateItem,
      user?.encryptionMode
    ]
  );

  const runQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    setIsRunning(true);

    try {
      while (true) {
        const next = queueRef.current.find((it) => it.status === 'queued');
        if (!next) break;
        await uploadSingleItem(next);
      }
    } finally {
      processingRef.current = false;
      setIsRunning(false);
    }
  }, [uploadSingleItem]);

  const handlePause = (id: string) => {
    pausedSetRef.current.add(id);
    abortMapRef.current.get(id)?.abort();
    updateItem(id, { status: 'paused' });
  };

  const handleResumeOrRetry = (id: string, allowDuplicate?: boolean) => {
    pausedSetRef.current.delete(id);
    updateItem(id, {
      status: 'queued',
      error: undefined,
      ...(allowDuplicate !== undefined ? { allowDuplicate } : {})
    });
    setTimeout(() => void runQueue(), 0);
  };

  const handleSkipDuplicate = (id: string) => {
    updateItem(id, { status: 'skipped', notice: 'Đã bỏ qua (file gốc giống hệt đã có sẵn trong kho).' });
  };

  const handleCancel = async (item: QueueItem) => {
    pausedSetRef.current.add(item.id);
    abortMapRef.current.get(item.id)?.abort();
    if (item.sessionId && item.status !== 'done') {
      await api.abortUpload(item.sessionId).catch(() => {});
    }
    setQueue((prev) => prev.filter((q) => q.id !== item.id));
  };

  const unbackedNativeCount = nativeItems.filter(
    (it) => it.syncState === 'unbacked' || it.syncState === 'failed'
  ).length;
  const backedUpNativeCount = nativeItems.filter(
    (it) => it.syncState === 'backed_up' || it.syncState === 'done'
  ).length;

  const visibleNativeItems = useMemo(() => {
    if (statusFilter === 'unbacked') {
      return nativeItems.filter((it) => it.syncState !== 'backed_up' && it.syncState !== 'done');
    }
    if (statusFilter === 'backed_up') {
      return nativeItems.filter((it) => it.syncState === 'backed_up' || it.syncState === 'done');
    }
    return nativeItems;
  }, [nativeItems, statusFilter]);

  const doneCount = queue.filter((q) => q.status === 'done').length;
  const failedCount = queue.filter((q) => q.status === 'failed').length;
  const pendingCount = queue.filter((q) => q.status === 'queued' || q.status === 'paused').length;
  const overallProgress =
    queue.length === 0
      ? 0
      : Math.round(
          queue.reduce((acc, q) => acc + (q.status === 'skipped' ? 100 : q.progress), 0) / queue.length
        );

  return (
    <div className="stack-lg">
      {isNativeMode && (
        <section className="panel device-gallery">
          <div className="panel-head-row">
            <div>
              <span className="device-gallery-label">TRÊN ĐIỆN THOẠI</span>
              <h3>Ảnh và video trên máy</h3>
              <p className="muted small">Chọn album để kiểm tra những ảnh và video chưa có trong kho.</p>
            </div>
            <span className={`pill ${isNativeWifiAllowed ? 'ok' : nativeNet.type === 'cellular' || !nativeNet.connected || nativeNet.type === 'none' ? 'danger' : 'warn'}`}>
              {isNativeWifiAllowed
                ? `Wi-Fi đã kết nối · ${policies?.uploadNetworkPolicy === 'wifi_only' ? 'Chỉ Wi-Fi' : 'Chỉ Wi-Fi'}`
                : nativeNet.type === 'cellular'
                  ? 'Đang dùng 4G/5G — Đã chặn'
                  : !nativeNet.connected || nativeNet.type === 'none'
                    ? 'Ngoại tuyến — Đã tạm khóa'
                    : 'Chưa có Wi-Fi — Đã tạm khóa'}
            </span>
          </div>

          {nativeNetworkAlertText && (
            <div className="alert error" style={{ marginTop: 10 }}>
              {nativeNetworkAlertText}
            </div>
          )}

          {permission?.accessLevel === 'limited' && (
            <div className="privacy-banner" style={{ marginTop: 10 }}>
              Bạn đang cấp quyền truy cập thư viện ảnh ở chế độ <strong>Giới hạn (Limited)</strong>. Chỉ các
              ảnh/video đã chọn mới được quét và sao lưu.
            </div>
          )}

          {scanError && (
            <div className="alert error" style={{ marginTop: 10 }}>
              {scanError}
            </div>
          )}

          {permission && !permission.granted ? (
            <div className="hero-empty" style={{ marginTop: 12 }}>
              <h4>Cần quyền truy cập Thư viện ảnh & video</h4>
              <p className="muted small">
                Cấp quyền để Kho Ảnh quét album Camera/Screenshots và đối chiếu mục chưa sao lưu.
              </p>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void refreshNativeGallery(selectedAlbumId, false)}
              >
                Cấp quyền & Quét lại
              </button>
            </div>
          ) : (
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="chips-row" role="group" aria-label="Lọc theo album thiết bị">
                <button
                  type="button"
                  className="btn-small"
                  aria-pressed={selectedAlbumId === 'all'}
                  disabled={isNativeUploading}
                  onClick={() => {
                    setSelectedAlbumId('all');
                    void refreshNativeGallery('all', false);
                  }}
                >
                  Tất cả ảnh & video
                </button>
                {albums.map((album) => {
                  const active = selectedAlbumId === album.id;
                  return (
                    <button
                      key={album.id}
                      type="button"
                      className="btn-small"
                      aria-pressed={active}
                      disabled={isNativeUploading}
                      onClick={() => {
                        setSelectedAlbumId(album.id);
                        void refreshNativeGallery(album.id, false);
                      }}
                    >
                      {album.name} ({album.count})
                    </button>
                  );
                })}
              </div>

              <div className="chips-row" role="group" aria-label="Lọc trạng thái sao lưu">
                <button
                  type="button"
                  className="btn-small"
                  aria-pressed={statusFilter === 'all'}
                  onClick={() => setStatusFilter('all')}
                >
                  Tất cả ({nativeItems.length})
                </button>
                <button
                  type="button"
                  className="btn-small"
                  aria-pressed={statusFilter === 'unbacked'}
                  onClick={() => setStatusFilter('unbacked')}
                >
                  Chưa sao lưu ({unbackedNativeCount})
                </button>
                <button
                  type="button"
                  className="btn-small"
                  aria-pressed={statusFilter === 'backed_up'}
                  onClick={() => setStatusFilter('backed_up')}
                >
                  Đã sao lưu ({backedUpNativeCount})
                </button>
              </div>

              <div className="chips-row">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!isNativeWifiAllowed || isNativeUploading || scanning || unbackedNativeCount === 0}
                  onClick={() => void runNativeBackup()}
                >
                  {isNativeUploading
                    ? 'Đang sao lưu lên kho...'
                    : `Sao lưu ${unbackedNativeCount} mục chưa sao lưu`}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={scanning || isNativeUploading}
                  onClick={() => void refreshNativeGallery(selectedAlbumId, false)}
                >
                  {scanning ? 'Đang quét...' : 'Quét lại & Kiểm tra mạng'}
                </button>
              </div>

              {visibleNativeItems.length === 0 ? (
                <p className="muted small">
                  {scanning
                    ? 'Đang quét thư viện thiết bị và đối chiếu SHA-256...'
                    : 'Không có ảnh hoặc video nào trong bộ lọc hiện tại.'}
                </p>
              ) : (
                <div className="device-preview-grid" aria-label="Ảnh xem trước trên thiết bị">
                  {visibleNativeItems.map((item) => (
                    <div key={item.asset.assetId} className="queue-card device-preview-card">
                      <DeviceThumbnail assetId={item.asset.assetId} isVideo={item.mediaKind === 'video'} />
                      <div className="device-preview-info">
                        <strong title={item.asset.filename}>{item.asset.filename}</strong>
                        <div className="muted tiny">
                          {formatBytes(item.asset.sizeBytes)}
                          {item.asset.capturedAt
                            ? ` · ${new Date(item.asset.capturedAt).toLocaleDateString('vi-VN')}`
                            : ''}
                        </div>
                        <span
                          className={`pill ${
                            item.syncState === 'backed_up' || item.syncState === 'done'
                              ? 'ok'
                              : item.syncState === 'failed'
                                ? 'danger'
                                : item.syncState === 'unbacked'
                                  ? 'warn'
                                  : 'accent'
                          }`}
                        >
                          {item.syncState === 'checking' && 'Đang đối chiếu...'}
                          {item.syncState === 'backed_up' && 'Đã sao lưu'}
                          {item.syncState === 'done' && 'Đã sao lưu · Đã xác minh gốc'}
                          {item.syncState === 'unbacked' && 'Chưa sao lưu'}
                          {item.syncState === 'uploading' && `Đang tải ${item.progress}%`}
                          {item.syncState === 'verifying' && 'Đang xác minh'}
                          {item.syncState === 'failed' && 'Thất bại'}
                        </span>
                      </div>

                      {(item.syncState === 'uploading' || item.syncState === 'verifying') && (
                        <div className="progress-track">
                          <div className="progress-fill" style={{ width: `${item.progress}%` }} />
                        </div>
                      )}

                      {item.notice && <div className="muted small">{item.notice}</div>}
                      {item.error && <div className="error-text small">{item.error}</div>}
                    </div>
                  ))}
                </div>
              )}

              {rawScanOffset < nativeTotal && (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={scanning || isNativeUploading}
                  onClick={() => void refreshNativeGallery(selectedAlbumId, true)}
                >
                  Tải thêm ({nativeItems.length}/{nativeTotal})
                </button>
              )}
            </div>
          )}
        </section>
      )}

      <section className="panel">
        <div className="panel-head-row">
          <div>
            <h3>
              {isNativeMode
                ? 'Chọn tệp thủ công (Tùy chọn bổ sung)'
                : 'Sao lưu Ảnh & Video Nguyên bản (100% file gốc)'}
            </h3>
            <p className="muted small">
              Hỗ trợ mọi định dạng (JPEG, PNG, HEIC, DNG, ProRAW, TIFF, MP4, MOV, ProRes...). Chia nhỏ
              từng chunk 2 MB chịu gián đoạn và đối chiếu SHA-256 trước khi xác nhận.
            </p>
          </div>
          {!isNativeMode && (
            <span className={`pill ${isWebCellularBlocked || isWebOfflineBlocked ? 'danger' : 'ok'}`}>
              {isWebCellularBlocked
                ? 'Đang dùng 4G/5G — Đã chặn upload'
                : isWebOfflineBlocked
                  ? 'Ngoại tuyến — Đã tạm khóa'
                  : `Chính sách: ${policies?.uploadNetworkPolicy === 'wifi_only' ? 'Chỉ Wi-Fi' : 'Chỉ Wi-Fi'}`}
            </span>
          )}
        </div>

        {!isNativeMode && webNet.type === 'unknown' && webNet.connected && (
          <label className="wifi-confirm-box">
            <input
              type="checkbox"
              checked={wifiConfirmed}
              onChange={(e) => setWifiConfirmed(e.target.checked)}
            />
            <span>
              Tôi xác nhận thiết bị đang kết nối <strong>Wi-Fi</strong> (Safari/iOS không chia sẻ loại
              mạng với trình duyệt; tắt mục này để tạm khóa upload).
            </span>
          </label>
        )}

        {isWebCellularBlocked && (
          <div className="alert error" style={{ marginTop: 12 }}>
            Trình duyệt phát hiện kết nối dữ liệu di động (4G/5G). Hãy chuyển sang Wi-Fi để tiếp tục sao
            lưu.
          </div>
        )}

        {isWebOfflineBlocked && (
          <div className="alert error" style={{ marginTop: 12 }}>
            Trình duyệt đang ngoại tuyến (không có mạng). Đã tạm khóa sao lưu.
          </div>
        )}

        <div className="upload-dropzone">
          <label className="btn-primary file-picker-btn">
            + Chọn ảnh / video từ thiết bị
            <input
              type="file"
              multiple
              accept="image/*,video/*,.heic,.heif,.dng,.raw,.cr2,.cr3,.nef,.arw,.tif,.tiff,.mov,.mp4,.mkv,.prores"
              onChange={(e) => {
                handleFilesSelected(e.target.files);
                e.target.value = '';
              }}
              style={{ display: 'none' }}
            />
          </label>

          {queue.some((q) => q.status === 'queued') && (
            <button
              type="button"
              className="btn-secondary"
              disabled={isRunning || !isWebUploadAllowed}
              onClick={() => void runQueue()}
            >
              {isRunning ? 'Đang sao lưu...' : 'Bắt đầu sao lưu hàng đợi'}
            </button>
          )}
        </div>

        {rejectedNames.length > 0 && (
          <div className="alert error" style={{ marginTop: 12 }}>
            Đã loại bỏ {rejectedNames.length} file không phải ảnh/video theo PRD 2.4:{' '}
            <code>{rejectedNames.join(', ')}</code>
          </div>
        )}
      </section>

      {queue.length > 0 && (
        <section className="panel">
          <div className="panel-head-row">
            <h3>
              Hàng đợi sao lưu ({doneCount}/{queue.length} hoàn tất · {overallProgress}%)
            </h3>
            <div className="chips-row" style={{ marginTop: 0 }}>
              {pendingCount > 0 && <span className="pill warn">Chờ: {pendingCount}</span>}
              {failedCount > 0 && <span className="pill danger">Lỗi: {failedCount}</span>}
              <button
                type="button"
                className="btn-small"
                onClick={() =>
                  setQueue((prev) => prev.filter((q) => q.status !== 'done' && q.status !== 'skipped'))
                }
              >
                Dọn mục đã xong
              </button>
            </div>
          </div>

          <div className="progress-track" style={{ marginBottom: 14 }}>
            <div className="progress-fill" style={{ width: `${overallProgress}%` }} />
          </div>

          <div className="device-list">
            {queue.map((item) => (
              <div key={item.id} className="queue-card">
                <div className="queue-top">
                  <div>
                    <strong>{item.file.name}</strong>{' '}
                    <span className="pill neutral">{item.mediaKind === 'image' ? 'Ảnh' : 'Video'}</span>
                    {item.resumed && <span className="pill accent">Tiếp tục (Resumed)</span>}
                    <div className="muted tiny">
                      {formatBytes(item.file.size)} · Chunk {item.uploadedParts}/{item.totalParts}
                      {item.sha256 ? ` · SHA-256: ${item.sha256.slice(0, 12)}…` : ''}
                    </div>
                  </div>
                  <span
                    className={`pill ${
                      item.status === 'done'
                        ? 'ok'
                        : item.status === 'failed'
                          ? 'danger'
                          : item.status === 'duplicate_prompt' || item.status === 'paused'
                            ? 'warn'
                            : 'accent'
                    }`}
                  >
                    {item.status === 'queued' && 'Chờ upload'}
                    {item.status === 'hashing' && 'Đang tính SHA-256'}
                    {item.status === 'uploading' && `Đang tải ${item.progress}%`}
                    {item.status === 'paused' && 'Tạm dừng'}
                    {item.status === 'verifying' && 'Đang xác minh'}
                    {item.status === 'done' && 'Đã xác minh gốc'}
                    {item.status === 'duplicate_prompt' && 'Phát hiện trùng'}
                    {item.status === 'skipped' && 'Đã bỏ qua'}
                    {item.status === 'failed' && 'Thất bại'}
                  </span>
                </div>

                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${item.progress}%` }} />
                </div>

                {item.notice && <div className="muted small">{item.notice}</div>}
                {item.error && <div className="error-text small">{item.error}</div>}

                <div className="queue-actions">
                  {item.status === 'uploading' && (
                    <button type="button" className="btn-small" onClick={() => handlePause(item.id)}>
                      Tạm dừng
                    </button>
                  )}
                  {(item.status === 'paused' || item.status === 'failed') && (
                    <button
                      type="button"
                      className="btn-small"
                      onClick={() => handleResumeOrRetry(item.id)}
                    >
                      Tiếp tục / Thử lại
                    </button>
                  )}
                  {item.status === 'duplicate_prompt' && (
                    <>
                      <button
                        type="button"
                        className="btn-small"
                        onClick={() => handleSkipDuplicate(item.id)}
                      >
                        Bỏ qua (Giữ bản đã có)
                      </button>
                      <button
                        type="button"
                        className="btn-small"
                        onClick={() => handleResumeOrRetry(item.id, true)}
                      >
                        Vẫn lưu thêm bản sao
                      </button>
                    </>
                  )}
                  {item.status !== 'done' && item.status !== 'skipped' && (
                    <button
                      type="button"
                      className="btn-small danger"
                      onClick={() => void handleCancel(item)}
                    >
                      Hủy
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
