# Kế hoạch Kiểm thử & Nghiệm thu (PRD Mục 11)

Toàn bộ các ca kiểm thử bắt buộc trong PRD Mục 11 được tự động hóa bằng `Vitest` chạy trên PostgreSQL thực (`PGlite` in-memory) và Storage Adapter cục bộ độc lập:

| Bộ test | Các kịch bản kiểm chứng |
| :--- | :--- |
| `backend/tests/auth.test.ts` | Đăng ký bootstrap Admin, chống trùng email (`409`), xoay vòng Refresh Token & thu hồi cả chuỗi phiên khi phát hiện tái sử dụng, khôi phục tài khoản E2EE bằng recovery code dùng 1 lần (flag `e2eeVaultUnlockRequired: true`), thu hồi thiết bị chặn access token ngay lập tức. |
| `backend/tests/rbac_isolation.test.ts` | Cô lập hoàn toàn giữa Tài khoản A và Tài khoản B, chặn người dùng thường gọi `/api/v1/admin/*` (`403`), xác minh ranh giới riêng tư Admin (không thấy password hash, khóa E2EE hay file media người dùng), chặn Admin tự khóa tài khoản của chính mình. |
| `backend/tests/storage_adapter.test.ts` | Lưu/đọc nguyên bản từng byte + đối chiếu SHA-256, từ chối khi sai checksum, chống path traversal, ghép multipart đúng thứ tự & checksum. |
| `backend/tests/backup_upload.test.ts` | Chặn upload qua dữ liệu di động (`403 WIFI_REQUIRED`), từ chối tài liệu PDF/DOCX (`400`), upload multipart bị ngắt giữa chừng → nối lại (resume) → đối chiếu SHA-256 → phân biệt trạng thái `insufficient_replicas` (1/3) → tải về khớp 100% từng byte → chặn Bob & Admin tải file của Alice (`404`) → xác nhận không rò rỉ dedup xuyên tài khoản → từ chối file hỏng checksum (`422`) → chặn vượt quota (`413`). |
| `backend/tests/sha256_and_formats.test.ts` | Khớp 100% SHA-256 thuần TypeScript với OpenSSL ở mọi mốc kích thước biên; phân loại chuẩn HEIC, ProRAW/DNG, CR3, ARW, TIFF, MOV, ProRes, MXF. |
| `backend/tests/library_restore_trash.test.ts` | Thư mục nhiều cấp + chống vòng lặp cha-con, Album, Tag, Yêu thích, HTTP `206 Partial Content` streaming, xuất ZIP không nén (STORE) bảo toàn cấu trúc thư mục/album + `restore-manifest.json` + khớp từng byte, Duplicate Center không tự xóa, cấm xóa phiên bản duy nhất, Thùng rác → Khôi phục → Xóa vĩnh viễn thủ công thu hồi dung lượng, xóa thư mục không xóa ảnh gốc. |
| `backend/tests/replication_and_healing.test.ts` | Nhân bản sang Copy 2 và thăng hạng `verified`; lần lượt làm hỏng Copy 2 rồi Copy 1 để xác nhận phục hồi khớp file gốc. Không ghi vào kho Copy 3 cũ. |
| `backend/tests/e2ee_roundtrip.test.ts` | Mã hóa phía client (PBKDF2-SHA256 + AES-256-GCM), upload ciphertext lên server, xác nhận server & Admin chỉ thấy ciphertext không thể đọc nội dung gốc, sai mật khẩu giải mã thất bại, đúng Master Key giải mã khôi phục 100% file gốc từng byte. |

## Lệnh chạy kiểm thử
```powershell
npm.cmd run build
npm.cmd test
```
