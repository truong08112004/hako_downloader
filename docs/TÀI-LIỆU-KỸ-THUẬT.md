# Hako Downloader — AI Reimplementation Specification

> Tài liệu đặc tả kỹ thuật đầy đủ để một đội phát triển (hoặc AI khác) xây dựng lại hệ thống từ đầu mà không cần xem source gốc.
>
> **Nguyên tắc:** Mọi kết luận trong tài liệu này được trích xuất trực tiếp từ source code thực tế (`server.js`, `index.js`, `public/index.html`, `public/app.js`, `package.json`). Khi source không cung cấp đủ thông tin, mục đó ghi rõ: **"Not enough evidence found in source code."**

---

## 0. Tổng Quan Hệ Thống

Hako Downloader là một công cụ **chạy local** để tìm, xem và tải Light Novel từ hệ sinh thái Hako/DocLN và Valvrare Team, xuất ra file TXT/HTML cache và EPUB.

Hệ thống có **2 giao diện độc lập dùng chung logic crawl**:

| Thành phần            | File                                                      | Vai trò                              | Cách chạy                       |
| --------------------- | --------------------------------------------------------- | ------------------------------------ | ------------------------------- |
| Web server + REST API | `server.js`                                               | Backend HTTP + giao diện web (chính) | `npm start` / `node server.js`  |
| Web UI (SPA tĩnh)     | `public/index.html`, `public/app.js`, `public/styles.css` | Frontend chạy trong trình duyệt      | mở `http://localhost:3000`      |
| CLI tương tác         | `index.js`                                                | Giao diện terminal cũ (terminal-kit) | `npm run cli` / `node index.js` |

**Ngôn ngữ/runtime:** Node.js (yêu cầu Node 20+ theo README). JavaScript thuần CommonJS (`require`). Không có bước build/transpile.

**Đặc điểm kiến trúc cốt lõi (suy ra từ code):**

- Không có cơ sở dữ liệu. Trạng thái task lưu trong RAM (`Map`), dữ liệu tải lưu xuống filesystem (`downloads/`).
- `server.js` và `index.js` **trùng lặp** phần lớn logic crawl/parse (copy-paste). `server.js` bổ sung cookie Cloudflare, fetch qua `curl`, mirror domain, task async, batch download.
- Web UI giao tiếp với backend qua REST API trả JSON; polling task mỗi 1.5s.

---

## 1. Functional Requirements (Yêu Cầu Chức Năng)

Đánh số `FR-x`. Tất cả đều có bằng chứng trong source.

### FR-1 — Gợi ý truyện từ trang chủ

- Crawl trang chủ của site đang active, trích các link truyện (`/truyen/...`), gộp trùng và sắp xếp theo số lần xuất hiện (`count`) giảm dần, lấy tối đa **40** truyện.
- Bằng chứng: `fetchHomepageRecommendations()` → `.slice(0, 40)`; route `GET /api/recommendations`.
- Nếu site active là Valvrare → thay bằng crawl toàn bộ danh mục Valvrare.

### FR-2 — Tìm truyện theo từ khóa

- Với DocLN: thử lần lượt 3 endpoint tìm kiếm, chấm điểm khớp tiêu đề (`scoreNovelMatch`), lọc `score > 0`, sắp xếp giảm dần, lấy tối đa **30** kết quả.
- Với Valvrare: tìm trong danh mục đã crawl bằng cùng thuật toán chấm điểm.
- Bằng chứng: `searchNovels()`; route `GET /api/search?q=`.

### FR-3 — Crawl toàn bộ danh mục Valvrare

- Crawl trang 1 của `/danh-sach-truyen`, đọc tổng số trang (`totalPages`) và tổng số truyện (`totalItems`), rồi crawl tuần tự trang 2..N, gộp danh sách.
- Có cache TTL **10 phút** (`VALVRARE_DIRECTORY_CACHE_TTL_MS = 10 * 60 * 1000`).
- Bằng chứng: `crawlValvrareDirectory()`; route `GET /api/catalog`.

### FR-4 — Mở truyện theo URL trực tiếp

- Nhận URL truyện, fetch trang, trích: tiêu đề, tác giả, tóm tắt, ảnh bìa, danh sách tập (volumes) + chương (chapters), ảnh bìa từng tập.
- Bằng chứng: `fetchNovelInfo()`; route `GET /api/novel?url=`.
- Frontend phân biệt: nếu URL là danh mục Valvrare → gọi catalog; ngược lại → mở novel (`directUrlForm` handler trong `app.js`).

### FR-5 — Xem chi tiết truyện

- Hiển thị bìa, tiêu đề, tác giả, tóm tắt, thống kê (số tập, số chương, hostname), danh sách tập với preview tối đa **5** chương/tập.
- Bằng chứng: `renderNovelDetail()` trong `app.js` (`.slice(0, 5)`).

### FR-6 — Chọn tập để tải

- Mỗi tập có checkbox (mặc định `checked`). Người dùng có nút "Chọn Tất Cả" / "Bỏ Chọn".
- Tập có ảnh bìa riêng → hiện thêm checkbox "Dùng cover tập này" (mặc định checked).
- Bằng chứng: `renderNovelDetail()`, `getSelectedVolumeIndexes()`, class `use-volume-cover-checkbox`.

### FR-7 — Tải 1 truyện với 4 chế độ EPUB

- Chế độ EPUB (`epubMode`): `'0'` chỉ TXT/HTML, `'1'` 1 EPUB tổng, `'2'` EPUB mỗi tập, `'3'` cả hai.
- Hỗ trợ tên file tùy chỉnh (`customTitle`) và chọn cover theo tập (`useVolumeCover`).
- Tải async qua task; trả `taskId`; frontend poll tiến độ.
- Bằng chứng: route `POST /api/download`; `startDownloadTask()` → `performDownload()` → `downloadNovelAssets()`.

### FR-8 — Tải hàng loạt (batch) toàn bộ danh mục Valvrare

- Crawl danh mục, tải song song nhiều truyện (concurrency 1/2/3), bỏ qua truyện đã có output, ghi báo cáo JSON.
- Bằng chứng: route `POST /api/batch-download`; `performBatchDownload()`.

### FR-9 — Cache chương đã tải

- Trước khi tải 1 chương, nếu đã tồn tại cả file `.txt` và `.html` trong thư mục tập → đọc từ cache, không request mạng.
- Bằng chứng: `downloadChapters()` — `if (fs.existsSync(htmlPath) && fs.existsSync(txtPath))`.

### FR-10 — Giải mã nội dung chương được bảo vệ

- Nếu chương có `<div id="chapter-c-protected" data-c data-k data-s>` → giải mã theo thuật toán `data-s`: `xor_shuffle`, `base64_reverse`, hoặc base64 thường.
- Bằng chứng: `decodeProtected()`, sử dụng trong `downloadChapters()`.

### FR-11 — Nhúng ảnh vào EPUB

- Tải ảnh trong nội dung chương về thư mục tạm `_temp_epub_images`, thay `src` bằng `file://`, loại bỏ ảnh banner responsive (`d-none`, `d-md-none`, `d-md-block`), wrap mỗi ảnh vào div page-break.
- Bằng chứng: `embedImagesInHtml()`, `isBannerImage()`.

### FR-12 — Theo dõi tiến độ task

- Mỗi task có `status`, `progress` (0–100), `logs[]`. Frontend poll `GET /api/tasks/:taskId` mỗi 1500ms.
- Bằng chứng: `startTaskPolling()` (`setInterval(poll, 1500)`); `serializeTask()`.

### FR-13 — Cấu hình DNS trong ứng dụng

- Chọn profile: `system`, `cloudflare` (1.1.1.1/1.0.0.1), `google` (8.8.8.8/8.8.4.4), hoặc tự nhập IP. Chỉ áp dụng cho phiên app, không đổi DNS toàn máy.
- Bằng chứng: `DNS_PROFILES`, `applyDnsProfile()`, `createLookup()`; routes `GET /api/dns-profiles`, `POST /api/dns`.

### FR-14 — Quản lý cookie docln.net (chỉ web server)

- Lưu/kiểm tra/xóa cookie docln.net. Chỉ giữ 2 key bắt buộc `cf_clearance` và `ln_session`. Hỗ trợ dán raw cookie hoặc lệnh `curl`.
- Bằng chứng: routes `GET/POST/DELETE /api/docln-cookies`, `POST /api/docln-cookies/test`; `setDoclnCookies()`, `filterEssentialDoclnCookies()`.

### FR-15 — Phục vụ file đã tải để download trực tiếp

- Thư mục `downloads/` được serve tĩnh tại `/downloads`. EPUB và báo cáo batch có link tải trực tiếp trong UI.
- Bằng chứng: `app.use('/downloads', express.static(DOWNLOADS_DIR))`; `toDownloadUrl()`.

### FR-16 — Ghi log ra file

- Mọi `console.log`/`console.error` được ghi đè để append vào `logs/server.log` kèm timestamp.
- Bằng chứng: `setupProcessLogging()`; script `npm run logs` = `tail -f logs/server.log`.

### FR-17 — CLI tương tác (giao diện cũ)

- Menu terminal: gợi ý trang chủ, tìm kiếm, nhập URL, cấu hình DNS, thoát. Render ảnh bìa trong terminal nếu hỗ trợ.
- Bằng chứng: `index.js` — `mainMenuLoop()`, `renderCoverImage()` dùng `terminal-image`.

### FR-18 — Mirror domain DocLN (chỉ web server)

- Khi `docln.net` lỗi, tự thử `docln.sbs` (và ngược lại).
- Bằng chứng: `toDoclnMirrorUrl()`, `expandDoclnMirrorCandidates()`, `buildCandidateUrls()` trong `server.js`.

---

## 2. Non-Functional Requirements (Yêu Cầu Phi Chức Năng)

| ID     | Yêu cầu                                                          | Bằng chứng trong source                                             |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| NFR-1  | **Local-only**: server bind `localhost`, không auth, không HTTPS | `app.listen(port)`, log `http://localhost:${port}`                  |
| NFR-2  | **Cổng mặc định 3000**, override bằng env `PORT`                 | `Number.parseInt(process.env.PORT \|\| '3000', 10)`                 |
| NFR-3  | **Rate limiting client-side**: delay 2000ms giữa các chương      | `await delay(2000)` trong `downloadChapters()`                      |
| NFR-4  | **Backoff khi HTTP 429**: chờ 10000ms                            | `if (error.response.status === 429) await delay(10000)`             |
| NFR-5  | **HTTP timeout**: 30s (axios chung), 20s (binary), 15s (ảnh CLI) | `timeout: 30000` / `20000` / `15000`                                |
| NFR-6  | **curl timeout**: 45s (HTML), 30s (binary)                       | `buildCurlArgs` `--max-time`; `timeoutSeconds`                      |
| NFR-7  | **maxBuffer curl**: 15MB (HTML), 12MB (binary)                   | `15 * 1024 * 1024`, `12 * 1024 * 1024`                              |
| NFR-8  | **Giới hạn body JSON request**: 1MB                              | `express.json({ limit: '1mb' })`                                    |
| NFR-9  | **Giới hạn log mỗi task**: 200 dòng (cắt bớt cũ nhất)            | `if (task.logs.length > 200) task.logs.splice(...)`                 |
| NFR-10 | **IPv4 ưu tiên + TLS tối thiểu 1.2**                             | `family: 4`, `minVersion: 'TLSv1.2'`                                |
| NFR-11 | **Cache danh mục Valvrare TTL 10 phút**                          | `VALVRARE_DIRECTORY_CACHE_TTL_MS`                                   |
| NFR-12 | **Polling tiến độ 1.5s**                                         | `setInterval(poll, 1500)`                                           |
| NFR-13 | **Batch concurrency hợp lệ chỉ {1,2,3}, mặc định 2**             | `BATCH_CONCURRENCY_VALUES`, `ensureBatchConcurrency()`              |
| NFR-14 | **Chống tên file không hợp lệ + tên reserved Windows**           | `sanitizeFileName()`                                                |
| NFR-15 | **Redirect tối đa 5 (HTML), 10 (binary)**                        | `maxRedirects: 5` / `10`                                            |
| NFR-16 | **Ngôn ngữ UI: tiếng Việt**                                      | toàn bộ chuỗi UI và `<html lang="vi">`                              |
| NFR-17 | **Giữ thư mục ảnh tạm để debug (web server không xóa)**          | comment `Keep temp image directories for debugging - DO NOT DELETE` |
| NFR-18 | **Bắt lỗi toàn cục không crash**                                 | `process.on('unhandledRejection'/'uncaughtException')`              |
| NFR-19 | **Xử lý cổng đã dùng (EADDRINUSE)** thoát có hướng dẫn           | `server.on('error', ...)`                                           |

**Lưu ý bảo mật (suy ra từ code):** Server không có xác thực, không kiểm soát CORS rõ ràng, dùng `express.static` cho `downloads/` và `public/`. Đây là công cụ local nên chấp nhận được, nhưng **không an toàn để expose ra internet**. Điều này nhất quán với README ("không phải dịch vụ public").

---

## 3. Database Schema

**Not enough evidence found in source code.** — Hệ thống không sử dụng cơ sở dữ liệu.

Thay vào đó, dữ liệu được lưu ở 3 nơi:

### 3.1 In-memory store (RAM)

- `const tasks = new Map();` — key là `task.id` (UUID v4), value là object task (xem §6.2). **Mất khi restart server.**

### 3.2 File cấu hình cookie (persisted)

**`.docln-cookies.json`** (ghi bởi `persistDoclnCookies`):

```json
{
  "cookie": "cf_clearance=...; ln_session=...",
  "updatedAt": "2026-05-30T10:00:00.000Z"
}
```

**`.docln-cookie.jar`** — Netscape HTTP Cookie File (cho `curl -b`), sinh bởi `writeDoclnCookieJar`:

```
# Netscape HTTP Cookie File
# Generated by hako-downloader
.docln.net	TRUE	/	FALSE	<expiry>	cf_clearance	<value>
.docln.net	TRUE	/	FALSE	<expiry>	ln_session	<value>
```

- `expiry = floor(Date.now()/1000) + 60*60*24*30` (30 ngày).

### 3.3 Output filesystem (xem §10 chi tiết layout)

- `downloads/<safeTitle>/` — thư mục mỗi truyện
- `downloads/<safeTitle>/<safeVolumeTitle>/` — TXT + HTML cache mỗi tập
- `downloads/_batch_reports/valvrare-batch-<timestamp>.json` — báo cáo batch
- `logs/server.log` — log server

---

## 4. Domain Models (Cấu Trúc Dữ Liệu Nội Bộ)

Các shape này được suy ra trực tiếp từ object literal trong code.

### 4.1 NovelListItem (kết quả search/recommend/catalog)

```ts
{
  title: string,
  imageUrl: string,        // có thể rỗng
  url: string,             // URL truyện đã normalize (bỏ query/hash)
  summary?: string,        // chỉ Valvrare directory
  badge?: string,          // 'Danh mục' cho Valvrare
  firstIndex: number,      // thứ tự xuất hiện đầu tiên (sau aggregate)
  count: number,           // số lần xuất hiện (dùng xếp hạng + badge 'Nổi bật' nếu >=3)
  score?: number           // chỉ khi search
}
```

Nguồn: `aggregateNovelItems()`, `extractValvrareDirectoryItems()`, `searchNovels()`.

### 4.2 Novel (chi tiết truyện)

```ts
{
  title: string,
  author: string,          // mặc định 'Khuyet danh' (index.js) / 'Khuyet danh' (server.js)
  summary: string,
  coverUrl: string,
  volumes: Volume[],
  sourceUrl: string        // = finalUrl sau redirect
}
```

Nguồn: `fetchNovelInfo()`.

### 4.3 Volume

```ts
{
  title: string,
  chapters: Chapter[],
  coverUrl: string         // server.js: trích từ .volume-cover; '' nếu không có. (index.js KHÔNG có field này)
}
```

Nguồn: `extractVolumes()`. **Khác biệt giữa 2 file:** `server.js` thêm `coverUrl` cho volume; `index.js` không có.

### 4.4 Chapter

```ts
{ title: string, url: string }
```

### 4.5 EpubChapter (đưa vào epub-gen-memory)

```ts
{ title: string, author: string, content: string /* HTML */ }
```

Title format: `` `${volume.title} - ${chapter.title}` ``.

### 4.6 DnsProfile

```ts
{ id: string, label: string, servers: string[] | null }
```

### 4.7 DoclnCookieStatus (trả qua API)

```ts
{
  configured: boolean,
  updatedAt: string | null,
  keys: string[],          // chỉ essential keys
  essentialKeys: string[],
  hasCloudflare: boolean,  // có cf_clearance
  hasSession: boolean,     // có ln_session
  isValid: boolean         // có cả hai
}
```

Nguồn: `getDoclnCookieStatus()`.

---

## 5. API Contracts (REST API — `server.js`)

Base URL: `http://localhost:3000`. Tất cả request/response body là `application/json` (trừ static files). Không có authentication.

### 5.1 `GET /api/status`

Trả trạng thái hiện tại.

- **200 Response:**

```json
{
  "site": "https://docln.net",
  "dns": "Hệ thống mặc định",
  "doclnCookies": {
    /* DoclnCookieStatus */
  }
}
```

Nguồn: `getStatus()`.

### 5.2 `GET /api/dns-profiles`

- **200 Response:**

```json
{
  "current": { "id": "system", "label": "Hệ thống mặc định", "servers": null },
  "profiles": [
    /* DnsProfile[] = system, cloudflare, google */
  ]
}
```

### 5.3 `POST /api/dns`

Đổi DNS.

- **Request (profile có sẵn):** `{ "profileId": "cloudflare" }`
- **Request (tự nhập):** `{ "profileId": "custom", "servers": ["1.1.1.1", "1.0.0.1"] }`
- **200:** `{ "ok": true, "current": { /* DnsProfile */ } }`
- **400:** `{ "error": "DNS không hợp lệ: ..." }` hoặc `{ "error": "Không nhận diện được cấu hình DNS." }`
- Validation: mỗi server phải pass `net.isIP() !== 0`.

### 5.4 `GET /api/docln-cookies`

- **200:** `{ "status": { /* DoclnCookieStatus */ } }`

### 5.5 `POST /api/docln-cookies`

Lưu cookie và tự kiểm tra.

- **Request:** `{ "cookie": "..." }` (chấp nhận cả key `curl` hoặc `value`)
- **200:**

```json
{
  "ok": true,
  "status": {
    /* DoclnCookieStatus */
  },
  "test": {
    "ok": true,
    "status": 200,
    "blocked": false,
    "finalUrl": "...",
    "mode": "curl"
  },
  "testError": "..." // optional, nếu test ném lỗi
}
```

- **400:** `{ "error": "Cookie phải có ít nhất cf_clearance và ln_session..." }`

### 5.6 `POST /api/docln-cookies/test`

- **200:** `{ "ok": boolean, "status": {...}, "test": {...} }`
- **400:** `{ "error": "Chưa cấu hình cookie docln.net." }`

### 5.7 `DELETE /api/docln-cookies`

- **200:** `{ "ok": true, "status": { /* configured=false */ } }`

### 5.8 `GET /api/recommendations`

- **200:** `{ "items": NovelListItem[], "status": {...} }`
- **500:** `{ "error": "..." }`

### 5.9 `GET /api/catalog?url=<valvrareDirectoryUrl>`

- Query `url` optional; nếu có và không hợp lệ → **400** `{ "error": "URL danh mục Valvrare không hợp lệ." }`
- **200:**

```json
{
  "items": NovelListItem[],
  "catalog": { "sourceUrl": "...", "totalPages": 12, "totalItems": 240 },
  "status": {...}
}
```

### 5.10 `GET /api/search?q=<keyword>`

- **400:** `{ "error": "Từ khóa tìm kiếm không được để trống." }` nếu thiếu `q`.
- **200:** `{ "items": NovelListItem[], "query": "...", "status": {...} }`

### 5.11 `GET /api/novel?url=<novelUrl>`

- **400:** `{ "error": "Thiếu URL truyện." }`
- **200:** `{ "novel": Novel, "status": {...} }`
- **500:** `{ "error": "..." }`

### 5.12 `POST /api/download`

Tạo task tải 1 truyện.

- **Request:**

```json
{
  "url": "https://docln.net/truyen/...",
  "epubMode": "1",
  "selectedVolumeIndexes": [0, 1, 2],
  "customTitle": "",
  "useVolumeCover": { "0": true, "1": false }
}
```

- **400:** `{ "error": "Thiếu URL truyện." }`
- **202:** `{ "task": SerializedTask }`
- Default: `epubMode` ép về `'1'` nếu không hợp lệ; `selectedVolumeIndexes` rỗng = tải tất cả.

### 5.13 `POST /api/batch-download`

Tạo task tải hàng loạt.

- **Request:** `{ "catalogUrl": "...", "epubMode": "1", "batchConcurrency": 2 }`
- **400:** `{ "error": "Thiếu hoặc sai URL danh mục Valvrare." }`
- **202:** `{ "task": SerializedTask }`

### 5.14 `GET /api/tasks/:taskId`

- **404:** `{ "error": "Không tìm thấy task." }`
- **200:** `{ "task": SerializedTask }`

### 5.15 `GET /api/tasks`

- **200:** `{ "tasks": SerializedTask[] }`

### 5.16 `GET /`

Trả `public/index.html`.

### 5.17 Static

- `GET /downloads/*` → file trong `downloads/`
- `GET /*` (static) → file trong `public/`

### 5.18 SerializedTask shape

```ts
{
  id: string,                 // UUID v4
  status: 'queued'|'running'|'completed'|'failed',
  progress: number,           // 0..100
  createdAt: string, updatedAt: string,
  startedAt?: string, finishedAt?: string,
  error?: string,
  result?: object,            // xem §6.4 / §6.5
  payload: object,            // input + tiến trình hiện tại
  logs: { at: string, message: string }[]
}
```

Nguồn: `serializeTask()`.

---

## 6. Business Rules (Quy Tắc Nghiệp Vụ)

### 6.1 Nhận diện URL

- **URL truyện** (`isNovelPath`): pathname khớp `^/truyen/\d+(?:-[^/?#]+)?/?$` HOẶC `^/truyen/[^/?#]+/?$`.
- **URL danh mục Valvrare** (`isValvrareDirectoryPath`): `^/danh-sach-truyen(?:/trang/\d+)?/?$` và origin = `https://valvrareteam.net`.
- **Normalize URL truyện** (`normalizeNovelUrl`): nếu là novel path thì **xóa `search` và `hash`**.

### 6.2 Sites & Origins

- `SITE_ORIGINS = ['https://docln.net', 'https://docln.sbs', 'https://ln.hako.vn', 'https://valvrareteam.net']`.
- `DOCLN_ORIGINS = {'https://docln.net', 'https://docln.sbs'}`.
- `activeOrigin` khởi tạo = `https://docln.net`, cập nhật thành origin cuối cùng sau redirect **nếu** origin đó thuộc `SITE_ORIGINS` (`updateActiveOrigin`).

### 6.3 Chiến lược fetch (server.js)

1. `refreshDoclnCookiesFromDisk()` trước mỗi `fetchPageContent`.
2. Nếu URL thuộc DocLN và **chưa có cookie** → ném lỗi yêu cầu cấu hình cookie.
3. Nếu URL thuộc DocLN và `DOCLN_FETCH_MODE !== 'axios'` (mặc định `'curl'`) → thử `curl` trước (dùng cookie jar).
4. Fallback sang `axios`.
5. `buildCandidateUrls`: với DocLN tự thêm mirror domain (`.net ↔ .sbs`); với path tương đối thử nhiều origin.
6. Phát hiện trang chặn Cloudflare (`isCloudflareBlockPage`) → coi như lỗi.

### 6.4 Quy tắc tải 1 truyện (`downloadNovelAssets` / `performDownload`)

- `resolveSelectedVolumeIndexes`: rỗng = tất cả tập; lọc index hợp lệ; loại trùng (`Set`).
- `finalTitle = customTitle.trim() || novel.title`; `safeTitle = sanitizeFileName(finalTitle)`.
- Thư mục truyện: `downloads/<safeTitle>/`.
- Với mỗi tập đã chọn: tạo `downloads/<safeTitle>/<safeVolumeTitle>/`, tải từng chương.
- **Tiến độ:** `progress = min(92, 8 + round(processedChapters/totalChapters * 80))`; hoàn tất = 100.
- `epubMode === '1' || '3'` → tạo 1 EPUB tổng tại `downloads/<safeTitle>/<safeTitle>.epub`.
- `epubMode === '2' || '3'` → mỗi tập 1 EPUB `downloads/<safeTitle>/<safeTitle> - <safeVolumeTitle>.epub`.
  - Cover dùng: nếu `useVolumeCover[index] !== false` và tập có `coverUrl` → dùng cover tập; ngược lại dùng cover truyện.
- `epubMode !== '0'` → dọn EPUB cũ ở thư mục gốc (`cleanupLegacyEpubOutputs`).
- `epubMode === '3'` → dọn file TXT/HTML trung gian + thư mục tập trống (`cleanupIntermediateChapterFiles`).

> **Mâu thuẫn trong source (ghi nhận trung thực):** Có **hai** định nghĩa `performDownload` và **hai** `startDownloadTask` trong `server.js`. Định nghĩa **sau** ghi đè định nghĩa trước (JS function hoisting + reassignment). Bản hiệu lực cuối cùng gọi `downloadNovelAssets()` và đặt EPUB **bên trong** `downloads/<safeTitle>/`. Khi reimplement, chỉ cần 1 phiên bản theo `downloadNovelAssets`.

### 6.5 Quy tắc tải hàng loạt (`performBatchDownload`)

- Validate `catalogUrl` là Valvrare directory.
- Crawl danh mục → danh sách items.
- Bỏ qua truyện nếu output yêu cầu đã tồn tại (`hasRequestedNovelOutputs`):
  - mode `'0'` cần `TXT/HTML`; `'1'` cần `EPUB tổng`; `'2'` cần `EPUB theo tập`; `'3'` cần cả `EPUB tổng` và `EPUB theo tập`.
- Worker pool với `Math.min(batchConcurrency, items.length)` worker, lấy index tuần tự (`nextIndex`).
- Tiến độ tổng = `(completedCount + tổng tỷ lệ active) / items.length`, clamp `[2, 98]`.
- Phân loại kết quả: `successes`, `skipped`, `failures`.
- Ghi báo cáo `downloads/_batch_reports/valvrare-batch-<ISO timestamp sanitized>.json`.
- Result giới hạn hiển thị: `skippedItems`/`failedItems` slice **25**.

### 6.6 Phát hiện output đã tồn tại (`detectExistingNovelOutputs`)

- `completedKinds` có thể chứa: `'EPUB tổng'` (file `<safeTitle>.epub`), `'EPUB theo tập'` (mọi tập đã chọn có `.epub`), `'TXT/HTML'` (mọi thư mục tập có ít nhất 1 file `.txt`/`.html`).

### 6.7 Giải mã chương (`decodeProtected`)

- `data-c` là JSON array các string.
- Sắp xếp tăng dần theo 4 ký tự đầu (số thứ tự): `parseInt(substring(0,4))`.
- Phần payload = `substring(4)`.
- `data-s === 'xor_shuffle'`: base64-decode rồi XOR từng byte với `dataK.charCodeAt(i % dataK.length)`.
- `data-s === 'base64_reverse'`: đảo ngược chuỗi rồi base64-decode.
- Mặc định: base64-decode thường.

### 6.8 Chấm điểm tìm kiếm (`scoreNovelMatch`)

- Chuẩn hóa bỏ dấu, lowercase (`normalizeSearchText`).
- `+120` nếu khớp tuyệt đối; `+60` nếu startsWith; `+50` nếu includes.
- Mỗi token (>1 ký tự) khớp: `+14`; khớp toàn bộ token: `+35`.
- Không khớp token nào và không includes query: `-50`.

### 6.9 Trích volume cover (server.js, `extractVolumes`)

- Lấy từ `.volume-cover .content.img-in-ratio` → attr `style` → regex `url(...)`.

### 6.10 Aggregation truyện (`aggregateNovelItems`)

- Gộp theo `url`; cộng dồn `count`; điền field thiếu từ bản trùng; loại item không có title hoặc title thuộc `NAV_TEXT_BLACKLIST`.

### 6.11 Selector parse HTML (tham chiếu reimplement)

- **DocLN volume/chapter:** `.volume-list` → `.sect-title` (tiêu đề), `.list-chapters li .chapter-name a` (chương).
- **Valvrare volume/chapter:** `.modules-list .module-container .module-title` + `.module-chapters .module-chapter-item a.chapter-title-link`.
- **Fallback chương:** `.list-chapters li .chapter-name a` gom vào tập "Toan bo".
- **Nội dung chương:** `#chapter-content` hoặc `.chapter-content`.
- **Cover truyện:** `.series-cover .img-in-ratio` style url → `.series-cover img` / `.rd-cover-image` / `meta[property=og:image]`.
- **Tác giả:** `.series-information .info-item` chứa "tac gia" → `a[href*="/tac-gia/"]` → `.rd-author-name` → `meta[name=author]`.
- **Tóm tắt:** `.rd-description-content`, `.summary-content`, `.series-summary`, `.summary`, `[itemprop=description]`, `#summary`; fallback heading chứa "tom tat".
- **Tiêu đề:** `.series-name a` → `.rd-novel-title` (bỏ button/span) → `h1` → `meta[og:title]` → `<title>`.
- **Valvrare directory card:** `.nd-novel-card` chứa `.nd-novel-title-link`, `.nd-novel-image img`, `.nd-novel-description`; phân trang `.nd-pagination a[href*="/danh-sach-truyen/trang/"]`.

---

## 7. Validation Rules (Quy Tắc Kiểm Tra Đầu Vào)

| Đầu vào                 | Quy tắc                                                          | Hành vi khi sai                                                                               | Nguồn                                                    |
| ----------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------- |
| `epubMode`              | ∈ `{'0','1','2','3'}`                                            | ép về `'1'`                                                                                   | `ensureValidEpubMode()`                                  |
| `batchConcurrency`      | ∈ `{1,2,3}`                                                      | ép về `2`                                                                                     | `ensureBatchConcurrency()`                               |
| DNS servers             | mỗi giá trị `net.isIP() !== 0`                                   | HTTP 400                                                                                      | route `POST /api/dns`                                    |
| `selectedVolumeIndexes` | integer, `0 <= i < volumes.length`, unique                       | bỏ index sai; rỗng = tất cả                                                                   | `resolveSelectedVolumeIndexes()`                         |
| Cookie                  | phải chứa `cf_clearance` và/hoặc `ln_session`; chỉ giữ 2 key này | ném lỗi nếu không có key essential nào                                                        | `filterEssentialDoclnCookies()`                          |
| Cookie input            | chấp nhận raw `Cookie:` hoặc lệnh `curl` (regex trích)           | trả '' nếu không match                                                                        | `normalizeDoclnCookieInput()`, `extractCookieFromCurl()` |
| `q` (search)            | không rỗng (sau normalizeWhitespace)                             | HTTP 400                                                                                      | route `/api/search`                                      |
| `url` (novel/download)  | không rỗng                                                       | HTTP 400                                                                                      | routes `/api/novel`, `/api/download`                     |
| `catalogUrl` (batch)    | phải là Valvrare directory URL                                   | HTTP 400                                                                                      | route `/api/batch-download`                              |
| `url` (catalog query)   | nếu có, phải hợp lệ                                              | HTTP 400                                                                                      | route `/api/catalog`                                     |
| Tên file                | thay `[\/\\?%\*:                                                 | "<>]`bằng`-`, bỏ `.`/space cuối, prefix `\_`nếu là tên reserved Windows, fallback`'untitled'` | luôn trả tên an toàn                                     | `sanitizeFileName()` |
| `toDownloadUrl`         | reject nếu path nằm ngoài `DOWNLOADS_DIR` (path traversal)       | trả `null`                                                                                    | `toDownloadUrl()`                                        |

---

## 8. User Permissions (Phân Quyền Người Dùng)

**Not enough evidence found in source code** cho hệ thống phân quyền nhiều vai trò.

Bằng chứng thực tế:

- Không có authentication/authorization, không có khái niệm user/role/session nội bộ.
- Mọi REST endpoint truy cập tự do (single-user, local).
- Khái niệm "cookie" duy nhất là **cookie của site nguồn docln.net** (`cf_clearance`, `ln_session`) để vượt Cloudflare và đăng nhập tài khoản DocLN của người dùng — **không phải** cơ chế phân quyền của ứng dụng này.

Kết luận: Mô hình quyền là **single local user, full access**.

---

## 9. UI Pages (Giao Diện)

### 9.1 Web UI — Single Page (`public/index.html` + `app.js`)

Một trang duy nhất, layout 2 cột.

**Header (topbar):**

- Tiêu đề "Hako Downloader".
- Nút "Làm Mới Gợi Ý" / "Crawl Danh Mục" (label đổi theo site, `updatePrimaryActionLabel`).
- Status chips: `Site: ...`, `DNS: ...`, nút `Cookie: ...` (mở dialog).

**Sidebar (cột trái):**

- Form tìm kiếm (`#searchForm`).
- Form mở URL trực tiếp (`#directUrlForm`).
- Panel DNS: select profile + input custom + nút "Áp Dụng DNS".
- Khu kết quả: tiêu đề + nút "Tải Toàn Bộ (N)" + count.
- Batch controls: select chế độ EPUB + select concurrency (1/2/3).
- Danh sách kết quả (`.result-card`): ảnh bìa, hostname, badge "Nổi bật"/"Đề xuất", tiêu đề, path.

**Content (cột phải):**

- **Detail card:** empty-state hoặc detail-view (bìa, tiêu đề, tác giả, stat pills, tóm tắt; toolbox chọn chế độ EPUB + tên file tùy chỉnh + nút Chọn tất cả/Bỏ chọn/Bắt Đầu Tải; danh sách tập với checkbox + preview 5 chương + tùy chọn cover tập).
- **Task card:** trạng thái (`Đang xếp hàng`/`Đang tải`/`Hoàn tất`/`Thất bại`), progress bar + %, summary, link download EPUB/báo cáo, log `<pre>`.

**Cookie dialog (`<dialog id="cookieDialog">`):** hướng dẫn lấy cookie, textarea nhập cookie/curl, meta trạng thái, nút Kiểm Tra/Xóa Cookie/Lưu Cookie.

**Hành vi khởi động (`bootstrap`):** bind events → render task rỗng → load status → load DNS profiles → load cookie status → nếu site là DocLN mà chưa có cookie → mở dialog + báo cần cookie; ngược lại load recommendations.

**Cover placeholder:** SVG inline data-URI khi không có ảnh (`COVER_PLACEHOLDER`).

> **Ghi chú lỗi mã hóa trong source:** Một số chuỗi trong `app.js` bị lỗi encoding (mojibake), ví dụ `'Lam Moi Goi Y'`, `` `HoÃ n táº¥t` ``, `` `Äang xá»­ lÃ½` ``. Có các hàm bị **định nghĩa trùng** (`buildCompletedTaskSummary`, `buildCompletedTaskLogs`, `buildRunningTaskSummary` xuất hiện 2 lần) — bản sau (UTF-8 đúng) ghi đè bản trước. Khi reimplement nên dùng chuỗi UTF-8 chuẩn.

### 9.2 CLI UI (`index.js`, dùng `terminal-kit`)

Menu chính (chọn bằng click chuột/menu 1 cột):

- `Goi y tu trang chu` → `homepageFlow()`
- `Tim truyen theo tu khoa` → `searchFlow()`
- `Nhap URL truyen truc tiep` → `directUrlFlow()`
- `Cau hinh DNS` → `configureDnsFlow()`
- `Thoat`

Màn chi tiết truyện (`showNovelDetailScreen`): render ảnh bìa trong terminal (`terminal-image` nếu hỗ trợ kitty/iterm2/sixel), thông tin, preview tối đa 12 tập; hành động: Tải tất cả / Chọn tập / Xem lại bìa / Quay lại; chọn chế độ EPUB; chọn phạm vi tập (`1,3,5` hoặc `0`=tất cả).

> **Khác biệt CLI vs Web:** CLI **không** hỗ trợ cookie docln, **không** fetch qua curl, **không** mirror domain, **không** batch download, **không** customTitle/useVolumeCover. CLI **xóa** thư mục ảnh tạm sau khi tạo EPUB (`cleanupTempImages`), còn web server giữ lại. CLI đặt EPUB theo tập tên `<safeVolumeTitle>.epub` (không prefix tiêu đề truyện).

---

## 10. Output Filesystem Layout (Chuẩn Hóa)

```
downloads/
├── <safeTitle>/
│   ├── <safeTitle>.epub                         # EPUB tổng (mode 1,3)
│   ├── <safeTitle> - <safeVolumeTitle>.epub     # EPUB theo tập (mode 2,3) — web server
│   └── <safeVolumeTitle>/
│       ├── _temp_epub_images/                   # ảnh tạm (web server giữ; CLI xóa)
│       ├── <safeChapterTitle>.txt               # cache text
│       └── <safeChapterTitle>.html              # cache html
└── _batch_reports/
    └── valvrare-batch-<ISO-timestamp>.json      # báo cáo batch
```

**Định dạng file TXT chương** (`buildChapterTextContent`):

```
<volumeTitle>

<chapterTitle>

[Anh: <imageUrl>]   (mỗi ảnh 1 dòng nếu có)

<đoạn văn bản, mỗi block cách nhau 2 newline>
```

**EPUB** (`generateEpub` qua `epub-gen-memory`): options `{ title, author, publisher: 'Hako Downloader', tocTitle: 'Mục lục', ignoreFailedDownloads: true, cover? }`. Nếu sinh EPUB lỗi → thử lại sau khi gỡ toàn bộ `<img>` và bỏ cover.

---

## 11. Cấu Hình & Biến Môi Trường

| Biến/Config                    | Mặc định                                             | Tác dụng                                                 | Nguồn                          |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------------- | ------------------------------ |
| `PORT`                         | `3000`                                               | cổng web server                                          | `process.env.PORT`             |
| `DOCLN_FETCH_MODE`             | `'curl'`                                             | `'curl'` → ưu tiên curl cho DocLN; `'axios'` → chỉ axios | `process.env.DOCLN_FETCH_MODE` |
| `HEADERS`                      | (UA Firefox 139 ở server.js / Chrome 125 ở index.js) | header request                                           | hằng `HEADERS`                 |
| `DOCLN_ESSENTIAL_COOKIE_NAMES` | `['cf_clearance','ln_session']`                      | cookie giữ lại                                           | hằng                           |

**Dependencies (`package.json`):** `axios ^1.6.8`, `cheerio ^1.0.0-rc.12`, `epub-gen-memory ^1.1.2`, `express ^5.2.1`, `fs-extra ^11.3.4`, `sharp ^0.34.5`, `terminal-image ^4.2.0`, `terminal-kit ^3.1.2`.

- **Ngoại lệ cần lưu ý:** `index.js` import động `supports-terminal-graphics` nhưng package này **không có** trong `dependencies` (chỉ catch lỗi và coi như không hỗ trợ). `sharp` được khai báo nhưng **không thấy `require('sharp')`** trong các file đã đọc → **Not enough evidence found in source code** về việc sử dụng `sharp`.

**Scripts:** `start`/`web` = `node server.js`; `cli` = `node index.js`; `stop` = kill process theo port; `logs` = `tail -f logs/server.log`.

**Yêu cầu hệ thống ngoài:** `curl` phải có sẵn trong PATH (server gọi `execFile('curl', ...)` cho DocLN).

---

## 12. Sơ Đồ Luồng (Tham Khảo)

**Tải 1 truyện (web):**

```
UI startDownload()
  → POST /api/download {url, epubMode, selectedVolumeIndexes, customTitle, useVolumeCover}
  → createTask(payload) [status=queued] → trả 202 {task}
  → performDownload(taskId): status=running, progress=2
      fetchNovelInfo(url)
      downloadNovelAssets():
        cho mỗi volume → downloadChapters() (cache → fetch → decodeProtected → ghi txt/html → delay 2s)
        embedImagesInHtml()
        generateEpub() theo epubMode
        cleanup theo mode
      status=completed, progress=100, result={epubItems, downloadItems, ...}
  ← UI poll GET /api/tasks/:id mỗi 1.5s → render progress + link tải
```

**Tải hàng loạt:** tương tự nhưng `performBatchDownload()` với worker pool concurrency, skip output đã có, ghi `_batch_reports/*.json`.

---

## 13. Những Điểm Cần Quyết Định Lại Khi Reimplement (Tech Debt Đã Phát Hiện)

Ghi nhận trung thực từ source để team mới không lặp lại:

1. **Trùng lặp logic** giữa `server.js` và `index.js` (~70%) → nên tách module dùng chung (`lib/crawler.js`, `lib/epub.js`, `lib/dns.js`).
2. **Hàm định nghĩa trùng** trong `server.js` (`performDownload`, `startDownloadTask`) và `app.js` (3 hàm build summary/logs) → giữ 1 bản.
3. **Mojibake** trong nhiều chuỗi tiếng Việt ở `app.js`/`index.js` → chuẩn hóa UTF-8.
4. **Task store in-memory** → mất khi restart; cân nhắc persist nếu cần.
5. **`console.log [DEBUG]`** còn sót trong production path (`downloadNovelAssets`, `performDownload`, `startDownload`).
6. **`sharp`** khai báo nhưng không dùng (theo bằng chứng đã đọc).
7. **Selector phụ thuộc HTML site nguồn** → dễ vỡ khi site đổi cấu trúc (README cũng cảnh báo).

---

## 14. Checklist Reimplement Tối Thiểu

- [ ] Express server, port 3000, static `public/` + `downloads/`, JSON limit 1MB, middleware log request.
- [ ] Module crawl: `fetchHtmlPage` (curl+axios, mirror, cookie), parse novel/volume/chapter/catalog theo selector §6.11.
- [ ] Cookie manager docln (load/save/test/clear, jar Netscape, chỉ 2 essential key).
- [ ] DNS profiles + custom lookup (resolver theo servers, IPv4, TLS 1.2).
- [ ] Task system (Map, UUID, status/progress/logs ≤200, serialize).
- [ ] Download 1 truyện (4 epubMode, customTitle, useVolumeCover, cache, decodeProtected, embed images, delay 2s, backoff 429).
- [ ] Batch download (worker pool 1–3, skip existing, report JSON).
- [ ] 15 REST endpoints (§5) với đúng status code & validation (§7).
- [ ] Web UI 1 trang (§9.1) + polling 1.5s.
- [ ] (Tùy chọn) CLI terminal-kit (§9.2).
- [ ] Logging ra `logs/server.log`, xử lý EADDRINUSE & lỗi toàn cục.

---

_Tài liệu được tạo từ phân tích trực tiếp source code thực tế. Các mục không đủ bằng chứng đã được đánh dấu rõ ràng._
