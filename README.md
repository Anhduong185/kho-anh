# Secure Media Backup

Ứng dụng sao lưu ảnh và video bảo mật — giữ nguyên 100% file gốc, sao lưu một chiều, hỗ trợ 2 chế độ mã hóa theo tài khoản (`Server-side` và `E2EE`), kiến trúc Storage Adapter với 2 bản sao trên hai nhóm kho, chạy được trên hạ tầng **Cloud miễn phí** (Render / Oracle Cloud + Neon PostgreSQL + Cloudflare R2 / Backblaze B2 / OCI) hoặc self-hosted bằng Docker.

Xem [cách ghép kho và dự toán chi phí](docs/STORAGE_PLAN.md).

## Các nguyên tắc & quyết định đã chốt
- **Sao lưu một chiều:** Xóa ảnh trên điện thoại không xóa bản sao trên server; không đồng bộ hai chiều.
- **Giữ nguyên 100% file gốc & metadata:** Không nén, không chuyển đổi hay làm giảm chất lượng file gốc.
- **Chỉ upload qua Wi-Fi:** Chặn upload qua dữ liệu di động.
- **Mã hóa theo tài khoản:** Chủ tài khoản chọn `server_side` hoặc `e2ee` ở cấp tài khoản.
- **Lưu giữ vô thời hạn:** File và lịch sử phiên bản giữ vô thời hạn cho tới khi người dùng xóa thủ công.
- **Quyền riêng tư tuyệt đối:** Không chia sẻ media/album, không tìm kiếm, không bản đồ GPS, Admin chỉ quản trị hạ tầng và không truy cập kho media cá nhân.

## Cấu trúc Monorepo
- `packages/shared/` — Kiểu dữ liệu, enum và hằng số dùng chung giữa Backend, Web PWA và tương lai là Expo Mobile App.
- `backend/` — API Server (`Fastify` + `TypeScript`), hỗ trợ **PostgreSQL** (Neon / Docker) và **PGlite** (PostgreSQL nhúng chạy ngay không cần cài Docker khi dev trên Windows).
- `apps/web/` — Ứng dụng Web/PWA (`React` + `Vite` + `TypeScript`) giao diện tối giản lấy cảm hứng từ Apple Photos, cài được lên màn hình chính iPhone (Safari → Add to Home Screen), Android và Windows.
- `infrastructure/docker/` — `docker-compose.yml` cho môi trường Docker (PostgreSQL 16 + MinIO).
- `docs/` — Tài liệu thiết kế (`PRD.md`, `ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md`).

## Chạy nhanh trên máy local (không cần Docker)
```bash
npm install
npm run dev:backend
# Mở terminal khác:
npm run dev:web
```
- Backend API: `http://localhost:3001` (Health check: `GET /health`)
- Web PWA: `http://localhost:5173`
- Tài khoản đầu tiên đăng ký tự động được cấp vai trò `admin` + `user`. Các tài khoản sau chỉ có vai trò `user`.

## Chạy kiểm thử (Unit + Integration Tests)
```bash
npm test
```
