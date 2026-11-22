# Thiết kế Bảo mật & Quyền riêng tư (Security)

## 1. Xác thực & Phiên đăng nhập
- **Mật khẩu:** Băm bằng `scrypt` (`N=16384, r=8, p=1`, keylen 64 byte, salt ngẫu nhiên 16 byte/tài khoản) kèm so sánh chống timing attack (`crypto.timingSafeEqual`).
- **Token:**
  - `Access Token` (JWT HS256, thời hạn ngắn mặc định 15 phút) chứa `sub` (userId), `roles`, `did` (deviceId), `enc` (encryptionMode).
  - `Refresh Token` ngẫu nhiên 32 byte, chỉ lưu **SHA-256 hash** trong bảng `refresh_tokens`, xoay vòng (rotation) mỗi lần làm mới. Nếu phát hiện tái sử dụng refresh token đã thu hồi trong cùng `token_family`, toàn bộ gia đình phiên đó bị thu hồi ngay lập tức.
- **Recovery Codes:** Sinh 10 mã dùng 1 lần (hiển thị duy nhất một lần cho người dùng), lưu bằng hash SHA-256 kèm salt riêng.
  - **Ranh giới quan trọng (PRD 4.1):** Khôi phục quyền đăng nhập tài khoản bằng recovery code **không** tự động khôi phục khóa giải mã E2EE; với tài khoản `e2ee`, response trả về cờ `e2eeVaultUnlockRequired: true`.

## 2. Hai chế độ mã hóa theo tài khoản
- **`server_side`:** File gốc được mã hóa khi lưu trữ (at-rest); server có thể hỗ trợ tạo preview/thumbnail và khôi phục thuận tiện.
- **`e2ee`:** File gốc được mã hóa trên thiết bị trước khi upload; server chỉ lưu ciphertext và bản master key đã bọc bằng mật khẩu/khóa khôi phục của người dùng. Mất khóa đồng nghĩa server không thể giải mã.
- Sau khi tài khoản đã có media được lưu, chế độ mã hóa của tài khoản được khóa để tránh trộn lẫn dữ liệu và rủi ro mất nhất quán khóa.

## 3. Phân quyền RBAC & Ranh giới riêng tư Admin
- **Mọi API người dùng** kiểm tra JWT + kiểm tra `user.is_active` + kiểm tra thiết bị chưa bị thu hồi + ép lọc theo `req.auth.userId`.
- **Mọi API Admin (`/api/v1/admin/*`)** bắt buộc có vai trò `admin` trên server.
- **Admin Privacy Boundary:** Admin chỉ xem được thông số hạ tầng (danh sách tài khoản, trạng thái hoạt động, quota, tổng dung lượng đã dùng, tình trạng storage adapter, cài đặt hệ thống). Không tồn tại endpoint nào cho phép Admin liệt kê, xem trước, tải file gốc hay truy xuất khóa E2EE của tài khoản khác.
- Không có API chia sẻ công khai, không có tìm kiếm xuyên kho, không thu thập dữ liệu vị trí GPS.
