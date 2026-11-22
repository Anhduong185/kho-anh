# Kiến trúc Hệ thống (Architecture)

## 1. Tổng quan kiến trúc cho Cloud Miễn phí & Mở rộng Self-hosted
Hệ thống được thiết kế theo mô hình **Modular Monolith** ở backend (`Fastify` + `TypeScript`) tách rạch ròi theo domain module (`auth`, `users`, `media`, `backup`, `storage`, `integrity`, `restore`, `admin`, `notifications`), giúp:
- Tiêu thụ RAM thấp, triển khai gọn 1 container duy nhất trên **Render Free (512 MB)** hoặc **Oracle Cloud Always Free VM**.
- Upload/Download file dung lượng lớn (video 4K/ProRes) đi trực tiếp qua **Presigned Multipart URL** giữa **Client ↔ Object Storage (R2/B2/OCI/MinIO)** — backend không đệm file trong RAM.
- Tác vụ nền (replication, checksum verification, cleanup) giai đoạn đầu sử dụng bảng job bền vững trong **PostgreSQL** thay vì phụ thuộc Redis free có giới hạn request/không lưu đĩa.

```text
[iPhone PWA / Safari]   [Windows / Web PWA]   [Future Expo iOS/Android]
          \                     |                     /
           +--------------------+--------------------+
                                | HTTPS (TLS)
                   [Backend API - Fastify / TS]
                 (Auth, RBAC, Metadata, Presigner)
                     /          |            \
                    /           |             \
     [PostgreSQL (Neon /       |      [Storage Adapter Layer]
      Docker / PGlite dev)]    |       /         |          \
                               |   Copy 1     Copy 2      Copy 3
                               |  (R2/Local) (B2/MinIO)  (OCI/NAS)
```

## 2. Database Adapter (Zero-setup Dev ↔ Production PostgreSQL)
- **Production / Docker:** Kết nối `PostgreSQL 16+` (Neon, Supabase, hoặc Docker Compose) thông qua `pg.Pool` khi `DATABASE_URL` bắt đầu bằng `postgres://` hoặc `postgresql://`.
- **Local Dev trên Windows & Integration Tests:** Tự động dùng **`@electric-sql/pglite`** (PostgreSQL biên dịch WASM chạy nhúng, lưu dữ liệu xuống `backend/data/pgdata` hoặc in-memory khi chạy test) khi `DATABASE_URL` bắt đầu bằng `pglite://`.
- Cả hai chế độ chạy **cùng một bộ SQL migration PostgreSQL chuẩn**, bảo đảm phát triển trên máy Windows không cần Docker mà không bị lệch dialect SQL.

## 3. Storage Abstraction Layer (PRD Mục 8.4)
Mọi thao tác object storage đi qua interface `StorageAdapter`:
- `LocalDiskStorageAdapter`: lưu vào thư mục cục bộ khi dev/test (chống path traversal, kiểm chứng SHA-256).
- `S3StorageAdapter`: dùng `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, tương thích trực tiếp **Cloudflare R2**, **Backblaze B2**, **Oracle Cloud Object Storage (S3 API)** và **MinIO**.
- `StorageRegistry`: ghi vào hai nhóm kho độc lập (`primary` và `secondary`); kho `offsite` cũ được giữ để hỗ trợ phục hồi.

## 4. Triển khai trên iPhone (Apple iOS)
- **Giai đoạn hiện tại (PWA):** `apps/web` cấu hình đầy đủ Web App Manifest + Apple PWA meta tags (`apple-mobile-web-app-capable`, `viewport-fit=cover`, safe-area bottom tab bar), cài ra màn hình chính iPhone qua Safari (0 USD, không cần Mac).
- **Giai đoạn 7 (Native `.ipa`):** Tạo app Expo / React Native tái sử dụng `packages/shared` và cùng Backend API; build `.ipa` qua cloud CI (GitHub Actions / EAS) và phân phối qua SideStore `source.json` (tự gia hạn bằng Shortcuts Automation) hoặc TestFlight.
