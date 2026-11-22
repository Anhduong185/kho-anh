import React, { useCallback, useEffect, useState } from 'react';
import type { AlbumItem, FolderItem, StorageSummaryResponse, TagItem } from '@smb/shared';
import { api } from '../api/client';
import type { LibraryFilterContext } from './LibraryPanel';
import { StorageAndRestorePanel } from './StorageAndRestorePanel';

export function AlbumsHubPanel({
  refreshKey,
  onOpenCollection,
  onChanged
}: {
  refreshKey: number;
  onOpenCollection: (ctx: LibraryFilterContext) => void;
  onChanged: () => void;
}) {
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [tags, setTags] = useState<TagItem[]>([]);
  const [summary, setSummary] = useState<StorageSummaryResponse | null>(null);

  const [showCreate, setShowCreate] = useState<'album' | 'folder' | null>(null);
  const [newName, setNewName] = useState('');
  const [parentFolderId, setParentFolderId] = useState('');
  const [subScreen, setSubScreen] = useState<'main' | 'utilities'>('main');

  const loadAll = useCallback(async () => {
    try {
      const [aRes, fRes, tRes, sumRes] = await Promise.all([
        api.listAlbums(),
        api.listFolders(),
        api.listTags(),
        api.storageSummary()
      ]);
      setAlbums(aRes.albums);
      setFolders(fRes.folders);
      setTags(tRes.tags);
      setSummary(sumRes);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll, refreshKey]);

  if (subScreen === 'utilities') {
    return (
      <>
        <header className="top">
          <div className="top-row">
            <button
              type="button"
              className="round"
              aria-label="Quay lại Album"
              onClick={() => setSubScreen('main')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m15 5-7 7 7 7" />
              </svg>
            </button>
            <h1>Khôi phục & Tiện ích</h1>
          </div>
          <p className="hint">Xuất ZIP không nén · Trùng lặp · Thùng rác</p>
        </header>
        <StorageAndRestorePanel
          onChanged={() => {
            void loadAll();
            onChanged();
          }}
        />
      </>
    );
  }

  return (
    <>
      <header className="top">
        <div className="top-row">
          <h1>Album</h1>
          <button
            type="button"
            className="pill-btn"
            onClick={() => setShowCreate((v) => (v === 'album' ? null : 'album'))}
          >
            + Album
          </button>
          <button
            type="button"
            className="pill-btn"
            onClick={() => setShowCreate((v) => (v === 'folder' ? null : 'folder'))}
          >
            + Thư mục
          </button>
        </div>
        <p className="hint">
          {albums.length} album · {folders.length} thư mục · {tags.length} thẻ
        </p>
      </header>

      {showCreate && (
        <section className="panel">
          <h3>{showCreate === 'album' ? 'Tạo Album mới' : 'Tạo Thư mục nhiều cấp'}</h3>
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newName.trim()) return;
              if (showCreate === 'album') {
                await api.createAlbum(newName.trim());
              } else {
                await api.createFolder(newName.trim(), parentFolderId || null);
              }
              setNewName('');
              setParentFolderId('');
              setShowCreate(null);
              await loadAll();
            }}
          >
            <input
              type="text"
              autoFocus
              required
              placeholder={showCreate === 'album' ? 'VD: Du lịch Đà Lạt' : 'VD: Năm 2026'}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            {showCreate === 'folder' && (
              <select
                className="sort-select"
                value={parentFolderId}
                onChange={(e) => setParentFolderId(e.target.value)}
              >
                <option value="">Thư mục gốc (/)</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    Bên trong: {f.name}
                  </option>
                ))}
              </select>
            )}
            <button type="submit" className="btn-primary">
              Tạo ngay
            </button>
          </form>
        </section>
      )}

      {/* Smart collections — exact kho-anh.html grouped .rows look */}
      <div className="group-label">Loại phương tiện</div>
      <div className="rows">
        <button
          type="button"
          className="row-btn"
          onClick={() => onOpenCollection({ title: 'Gần đây', kind: 'all' })}
        >
          <strong>Gần đây</strong>
          <span className="row-right">
            {summary?.totalFiles ?? 0} mục ›
          </span>
        </button>
        <button
          type="button"
          className="row-btn"
          onClick={() => onOpenCollection({ title: 'Yêu thích', favoriteOnly: true })}
        >
          <strong>Yêu thích</strong>
          <span className="row-right">♥ ›</span>
        </button>
        <button
          type="button"
          className="row-btn"
          onClick={() => onOpenCollection({ title: 'Ảnh', kind: 'image' })}
        >
          <strong>Ảnh</strong>
          <span className="row-right">{summary?.imageCount ?? 0} mục ›</span>
        </button>
        <button
          type="button"
          className="row-btn"
          onClick={() => onOpenCollection({ title: 'Video', kind: 'video' })}
        >
          <strong>Video</strong>
          <span className="row-right">{summary?.videoCount ?? 0} mục ›</span>
        </button>
      </div>

      {/* My Albums */}
      <div className="group-label">Album của tôi ({albums.length})</div>
      <div className="rows">
        {albums.length === 0 ? (
          <div className="row">
            <span className="muted">Chưa có album nào</span>
            <small>Bấm + Album</small>
          </div>
        ) : (
          albums.map((a) => (
            <div key={a.id} className="row">
              <button
                type="button"
                className="row-btn"
                style={{ minHeight: 44, padding: 0 }}
                onClick={() => onOpenCollection({ title: a.name, albumId: a.id })}
              >
                <strong>{a.name}</strong>
                <span className="row-right">{a.mediaCount} mục ›</span>
              </button>
              <button
                type="button"
                className="btn-small danger"
                onClick={async () => {
                  await api.deleteAlbum(a.id);
                  await loadAll();
                }}
              >
                Xóa
              </button>
            </div>
          ))
        )}
      </div>

      {/* Multi-level Folders */}
      <div className="group-label">Thư mục ({folders.length})</div>
      <div className="rows">
        {folders.length === 0 ? (
          <div className="row">
            <span className="muted">Chưa có thư mục nào</span>
            <small>Bấm + Thư mục</small>
          </div>
        ) : (
          folders.map((f) => {
            const parentName = f.parentId ? folders.find((p) => p.id === f.parentId)?.name : null;
            const fullName = parentName ? `${parentName} / ${f.name}` : f.name;
            return (
              <div key={f.id} className="row">
                <button
                  type="button"
                  className="row-btn"
                  style={{ minHeight: 44, padding: 0 }}
                  onClick={() => onOpenCollection({ title: fullName, folderId: f.id })}
                >
                  <strong>{fullName}</strong>
                  <span className="row-right">{f.mediaCount} mục ›</span>
                </button>
                <button
                  type="button"
                  className="btn-small danger"
                  onClick={async () => {
                    await api.deleteFolder(f.id);
                    await loadAll();
                  }}
                >
                  Xóa
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Tags */}
      {tags.length > 0 && (
        <>
          <div className="group-label">Thẻ ({tags.length})</div>
          <div className="rows">
            {tags.map((t) => (
              <button
                key={t.id}
                type="button"
                className="row-btn"
                onClick={() => onOpenCollection({ title: `#${t.name}`, tagId: t.id })}
              >
                <strong>#{t.name}</strong>
                <span className="row-right">{t.mediaCount ?? 0} mục ›</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Utilities (Duplicates, Trash, Lossless Full ZIP Export) */}
      <div className="group-label">Tiện ích & Khôi phục</div>
      <div className="rows">
        <button type="button" className="row-btn" onClick={() => setSubScreen('utilities')}>
          <strong>Mục trùng lặp</strong>
          <span className="row-right">{summary?.duplicateGroupCount ?? 0} nhóm ›</span>
        </button>
        <button type="button" className="row-btn" onClick={() => setSubScreen('utilities')}>
          <strong>Thùng rác</strong>
          <span className="row-right">{summary?.trashCount ?? 0} mục ›</span>
        </button>
        <button type="button" className="row-btn" onClick={() => setSubScreen('utilities')}>
          <strong>Xuất khôi phục toàn bộ (ZIP gốc)</strong>
          <span className="row-right">Không nén ›</span>
        </button>
      </div>
    </>
  );
}
