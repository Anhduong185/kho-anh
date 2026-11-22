# Mô hình Dữ liệu (PostgreSQL Schema)

Schema khởi tạo nằm tại `backend/src/db/migrations/001_initial_schema.sql`, bao phủ đầy đủ 14 nhóm bảng trong PRD Mục 7.1.

## Nguyên tắc bảo vệ dữ liệu ở tầng Database
1. **Tenant / User Scope bắt buộc:** Mọi bảng dữ liệu cá nhân (`devices`, `media_files`, `albums`, `folders`, `tags`, `backup_jobs`, `storage_objects`, `file_versions`, `trash_items`, `notifications`) đều có khóa ngoại `user_id` tham chiếu `users(id)`. Mọi truy vấn API người dùng bắt buộc lọc `WHERE user_id = $authUserId`.
2. **Không lưu khóa giải mã E2EE dạng rõ:** Khi `users.encryption_mode = 'e2ee'`, database chỉ lưu `e2ee_encrypted_master_key` (đã bọc phía client), `e2ee_key_salt` và `e2ee_kdf_params`.
3. **Liên kết đa phương thức xác thực:** Bảng `auth_identities` tách khỏi `users` để sẵn sàng liên kết Email/Password, Google, Apple, Telegram, SĐT+OTP và Passkey về chung một tài khoản duy nhất.
4. **Deduplication trong phạm vi tài khoản:** Chỉ mục `idx_media_files_user_sha256` đặt trên `(user_id, sha256)` — tuyệt đối không dedup xuyên tài khoản (tránh lộ sự tồn tại file giữa các tài khoản).

## Danh sách bảng chính
1. `users` — Tài khoản, `encryption_mode` (`server_side` | `e2ee`), `quota_bytes`, `used_bytes`, `is_active`, metadata bọc khóa E2EE.
2. `roles`, `user_roles` — Phân quyền RBAC (`user`, `admin`).
3. `auth_identities`, `refresh_tokens`, `recovery_codes` — Xác thực đa phương thức, xoay vòng refresh token theo gia đình (`token_family`), mã khôi phục dùng một lần dạng hash.
4. `devices` — Thiết bị được ủy quyền của từng tài khoản (`ios`, `android`, `windows`, `web`), trạng thái `is_trusted`, `revoked_at`.
5. `folders`, `albums`, `media_files`, `album_media` — Cấu trúc thư mục nhiều cấp (`parent_id`), album và metadata file gốc kèm 8 trạng thái sao lưu.
6. `tags`, `media_tags` — Gắn nhãn và lọc không cần tìm kiếm toàn văn.
7. `backup_jobs`, `backup_items` — Phiên sao lưu, chính sách mạng (`wifi_only`) và từng file trong hàng đợi.
8. `storage_objects`, `replica_status` — Ánh xạ object lưu trữ và trạng thái xác minh checksum từng bản sao (`copy1_primary`, `copy2_secondary`, `copy3_offsite`).
9. `file_versions` — Lịch sử phiên bản (giữ vô thời hạn cho tới khi người dùng xóa thủ công).
10. `trash_items` — Thùng rác mềm phía server trước khi xóa vĩnh viễn.
11. `security_events` — Nhật ký sự kiện bảo mật tối thiểu hóa metadata vận hành.
12. `notifications` — 7 nhóm thông báo theo PRD Mục 5.2.
13. `system_settings` — Cấu hình hệ thống do Admin quản trị (`upload_network_policy`, `retention_policy`, `gps_map_enabled`, `registration_enabled`, `required_replicas`...).
