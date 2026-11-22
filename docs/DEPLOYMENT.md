# Hướng dẫn Triển khai trên Cloud Miễn phí (0 USD/tháng) & iPhone

## 1. Kiến trúc Cloud Miễn phí (không bắt buộc thẻ tín dụng ở mức cơ bản)

| Thành phần | Dịch vụ miễn phí | Ghi chú |
| :--- | :--- | :--- |
| **PostgreSQL Database** | **Neon** (`neon.tech`) | 500 MB free, không cần thẻ, không tự xóa sau 30 ngày. Lấy chuỗi `postgresql://...?sslmode=require`. |
| **Object Storage — Copy 1** | **Backblaze B2** *(không cần thẻ, 10 GB)* hoặc **Cloudflare R2** *(cần thẻ, 10 GB, egress = 0)* | Tạo bucket private, tạo S3 Application Key (Read/Write). |
| **Object Storage — Copy 2** | **Backblaze B2** + **Oracle Cloud Object Storage (20 GB)** nếu Copy 1 dùng R2 | Thêm các kho vào cùng nhóm Copy 2. Bấm **Nhân bản sang Copy 2** trong Admin. Xem [phương án lưu trữ và chi phí](STORAGE_PLAN.md). |
| **Backend API** | **Render** (`render.com`, dùng sẵn `render.yaml`) hoặc **Oracle Cloud Always Free VM** | Render Free chạy trực tiếp `infrastructure/deploy/Dockerfile`. Lưu ý Render Free ngủ sau 15 phút không dùng (~30–50s cold start). |
| **Web PWA (mở trên iPhone)** | **Cloudflare Pages** hoặc **Vercel** | Thư mục root: `apps/web`, Build command: `npm run build --workspace=packages/shared && npm run build --workspace=apps/web`, Output: `apps/web/dist`. |

## 2. Các bước triển khai nhanh (10 phút)

1. **Đẩy repo lên GitHub (private hoặc public).**
2. **Tạo DB trên Neon:** Copy `DATABASE_URL` dạng `postgresql://...`.
3. **Tạo Bucket S3 trên Backblaze B2 (hoặc Cloudflare R2 / Oracle OCI):**
   - Tạo Bucket ở chế độ **Private**.
   - Tạo khóa S3 API (`Access Key ID` + `Secret Access Key`) có quyền Read/Write trên bucket đó.
   - *(Khuyên dùng để tăng tốc upload trực tiếp từ iPhone/trình duyệt không qua RAM Render):* bật CORS cho bucket với `AllowedOrigins`: domain web của bạn, `AllowedMethods`: `GET, PUT, HEAD`, `AllowedHeaders`: `*`, và **`ExposeHeaders`: `ETag`**.
   - **Tích hợp nhanh không cần sửa `.env`:** bạn có thể điền trực tiếp khóa Cloud R2 / B2 / OCI ngay trong giao diện **Quản trị hệ thống (Admin) → Storage Pool**, bấm **Thử kết nối trước khi lưu** (hệ thống tự test Ghi → Đọc SHA-256 → Xóa) rồi bấm **Lưu & Kích hoạt ngay** (khóa bí mật được mã hóa `AES-256-GCM` bằng `STORAGE_CONFIG_KEY`).
4. **Deploy Backend trên Render:**
   - Chọn **New → Blueprint** và chọn repo (Render tự đọc [render.yaml](file:///e:/app_luu_tru/render.yaml)).
   - Điền `DATABASE_URL`, `S3_PRIMARY_*` và `S3_SECONDARY_*` (hoặc thêm kho Copy 2 trong Admin), `CORS_ORIGINS` (URL Cloudflare Pages của bạn).
   - Sau khi deploy xong, kiểm tra `https://<backend-url>/health` trả về `{"status":"ok","dbDriver":"pg"}`.
5. **Deploy Web PWA trên Cloudflare Pages:**
   - Thiết lập biến môi trường `VITE_API_BASE_URL=https://<backend-url>`.
   - Cloudflare Pages tự cấp HTTPS miễn phí (bắt buộc cho WebCrypto E2EE & cài PWA trên iPhone).
6. **Cài lên iPhone của Apple:**
   - Mở đường link Cloudflare Pages bằng **Safari** trên iPhone.
   - Bấm **Chia sẻ (Share)** → **Thêm vào Màn hình chính (Add to Home Screen)**.
   - Đăng ký tài khoản đầu tiên → tự động nhận quyền **Admin** và 10 mã khôi phục dùng 1 lần.

## 3. Chạy ngay trên máy Windows (Dev / Self-host tại nhà)
```powershell
npm.cmd install
npm.cmd run dev:backend   # Terminal 1: API http://localhost:3001 (dùng PGlite, không cần Docker)
npm.cmd run dev:web       # Terminal 2: Web PWA http://localhost:5173
```
Nếu muốn chạy cùng Docker Compose (PostgreSQL 16 + MinIO 2 buckets):
```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d
```
