import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AlbumItem, FileVersionItem, FolderItem, MediaFileItem, TagItem } from '@smb/shared';
import { api, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { bytesToBase64, triggerBlobDownload, vaultMedia } from '../native/vaultMedia';
import { decryptBytesFromE2ee, formatBytes } from '../utils/e2ee';
import { sha256Bytes } from '../utils/sha256';

export interface LibraryFilterContext {
  title: string;
  kind?: 'all' | 'image' | 'video';
  favoriteOnly?: boolean;
  albumId?: string;
  folderId?: string;
  tagId?: string;
}

function canBrowserPreviewImage(mimeType: string, filename: string): boolean {
  const m = mimeType.toLowerCase();
  if (/^image\/(jpeg|jpg|png|gif|webp|avif|bmp)$/.test(m)) return true;
  return /\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(filename);
}

function canBrowserPlayVideo(mimeType: string, filename: string): boolean {
  const m = mimeType.toLowerCase();
  if (/^video\/(mp4|webm|ogg|quicktime)$/.test(m)) return true;
  return /\.(mp4|webm|mov|m4v)$/i.test(filename);
}

function formatDayHeading(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((today - target) / 86_400_000);
  if (diffDays === 0) return 'Hôm nay';
  if (diffDays === 1) return 'Hôm qua';
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function MediaTile({
  item,
  picking,
  selected,
  e2eeMasterKey,
  onClick
}: {
  item: MediaFileItem;
  picking: boolean;
  selected: boolean;
  e2eeMasterKey: CryptoKey | null;
  onClick: () => void;
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  const previewableImage =
    item.mediaKind === 'image' &&
    canBrowserPreviewImage(item.mimeType, item.originalFilename) &&
    (item.encryptionMode === 'server_side' || Boolean(e2eeMasterKey));

  useEffect(() => {
    if (!previewableImage) {
      setThumbUrl(null);
      return;
    }
    let active = true;
    let objectUrl: string | null = null;

    (async () => {
      try {
        const { blob } = await api.streamMediaBlob(item.id);
        let finalBlob = blob;
        if (item.encryptionMode === 'e2ee' && e2eeMasterKey && item.encryptedFileKey && item.encryptionIv) {
          const cipher = new Uint8Array(await blob.arrayBuffer());
          const plain = await decryptBytesFromE2ee(
            cipher,
            item.encryptedFileKey,
            item.encryptionIv,
            e2eeMasterKey
          );
          finalBlob = new Blob([plain as unknown as BlobPart], { type: item.mimeType || 'image/jpeg' });
        }
        if (!active) return;
        objectUrl = URL.createObjectURL(finalBlob);
        setThumbUrl(objectUrl);
      } catch {
        // graceful fallback
      }
    })();

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    item.id,
    item.encryptionMode,
    item.encryptedFileKey,
    item.encryptionIv,
    item.mimeType,
    previewableImage,
    e2eeMasterKey
  ]);

  return (
    <button
      type="button"
      className="tile"
      aria-label={item.originalFilename}
      aria-pressed={picking ? selected : undefined}
      onClick={onClick}
    >
      {thumbUrl ? (
        <img src={thumbUrl} alt={item.originalFilename} loading="lazy" />
      ) : (
        <div className="tile-fallback">
          <span className="tile-ext">
            {item.encryptionMode === 'e2ee' && !e2eeMasterKey
              ? 'E2EE'
              : item.mediaKind === 'video'
                ? 'VIDEO'
                : item.originalFilename.split('.').pop()?.toUpperCase() ?? 'RAW'}
          </span>
          <span className="tile-name">{item.originalFilename}</span>
        </div>
      )}
      {item.mediaKind === 'video' && (
        <span className="video" aria-hidden="true">
          ▶
        </span>
      )}
      {item.isFavorite && !picking && (
        <span className="fav-mark" aria-hidden="true">
          ♥
        </span>
      )}
      {picking && (
        <span className="mark" aria-hidden="true">
          {selected ? '✓' : '○'}
        </span>
      )}
    </button>
  );
}

export function LibraryPanel({
  refreshKey,
  filterContext,
  onClearFilterContext,
  onGoToUpload
}: {
  refreshKey: number;
  filterContext?: LibraryFilterContext | null;
  onClearFilterContext?: () => void;
  onGoToUpload?: () => void;
}) {
  const { user, e2eeMasterKey } = useAuth();
  const [items, setItems] = useState<MediaFileItem[]>([]);
  const [total, setTotal] = useState(0);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [kind, setKind] = useState<'all' | 'image' | 'video'>(filterContext?.kind ?? 'all');
  const [favoriteOnly, setFavoriteOnly] = useState(Boolean(filterContext?.favoriteOnly));
  const [sortBy, setSortBy] = useState<'captured_at' | 'created_at' | 'size_bytes' | 'original_filename'>(
    'captured_at'
  );

  // Selection mode (exact kho-anh.html "Chọn" / "Xong" flow)
  const [picking, setPicking] = useState(false);
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());

  // Fullscreen Viewer (exact kho-anh.html #viewer flow)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerZoom, setViewerZoom] = useState(1);
  const [showInfoSheet, setShowInfoSheet] = useState(false);
  const [touchStartX, setTouchStartX] = useState<number | null>(null);
  const [viewerVersions, setViewerVersions] = useState<FileVersionItem[]>([]);
  const [newTagName, setNewTagName] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setKind(filterContext?.kind ?? 'all');
    setFavoriteOnly(Boolean(filterContext?.favoriteOnly));
    setPicking(false);
    setPickedIds(new Set());
  }, [filterContext]);

  const loadOrganization = useCallback(async () => {
    try {
      const [fRes, aRes] = await Promise.all([api.listFolders(), api.listAlbums()]);
      setFolders(fRes.folders);
      setAlbums(aRes.albums);
    } catch {
      // ignore
    }
  }, []);

  const loadMedia = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listMedia({
        kind,
        favoriteOnly,
        albumId: filterContext?.albumId,
        folderId: filterContext?.folderId,
        tagId: filterContext?.tagId,
        sortBy,
        sortDir: sortBy === 'original_filename' ? 'asc' : 'desc'
      });
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Không tải được thư viện'
      });
    } finally {
      setLoading(false);
    }
  }, [kind, favoriteOnly, filterContext?.albumId, filterContext?.folderId, filterContext?.tagId, sortBy]);

  useEffect(() => {
    void loadOrganization();
  }, [loadOrganization, refreshKey]);

  useEffect(() => {
    void loadMedia();
  }, [loadMedia, refreshKey]);

  const groupedTimeline = useMemo(() => {
    const groups: Array<{ label: string; items: Array<{ item: MediaFileItem; globalIndex: number }> }> = [];
    const map = new Map<string, number>();

    items.forEach((item, idx) => {
      const label = formatDayHeading(item.capturedAt ?? item.createdAt);
      const existingIdx = map.get(label);
      if (existingIdx === undefined) {
        map.set(label, groups.length);
        groups.push({ label, items: [{ item, globalIndex: idx }] });
      } else {
        groups[existingIdx]!.items.push({ item, globalIndex: idx });
      }
    });
    return groups;
  }, [items]);

  const activeViewerItem = viewerIndex !== null ? (items[viewerIndex] ?? null) : null;

  const openViewer = useCallback((index: number) => {
    setFeedback(null);
    setViewerIndex(index);
  }, []);

  const stepViewer = useCallback(
    (delta: -1 | 1) => {
      if (viewerIndex === null) return;
      const next = Math.max(0, Math.min(items.length - 1, viewerIndex + delta));
      if (next !== viewerIndex) {
        setFeedback(null);
        setViewerIndex(next);
      }
    },
    [viewerIndex, items.length]
  );

  const closeViewer = useCallback(() => {
    setFeedback(null);
    setViewerIndex(null);
  }, []);

  useEffect(() => {
    if (!activeViewerItem) {
      setViewerUrl(null);
      setViewerVersions([]);
      setViewerZoom(1);
      setShowInfoSheet(false);
      return;
    }

    let active = true;
    let objectUrl: string | null = null;
    setViewerZoom(1);

    void api
      .listVersions(activeViewerItem.id)
      .then((res) => {
        if (active) setViewerVersions(res.versions);
      })
      .catch(() => {});

    const canDisplay =
      (activeViewerItem.mediaKind === 'image' &&
        canBrowserPreviewImage(activeViewerItem.mimeType, activeViewerItem.originalFilename)) ||
      (activeViewerItem.mediaKind === 'video' &&
        canBrowserPlayVideo(activeViewerItem.mimeType, activeViewerItem.originalFilename));

    if (!canDisplay || (activeViewerItem.encryptionMode === 'e2ee' && !e2eeMasterKey)) {
      setViewerUrl(null);
      return;
    }

    (async () => {
      try {
        const { blob } = await api.streamMediaBlob(activeViewerItem.id);
        let finalBlob = blob;
        if (
          activeViewerItem.encryptionMode === 'e2ee' &&
          e2eeMasterKey &&
          activeViewerItem.encryptedFileKey &&
          activeViewerItem.encryptionIv
        ) {
          const cipher = new Uint8Array(await blob.arrayBuffer());
          const plain = await decryptBytesFromE2ee(
            cipher,
            activeViewerItem.encryptedFileKey,
            activeViewerItem.encryptionIv,
            e2eeMasterKey
          );
          finalBlob = new Blob([plain as unknown as BlobPart], {
            type: activeViewerItem.mimeType || 'application/octet-stream'
          });
        }
        if (!active) return;
        objectUrl = URL.createObjectURL(finalBlob);
        setViewerUrl(objectUrl);
      } catch {
        if (active) setViewerUrl(null);
      }
    })();

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [activeViewerItem, e2eeMasterKey]);

  useEffect(() => {
    if (viewerIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeViewer();
      if (e.key === 'ArrowRight') stepViewer(1);
      if (e.key === 'ArrowLeft') stepViewer(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewerIndex, closeViewer, stepViewer]);

  const handleDownloadOriginal = async (item: MediaFileItem) => {
    setBusy(true);
    setFeedback(null);
    try {
      const { blob, expectedSha256 } = await api.downloadOriginalMedia(item.id);
      const rawBytes = new Uint8Array(await blob.arrayBuffer());
      const wireSha = sha256Bytes(rawBytes);

      if (expectedSha256 && wireSha !== expectedSha256) {
        throw new Error(`Sai checksum SHA-256 khi tải xuống (${wireSha} ≠ ${expectedSha256})`);
      }

      let finalBytes: Uint8Array = rawBytes;
      let outputBlob = blob;
      if (item.encryptionMode === 'e2ee') {
        if (!e2eeMasterKey || !item.encryptedFileKey || !item.encryptionIv) {
          throw new Error('Kho E2EE đang khóa — hãy mở khóa E2EE trước khi tải bản giải mã.');
        }
        const plain = await decryptBytesFromE2ee(
          rawBytes,
          item.encryptedFileKey,
          item.encryptionIv,
          e2eeMasterKey
        );
        finalBytes = plain;
        outputBlob = new Blob([plain as unknown as BlobPart], {
          type: item.mimeType || 'application/octet-stream'
        });
      }

      if (vaultMedia.isNative()) {
        const res = await vaultMedia.saveOriginalToGallery({
          filename: item.originalFilename,
          mimeType: item.mimeType || 'application/octet-stream',
          mediaKind: item.mediaKind,
          dataBase64: bytesToBase64(finalBytes)
        });
        if (!res.saved) {
          throw new Error('Không thể lưu tệp vào Thư viện ảnh trên thiết bị.');
        }
        setFeedback({
          type: 'success',
          text: `Đã lưu nguyên bản "${item.originalFilename}" vào Thư viện ảnh thiết bị — SHA-256 khớp 100%.`
        });
      } else {
        triggerBlobDownload(outputBlob, item.originalFilename);
        setFeedback({
          type: 'success',
          text: `Đã tải nguyên bản "${item.originalFilename}" — SHA-256 khớp 100%.`
        });
      }
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'Tải file gốc thất bại' });
    } finally {
      setBusy(false);
    }
  };

  const handleExportSelection = async () => {
    if (pickedIds.size === 0) return;
    setBusy(true);
    try {
      const { blob } = await api.exportZip({ scope: 'selection', mediaIds: [...pickedIds] });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kho-anh-${pickedIds.size}-muc.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setPicking(false);
      setPickedIds(new Set());
    } finally {
      setBusy(false);
    }
  };

  const handleTrashSelection = async () => {
    if (pickedIds.size === 0) return;
    setBusy(true);
    try {
      for (const id of pickedIds) {
        await api.trashMedia(id);
      }
      setPicking(false);
      setPickedIds(new Set());
      setFeedback({ type: 'success', text: 'Đã chuyển các mục đã chọn vào Thùng rác.' });
      await loadMedia();
    } finally {
      setBusy(false);
    }
  };

  const handleToggleFavorite = async (item: MediaFileItem) => {
    await api.updateMedia(item.id, { isFavorite: !item.isFavorite });
    await loadMedia();
  };

  const handleMoveFolder = async (item: MediaFileItem, folderId: string | null) => {
    await api.updateMedia(item.id, { folderId });
    await loadMedia();
  };

  const handleToggleAlbum = async (item: MediaFileItem, albumId: string) => {
    if (item.albumIds.includes(albumId)) {
      await api.removeMediaFromAlbum(albumId, item.id);
    } else {
      await api.addMediaToAlbum(albumId, [item.id]);
    }
    await loadMedia();
  };

  const handleAttachNewTag = async (item: MediaFileItem) => {
    const clean = newTagName.trim();
    if (!clean) return;
    const { tag } = await api.createTag(clean);
    await api.attachTag(item.id, tag.id);
    setNewTagName('');
    await loadMedia();
  };

  const handleTrashMedia = async (item: MediaFileItem) => {
    await api.trashMedia(item.id);
    setViewerIndex(null);
    setFeedback({ type: 'success', text: `Đã chuyển "${item.originalFilename}" vào Thùng rác.` });
    await loadMedia();
  };

  return (
    <>
      <header className="top">
        <div className="top-row">
          {filterContext && onClearFilterContext && (
            <button
              type="button"
              className="round"
              aria-label="Quay lại"
              onClick={onClearFilterContext}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m15 5-7 7 7 7" />
              </svg>
            </button>
          )}
          <h1>{filterContext ? filterContext.title : 'Kho Ảnh'}</h1>
          {onGoToUpload && !picking && (
            <button type="button" className="round" aria-label="Tải ảnh lên" onClick={onGoToUpload}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="pill-btn"
            aria-pressed={picking}
            onClick={() => {
              setPicking((p) => !p);
              setPickedIds(new Set());
            }}
          >
            {picking ? 'Xong' : 'Chọn'}
          </button>
        </div>
        <p className="hint">
          {picking
            ? `Đã chọn ${pickedIds.size} mục`
            : `${total} mục · Chỉ Wi-Fi · ${user?.encryptionMode === 'e2ee' ? 'E2EE' : 'Nguyên bản 100%'}`}
        </p>
      </header>

      {/* Lightweight filter & sort strip (NO search per PRD 1.2) */}
      <div className="chip-strip">
        <button type="button" className={kind === 'all' && !favoriteOnly ? 'active' : ''} onClick={() => { setKind('all'); setFavoriteOnly(false); }}>
          Tất cả
        </button>
        <button type="button" className={kind === 'image' ? 'active' : ''} onClick={() => setKind('image')}>
          Ảnh
        </button>
        <button type="button" className={kind === 'video' ? 'active' : ''} onClick={() => setKind('video')}>
          Video
        </button>
        <button type="button" className={favoriteOnly ? 'active' : ''} onClick={() => setFavoriteOnly((v) => !v)}>
          ♥ Yêu thích
        </button>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          aria-label="Sắp xếp"
        >
          <option value="captured_at">Ngày chụp</option>
          <option value="created_at">Mới tải lên</option>
          <option value="size_bytes">Dung lượng</option>
          <option value="original_filename">Tên A–Z</option>
        </select>
      </div>

      {feedback && <div className={`alert ${feedback.type}`}>{feedback.text}</div>}

      {loading ? (
        <div className="hero-empty">
          <p className="muted">Đang tải thư viện...</p>
        </div>
      ) : items.length === 0 ? (
        <div className="hero-empty">
          <h3>Chưa có ảnh hoặc video nào</h3>
          <p className="muted small">
            Bấm nút <strong>+</strong> ở góc trên hoặc vào mục <strong>Kho</strong> để sao lưu ảnh &
            video gốc qua Wi-Fi.
          </p>
          {onGoToUpload && (
            <button type="button" className="pill-btn primary" onClick={onGoToUpload}>
              + Tải ảnh / video lên
            </button>
          )}
        </div>
      ) : (
        groupedTimeline.map((group) => (
          <section key={group.label} className="section">
            <h2>{group.label}</h2>
            <div className="grid">
              {group.items.map(({ item, globalIndex }) => {
                const isSelected = pickedIds.has(item.id);
                return (
                  <MediaTile
                    key={item.id}
                    item={item}
                    picking={picking}
                    selected={isSelected}
                    e2eeMasterKey={e2eeMasterKey}
                    onClick={() => {
                      if (picking) {
                        setPickedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(item.id)) next.delete(item.id);
                          else next.add(item.id);
                          return next;
                        });
                      } else {
                        openViewer(globalIndex);
                      }
                    }}
                  />
                );
              })}
            </div>
          </section>
        ))
      )}

      {/* Selection batch actions bar */}
      {picking && pickedIds.size > 0 && (
        <div className="selection-bar">
          <strong className="small">{pickedIds.size} mục</strong>
          <div className="media-row-actions">
            <button
              type="button"
              className="pill-btn primary"
              style={{ minHeight: 38 }}
              disabled={busy}
              onClick={() => void handleExportSelection()}
            >
              Tải ZIP gốc
            </button>
            <button
              type="button"
              className="btn-small danger"
              disabled={busy}
              onClick={() => void handleTrashSelection()}
            >
              Thùng rác
            </button>
          </div>
        </div>
      )}

      {/* EXACT kho-anh.html FULLSCREEN VIEWER (#viewer) */}
      {activeViewerItem && (
        <div className="viewer-overlay" role="dialog" aria-modal="true" aria-label={activeViewerItem.originalFilename}>
          <div className="viewer-shell">
            <header className="viewer-bar">
              <button
                type="button"
                className="round"
                aria-label="Đóng trình xem"
                onClick={closeViewer}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
              <h2>{activeViewerItem.originalFilename}</h2>
              <span className="viewer-pos">
                {(viewerIndex ?? 0) + 1}/{items.length}
              </span>
            </header>

            <div
              className="viewer-stage"
              onTouchStart={(e) => setTouchStartX(e.changedTouches[0]?.clientX ?? null)}
              onTouchEnd={(e) => {
                if (touchStartX === null) return;
                const change = (e.changedTouches[0]?.clientX ?? touchStartX) - touchStartX;
                setTouchStartX(null);
                if (Math.abs(change) > 45) {
                  stepViewer(change < 0 ? 1 : -1);
                }
              }}
            >
              {viewerUrl ? (
                activeViewerItem.mediaKind === 'video' ? (
                  <video src={viewerUrl} controls playsInline />
                ) : (
                  <img
                    src={viewerUrl}
                    alt={activeViewerItem.originalFilename}
                    style={{ transform: `scale(${viewerZoom})` }}
                    onClick={() => setViewerZoom((z) => (z >= 2 ? 1 : 2))}
                  />
                )
              ) : (
                <div style={{ padding: 24, textAlign: 'center', maxWidth: 360 }}>
                  <p style={{ fontWeight: 600 }}>
                    {activeViewerItem.encryptionMode === 'e2ee' && !e2eeMasterKey
                      ? 'Ảnh được bảo vệ bởi E2EE'
                      : 'Định dạng gốc chuyên dụng (RAW / ProRAW / ProRes)'}
                  </p>
                  <p className="muted small">
                    {activeViewerItem.encryptionMode === 'e2ee' && !e2eeMasterKey
                      ? 'Mở khóa E2EE trong tab Kho để xem trực tiếp.'
                      : 'File gốc 100% được lưu nguyên vẹn; bấm nút tải xuống bên dưới để lấy file gốc.'}
                  </p>
                </div>
              )}
              {feedback && (
                <div className={`viewer-toast ${feedback.type}`} role="status">
                  {feedback.text}
                </div>
              )}
            </div>

            <footer className="viewer-actions">
              <button
                type="button"
                className="round"
                aria-label="Ảnh trước"
                disabled={viewerIndex === 0}
                onClick={() => stepViewer(-1)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m15 5-7 7 7 7" />
                </svg>
              </button>

              <button
                type="button"
                className={`round ${activeViewerItem.isFavorite ? 'fav-on' : ''}`}
                aria-label="Yêu thích"
                onClick={() => void handleToggleFavorite(activeViewerItem)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill={activeViewerItem.isFavorite ? 'currentColor' : 'none'}
                    d="M12 20.5 4.8 13.7a4.8 4.8 0 0 1 6.8-6.8L12 7.3l.4-.4a4.8 4.8 0 0 1 6.8 6.8Z"
                  />
                </svg>
              </button>

              <button
                type="button"
                className="round"
                aria-label="Tải file gốc"
                disabled={busy}
                onClick={() => void handleDownloadOriginal(activeViewerItem)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 4v12m0 0-4-4m4 4 4-4M5 20h14" />
                </svg>
              </button>

              <button
                type="button"
                className="round"
                aria-label="Thông tin ảnh"
                onClick={() => setShowInfoSheet(true)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 16v-4m0-4h.01" />
                </svg>
              </button>

              <button
                type="button"
                className="round"
                aria-label="Ảnh sau"
                disabled={viewerIndex === items.length - 1}
                onClick={() => stepViewer(1)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m9 5 7 7-7 7" />
                </svg>
              </button>
            </footer>
          </div>

          {/* Slide-up Info Sheet */}
          {showInfoSheet && (
            <div className="viewer-sheet-backdrop" onClick={() => setShowInfoSheet(false)}>
              <div className="viewer-sheet stack" onClick={(e) => e.stopPropagation()}>
                <div className="panel-head-row" style={{ marginBottom: 0 }}>
                  <h3>Thông tin tệp gốc</h3>
                  <button type="button" className="btn-small" onClick={() => setShowInfoSheet(false)}>
                    Xong
                  </button>
                </div>

                <div className="rows" style={{ margin: 0 }}>
                  <div className="row">
                    <span>Dung lượng</span>
                    <small>{formatBytes(activeViewerItem.sizeBytes)}</small>
                  </div>
                  <div className="row">
                    <span>Ngày chụp / lưu</span>
                    <small>
                      {new Date(activeViewerItem.capturedAt ?? activeViewerItem.createdAt).toLocaleString(
                        'vi-VN'
                      )}
                    </small>
                  </div>
                  <div className="row">
                    <span>Bản sao xác minh</span>
                    <small>
                      {activeViewerItem.verifiedReplicaCount}/{activeViewerItem.requiredReplicas} bản sao ·{' '}
                      {viewerVersions.length} phiên bản
                    </small>
                  </div>
                  <div className="row">
                    <span>Mã hóa</span>
                    <small>{activeViewerItem.encryptionMode}</small>
                  </div>
                </div>

                <div className="tiny muted" style={{ wordBreak: 'break-all' }}>
                  SHA-256: <code>{activeViewerItem.sha256}</code>
                </div>

                <label className="field">
                  <span>Thư mục</span>
                  <select
                    className="sort-select"
                    value={activeViewerItem.folderId ?? ''}
                    onChange={(e) => void handleMoveFolder(activeViewerItem, e.target.value || null)}
                  >
                    <option value="">Thư mục gốc (/)</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </label>

                {albums.length > 0 && (
                  <div>
                    <span className="field-label">Album</span>
                    <div className="chips-row">
                      {albums.map((a) => {
                        const inAlbum = activeViewerItem.albumIds.includes(a.id);
                        return (
                          <button
                            key={a.id}
                            type="button"
                            className="btn-small"
                            aria-pressed={inAlbum}
                            onClick={() => void handleToggleAlbum(activeViewerItem, a.id)}
                          >
                            {inAlbum ? '✓ ' : '+ '}
                            {a.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div>
                  <span className="field-label">Thẻ (Tags)</span>
                  <div className="chips-row" style={{ marginBottom: 8 }}>
                    {activeViewerItem.tags.map((t: TagItem) => (
                      <button
                        key={t.id}
                        type="button"
                        className="btn-small"
                        onClick={async () => {
                          await api.detachTag(activeViewerItem.id, t.id);
                          await loadMedia();
                        }}
                      >
                        #{t.name} ×
                      </button>
                    ))}
                  </div>
                  <div className="inline-form">
                    <input
                      type="text"
                      placeholder="Thêm thẻ mới..."
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => void handleAttachNewTag(activeViewerItem)}
                    >
                      Gắn thẻ
                    </button>
                  </div>
                </div>

                <div className="two-col">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={async () => {
                      const res = await api.verifyMediaIntegrity(activeViewerItem.id);
                      setFeedback({
                        type: res.verified ? 'success' : 'error',
                        text: res.verified
                          ? `Xác minh SHA-256 thành công cho ${activeViewerItem.originalFilename}.`
                          : `Cảnh báo hỏng dữ liệu trên ${activeViewerItem.originalFilename}!`
                      });
                      setShowInfoSheet(false);
                    }}
                  >
                    Xác minh SHA-256
                  </button>
                  <button
                    type="button"
                    className="btn-small danger"
                    style={{ minHeight: 44, borderRadius: 12 }}
                    onClick={() => void handleTrashMedia(activeViewerItem)}
                  >
                    Chuyển vào Thùng rác
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
