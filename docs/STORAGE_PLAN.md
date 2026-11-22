# Hai bản sao ảnh/video trong ngân sách 50.000–100.000 đ/tháng

## Kho ưu tiên

| Nhóm | Dịch vụ | Vai trò |
|---|---|---|
| Copy 1 | [Cloudflare R2 Standard](https://developers.cloudflare.com/r2/pricing/) | Kho chính; 10 GB-tháng miễn phí tham khảo, không thu phí egress Internet. Worker đã có tích hợp R2 native. |
| Copy 2 | [Backblaze B2](https://www.backblaze.com/cloud-storage/pricing) | Kho dự phòng S3 độc lập với Cloudflare; 10 GB miễn phí tham khảo, trả phí theo dung lượng khi vượt mức. |
| Copy 2 | [Oracle OCI Object Storage Standard](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) | Kho bổ sung: 20 GB tổng cộng và 50.000 yêu cầu/tháng cho tài khoản Always Free sau dùng thử. Đặt giới hạn thấp hơn 20 GB; nếu vượt hạn mức khi hết dùng thử, Oracle có thể xóa toàn bộ object. |

[InfiniCLOUD](https://infini-cloud.net/en/) và [Koofr](https://koofr.eu/pricing/) là ứng viên WebDAV bổ sung, không phải lựa chọn chính cho ảnh quan trọng. Chỉ tính dung lượng khi đã xác nhận gói miễn phí còn hỗ trợ WebDAV, quy định tài khoản không hoạt động và giới hạn từng file. Không dùng nhiều tài khoản để nhân hạn mức hoặc coi nhiều bucket trong cùng tài khoản là các bản lưu độc lập. Không tính VM Always Free vào dung lượng cam kết vì có thể khó cấp tài nguyên và VM nhàn rỗi có thể bị thu hồi.

## Dung lượng và chi phí

- Pool cộng dung lượng các kho **trong từng nhóm** và chuyển file mới sang kho kế tiếp khi kho ưu tiên hết chỗ. Không chia một file ra nhiều kho. Dung lượng lưu đủ hai bản bị giới hạn bởi nhóm nhỏ hơn: R2 10 GB và B2 + OCI 30 GB thì chỉ lưu được khoảng **10 GB** miễn phí với đủ hai bản.
- Nếu InfiniCLOUD xác nhận được **20 GB miễn phí có WebDAV**, có thể ghép vào Copy 1 để thử cấu hình khoảng **30 GB đủ hai bản** (R2 + InfiniCLOUD / B2 + OCI). Đây là mức lý thuyết trước khi chừa dung lượng dự phòng; với ảnh quan trọng, ưu tiên tăng hạn mức của kho S3 thay vì dựa vào WebDAV miễn phí.
- Ví dụ **150 GB ảnh gốc**: giả định giá R2 Standard **0,015 USD/GB-tháng**, B2 **0,007 USD/GB-tháng** để lập ngân sách, mỗi dịch vụ có 10 GB miễn phí. Hai kho khoảng **3,08 USD/tháng** nếu chưa dùng OCI (140 × 0,015 + 140 × 0,007), tức khoảng **80.000 đ** theo tỷ giá giả định 26.000 đ/USD. Chưa gồm thuế, phí API, tải dữ liệu theo điều kiện của từng dịch vụ, backend và cơ sở dữ liệu. Đây là phép tính tham khảo, không phải báo giá đã xác nhận. Hạn mức khai báo trong app không phải trần hóa đơn; bật cảnh báo chi phí riêng ở mỗi nhà cung cấp.

## Đăng ký và vận hành

1. Tạo tài khoản tại trang chính thức và bật MFA. Tạo bucket **private** cho R2 và B2. Với OCI, tạo bucket **Standard** và S3 Customer Secret Key. Dùng khóa giới hạn quyền cho bucket khi nhà cung cấp hỗ trợ.
2. Trong Admin → Storage Pool, dùng R2 native hiện tại (nếu dùng Worker) hoặc thêm bucket R2 vào **Copy 1**. Thêm B2 vào **Copy 2**; thêm OCI vào cùng nhóm như kho bổ sung nếu đã xác minh tài khoản. Nhập hạn mức theo byte thực tế: **10 GB ≈ 9,31 GiB**, **20 GB ≈ 18,63 GiB**; chừa dư cho thao tác và file tạm.
3. Bấm thử kết nối, tải một ảnh và một video mẫu, chạy **Nhân bản sang Copy 2**. Kiểm tra app báo 2/2 và tải lại được file. Luồng hiện tại chạy nhân bản bằng nút Admin, không tự chạy theo lịch. Khi còn 1/2, giữ file trên thiết bị. Tắt lifecycle xóa file tự động; giữ bản sao cơ sở dữ liệu và thông tin khôi phục khóa mã hóa ở nơi riêng.
4. Khi có máy chủ riêng, đưa một nhóm về ổ cứng/NAS/MinIO và giữ nhóm kia ngoài địa điểm. Kho Copy 3 có sẵn không bị migration xóa. Fastify áp dụng migration khi khởi động; triển khai Worker cần áp dụng migration D1 0003 trước khi sử dụng giao diện mới. Giữ cấu hình cũ để phục hồi cho tới khi dữ liệu cần giữ đã có đủ hai bản xác minh ở các kho mới.
