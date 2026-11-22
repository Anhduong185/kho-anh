# PRD — Ứng dụng Sao lưu Ảnh và Video Bảo mật (v1.1 — Đã chốt quyết định mở)

Tài liệu này chuyển thể và cập nhật từ `PRD_Kien_truc_Ung_dung_Sao_luu_Anh_Video.docx` (v1.0) kèm các quyết định đã xác nhận để làm cơ sở triển khai trực tiếp.

## 1. Các quyết định đã chốt (cập nhật Mục 9.1)
| Hạng mục | Quyết định đã chốt |
| :--- | :--- |
| Điều kiện mạng upload | **Chỉ cho phép upload qua Wi-Fi** (không dùng dữ liệu di động). |
| Phạm vi chế độ mã hóa | **Chọn theo tài khoản** (`server_side` hoặc `e2ee`). |
| Lưu giữ dữ liệu & phiên bản | **Lưu giữ vô thời hạn**, chỉ xóa khi người dùng **xóa thủ công**. |
| Bản đồ GPS | **Không triển khai** (`gps_map_enabled = false`). |
| Hạ tầng triển khai ban đầu | **Cloud miễn phí** (Render / Oracle Cloud + Neon PostgreSQL + R2 / B2 / OCI qua Storage Adapter). |
| Stack công nghệ | **Backend:** Node.js + TypeScript (Fastify) · **DB:** PostgreSQL (Neon / PGlite dev) · **Client giai đoạn đầu:** React + TypeScript PWA (Web, Windows, Android, iPhone Safari) · **Native Mobile giai đoạn sau:** Expo / React Native (build `.apk` & `.ipa` cho SideStore/TestFlight). |

## 2. Nguyên tắc sản phẩm bất biến
1. **Backup một chiều:** Xóa ảnh trên thiết bị không xóa bản sao trên server; không đồng bộ hai chiều.
2. **Bảo toàn 100% file gốc & metadata:** Mọi định dạng ảnh/video (bao gồm HEIC, RAW/ProRAW, DNG, TIFF, ProRes...) được lưu nguyên bản; preview/thumbnail tách riêng.
3. **Cô lập tuyệt đối theo tài khoản:** Không truy cập chéo, không chia sẻ media/album, không tạo link chia sẻ.
4. **Không có tìm kiếm:** Duyệt bằng timeline (ngày/tháng/năm), album, thư mục nhiều cấp, tag, yêu thích, bộ lọc và sắp xếp.
5. **Ranh giới quyền Admin:** Admin quản trị tài khoản, dung lượng, hạ tầng, trạng thái replica và cài đặt hệ thống — **không được truy cập kho media hay khóa mã hóa cá nhân**.
6. **Xác minh trước khi coi là an toàn:** Phân biệt rõ các trạng thái `detected → queued → uploading → uploaded → verifying → verified / insufficient_replicas / failed`.

## 3. Lộ trình triển khai cuốn chiếu
- **Giai đoạn 1 (Hiện tại):** Nền tảng — Monorepo, PostgreSQL schema đầy đủ 14 nhóm bảng, Storage Adapter (Local + S3-compatible), Auth (đăng ký, đăng nhập, refresh token rotation, recovery codes, chọn chế độ mã hóa theo tài khoản), quản lý thiết bị, RBAC & Admin cơ bản, Web PWA shell, bộ kiểm thử tự động (auth, RBAC isolation, admin privacy boundary, storage adapter).
- **Giai đoạn 2:** Sao lưu cơ bản — Multipart/resumable upload trực tiếp qua Presigned URL, xác minh SHA-256, kiểm tra Wi-Fi-only, nhận diện trùng lặp trong phạm vi tài khoản.
- **Giai đoạn 3:** Thư viện media — Timeline kiểu Apple Photos, album/thư mục nhiều cấp, tag, yêu thích, bộ lọc & sắp xếp, preview/streaming thích ứng.
- **Giai đoạn 4:** Khôi phục & Giải phóng dung lượng — Tải file gốc lẻ/hàng loạt/theo album/toàn bộ thư viện giữ nguyên cấu trúc, thùng rác & lịch sử phiên bản.
- **Giai đoạn 5:** Bảo mật nâng cao — Luồng E2EE đầy đủ phía client (WebCrypto / native crypto), khóa ứng dụng PIN/sinh trắc học, thiết bị tin cậy, mở rộng OAuth/OTP/Passkey.
- **Giai đoạn 6:** Hai bản sao độc lập — Copy 1 và Copy 2, xác minh SHA-256 trước khi báo đủ bản sao, quét toàn vẹn và tự phục hồi từ bản còn tốt.
- **Giai đoạn 7:** Native Mobile (`Expo`) — Quét thư viện Photos tự động, chạy nền trên Android (`WorkManager`) và iOS (`BGProcessingTask` + `URLSession`), build `.apk` và `.ipa` (kèm SideStore `source.json`).
- **Giai đoạn 8:** Kiểm thử chịu tải, bảo mật, diễn tập phục hồi thảm họa & triển khai vận hành.
