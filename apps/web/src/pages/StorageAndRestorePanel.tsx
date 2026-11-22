import React, { useCallback, useEffect, useState } from 'react';
import type { DuplicateGroup, StorageSummaryResponse, TrashItemSummary } from '@smb/shared';
import { api, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { formatBytes } from '../utils/e2ee';

export function StorageAndRestorePanel({ onChanged }: { onChanged: () => void }) {
  const { refreshProfile } = useAuth();
  const [summary, setSummary] = useState<StorageSummaryResponse | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [trash, setTrash] = useState<TrashItemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [sum, dup, tr] = await Promise.all([
        api.storageSummary(),
        api.listDuplicates(),
        api.listTrash()
      ]);
      setSummary(sum);
      setDuplicates(dup.groups);
      setTrash(tr.items);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Không tải được thống kê dung lượng'
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleExportAll = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const { blob } = await api.exportZip({ scope: 'all' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vault-full-restore-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setFeedback({
        type: 'success',
        text: 'Đã xuất toàn bộ thư viện dạng ZIP không nén (STORE) giữ nguyên cấu trúc thư mục, album và file gốc + manifest SHA-256.'
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Xuất thư viện thất bại'
      });
    } finally {
      setBusy(false);
    }
  };

  const handleTrashDuplicate = async (mediaId: string, filename: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      await api.trashMedia(mediaId);
      setFeedback({
        type: 'success',
        text: `Đã chuyển bản trùng "${filename}" vào Thùng rác (bạn vẫn có thể khôi phục hoặc xóa vĩnh viễn).`
      });
      await loadAll();
      onChanged();
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof ApiError ? err.message : 'Thao tác thất bại' });
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreTrash = async (mediaId: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      await api.restoreTrash(mediaId);
      setFeedback({ type: 'success', text: 'Đã khôi phục file về lại Thư viện.' });
      await loadAll();
      onChanged();
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof ApiError ? err.message : 'Khôi phục thất bại' });
    } finally {
      setBusy(false);
    }
  };

  const handlePermanentDelete = async (item: TrashItemSummary) => {
    if (!window.confirm(`Xóa vĩnh viễn "${item.originalFilename}" khỏi tất cả bản sao? Không thể hoàn tác.`)) {
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api.permanentDeleteTrash(item.mediaId);
      setFeedback({
        type: 'success',
        text: `Đã xóa vĩnh viễn "${item.originalFilename}", giải phóng ${formatBytes(res.freedBytes)}.`
      });
      await Promise.all([loadAll(), refreshProfile()]);
      onChanged();
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof ApiError ? err.message : 'Xóa vĩnh viễn thất bại' });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="panel muted">Đang tổng hợp dữ liệu dung lượng & khôi phục...</div>;
  }

  return (
    <div className="stack-lg">
      {feedback && <div className={`alert ${feedback.type}`}>{feedback.text}</div>}

      {summary && (
        <>
          <div className="stats-grid">
            <div className="stat-card">
              <span className="muted small">Ảnh đã sao lưu ({summary.imageCount})</span>
              <strong>{formatBytes(summary.imageBytes)}</strong>
            </div>
            <div className="stat-card">
              <span className="muted small">Video đã sao lưu ({summary.videoCount})</span>
              <strong>{formatBytes(summary.videoBytes)}</strong>
            </div>
            <div className="stat-card">
              <span className="muted small">
                An toàn đủ {summary.requiredReplicas} bản sao ({summary.verifiedSafeCount})
              </span>
              <strong>{formatBytes(summary.verifiedSafeBytes)}</strong>
            </div>
            <div className="stat-card">
              <span className="muted small">File trùng có thể tiết kiệm</span>
              <strong>{formatBytes(summary.duplicateReclaimableBytes)}</strong>
            </div>
          </div>

          <section className="panel">
            <div className="panel-head-row">
              <div>
                <h3>Khôi phục toàn bộ thư viện (Lossless ZIP STORE)</h3>
                <p className="muted small">
                  Tải về toàn bộ ảnh/video gốc không nén (giữ nguyên 100% từng byte), bảo toàn cây thư
                  mục nhiều cấp, phân nhóm album và kèm file <code>restore-manifest.json</code> chứa
                  SHA-256 để đối chiếu.
                </p>
              </div>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || summary.totalFiles === 0}
                onClick={() => void handleExportAll()}
              >
                {busy ? 'Đang đóng gói...' : `Xuất toàn bộ (${summary.totalFiles} file)`}
              </button>
            </div>
            <div className="privacy-banner" style={{ marginTop: 12 }}>
              <strong>Giải phóng dung lượng điện thoại an toàn (PRD 3.5):</strong> Chỉ nên xóa ảnh gốc
              trên điện thoại đối với <strong>{summary.verifiedSafeCount}</strong> file đã đạt đủ{' '}
              <strong>{summary.requiredReplicas} bản sao xác minh</strong> (
              {formatBytes(summary.verifiedSafeBytes)}). Hiện có{' '}
              <strong>{summary.insufficientReplicaCount}</strong> file mới có 1 bản sao xác minh — chưa
              đề xuất xóa trên thiết bị.
            </div>
          </section>
        </>
      )}

      <section className="panel">
        <h3>Trung tâm file trùng lặp ({duplicates.length} nhóm)</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Nhận diện bằng SHA-256 chỉ trong kho của bạn. Hệ thống <strong>không bao giờ tự xóa</strong>{' '}
          — bạn tự chọn bản trùng muốn chuyển vào Thùng rác.
        </p>
        {duplicates.length === 0 ? (
          <p className="muted">Không có file trùng lặp nào trong kho.</p>
        ) : (
          <div className="device-list">
            {duplicates.map((grp) => (
              <div key={grp.sha256} className="queue-card">
                <div className="queue-top">
                  <div>
                    <strong>{grp.count} bản giống hệt nhau</strong> · {formatBytes(grp.sizeBytes)} / file
                    <div className="muted tiny">
                      SHA-256: <code>{grp.sha256.slice(0, 18)}…</code> · Tiết kiệm tối đa{' '}
                      {formatBytes(grp.reclaimableBytes)}
                    </div>
                  </div>
                </div>
                {grp.files.map((f, idx) => (
                  <div key={f.id} className="policy-row">
                    <div>
                      <span>{f.originalFilename}</span>{' '}
                      {idx === 0 && <span className="pill ok">Bản đầu tiên (nên giữ)</span>}
                      <div className="muted tiny">{new Date(f.createdAt).toLocaleString('vi-VN')}</div>
                    </div>
                    {idx > 0 && (
                      <button
                        type="button"
                        className="btn-small danger"
                        disabled={busy}
                        onClick={() => void handleTrashDuplicate(f.id, f.originalFilename)}
                      >
                        Chuyển vào thùng rác
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Thùng rác ({trash.length})</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Theo chính sách lưu giữ vô thời hạn bạn đã chốt, file trong thùng rác chỉ bị xóa vĩnh viễn khi
          bạn bấm <strong>Xóa vĩnh viễn</strong> thủ công.
        </p>
        {trash.length === 0 ? (
          <p className="muted">Thùng rác đang trống.</p>
        ) : (
          <div className="device-list">
            {trash.map((t) => (
              <div key={t.mediaId} className="device-row">
                <div>
                  <strong>{t.originalFilename}</strong>
                  <div className="muted tiny">
                    {formatBytes(t.sizeBytes)} · Đưa vào lúc{' '}
                    {new Date(t.trashedAt).toLocaleString('vi-VN')}
                  </div>
                </div>
                <div className="media-row-actions">
                  <button
                    type="button"
                    className="btn-small"
                    disabled={busy}
                    onClick={() => void handleRestoreTrash(t.mediaId)}
                  >
                    Khôi phục
                  </button>
                  <button
                    type="button"
                    className="btn-small danger"
                    disabled={busy}
                    onClick={() => void handlePermanentDelete(t)}
                  >
                    Xóa vĩnh viễn
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
