# Vault Photos Native Mobile Blueprint (Android `.apk` & iPhone `.ipa`)

Thư mục này chứa cấu hình sẵn sàng cho app Native (`Expo / React Native`) dùng chung **đúng Backend API** và gói `@smb/shared` đã hoàn thiện ở dự án này.

## Vì sao cấu hình tách khỏi workspace build mặc định?
- Trên máy Windows không cần cài Xcode hay Android Studio vẫn chạy & phát triển được toàn bộ Backend + Web PWA.
- Khi cần build bản Native để có **tự động quét thư viện Photos chạy nền** trên Android (`WorkManager`) và iPhone (`PHPhotoLibrary` + `BGProcessingTask` + `URLSession`), sử dụng **Expo EAS Build** (có gói free build cloud cho cả Android `.apk` và iOS `.ipa` mà không cần mua Mac).

## Cài lên iPhone bằng SideStore + Tự gia hạn không cần PC
1. Xuất file `.ipa` từ GitHub Actions (`macos-latest`) hoặc Expo EAS Build.
2. Cập nhật `downloadURL` trong `infrastructure/sidestore/source.json` và đẩy lên GitHub Pages / Cloudflare Pages.
3. Trên iPhone đã cài **SideStore** + **LocalDevVPN/StosVPN** (dùng Apple ID phụ), thêm nguồn `source.json` và cài app.
4. Tạo **Tự động hóa (Shortcuts Automation)** trên iPhone chạy mỗi sáng lúc 03:00 khi có Wi-Fi (*Chạy ngay lập tức*): Bật LocalDevVPN → SideStore *Refresh All Apps* → Tắt VPN.
