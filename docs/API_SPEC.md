# Tài liệu API Specification (v1)

Tất cả endpoint ngoại trừ `/health` và `/api/v1/auth/{register,login,refresh,recover}` yêu cầu header `Authorization: Bearer <accessToken>` và tự động ép ranh giới cô lập tài khoản (`user_id`).

## 1. Hệ thống & Xác thực (`/api/v1/auth`)
- `GET /health` — Kiểm tra tình trạng API & driver DB (`pg` / `pglite`).
- `POST /api/v1/auth/register` — Đăng ký tài khoản, chọn `encryptionMode` (`server_side` | `e2ee`), trả về JWT + Refresh Token + 10 mã khôi phục dùng 1 lần. Tài khoản đầu tiên tự nhận vai trò `admin` + `user`.
- `POST /api/v1/auth/login` — Đăng nhập, ghi nhận thiết bị, trả `e2eeKeyBundle` (chỉ ciphertext bọc khóa) nếu tài khoản dùng E2EE.
- `POST /api/v1/auth/refresh` — Xoay vòng Refresh Token (phát hiện tái sử dụng sẽ thu hồi toàn bộ chuỗi phiên `token_family`).
- `POST /api/v1/auth/logout` — Đăng xuất và thu hồi refresh token của thiết bị hiện tại.
- `POST /api/v1/auth/recover` — Đặt lại mật khẩu đăng nhập bằng mã khôi phục dùng 1 lần (trả `e2eeVaultUnlockRequired: true` cho tài khoản E2EE).

## 2. Tài khoản, Thiết bị & Thông báo
- `GET /api/v1/users/me` — Hồ sơ tài khoản + chính sách hệ thống hiện hành.
- `PATCH /api/v1/users/me/password` — Đổi mật khẩu & thu hồi phiên các thiết bị khác.
- `POST /api/v1/users/me/recovery-codes/regenerate` — Tạo bộ 10 mã khôi phục mới.
- `PUT /api/v1/users/me/e2ee-key` — Cập nhật gói khóa E2EE đã bọc phía client.
- `GET /api/v1/devices`, `PATCH /api/v1/devices/:deviceId/trust`, `DELETE /api/v1/devices/:deviceId` — Quản lý, đánh dấu tin cậy và thu hồi tức thì thiết bị.
- `GET /api/v1/security/events` — Nhật ký bảo mật tối thiểu hóa metadata của chính người dùng.
- `GET /api/v1/notifications`, `PATCH /api/v1/notifications/:id/read`, `POST /api/v1/notifications/read-all`.

## 3. Sao lưu Resumable & Kiểm tra Trùng lặp (`/api/v1/uploads`)
- `POST /api/v1/uploads/check-duplicates` — Kiểm tra file trùng & phiên dở dang chỉ trong phạm vi `user_id`.
- `POST /api/v1/uploads/init` — Khởi tạo hoặc tự động nối lại (resume) phiên upload multipart. Bắt buộc `networkType: "wifi"`, chỉ chấp nhận ảnh/video, kiểm tra quota.
- `GET /api/v1/uploads/:sessionId` — Xem tiến độ & danh sách chunk đã nhận.
- `PUT /api/v1/uploads/:sessionId/parts/:partNumber` — Upload chunk nhị phân (`application/octet-stream`) kèm header `X-Part-SHA256`.
- `POST /api/v1/uploads/:sessionId/complete` — Ghép file, đối chiếu 100% kích thước & SHA-256, tạo v1 trong `file_versions`, phân biệt `insufficient_replicas` vs `verified`.
- `DELETE /api/v1/uploads/:sessionId` — Hủy phiên upload và xóa chunk tạm.

## 4. Thư viện, Phân loại & Streaming (Không tìm kiếm, không chia sẻ, không GPS)
- `GET /api/v1/media` — Lọc theo `kind`, `favoriteOnly`, `albumId`, `folderId`, `tagId`, `deviceId` và sắp xếp theo `captured_at | created_at | size_bytes | original_filename`.
- `PATCH /api/v1/media/:mediaId` — Cập nhật `isFavorite` hoặc chuyển `folderId`.
- `GET /api/v1/media/:mediaId/stream` — Streaming HTTP `206 Partial Content` hỗ trợ tua video & xem ảnh.
- `GET /api/v1/media/:mediaId/download` — Tải file gốc 100% nguyên bản kèm `X-Content-SHA256`.
- `GET /api/v1/media/:mediaId/verify` — Băm lại SHA-256 trực tiếp từ kho lưu trữ để xác minh toàn vẹn.
- `GET/POST/PATCH/DELETE /api/v1/folders` — Thư mục nhiều cấp có chống vòng lặp cha-con; xóa thư mục không xóa media gốc.
- `GET/POST/PATCH/DELETE /api/v1/albums`, `POST /api/v1/albums/:id/media`, `DELETE /api/v1/albums/:id/media/:mediaId`.
- `GET/POST/DELETE /api/v1/tags`, `POST/DELETE /api/v1/media/:id/tags`.

## 5. Khôi phục, Dung lượng, Trùng lặp, Thùng rác & Phiên bản
- `POST /api/v1/restore/export-zip` — Xuất ZIP không nén (STORE) theo `selection | album | folder | all`, giữ nguyên cấu trúc thư mục/album + `restore-manifest.json` chứa SHA-256.
- `GET /api/v1/storage/summary` — Thống kê dung lượng ảnh/video, số file đạt đủ bản sao an toàn để giải phóng bộ nhớ máy, trùng lặp & thùng rác.
- `GET /api/v1/storage/duplicates` — Nhóm các file trùng SHA-256 trong kho (không tự xóa).
- `POST /api/v1/media/:mediaId/trash`, `GET /api/v1/trash`, `POST /api/v1/trash/:mediaId/restore`, `DELETE /api/v1/trash/:mediaId` (xóa vĩnh viễn thủ công trên mọi replica & giải phóng quota).
- `GET /api/v1/media/:mediaId/versions`, `DELETE /api/v1/media/:mediaId/versions/:versionNumber` (cấm xóa phiên bản duy nhất đang bảo vệ file).

## 6. Quản trị Hạ tầng & Độ tin cậy 3 Bản sao (`/api/v1/admin` — yêu cầu vai trò `admin`)
- `GET /api/v1/admin/overview`, `GET /api/v1/admin/users`, `PATCH /api/v1/admin/users/:userId`, `GET/PATCH /api/v1/admin/settings`.
- `POST /api/v1/admin/replication/run` — Nhân bản các file đã xác minh sang Copy 2 & Copy 3 và thăng hạng `verified`.
- `POST /api/v1/admin/integrity/scan` — Quét bit-rot trên mọi bản sao và tự động phục hồi từ bản sao lành mạnh.
- `GET /api/v1/admin/integrity/summary` — Tổng hợp số lượng bản sao theo trạng thái (không lộ nội dung media cá nhân).
