# Hako Downloader

Hako Downloader là công cụ local để tìm và tải Light Novel từ hệ sinh thái Hako / DocLN. Dự án có web UI chạy trên Chrome và vẫn giữ CLI cũ khi cần.

## Tính năng

- Tìm truyện theo từ khóa
- Gợi ý truyện từ trang chủ
- Xem ảnh bìa, tóm tắt và danh sách tập
- Chọn tập cần tải
- Xuất TXT và EPUB
- Đổi DNS ngay trong ứng dụng
- Cấu hình cookie DocLN (`cf_clearance`, `ln_session`) để vượt Cloudflare
- Theo dõi tiến độ tải trên giao diện web
- Có thể quay lại CLI bằng `npm run cli`

## Yêu cầu

- Máy tính Windows, macOS hoặc Linux
- Kết nối internet
- Node.js 20+ và npm

## Cài đặt

### 1. Cài Node.js nếu máy bạn chưa có

1. Truy cập [https://nodejs.org](https://nodejs.org)
2. Tải bản `LTS`
3. Nếu bạn dùng Windows, hãy chọn file cài đặt `.msi`
4. Nếu bạn dùng macOS, hãy chọn file cài đặt `.pkg`
5. Mở file vừa tải về và bấm `Next` theo các bước mặc định
6. Giữ nguyên các tùy chọn mặc định của trình cài đặt
7. Chờ cài xong rồi bấm `Finish`
8. Đóng tất cả cửa sổ terminal đang mở, sau đó mở lại

### 2. Kiểm tra Node.js đã cài thành công chưa

Mở terminal rồi chạy:

```bash
node -v
npm -v
```

Nếu màn hình hiện ra số phiên bản, ví dụ như `v20.x.x` hoặc `10.x.x`, nghĩa là máy đã cài xong.

Nếu thấy lỗi kiểu `node is not recognized` hoặc `npm is not recognized`, hãy thử:

- đóng terminal và mở lại
- nếu vẫn chưa được, khởi động lại máy
- nếu vẫn lỗi, cài lại Node.js rồi kiểm tra lại 2 lệnh trên

### 3. Tải mã nguồn dự án về máy

Nếu bạn đã có sẵn thư mục dự án này thì có thể bỏ qua bước này.

Nếu bạn tải từ GitHub:

1. Mở trang GitHub của dự án
2. Bấm nút `Code`
3. Chọn `Download ZIP`
4. Giải nén ra một thư mục dễ nhớ, ví dụ `D:\hako_downloader`

### 4. Mở terminal trong đúng thư mục dự án

Trên Windows, cách dễ nhất là:

1. Mở thư mục dự án bằng File Explorer
2. Bấm vào thanh địa chỉ của thư mục
3. Gõ `cmd`
4. Nhấn `Enter`

Lúc này terminal sẽ mở đúng ngay trong thư mục dự án.

Bạn cũng có thể dùng lệnh `cd` nếu muốn:

```bash
cd D:\duong_dan_den_thu_muc_du_an
```

### 5. Cài các thư viện cần thiết cho dự án

Chạy lệnh sau:

```bash
npm install
```

Lần cài đầu tiên có thể mất vài phút tùy tốc độ mạng.

Khi cài xong, bạn có thể chuyển sang phần `Chạy web UI` bên dưới.

## Chạy web UI

```bash
npm start
```

Sau đó mở:

- [http://localhost:3000](http://localhost:3000)

Terminal lúc này sẽ chạy backend local. Giao diện web là nơi thao tác chính.

## Chạy CLI cũ

```bash
npm run cli
```

## Cách dùng nhanh

1. Chạy `npm start`
2. Mở `http://localhost:3000`
3. Nếu dùng site DocLN (`docln.sbs`), cấu hình cookie trước (xem mục bên dưới)
4. Tìm truyện bằng từ khóa hoặc dán URL truyện trực tiếp
5. Chọn truyện từ danh sách bên trái
6. Chọn chế độ tải:
   - `Chỉ tải TXT`
   - `1 EPUB tổng`
   - `EPUB từng tập`
   - `Cả hai`
7. Chọn các tập muốn tải
8. Bấm `Bắt Đầu Tải`

Sau khi tải xong:

- TXT / HTML cache nằm trong `downloads/`
- EPUB có thể tải trực tiếp từ giao diện web

## Cấu hình cookie DocLN

Site `docln.sbs` cần cookie đăng nhập và Cloudflare. Không có cookie hợp lệ thì app không tải được nội dung DocLN.

### Cách lấy cookie

1. Mở [https://docln.sbs](https://docln.sbs/) và đăng nhập tài khoản.
2. Nhấn `F12` để mở DevTools, chọn tab **Mạng / Network**.
3. Tải lại trang (`F5`), bấm một request tới `docln.sbs`.
4. Trong **Headers**, tìm dòng `Cookie:` và copy toàn bộ giá trị.
5. Hoặc chuột phải request → **Copy** → **Copy as cURL**.

### Cách lưu vào app

1. Trên giao diện web, bấm nút **Cookie** ở góc trên.
2. Dán một dòng Cookie hoặc toàn bộ lệnh curl vào ô nhập.
3. Bấm **Lưu Cookie**. App sẽ tự kiểm tra với `docln.sbs`.
4. Có thể bấm **Kiểm Tra** để test lại, hoặc **Xóa Cookie** khi cookie hết hạn.

App chỉ giữ 2 key bắt buộc:

- `cf_clearance` — vượt Cloudflare
- `ln_session` — phiên đăng nhập

Các key khác (`XSRF-TOKEN`, `remember_web`, …) sẽ bị bỏ qua.

Cookie được lưu local trong `.docln-cookies.json` (và file jar cho curl). Khi cookie hết hạn hoặc gặp lỗi 403 / Cloudflare, mở lại dialog Cookie và dán cookie mới.

> CLI (`npm run cli`) hiện **không** hỗ trợ cookie DocLN. Muốn tải DocLN hãy dùng web UI.

## DNS tùy chỉnh

Ung dụng hỗ trợ các lựa chọn DNS sau:

- `Hệ thống mặc định`
- `Cloudflare`
- `Google`
- `Tự nhập`

Thiết lập này chỉ áp dụng cho app hiện tại, không thay đổi DNS toàn máy, nên chọn Google/Cloudflare vì nhà mạng có thể chặn.

## Cấu trúc chính

```text
.
|- public/        # giao diện web
|- server.js      # backend local
|- index.js       # CLI cũ
|- downloads/     # file tải về và cache
`- output/        # ảnh / artifact debug
```

## Scripts

```json
{
  "start": "node server.js",
  "web": "node server.js",
  "cli": "node index.js"
}
```

## Ảnh Chụp Màn Hình

Giao diện web local của ứng dụng trên trình duyệt.

### Trang chủ

![Trang chủ](docs/screenshots/web-ui-home.png)

### Trang chi tiết

![Trang chi tiết](docs/screenshots/web-ui-detail.png)


## Lưu ý

- Đây là công cụ chạy local, không phải dịch vụ public
- Tốc độ tải phụ thuộc vào site nguồn và giới hạn mạng
- DocLN cần cookie hợp lệ; cookie hết hạn thì lấy lại từ trình duyệt
- Nếu cấu trúc HTML của site thay đổi, app có thể cần cập nhật selector
