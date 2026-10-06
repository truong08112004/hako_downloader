const axios = require("axios");
const cheerio = require("cheerio");
const { execFile } = require("child_process");
const dns = require("dns");
const express = require("express");
const fs = require("fs-extra");
const http = require("http");
const https = require("https");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const EpubGen = require("epub-gen-memory").default;

const app = express();
const DOWNLOADS_DIR = path.join(__dirname, "downloads");
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "server.log");
const DOCLN_COOKIE_FILE = path.join(__dirname, ".docln-cookies.json");
const DOCLN_COOKIE_JAR_FILE = path.join(__dirname, ".docln-cookie.jar");
const DOCLN_PRIMARY_ORIGIN = "https://docln.sbs";
const DOCLN_LEGACY_ORIGIN = "https://docln.net";
const VALVRARE_ORIGIN = "https://valvrareteam.net";
const DOCLN_ORIGINS = new Set([DOCLN_PRIMARY_ORIGIN, DOCLN_LEGACY_ORIGIN]);
const VALVRARE_DIRECTORY_CACHE_TTL_MS = 10 * 60 * 1000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  Referer: "https://docln.sbs/",
};

const DOCLN_FETCH_MODE = process.env.DOCLN_FETCH_MODE || "curl";
const DOCLN_ESSENTIAL_COOKIE_NAMES = ["cf_clearance", "ln_session"];

const SITE_ORIGINS = [
  DOCLN_PRIMARY_ORIGIN,
  "https://ln.hako.vn",
  VALVRARE_ORIGIN,
];

const DNS_PROFILES = {
  system: { id: "system", label: "Hệ thống mặc định", servers: null },
  cloudflare: {
    id: "cloudflare",
    label: "Cloudflare (1.1.1.1, 1.0.0.1)",
    servers: ["1.1.1.1", "1.0.0.1"],
  },
  google: {
    id: "google",
    label: "Google (8.8.8.8, 8.8.4.4)",
    servers: ["8.8.8.8", "8.8.4.4"],
  },
};

const EPUB_MODES = ["0", "1", "2", "3"];
const BATCH_CONCURRENCY_VALUES = [1, 2, 3];

const NAV_TEXT_BLACKLIST = new Set([
  "",
  "xem them",
  "dang nhap",
  "lich su",
  "thao luan",
  "sang tac",
  "ai dich",
  "xuat ban",
  "danh sach",
  "thong tin",
  "chu y",
  "donate",
  "top thang",
  "toan t/gian",
  "truyen vua doc",
]);

let activeOrigin = DOCLN_PRIMARY_ORIGIN;
let dnsProfile = createDnsProfile(
  DNS_PROFILES.system.label,
  DNS_PROFILES.system.servers,
  DNS_PROFILES.system.id,
);
let httpClient;
let valvrareDirectoryCache = null;
let doclnCookieStore = {
  cookie: "",
  updatedAt: null,
};

const tasks = new Map();
const imageResolutionWaiters = new Map();

loadDoclnCookiesFromDisk();
applyDnsProfile(DNS_PROFILES.system);
setupProcessLogging();

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    if (shouldLogHttpRequest(req, res, durationMs)) {
      logLine(
        `[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms)`,
      );
    }
  });
  next();
});
app.use("/downloads", express.static(DOWNLOADS_DIR));
app.use(express.static(path.join(__dirname, "public")));

function logLine(message) {
  console.log(message);
}

function logError(message) {
  console.error(message);
}

function formatFetchUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname =
      parsed.pathname.length > 55
        ? `${parsed.pathname.slice(0, 52)}...`
        : parsed.pathname;
    return `${parsed.hostname}${pathname}`;
  } catch {
    return url;
  }
}

function formatTaskId(taskId) {
  return String(taskId || "").slice(0, 8);
}

function shouldLogHttpRequest(req, res, durationMs) {
  const url = req.originalUrl.split("?")[0];

  if (
    req.method === "GET" &&
    /^\/api\/tasks(?:\/[^/]+)?$/.test(url) &&
    res.statusCode < 400
  ) {
    return false;
  }

  if (
    req.method === "GET" &&
    /\.(css|js|ico|png|jpg|svg|woff2?)$/i.test(url) &&
    res.statusCode < 400
  ) {
    return false;
  }

  if (
    req.method === "GET" &&
    (url === "/" || url === "/favicon.ico") &&
    res.statusCode < 400
  ) {
    return false;
  }

  if (res.statusCode >= 400 || durationMs >= 3000) {
    return true;
  }

  return req.method !== "GET" || url.startsWith("/api/");
}

function setupProcessLogging() {
  fs.ensureDirSync(LOG_DIR);

  const writeLog = (level, args) => {
    const text = args
      .map((value) => {
        if (typeof value === "string") return value;
        if (value instanceof Error) return value.stack || value.message;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(" ");

    fs.appendFile(
      LOG_FILE,
      `[${new Date().toISOString()}] [${level}] ${text}\n`,
    ).catch(() => {});
  };

  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);

  console.log = (...args) => {
    originalLog(...args);
    writeLog("info", args);
  };

  console.error = (...args) => {
    originalError(...args);
    writeLog("error", args);
  };

  process.on("unhandledRejection", (error) => {
    logError(`[fatal] unhandledRejection: ${formatErrorMessage(error)}`);
  });

  process.on("uncaughtException", (error) => {
    logError(`[fatal] uncaughtException: ${formatErrorMessage(error)}`);
  });
}

function keepProcessAliveForTerminal() {
  if (process.stdin.isTTY) {
    process.stdin.resume();
  }

  process.on("SIGINT", () => {
    logLine("\n[server] Nhận Ctrl+C — đang dừng server...");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    logLine("[server] Nhận SIGTERM — đang dừng server...");
    process.exit(0);
  });
}

function createDnsProfile(label, servers, id = "custom") {
  return {
    id,
    label,
    servers: Array.isArray(servers) && servers.length > 0 ? [...servers] : null,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFileName(value) {
  const normalized = String(value || "").normalize("NFC");
  const sanitized = normalized
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim();

  const safeValue = sanitized || "untitled";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(safeValue)
    ? `_${safeValue}`
    : safeValue;
}

function normalizeWhitespace(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function normalizeSearchText(value) {
  return normalizeWhitespace(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function toDownloadUrl(filePath) {
  const relativePath = path.relative(DOWNLOADS_DIR, filePath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  const encodedPath = relativePath
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `/downloads/${encodedPath}`;
}

function buildDownloadResult(novel, novelDir, epubFiles) {
  const epubItems = epubFiles
    .map((filePath) => ({
      name: path.basename(filePath),
      path: filePath,
      url: toDownloadUrl(filePath),
    }))
    .filter((item) => item.url);

  return {
    novelTitle: novel.title,
    novelDir,
    epubFiles,
    epubItems,
    downloadItems: epubItems,
    sourceUrl: novel.sourceUrl,
  };
}

function isNovelPath(pathname) {
  return (
    /^\/truyen\/\d+(?:-[^/?#]+)?\/?$/.test(pathname) ||
    /^\/truyen\/[^/?#]+\/?$/.test(pathname)
  );
}

function isValvrareOrigin(origin) {
  return origin === VALVRARE_ORIGIN;
}

function isValvrareDirectoryPath(pathname) {
  return /^\/danh-sach-truyen(?:\/trang\/\d+)?\/?$/.test(pathname);
}

function isValvrareDirectoryUrl(href) {
  if (!href) return false;

  try {
    const url = new URL(href, VALVRARE_ORIGIN);
    return (
      isValvrareOrigin(url.origin) && isValvrareDirectoryPath(url.pathname)
    );
  } catch {
    return false;
  }
}

function isNovelHref(href) {
  if (!href) return false;

  try {
    const url = new URL(href, activeOrigin);
    return isNovelPath(url.pathname);
  } catch {
    return false;
  }
}

function normalizeUrl(href, baseUrl = activeOrigin) {
  if (!href) return "";

  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return "";
  }
}

function normalizeNovelUrl(href, baseUrl = activeOrigin) {
  const normalized = normalizeUrl(href, baseUrl);
  if (!normalized) return "";

  try {
    const url = new URL(normalized);
    if (isNovelPath(url.pathname)) {
      url.search = "";
      url.hash = "";
    }
    return url.toString();
  } catch {
    return normalized;
  }
}

function extractImageUrlFromStyle(styleValue = "") {
  return styleValue.match(/url\(['"]?(.*?)['"]?\)/)?.[1] || "";
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return activeOrigin;
  }
}

function isDoclnOrigin(origin) {
  return DOCLN_ORIGINS.has(origin);
}

function needsDoclnCookies(targetUrl) {
  return isDoclnOrigin(getOrigin(targetUrl));
}

function parseCookieNames(cookieHeader) {
  if (!cookieHeader) return [];

  return cookieHeader
    .split(";")
    .map((part) => part.trim().split("=")[0])
    .filter(Boolean);
}

function isEssentialDoclnCookieName(name) {
  return DOCLN_ESSENTIAL_COOKIE_NAMES.includes(name);
}

function filterEssentialDoclnCookies(cookieHeader) {
  const pairs = parseCookieHeaderPairs(cookieHeader);
  const essentialPairs = pairs.filter((pair) =>
    isEssentialDoclnCookieName(pair.name),
  );

  if (essentialPairs.length === 0) {
    throw new Error(
      `Cookie phải có ít nhất cf_clearance và ln_session. Chỉ cần dán 1 dòng Cookie từ trình duyệt — app sẽ tự giữ 2 key này.`,
    );
  }

  return essentialPairs.map((pair) => `${pair.name}=${pair.value}`).join("; ");
}

function extractCookieFromCurl(curlText) {
  const normalized = String(curlText || "");
  const patterns = [
    /(?:^|\s)(?:-H|--header)\s+['"]Cookie:\s*([^'"]+)['"]/i,
    /(?:^|\s)(?:-H|--header)\s+['"]cookie:\s*([^'"]+)['"]/i,
    /(?:^|\s)(?:-b|--cookie)\s+['"]([^'"]+)['"]/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return "";
}

function normalizeDoclnCookieInput(rawInput) {
  const trimmed = normalizeWhitespace(rawInput);
  if (!trimmed) return "";

  if (/curl\s/i.test(trimmed) || /(?:^|\s)(?:-H|--header)\s/i.test(trimmed)) {
    return extractCookieFromCurl(trimmed);
  }

  return trimmed.replace(/^cookie:\s*/i, "");
}

function parseCookieHeaderPairs(cookieHeader) {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) return null;
      return {
        name: part.slice(0, separatorIndex),
        value: part.slice(separatorIndex + 1),
      };
    })
    .filter(Boolean);
}

async function writeDoclnCookieJar(cookieHeader, hostname = "docln.sbs") {
  const cookies = parseCookieHeaderPairs(cookieHeader);
  if (cookies.length === 0) return;

  const expiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  const domain = hostname.startsWith(".") ? hostname : `.${hostname}`;
  const lines = [
    "# Netscape HTTP Cookie File",
    "# Generated by hako-downloader",
    "",
  ];

  for (const { name, value } of cookies) {
    lines.push([domain, "TRUE", "/", "FALSE", expiry, name, value].join("\t"));
  }

  await fs.writeFile(DOCLN_COOKIE_JAR_FILE, `${lines.join("\n")}\n`, "utf8");
}

function refreshDoclnCookiesFromDisk() {
  try {
    if (!fs.existsSync(DOCLN_COOKIE_FILE)) return;

    const saved = fs.readJsonSync(DOCLN_COOKIE_FILE);
    const cookie = normalizeDoclnCookieInput(saved.cookie || "");
    if (!cookie) return;

    const changed =
      cookie !== doclnCookieStore.cookie ||
      saved.updatedAt !== doclnCookieStore.updatedAt;

    if (!changed) return;

    doclnCookieStore = {
      cookie: filterEssentialDoclnCookies(cookie),
      updatedAt: saved.updatedAt || null,
    };
    writeDoclnCookieJar(doclnCookieStore.cookie, "docln.sbs").catch((error) => {
      console.warn(`Không ghi cookie jar: ${error.message}`);
    });
  } catch (error) {
    console.warn(`Không đọc được cookie docln: ${error.message}`);
  }
}

function loadDoclnCookiesFromDisk() {
  try {
    if (!fs.existsSync(DOCLN_COOKIE_FILE)) return;

    const saved = fs.readJsonSync(DOCLN_COOKIE_FILE);
    const normalized = normalizeDoclnCookieInput(saved.cookie || "");
    if (!normalized) return;

    const cookie = filterEssentialDoclnCookies(normalized);

    doclnCookieStore = {
      cookie,
      updatedAt: saved.updatedAt || null,
    };
    writeDoclnCookieJar(cookie, "docln.sbs").catch((error) => {
      console.warn(`Không ghi cookie jar: ${error.message}`);
    });

    if (cookie !== normalized) {
      persistDoclnCookies().catch((error) => {
        console.warn(`Không ghi lại cookie đã lọc: ${error.message}`);
      });
    }
  } catch (error) {
    console.warn(`Không đọc được cookie docln: ${error.message}`);
  }
}

async function persistDoclnCookies() {
  if (!doclnCookieStore.cookie) {
    if (await fs.pathExists(DOCLN_COOKIE_FILE)) {
      await fs.remove(DOCLN_COOKIE_FILE);
    }
    if (await fs.pathExists(DOCLN_COOKIE_JAR_FILE)) {
      await fs.remove(DOCLN_COOKIE_JAR_FILE);
    }
    return;
  }

  await fs.writeJson(
    DOCLN_COOKIE_FILE,
    {
      cookie: doclnCookieStore.cookie,
      updatedAt: doclnCookieStore.updatedAt,
    },
    { spaces: 2 },
  );
  await writeDoclnCookieJar(doclnCookieStore.cookie, "docln.sbs");
}

function getDoclnCookieStatus() {
  const keys = parseCookieNames(doclnCookieStore.cookie);
  const essentialKeys = keys.filter(isEssentialDoclnCookieName);

  return {
    configured: Boolean(doclnCookieStore.cookie),
    updatedAt: doclnCookieStore.updatedAt,
    keys: essentialKeys,
    essentialKeys,
    hasCloudflare: essentialKeys.includes("cf_clearance"),
    hasSession: essentialKeys.includes("ln_session"),
    isValid:
      essentialKeys.includes("cf_clearance") &&
      essentialKeys.includes("ln_session"),
  };
}

function setDoclnCookies(rawInput) {
  const normalized = normalizeDoclnCookieInput(rawInput);
  if (!normalized) {
    throw new Error("Cookie trống hoặc không đọc được từ nội dung đã dán.");
  }

  const cookie = filterEssentialDoclnCookies(normalized);

  doclnCookieStore = {
    cookie,
    updatedAt: new Date().toISOString(),
  };
  writeDoclnCookieJar(cookie, "docln.sbs").catch(() => {});

  return getDoclnCookieStatus();
}

async function clearDoclnCookies() {
  doclnCookieStore = {
    cookie: "",
    updatedAt: null,
  };

  if (await fs.pathExists(DOCLN_COOKIE_JAR_FILE)) {
    await fs.remove(DOCLN_COOKIE_JAR_FILE);
  }
}

async function testDoclnCookies() {
  if (!doclnCookieStore.cookie) {
    throw new Error("Chưa cấu hình cookie docln.sbs.");
  }

  const testUrl = `${DOCLN_PRIMARY_ORIGIN}/`;
  const headers = buildRequestHeaders(testUrl);
  await writeDoclnCookieJar(doclnCookieStore.cookie, "docln.sbs");

  try {
    const result = await fetchViaCurl(testUrl, headers);
    const blocked = isCloudflareBlockPage(result.body);

    return {
      ok: !blocked && result.body.length > 200,
      status: blocked ? 403 : 200,
      blocked,
      finalUrl: result.finalUrl || testUrl,
      mode: "curl",
    };
  } catch (error) {
    const response = await httpClient.get(testUrl, {
      responseType: "text",
      headers,
      validateStatus: () => true,
    });
    const html =
      typeof response.data === "string"
        ? response.data
        : String(response.data || "");
    const blocked = response.status === 403 || isCloudflareBlockPage(html);

    return {
      ok: response.status >= 200 && response.status < 400 && !blocked,
      status: response.status,
      blocked,
      finalUrl: getFinalResponseUrl(response, testUrl),
      mode: "axios",
      fallbackError: formatErrorMessage(error),
    };
  }
}

function buildRequestHeaders(targetUrl) {
  const targetOrigin = getOrigin(targetUrl);
  const refererOrigin = isDoclnOrigin(targetOrigin)
    ? targetOrigin
    : isSiteOrigin(targetOrigin)
      ? targetOrigin
      : DOCLN_PRIMARY_ORIGIN;
  const headers = {
    ...HEADERS,
    Referer: `${refererOrigin}/`,
  };

  if (needsDoclnCookies(targetUrl) && doclnCookieStore.cookie) {
    headers.Cookie = doclnCookieStore.cookie;
  }

  return headers;
}

function updateActiveOrigin(finalUrl) {
  const finalOrigin = getOrigin(finalUrl);
  if (isSiteOrigin(finalOrigin)) {
    activeOrigin = finalOrigin;
  }
}

function isCloudflareBlockPage(html) {
  if (!html || html.length < 120) return true;
  if (
    /series-name|volume-list|rd-novel-title|module-chapter-item|list-chapters|danh-sach-chuong/i.test(
      html,
    )
  ) {
    return false;
  }

  const sniff = html.slice(0, 12000).toLowerCase();
  return (
    sniff.includes("<title>just a moment") ||
    sniff.includes("cf-browser-verification") ||
    sniff.includes("checking if the site connection is secure") ||
    (sniff.includes("challenge-platform") &&
      sniff.includes("window._cf_chl_opt"))
  );
}

function isSiteOrigin(origin) {
  return SITE_ORIGINS.includes(origin);
}

function getFinalResponseUrl(response, fallbackUrl) {
  return response?.request?.res?.responseUrl || fallbackUrl;
}

function collectErrorMessages(error, messages = [], seen = new Set()) {
  if (!error || seen.has(error)) return messages;
  seen.add(error);

  const message =
    typeof error === "string"
      ? error
      : error.message || error.code || String(error);

  if (message && !messages.includes(message)) {
    messages.push(message);
  }

  if (Array.isArray(error.errors)) {
    error.errors.forEach((child) =>
      collectErrorMessages(child, messages, seen),
    );
  }

  if (error.cause) {
    collectErrorMessages(error.cause, messages, seen);
  }

  return messages;
}

function formatErrorMessage(error) {
  const messages = collectErrorMessages(error);
  if (messages.length === 0) return "Lỗi không xác định";
  if (messages.length === 1) return messages[0];
  return messages.slice(0, 5).join(" | ");
}

function isNoDataError(error) {
  return error && ["ENOTFOUND", "ENODATA", "EAI_NODATA"].includes(error.code);
}

function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname.endsWith(".local");
}

async function resolveWithCustomDns(resolver, hostname, family, all) {
  const resolveFamily = async (targetFamily) => {
    const addresses =
      targetFamily === 6
        ? await resolver.resolve6(hostname)
        : await resolver.resolve4(hostname);
    return addresses.map((address) => ({ address, family: targetFamily }));
  };

  if (family === 4 || family === 6) return resolveFamily(family);

  if (!all) {
    try {
      return await resolveFamily(4);
    } catch (error) {
      if (!isNoDataError(error)) throw error;
      return resolveFamily(6);
    }
  }

  const records = [];
  let firstError = null;

  for (const targetFamily of [4, 6]) {
    try {
      records.push(...(await resolveFamily(targetFamily)));
    } catch (error) {
      if (!firstError) firstError = error;
      if (!isNoDataError(error)) throw error;
    }
  }

  if (records.length > 0) return records;
  throw firstError || new Error(`DNS lookup failed for ${hostname}`);
}

function createLookup(servers) {
  if (!servers || servers.length === 0) return dns.lookup;

  const resolver = new dns.promises.Resolver();
  resolver.setServers(servers);

  return function customLookup(hostname, options, callback) {
    let lookupOptions = options;
    let done = callback;

    if (typeof lookupOptions === "function") {
      done = lookupOptions;
      lookupOptions = {};
    } else if (typeof lookupOptions === "number") {
      lookupOptions = { family: lookupOptions };
    } else {
      lookupOptions = lookupOptions || {};
    }

    const ipFamily = net.isIP(hostname);
    if (ipFamily) {
      if (lookupOptions.all) {
        done(null, [{ address: hostname, family: ipFamily }]);
        return;
      }

      done(null, hostname, ipFamily);
      return;
    }

    if (isLocalHostname(hostname)) {
      dns.lookup(hostname, lookupOptions, done);
      return;
    }

    resolveWithCustomDns(
      resolver,
      hostname,
      lookupOptions.family,
      Boolean(lookupOptions.all),
    )
      .then((records) => {
        if (lookupOptions.all) {
          done(null, records);
          return;
        }

        done(null, records[0].address, records[0].family);
      })
      .catch(done);
  };
}

function createHttpClient(lookup) {
  return axios.create({
    headers: HEADERS,
    timeout: 30000,
    maxRedirects: 5,
    httpAgent: new http.Agent({ lookup, family: 4 }),
    httpsAgent: new https.Agent({ lookup, family: 4, minVersion: "TLSv1.2" }),
    validateStatus: (status) => status >= 200 && status < 400,
  });
}

function shouldFetchDoclnViaCurl(targetUrl) {
  return needsDoclnCookies(targetUrl) && DOCLN_FETCH_MODE !== "axios";
}

function buildCurlArgs(url, headers, options = {}) {
  const args = [
    "-sSL",
    "--compressed",
    "--ipv4",
    "--tlsv1.2",
    "--http1.1",
    "--max-time",
    String(options.timeoutSeconds || 45),
    "-A",
    headers["User-Agent"] || HEADERS["User-Agent"],
    "-H",
    `Accept: ${headers.Accept || HEADERS.Accept}`,
    "-H",
    `Accept-Language: ${headers["Accept-Language"] || HEADERS["Accept-Language"]}`,
  ];

  if (
    needsDoclnCookies(url) &&
    doclnCookieStore.cookie &&
    fs.existsSync(DOCLN_COOKIE_JAR_FILE)
  ) {
    args.push("-b", DOCLN_COOKIE_JAR_FILE);
  } else if (headers.Cookie) {
    args.push("-H", `Cookie: ${headers.Cookie}`);
  }

  if (headers.Referer) {
    args.push("-H", `Referer: ${headers.Referer}`);
  }

  if (options.includeEffectiveUrl) {
    args.push("-w", "\n__CURL_EFFECTIVE_URL__:%{url_effective}");
  }

  args.push(url);
  return args;
}

function splitCurlResponse(rawOutput) {
  const marker = "\n__CURL_EFFECTIVE_URL__:";
  const markerIndex = rawOutput.lastIndexOf(marker);

  if (markerIndex === -1) {
    return { body: rawOutput, finalUrl: "" };
  }

  return {
    body: rawOutput.slice(0, markerIndex),
    finalUrl: rawOutput.slice(markerIndex + marker.length).trim(),
  };
}

function isRecoverableFetchError(error) {
  const message = formatErrorMessage(error).toLowerCase();
  return /tls|socket disconnected|econnreset|etimedout|timeout exceeded|ssl|certificate|epipe|enotfound|eai_again|403|cloudflare|cookie|curl/i.test(
    message,
  );
}

function formatCurlExecError(error) {
  const stderr = error?.stderr ? String(error.stderr).trim() : "";
  if (stderr) return stderr.split("\n").pop();
  return formatErrorMessage(error);
}

async function fetchViaCurl(url, headers, options = {}) {
  const args = buildCurlArgs(url, headers, {
    timeoutSeconds: options.timeoutSeconds || 45,
    includeEffectiveUrl: true,
  });

  const { stdout } = await execFileAsync("curl", args, {
    maxBuffer: options.maxBuffer || 15 * 1024 * 1024,
    encoding: "utf8",
  });

  const { body, finalUrl } = splitCurlResponse(stdout);
  if (!body || body.length < 120) {
    throw new Error("curl trả về nội dung quá ngắn hoặc rỗng.");
  }

  if (isCloudflareBlockPage(body)) {
    const host = getOrigin(url);
    throw new Error(
      `${host} trả về trang Cloudflare. Hãy mở ${host} trên trình duyệt, lấy cookie mới và lưu lại.`,
    );
  }

  return {
    body,
    finalUrl: finalUrl || url,
  };
}

async function fetchBinaryViaCurl(url, headers, options = {}) {
  const args = buildCurlArgs(url, headers, {
    timeoutSeconds: options.timeoutSeconds || 30,
  });

  const { stdout } = await execFileAsync("curl", args, {
    maxBuffer: options.maxBuffer || 12 * 1024 * 1024,
    encoding: "buffer",
  });

  if (!stdout || stdout.length < 100) {
    throw new Error(
      `curl tải nhị phân thất bại (${stdout?.length || 0} bytes).`,
    );
  }

  return stdout;
}

async function fetchPageContent(url) {
  refreshDoclnCookiesFromDisk();
  const headers = buildRequestHeaders(url);
  const errors = [];

  if (needsDoclnCookies(url) && doclnCookieStore.cookie) {
    const hostname = new URL(url).hostname;
    await writeDoclnCookieJar(doclnCookieStore.cookie, hostname);
  }

  if (needsDoclnCookies(url) && !doclnCookieStore.cookie) {
    throw new Error(
      "docln.sbs yêu cầu cookie. Hãy mở Cấu Hình Cookie và dán cookie từ trình duyệt.",
    );
  }

  if (shouldFetchDoclnViaCurl(url)) {
    const label = formatFetchUrl(url);
    const startedAt = Date.now();
    logLine(`[fetch] ▶ curl ${label}`);
    try {
      const curlResult = await fetchViaCurl(url, headers);
      logLine(`[fetch] ✓ curl ${label} (${Date.now() - startedAt}ms)`);
      return {
        html: curlResult.body,
        finalUrl: curlResult.finalUrl || url,
      };
    } catch (error) {
      errors.push(error);
      logLine(`[fetch] ✗ curl ${label}: ${formatCurlExecError(error)}`);
    }
  }

  const label = formatFetchUrl(url);
  const startedAt = Date.now();
  logLine(`[fetch] ▶ axios ${label}`);
  try {
    const response = await httpClient.get(url, {
      responseType: "text",
      headers,
    });
    const html =
      typeof response.data === "string" ? response.data : String(response.data);
    logLine(`[fetch] ✓ axios ${label} (${Date.now() - startedAt}ms)`);

    return {
      html,
      finalUrl: getFinalResponseUrl(response, url),
    };
  } catch (error) {
    errors.push(error);
    logLine(`[fetch] ✗ axios ${label}: ${formatErrorMessage(error)}`);
  }

  const combinedMessage = errors
    .map((error) => formatCurlExecError(error))
    .filter(Boolean)
    .join(" | ");

  throw new Error(combinedMessage || `Không thể tải trang: ${url}`);
}

async function fetchBinaryContent(url, headers = buildRequestHeaders(url)) {
  if (shouldFetchDoclnViaCurl(url)) {
    return fetchBinaryViaCurl(url, headers);
  }

  const requestOptions = {
    responseType: "arraybuffer",
    timeout: 45000,
    headers,
    maxRedirects: 10,
  };

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await httpClient.get(url, requestOptions);
      return Buffer.from(response.data);
    } catch (error) {
      lastError = error;
      if (attempt === 0 && isRecoverableFetchError(error)) {
        await delay(1500);
        continue;
      }
      break;
    }
  }

  if (isRecoverableFetchError(lastError)) {
    const label = formatFetchUrl(url);
    const startedAt = Date.now();
    logLine(`[fetch] ▶ curl ${label} (ảnh)`);
    try {
      const buffer = await fetchBinaryViaCurl(url, headers, {
        timeoutSeconds: 45,
      });
      logLine(`[fetch] ✓ curl ${label} (ảnh, ${Date.now() - startedAt}ms)`);
      return buffer;
    } catch (curlError) {
      logLine(
        `[fetch] ✗ curl ${label} (ảnh): ${formatCurlExecError(curlError)}`,
      );
      throw curlError;
    }
  }

  throw lastError;
}

function applyDnsProfile(profile) {
  dnsProfile = createDnsProfile(
    profile.label,
    profile.servers,
    profile.id || "custom",
  );
  const lookup = createLookup(dnsProfile.servers);
  httpClient = createHttpClient(lookup);
}

function getStatus() {
  return {
    site: activeOrigin,
    dns: dnsProfile.label,
    doclnCookies: getDoclnCookieStatus(),
  };
}

function extractAnchorTitle($, anchor) {
  const anchorNode = $(anchor);
  return normalizeWhitespace(
    anchorNode.attr("title") ||
      anchorNode.find("img").first().attr("alt") ||
      anchorNode.text(),
  );
}

function extractAnchorImage($, anchor, pageUrl) {
  const anchorNode = $(anchor);
  const nearbyImageNode =
    anchorNode.find(".img-in-ratio").first().length > 0
      ? anchorNode.find(".img-in-ratio").first()
      : anchorNode.parent().find(".img-in-ratio").first().length > 0
        ? anchorNode.parent().find(".img-in-ratio").first()
        : anchorNode
            .parents(
              ".thumb-wrapper, .series-cover, .thumb-item-flow, .popular-thumb-item",
            )
            .first()
            .find(".img-in-ratio")
            .first();

  const imageUrl =
    anchorNode.find("img").first().attr("data-src") ||
    anchorNode.find("img").first().attr("src") ||
    nearbyImageNode.attr("data-bg") ||
    extractImageUrlFromStyle(nearbyImageNode.attr("style") || "") ||
    "";
  return imageUrl ? normalizeUrl(imageUrl, pageUrl) : "";
}

function aggregateNovelItems(items) {
  const map = new Map();

  items.forEach((item, index) => {
    if (!item.url) return;

    const existing = map.get(item.url);

    if (!existing) {
      map.set(item.url, {
        ...item,
        firstIndex: index,
        count: 1,
      });
      return;
    }

    existing.count += 1;
    if (!existing.title && item.title) existing.title = item.title;
    if (!existing.imageUrl && item.imageUrl) existing.imageUrl = item.imageUrl;
    if (!existing.summary && item.summary) existing.summary = item.summary;
    if (!existing.badge && item.badge) existing.badge = item.badge;
  });

  return [...map.values()].filter(
    (item) =>
      item.title && !NAV_TEXT_BLACKLIST.has(normalizeSearchText(item.title)),
  );
}

function extractNovelCandidatesFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const items = [];

  $("a[href]").each((_, anchor) => {
    const href = $(anchor).attr("href");
    if (!isNovelHref(href)) return;

    const title = extractAnchorTitle($, anchor);
    const imageUrl = extractAnchorImage($, anchor, pageUrl);
    const url = normalizeNovelUrl(href, pageUrl);
    if (!url) return;

    items.push({ title, imageUrl, url });
  });

  return aggregateNovelItems(items);
}

function extractValvrareDirectoryItems(html, pageUrl) {
  const $ = cheerio.load(html);
  const items = [];

  $(".nd-novel-card").each((_, card) => {
    const cardNode = $(card);
    const titleAnchor = cardNode.find(".nd-novel-title-link[href]").first();
    const imageAnchor = cardNode.find(".nd-novel-image-link[href]").first();
    const href = titleAnchor.attr("href") || imageAnchor.attr("href");
    const url = normalizeNovelUrl(href, pageUrl);
    const title = normalizeWhitespace(
      cardNode.find(".nd-novel-title").first().text() ||
        titleAnchor.attr("title") ||
        titleAnchor.text() ||
        imageAnchor.find("img").first().attr("alt"),
    );

    if (!url || !title) return;

    const imageNode = cardNode.find(".nd-novel-image img").first();
    const imageUrl = normalizeUrl(
      imageNode.attr("src") || imageNode.attr("data-src") || "",
      pageUrl,
    );
    const summary = normalizeWhitespace(
      cardNode.find(".nd-novel-description").first().text(),
    );

    items.push({
      title,
      imageUrl,
      summary,
      badge: "Danh mục",
      url,
    });
  });

  return items;
}

function extractValvrareDirectoryMeta(html) {
  const $ = cheerio.load(html);
  let totalPages = 0;
  let totalItems = 0;

  $('.nd-pagination a[href*="/danh-sach-truyen/trang/"]').each((_, anchor) => {
    const href = $(anchor).attr("href") || "";
    const hrefMatch = href.match(/\/trang\/(\d+)/);
    const hrefPage = Number.parseInt(hrefMatch?.[1] || "", 10);
    const textPage = Number.parseInt(normalizeWhitespace($(anchor).text()), 10);

    if (Number.isInteger(hrefPage)) {
      totalPages = Math.max(totalPages, hrefPage);
    }

    if (Number.isInteger(textPage)) {
      totalPages = Math.max(totalPages, textPage);
    }
  });

  const totalPagesMatch = html.match(/"totalPages":(\d+)/);
  const totalItemsMatch = html.match(/"totalItems":(\d+)/);
  const headingMatch = normalizeWhitespace(
    $(".nd-section-headers h2").first().text(),
  ).match(/\((\d+)\)/);

  if (totalPagesMatch) {
    totalPages = Math.max(
      totalPages,
      Number.parseInt(totalPagesMatch[1], 10) || 0,
    );
  }

  if (totalItemsMatch) {
    totalItems = Number.parseInt(totalItemsMatch[1], 10) || 0;
  }

  if (!totalItems && headingMatch) {
    totalItems = Number.parseInt(headingMatch[1], 10) || 0;
  }

  return {
    totalPages: Math.max(totalPages, 1),
    totalItems,
  };
}

function getCachedValvrareDirectory() {
  if (!valvrareDirectoryCache) return null;

  if (
    Date.now() - valvrareDirectoryCache.timestamp >
    VALVRARE_DIRECTORY_CACHE_TTL_MS
  ) {
    valvrareDirectoryCache = null;
    return null;
  }

  return valvrareDirectoryCache;
}

function buildValvrareDirectoryPageUrl(pageNumber = 1) {
  return normalizeUrl(`/danh-sach-truyen/trang/${pageNumber}`, VALVRARE_ORIGIN);
}

async function crawlValvrareDirectory() {
  const cached = getCachedValvrareDirectory();
  if (cached) return cached;

  const firstPageUrl = buildValvrareDirectoryPageUrl(1);
  const firstPage = await fetchHtmlPage(firstPageUrl);
  const firstPagePath = new URL(firstPage.url).pathname;

  if (
    !isValvrareOrigin(getOrigin(firstPage.url)) ||
    !isValvrareDirectoryPath(firstPagePath)
  ) {
    throw new Error("Không thể mở danh mục truyện Valvrare.");
  }

  const directoryItems = [
    ...extractValvrareDirectoryItems(firstPage.html, firstPage.url),
  ];
  const directoryMeta = extractValvrareDirectoryMeta(firstPage.html);

  for (
    let pageNumber = 2;
    pageNumber <= directoryMeta.totalPages;
    pageNumber += 1
  ) {
    const page = await fetchHtmlPage(buildValvrareDirectoryPageUrl(pageNumber));
    directoryItems.push(...extractValvrareDirectoryItems(page.html, page.url));
  }

  const items = aggregateNovelItems(directoryItems).sort(
    (left, right) => left.firstIndex - right.firstIndex,
  );

  if (items.length === 0) {
    throw new Error("Không tìm thấy truyện nào trong danh mục Valvrare.");
  }

  valvrareDirectoryCache = {
    items,
    sourceUrl: firstPageUrl,
    totalPages: directoryMeta.totalPages,
    totalItems: directoryMeta.totalItems || items.length,
    timestamp: Date.now(),
  };

  return valvrareDirectoryCache;
}

function scoreNovelMatch(title, query) {
  const normalizedTitle = normalizeSearchText(title);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const tokens = normalizedQuery.split(" ").filter((token) => token.length > 1);
  let score = 0;

  if (normalizedTitle === normalizedQuery) score += 120;
  if (normalizedTitle.startsWith(normalizedQuery)) score += 60;
  if (normalizedTitle.includes(normalizedQuery)) score += 50;

  let matchedTokenCount = 0;
  for (const token of tokens) {
    if (normalizedTitle.includes(token)) {
      matchedTokenCount += 1;
      score += 14;
    }
  }

  if (tokens.length > 0 && matchedTokenCount === tokens.length) score += 35;
  if (matchedTokenCount === 0 && !normalizedTitle.includes(normalizedQuery))
    score -= 50;

  return score;
}

function toDoclnPrimaryUrl(url) {
  try {
    const parsed = new URL(url);
    if (!isDoclnOrigin(parsed.origin)) return url;
    if (parsed.origin === DOCLN_LEGACY_ORIGIN) {
      return `${DOCLN_PRIMARY_ORIGIN}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return url;
  } catch {
    return url;
  }
}

function normalizeDoclnCandidates(candidates) {
  const normalized = [];

  for (const candidateUrl of candidates) {
    const primaryUrl = toDoclnPrimaryUrl(candidateUrl);
    if (!normalized.includes(primaryUrl)) {
      normalized.push(primaryUrl);
    }
  }

  return normalized;
}

function buildCandidateUrls(pathOrUrl) {
  let candidates = [];

  if (/^https?:\/\//i.test(pathOrUrl)) {
    candidates = [pathOrUrl];
  } else if (typeof pathOrUrl === "string" && pathOrUrl.startsWith("/")) {
    candidates = [normalizeUrl(pathOrUrl, DOCLN_PRIMARY_ORIGIN)].filter(
      Boolean,
    );
  } else {
    const uniqueOrigins = [
      DOCLN_PRIMARY_ORIGIN,
      activeOrigin,
      ...SITE_ORIGINS,
    ].filter((origin, index, list) => list.indexOf(origin) === index);
    candidates = uniqueOrigins
      .map((origin) => normalizeUrl(pathOrUrl, origin))
      .filter(Boolean);
  }

  return normalizeDoclnCandidates(candidates);
}

async function fetchHtmlPage(pathOrUrl) {
  const candidates = buildCandidateUrls(pathOrUrl);
  let lastError = null;

  for (const candidateUrl of candidates) {
    try {
      const page = await fetchPageContent(candidateUrl);
      updateActiveOrigin(page.finalUrl);
      return { url: page.finalUrl, html: page.html };
    } catch (error) {
      lastError = error;
    }
  }

  const failedOrigin = getOrigin(candidates[0] || pathOrUrl);
  if (isDoclnOrigin(failedOrigin) && !doclnCookieStore.cookie) {
    throw new Error(
      "docln.sbs yêu cầu cookie. Hãy mở Cấu Hình Cookie và dán cookie từ trình duyệt.",
    );
  }

  if (isDoclnOrigin(failedOrigin) && lastError?.response?.status === 403) {
    throw new Error(
      "docln.sbs từ chối truy cập (403). Cookie có thể đã hết hạn — hãy lấy lại và lưu lại.",
    );
  }

  const combined = formatErrorMessage(lastError);
  if (
    isDoclnOrigin(failedOrigin) &&
    /tls|socket disconnected|curl: \(35\)/i.test(combined)
  ) {
    throw new Error(
      "Không truy cập được docln.sbs. Thử đổi DNS (Cloudflare 1.1.1.1) trong app, hoặc lấy cookie mới từ trình duyệt.",
    );
  }

  throw lastError || new Error(`Không thể tải trang: ${pathOrUrl}`);
}

async function fetchHomepageRecommendations() {
  if (isValvrareOrigin(activeOrigin)) {
    const directory = await crawlValvrareDirectory();
    return directory.items;
  }

  const page = await fetchHtmlPage("/");
  const novels = extractNovelCandidatesFromHtml(page.html, page.url)
    .sort(
      (left, right) =>
        right.count - left.count || left.firstIndex - right.firstIndex,
    )
    .slice(0, 40);

  if (novels.length === 0) {
    throw new Error("Không tìm thấy truyện nào trên trang chủ.");
  }

  return novels;
}

async function searchNovels(keyword) {
  if (isValvrareOrigin(activeOrigin)) {
    const directory = await crawlValvrareDirectory();

    return directory.items
      .map((item) => ({ ...item, score: scoreNovelMatch(item.title, keyword) }))
      .filter((item) => item.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.firstIndex - right.firstIndex,
      )
      .slice(0, 30);
  }

  const encodedKeyword = encodeURIComponent(keyword);
  const searchPaths = [
    `/tim-kiem-nang-cao?author=&illustrator=&page=1&rejectgenres=&selectgenres=&status=0&title=${encodedKeyword}`,
    `/tim-kiem-nang-cao?page=1&title=${encodedKeyword}`,
    `/tim-kiem?keywords=${encodedKeyword}&page=1&query=${encodedKeyword}`,
  ];

  for (const searchPath of searchPaths) {
    try {
      const page = await fetchHtmlPage(searchPath);
      const results = extractNovelCandidatesFromHtml(page.html, page.url)
        .map((item) => ({
          ...item,
          score: scoreNovelMatch(item.title, keyword),
        }))
        .filter((item) => item.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score || left.firstIndex - right.firstIndex,
        )
        .slice(0, 30);

      if (results.length > 0) return results;
    } catch {
      // Try the next endpoint.
    }
  }

  return [];
}

function extractSummary($) {
  const selectors = [
    ".rd-description-content",
    ".summary-content",
    ".series-summary",
    ".summary",
    '[itemprop="description"]',
    "#summary",
  ];

  for (const selector of selectors) {
    const text = normalizeWhitespace($(selector).first().text());
    if (text) return text;
  }

  let fallbackSummary = "";
  $("h1,h2,h3,h4,strong,b").each((_, element) => {
    if (fallbackSummary) return;
    const label = normalizeSearchText($(element).text());
    if (!label.includes("tom tat")) return;

    const nextText =
      normalizeWhitespace($(element).parent().next().text()) ||
      normalizeWhitespace($(element).next().text());
    if (nextText) fallbackSummary = nextText;
  });

  return fallbackSummary;
}

function extractAuthor($) {
  let author = "";

  $(".series-information .info-item").each((_, element) => {
    if (author) return;
    const label = normalizeSearchText($(element).text());
    if (!label.includes("tac gia")) return;

    author = normalizeWhitespace(
      $(element).find(".info-value a").first().text() ||
        $(element).find(".info-value").first().text(),
    );
  });

  if (!author) {
    author = normalizeWhitespace($('a[href*="/tac-gia/"]').first().text());
  }

  if (!author) {
    author = normalizeWhitespace($(".rd-author-name").first().text());
  }

  if (!author) {
    author = normalizeWhitespace($('meta[name="author"]').attr("content"));
  }

  return author || "Khuyet danh";
}

function extractCoverUrl($, pageUrl) {
  const rawCoverStyle =
    $(".series-cover .img-in-ratio").first().attr("style") || "";
  const coverFromStyle =
    rawCoverStyle.match(/url\(['"]?(.*?)['"]?\)/)?.[1] || "";
  const coverFromImage =
    $(".series-cover img").first().attr("src") ||
    $(".rd-cover-image").first().attr("src") ||
    $('meta[property="og:image"]').attr("content") ||
    "";

  return normalizeUrl(coverFromStyle || coverFromImage, pageUrl);
}

function extractValvrareVolumes($, pageUrl) {
  const moduleTitles = $(".modules-list .module-container .module-title")
    .map((_, element) => normalizeWhitespace($(element).text()))
    .get()
    .filter(Boolean);
  const moduleSections = $(".module-chapters").toArray();

  if (moduleTitles.length === 0 || moduleSections.length === 0) return [];

  const volumes = [];
  const totalSections = Math.min(moduleTitles.length, moduleSections.length);

  for (let index = 0; index < totalSections; index += 1) {
    const title = moduleTitles[index] || `Tap ${index + 1}`;
    const section = moduleSections[index];
    const chapters = [];

    $(section)
      .find(".module-chapter-item")
      .each((__, chapterItem) => {
        const anchor = $(chapterItem)
          .find("a.chapter-title-link[href]")
          .first();
        const href = anchor.attr("href");
        const chapterUrl = normalizeUrl(href, pageUrl);
        const chapterTitle = normalizeWhitespace(anchor.text());

        if (!chapterUrl || !chapterTitle) return;
        chapters.push({
          title: chapterTitle,
          url: chapterUrl,
        });
      });

    if (chapters.length > 0) {
      volumes.push({ title, chapters, coverUrl: "" });
    }
  }

  return volumes;
}

function extractVolumes($, pageUrl) {
  const volumes = [];

  $(".volume-list").each((_, element) => {
    const title =
      normalizeWhitespace($(element).find(".sect-title").first().text()) ||
      `Tap ${volumes.length + 1}`;
    const chapters = [];

    // Extract volume cover from volume-cover
    let coverUrl = "";
    const volumeCoverDiv = $(element)
      .find(".volume-cover .content.img-in-ratio")
      .first();
    if (volumeCoverDiv.length > 0) {
      const styleAttr = volumeCoverDiv.attr("style") || "";
      const urlMatch = styleAttr.match(/url\(['"]?(.*?)['"]?\)/);
      if (urlMatch && urlMatch[1]) {
        coverUrl = normalizeUrl(urlMatch[1], pageUrl);
      }
    }

    $(element)
      .find(".list-chapters li")
      .each((__, listItem) => {
        const anchor = $(listItem).find(".chapter-name a").first();
        const href = anchor.attr("href");
        const chapterUrl = normalizeUrl(href, pageUrl);
        const chapterTitle = normalizeWhitespace(anchor.text());

        if (!chapterUrl || !chapterTitle) return;
        chapters.push({
          title: chapterTitle,
          url: chapterUrl,
        });
      });

    if (chapters.length > 0) {
      volumes.push({ title, chapters, coverUrl });
    }
  });

  if (volumes.length > 0) return volumes;

  const valvrareVolumes = extractValvrareVolumes($, pageUrl);
  if (valvrareVolumes.length > 0) return valvrareVolumes;

  const fallbackChapters = [];
  $(".list-chapters li").each((_, listItem) => {
    const anchor = $(listItem).find(".chapter-name a").first();
    const href = anchor.attr("href");
    const chapterUrl = normalizeUrl(href, pageUrl);
    const chapterTitle = normalizeWhitespace(anchor.text());

    if (!chapterUrl || !chapterTitle) return;
    fallbackChapters.push({
      title: chapterTitle,
      url: chapterUrl,
    });
  });

  if (fallbackChapters.length > 0) {
    volumes.push({
      title: "Toan bo",
      chapters: fallbackChapters,
      coverUrl: "",
    });
  }

  return volumes;
}

function extractNovelTitle($) {
  const valvrareTitleNode = $(".rd-novel-title").first().clone();
  if (valvrareTitleNode.length > 0) {
    valvrareTitleNode.find("button, span").remove();
  }

  return (
    normalizeWhitespace($(".series-name a").first().text()) ||
    normalizeWhitespace(valvrareTitleNode.text()) ||
    normalizeWhitespace($("h1").first().text()) ||
    normalizeWhitespace($('meta[property="og:title"]').attr("content") || "") ||
    normalizeWhitespace($("title").text()) ||
    "Chua ro tieu de"
  );
}

async function fetchNovelInfo(url) {
  const page = await fetchHtmlPage(url);
  const $ = cheerio.load(page.html);

  let title =
    normalizeWhitespace($(".series-name a").first().text()) ||
    normalizeWhitespace($("h1").first().text()) ||
    normalizeWhitespace(
      $("title")
        .text()
        .replace(/\s*-\s*Cổng Light Novel.*$/i, ""),
    ) ||
    "Chưa rõ tiêu đề";

  title = extractNovelTitle($);
  const volumes = extractVolumes($, page.url);
  if (volumes.length === 0) {
    throw new Error("Không đọc được danh sách tập/chương của truyện này.");
  }

  return {
    title,
    author: extractAuthor($),
    summary: extractSummary($),
    coverUrl: extractCoverUrl($, page.url),
    volumes,
    sourceUrl: page.url,
  };
}

function decodeProtected(dataC, dataK, dataS) {
  let entries = [];

  try {
    entries = JSON.parse(dataC);
  } catch {
    return "";
  }

  if (!Array.isArray(entries) || entries.length === 0) return "";

  entries.sort(
    (left, right) =>
      parseInt(left.substring(0, 4), 10) - parseInt(right.substring(0, 4), 10),
  );

  let result = "";

  for (const item of entries) {
    const payload = item.substring(4);

    if (dataS === "xor_shuffle") {
      const buffer = Buffer.from(payload, "base64");
      const decoded = Buffer.alloc(buffer.length);
      for (let index = 0; index < buffer.length; index += 1) {
        decoded[index] = buffer[index] ^ dataK.charCodeAt(index % dataK.length);
      }
      result += decoded.toString("utf-8");
      continue;
    }

    if (dataS === "base64_reverse") {
      result += Buffer.from(
        payload.split("").reverse().join(""),
        "base64",
      ).toString("utf-8");
      continue;
    }

    result += Buffer.from(payload, "base64").toString("utf-8");
  }

  return result;
}

function getChapterContentRoot($) {
  const selectors = ["#chapter-content", ".chapter-content"];

  for (const selector of selectors) {
    const root = $(selector).first();
    if (root.length > 0) return root;
  }

  return null;
}

function guessImageExtension(buffer) {
  if (!buffer || buffer.length < 4) return ".jpg";
  const hex = buffer.slice(0, 4).toString("hex");
  if (hex.startsWith("89504e47")) return ".png";
  if (hex.startsWith("ffd8ff")) return ".jpg";
  if (hex.startsWith("47494638")) return ".gif";
  if (hex.startsWith("52494646")) return ".webp";
  return ".jpg";
}

const BANNER_IMAGE_CLASS_TOKENS = new Set([
  "d-none",
  "d-md-none",
  "d-md-block",
]);

function isBannerImage(classAttr) {
  if (!classAttr) return false;
  return classAttr.split(/\s+/).some(function (token) {
    return BANNER_IMAGE_CLASS_TOKENS.has(token);
  });
}

function formatImageLabel(index, imageUrl, alt = "") {
  const altLabel = String(alt || "").trim();
  if (altLabel) return `#${index} (${altLabel})`;

  try {
    const fileName = path.basename(new URL(imageUrl).pathname);
    if (fileName) return `#${index} (${fileName})`;
  } catch {
    // ignore invalid URL
  }

  return `#${index}`;
}

function logImageIssue(handlers, message) {
  handlers?.onLog?.(`[ảnh] ${message}`);
}

const EPUB_CHAPTER_CSS = [
  "body { margin: 0; padding: 0; }",
  ".galley-rw { margin: 0; padding: 0; }",
  ".body-rw { margin: 0; padding: 0; }",
  ".image_full { margin: 0; padding: 0; text-align: center; }",
  ".image_full img { display: block; width: 100%; max-width: 100%; height: auto; margin: 0 auto; }",
].join("\n");

function escapeHtmlAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

function slugifySectionId(value, fallback = "section") {
  const slug = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || fallback;
}

function hasMeaningfulHtml(html) {
  if (!html || !String(html).trim()) return false;

  const $ = cheerio.load(html, null, false);
  if (normalizeWhitespace($.text()).length > 0) return true;
  return $("img, svg, video").length > 0;
}

function buildImageChapterContent(alt, filePath) {
  const src = "file://" + filePath.replace(/\\/g, "/");
  const safeAlt = escapeHtmlAttr(alt || "Image");

  return `<div class="image_full"><img alt="${safeAlt}" src="${src}"/></div>`;
}

function buildTextChapterContent(html) {
  return `<div class="galley-rw">
<section class="body-rw Chapter-rw" epub:type="bodymatter chapter">
${html}
</section>
</div>`;
}

function buildSegmentsFromMarkedHtml(html, embeddedRecords) {
  const segments = [];
  const markerPattern = /<!--EPUB_IMG_(\d+)-->/g;
  let lastIndex = 0;
  let match;

  while ((match = markerPattern.exec(html))) {
    const textPart = html.slice(lastIndex, match.index);
    if (hasMeaningfulHtml(textPart)) {
      segments.push({ type: "text", html: textPart.trim() });
    }

    const record = embeddedRecords.get(Number(match[1]));
    if (record) {
      segments.push({ type: "image", ...record });
    }

    lastIndex = match.index + match[0].length;
  }

  const tail = html.slice(lastIndex);
  if (hasMeaningfulHtml(tail)) {
    segments.push({ type: "text", html: tail.trim() });
  }

  return segments;
}

function markEmbeddedImage($doc, img, index, record, embeddedRecords) {
  embeddedRecords.set(index, record);
  $doc(img).replaceWith(`<!--EPUB_IMG_${index}-->`);
}

function pushEpubSegmentsFromChapter(epubChapters, segments, meta) {
  const baseTitle = `${meta.volumeTitle} - ${meta.chapterTitle}`;
  let tocEntryAdded = false;
  let chapterTitleShown = false;

  for (const segment of segments) {
    const isFirstTocEntry = !tocEntryAdded;
    if (isFirstTocEntry) {
      tocEntryAdded = true;
    }

    if (segment.type === "image") {
      epubChapters.push({
        title: baseTitle,
        author: [],
        content: buildImageChapterContent(segment.alt, segment.filePath),
        excludeFromToc: !isFirstTocEntry,
        prependChapterTitles: false,
      });
      continue;
    }

    const showChapterTitle = !chapterTitleShown;
    if (showChapterTitle) {
      chapterTitleShown = true;
    }

    epubChapters.push({
      title: baseTitle,
      author: showChapterTitle ? meta.author : [],
      content: buildTextChapterContent(segment.html),
      excludeFromToc: !isFirstTocEntry,
      prependChapterTitles: showChapterTitle,
    });
  }
}

async function persistImageBuffer(buffer, tempDir, index) {
  const ext = guessImageExtension(buffer);
  const fileName = `img_${Date.now()}_${index}${ext}`;
  const filePath = path.join(tempDir, fileName);
  await fs.writeFile(filePath, buffer);

  const fileStats = await fs.stat(filePath);
  if (fileStats.size < 100) {
    throw new Error(`file lưu bị lỗi (${fileStats.size} bytes)`);
  }

  return filePath;
}

function buildImagePrompt(context) {
  return {
    label: context.label,
    imageUrl: context.imageUrl,
    imageIndex: context.index,
    chapterTitle: context.chapterTitle || "",
    volumeTitle: context.volumeTitle || "",
    error: context.error || "",
    tempDir: context.tempDir,
  };
}

function waitForImageResolution(taskId, context) {
  return new Promise((resolve) => {
    const prompt = buildImagePrompt(context);
    imageResolutionWaiters.set(taskId, { resolve, prompt });
    updateTask(taskId, {
      status: "waiting_image",
      imagePrompt: prompt,
    });
    pushTaskLog(taskId, `Tạm dừng — chờ xử lý ảnh ${prompt.label}`);
  });
}

function clearImageResolutionWaiter(taskId) {
  imageResolutionWaiters.delete(taskId);
}

async function applyImageResolution(taskId, body = {}) {
  const waiter = imageResolutionWaiters.get(taskId);
  if (!waiter) {
    throw new Error("Task không đang chờ xử lý ảnh.");
  }

  const action = String(body.action || "").trim();
  let resolution;

  if (action === "skip") {
    resolution = { action: "skip" };
    pushTaskLog(taskId, `Bỏ qua ảnh ${waiter.prompt.label}`);
  } else if (action === "replace") {
    const dataBase64 = String(body.dataBase64 || "").trim();
    if (!dataBase64) {
      throw new Error("Thiếu dữ liệu ảnh thay thế.");
    }

    const buffer = Buffer.from(dataBase64, "base64");
    if (buffer.length < 100) {
      throw new Error("Ảnh thay thế quá nhỏ hoặc không hợp lệ.");
    }

    const ext =
      guessImageExtension(buffer) ||
      path.extname(String(body.fileName || "")) ||
      ".jpg";
    const filePath = path.join(
      waiter.prompt.tempDir,
      `img_${Date.now()}_${waiter.prompt.imageIndex}${ext}`,
    );
    await fs.ensureDir(waiter.prompt.tempDir);
    await fs.writeFile(filePath, buffer);
    resolution = { action: "replace", filePath };
    pushTaskLog(taskId, `Dùng ảnh thay thế cho ${waiter.prompt.label}`);
  } else {
    throw new Error("action phải là skip hoặc replace.");
  }

  imageResolutionWaiters.delete(taskId);
  updateTask(taskId, { status: "running", imagePrompt: null });
  waiter.resolve(resolution);
  return resolution;
}

async function resolveFailedImage(
  $doc,
  img,
  handlers,
  context,
  embeddedRecords,
) {
  if (!handlers?.onImageFailed) {
    return "fail";
  }

  const resolution = await handlers.onImageFailed(context);

  if (resolution?.action === "skip") {
    $doc(img).remove();
    logImageIssue(handlers, `Bỏ qua ${context.label} (thủ công)`);
    return "skipped";
  }

  if (resolution?.action === "replace" && resolution.filePath) {
    markEmbeddedImage(
      $doc,
      img,
      context.index,
      {
        filePath: resolution.filePath,
        alt: context.alt || "",
        label: context.label,
      },
      embeddedRecords,
    );
    return "embedded";
  }

  return "fail";
}

async function embedImagesInHtml(contentHtml, pageUrl, tempDir, handlers) {
  const $doc = cheerio.load(contentHtml, null, false);

  let bannersRemoved = 0;
  $doc("img").each(function (_, img) {
    if (isBannerImage($doc(img).attr("class"))) {
      bannersRemoved += 1;
      $doc(img).remove();
    }
  });

  const images = $doc("img").toArray();
  let embedded = 0;
  let failed = 0;
  let skipped = 0;
  const embeddedRecords = new Map();

  if (bannersRemoved > 0) {
    logImageIssue(handlers, `Bỏ qua ${bannersRemoved} ảnh banner`);
  }

  await fs.ensureDir(tempDir);

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const alt = $doc(img).attr("alt") || "";
    const src = $doc(img).attr("src") || $doc(img).attr("data-src") || "";
    const imageUrl = normalizeUrl(src, pageUrl);
    const label = formatImageLabel(i, imageUrl || src, alt);

    if (
      !imageUrl ||
      imageUrl.startsWith("data:") ||
      imageUrl.startsWith("file:")
    ) {
      skipped += 1;
      logImageIssue(handlers, `Bỏ qua ${label}: không có URL hợp lệ`);
      continue;
    }

    const failureContext = {
      index: i,
      label,
      imageUrl,
      tempDir,
      alt,
      chapterTitle: handlers?.chapterTitle || "",
      volumeTitle: handlers?.volumeTitle || "",
    };

    let buffer = null;
    let fetchError = "";

    try {
      const imageHeaders = {
        ...buildRequestHeaders(imageUrl),
        Accept:
          "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      };

      buffer = await fetchBinaryContent(imageUrl, imageHeaders);

      if (buffer.length < 100) {
        fetchError = `quá nhỏ (${buffer.length} bytes)`;
        buffer = null;
      }
    } catch (error) {
      const statusCode = error.response?.status || "N/A";
      fetchError = `[${statusCode}] ${error.message}`;
    }

    if (fetchError) {
      const outcome = await resolveFailedImage(
        $doc,
        img,
        handlers,
        {
          ...failureContext,
          error: fetchError,
        },
        embeddedRecords,
      );

      if (outcome === "embedded") {
        embedded += 1;
      } else if (outcome === "skipped") {
        skipped += 1;
      } else {
        failed += 1;
        $doc(img).remove();
        logImageIssue(handlers, `Ảnh ${label}: ${fetchError}`);
      }
      continue;
    }

    try {
      const filePath = await persistImageBuffer(buffer, tempDir, i);
      markEmbeddedImage(
        $doc,
        img,
        i,
        {
          filePath,
          alt,
          label,
        },
        embeddedRecords,
      );
      embedded += 1;
    } catch (error) {
      const outcome = await resolveFailedImage(
        $doc,
        img,
        handlers,
        {
          ...failureContext,
          error: error.message,
        },
        embeddedRecords,
      );

      if (outcome === "embedded") {
        embedded += 1;
      } else if (outcome === "skipped") {
        skipped += 1;
      } else {
        failed += 1;
        $doc(img).remove();
        logImageIssue(handlers, `Ảnh ${label}: ${error.message}`);
      }
    }
  }

  if (embedded > 0 || failed > 0 || skipped > 0) {
    if (handlers && handlers.onLog) {
      const parts = [`Nhúng ${embedded} ảnh`];
      if (failed > 0) parts.push(`lỗi ${failed}`);
      if (skipped > 0) parts.push(`bỏ qua ${skipped}`);
      handlers.onLog(`[ảnh] ${parts.join(", ")}`);
    }
  }

  return buildSegmentsFromMarkedHtml($doc.html(), embeddedRecords);
}

async function cleanupTempImages(tempDir) {
  try {
    await fs.remove(tempDir);
  } catch {
    /* ignore */
  }
}

function buildChapterTextContent(
  $,
  contentRoot,
  volumeTitle,
  chapterTitle,
  pageUrl,
) {
  let textContent = `${volumeTitle}\n\n${chapterTitle}\n\n`;
  const blocks =
    contentRoot.children().length > 0
      ? contentRoot.children()
      : contentRoot.contents();

  blocks.each((_, element) => {
    const node = $(element);
    const images = node.is("img") ? node : node.find("img");

    images.each((__, image) => {
      const imageUrl = normalizeUrl(
        $(image).attr("src") || $(image).attr("data-src"),
        pageUrl,
      );
      if (imageUrl) {
        textContent += `[Anh: ${imageUrl}]\n\n`;
      }
    });

    const line = normalizeWhitespace(node.text());
    if (line) {
      textContent += `${line}\n\n`;
    }
  });

  return textContent;
}

async function generateEpub(
  epubPath,
  title,
  author,
  coverUrl,
  chapters,
  tempDir,
) {
  const options = {
    title,
    author,
    publisher: "Hako Downloader",
    tocTitle: "Mục lục",
    lang: "vi",
    css: EPUB_CHAPTER_CSS,
    numberChaptersInTOC: true,
    ignoreFailedDownloads: true,
  };

  if (coverUrl) options.cover = coverUrl;

  try {
    const buffer = await EpubGen(options, chapters);
    await fs.writeFile(epubPath, buffer);
  } catch (error) {
    // If EPUB generation fails, try without images
    for (const chapter of chapters) {
      const $chapter = cheerio.load(chapter.content);
      $chapter("img").remove();
      chapter.content = $chapter.html();
    }

    delete options.cover;
    const buffer = await EpubGen(options, chapters);
    await fs.writeFile(epubPath, buffer);
  }
}

async function downloadChapters(volume, volumeDir, author, handlers = {}) {
  const epubChapters = [];
  const tempDir = path.join(volumeDir, "_temp_epub_images");

  for (const [index, chapter] of volume.chapters.entries()) {
    handlers.onChapterStart?.(chapter, index, volume.chapters.length);

    const safeChapterTitle = sanitizeFileName(chapter.title);
    const txtPath = path.join(volumeDir, `${safeChapterTitle}.txt`);
    const htmlPath = path.join(volumeDir, `${safeChapterTitle}.html`);

    let contentHtml = "";

    if (fs.existsSync(htmlPath) && fs.existsSync(txtPath)) {
      contentHtml = await fs.readFile(htmlPath, "utf-8");
      handlers.onLog?.(`[cache] ${chapter.title}`);
    } else {
      try {
        const chapterPage = await fetchPageContent(chapter.url);
        let $chapter = cheerio.load(chapterPage.html);
        const protectedDiv = $chapter("#chapter-c-protected");

        if (protectedDiv.length > 0) {
          const dataC = protectedDiv.attr("data-c");
          const dataK = protectedDiv.attr("data-k") || "";
          const dataS = protectedDiv.attr("data-s") || "none";

          if (dataC) {
            const decodedHtml = decodeProtected(dataC, dataK, dataS);
            if (decodedHtml) {
              protectedDiv.replaceWith(decodedHtml);
              $chapter = cheerio.load($chapter.html());
            }
          }
        }

        const contentRoot = getChapterContentRoot($chapter);
        contentHtml = contentRoot?.html() || "";
        if (!contentHtml) {
          handlers.onLog?.(`[bỏ qua] ${chapter.title} (rỗng)`);
          continue;
        }

        const textContent = buildChapterTextContent(
          $chapter,
          contentRoot,
          volume.title,
          chapter.title,
          chapter.url,
        );

        await fs.writeFile(txtPath, textContent, "utf-8");
        await fs.writeFile(htmlPath, contentHtml, "utf-8");
        handlers.onLog?.(`[ok] ${chapter.title}`);
      } catch (error) {
        handlers.onLog?.(`[lỗi] ${chapter.title}: ${error.message}`);
        if (error.response && error.response.status === 429) {
          await delay(10000);
        }
        continue;
      }

      await delay(2000);
    }

    const segments = contentHtml
      ? await embedImagesInHtml(contentHtml, chapter.url, tempDir, {
          ...handlers,
          chapterTitle: chapter.title,
          volumeTitle: volume.title,
        })
      : [];

    if (segments.length > 0) {
      pushEpubSegmentsFromChapter(epubChapters, segments, {
        volumeTitle: volume.title,
        chapterTitle: chapter.title,
        author,
      });
    } else if (contentHtml && hasMeaningfulHtml(contentHtml)) {
      epubChapters.push({
        title: `${volume.title} - ${chapter.title}`,
        author,
        content: buildTextChapterContent(contentHtml),
      });
    }

    handlers.onChapterDone?.(chapter, index, volume.chapters.length);
  }

  return { epubChapters, tempDir };
}

async function removeIfExists(targetPath) {
  if (await fs.pathExists(targetPath)) {
    await fs.remove(targetPath);
    return true;
  }

  return false;
}

async function cleanupLegacyEpubOutputs(
  novel,
  selectedVolumeIndexes,
  novelDir,
  handlers = {},
) {
  const safeTitle = sanitizeFileName(novel.title);
  const legacyPaths = [
    path.join(DOWNLOADS_DIR, `${safeTitle}.epub`),
    ...selectedVolumeIndexes.map((volumeIndex) => {
      const safeVolumeTitle = sanitizeFileName(
        novel.volumes[volumeIndex].title,
      );
      return path.join(DOWNLOADS_DIR, `${safeTitle} - ${safeVolumeTitle}.epub`);
    }),
  ].filter((filePath) => path.dirname(filePath) !== novelDir);

  let removedCount = 0;

  for (const legacyPath of legacyPaths) {
    if (await removeIfExists(legacyPath)) {
      removedCount += 1;
    }
  }

  if (removedCount > 0) {
    handlers.onLog?.(`Đã dọn ${removedCount} file EPUB cũ ở thư mục gốc.`);
  }
}

async function cleanupIntermediateChapterFiles(volumeDirs, handlers = {}) {
  let removedCount = 0;
  let removedVolumeDirs = 0;

  for (const volumeDir of volumeDirs) {
    if (!(await fs.pathExists(volumeDir))) continue;

    const entries = await fs.readdir(volumeDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".txt") && !entry.name.endsWith(".html"))
        continue;

      await fs.remove(path.join(volumeDir, entry.name));
      removedCount += 1;
    }

    const remainingEntries = await fs.readdir(volumeDir);
    if (remainingEntries.length === 0) {
      await fs.remove(volumeDir);
      removedVolumeDirs += 1;
    }
  }

  if (removedCount > 0) {
    handlers.onLog?.(`Đã dọn ${removedCount} file TXT/HTML trung gian.`);
  }

  if (removedVolumeDirs > 0) {
    handlers.onLog?.(`Đã dọn ${removedVolumeDirs} thư mục tập trống.`);
  }
}

function getNovelOutputLayout(novel, selectedVolumeIndexesInput = []) {
  const selectedVolumeIndexes = resolveSelectedVolumeIndexes(
    novel.volumes,
    selectedVolumeIndexesInput,
  );
  const safeTitle = sanitizeFileName(novel.title);
  const novelDir = path.join(DOWNLOADS_DIR, safeTitle);
  const singleEpubPath = path.join(novelDir, `${safeTitle}.epub`);
  const volumeOutputs = selectedVolumeIndexes.map((volumeIndex) => {
    const volume = novel.volumes[volumeIndex];
    const safeVolumeTitle = sanitizeFileName(volume.title);

    return {
      volumeIndex,
      title: volume.title,
      safeVolumeTitle,
      volumeDir: path.join(novelDir, safeVolumeTitle),
      epubPath: path.join(novelDir, `${safeVolumeTitle}.epub`),
    };
  });

  return {
    selectedVolumeIndexes,
    safeTitle,
    novelDir,
    singleEpubPath,
    volumeOutputs,
  };
}

async function volumeDirHasChapterFiles(volumeDir) {
  if (!(await fs.pathExists(volumeDir))) {
    return false;
  }

  const entries = await fs.readdir(volumeDir, { withFileTypes: true });
  return entries.some((entry) => {
    return (
      entry.isFile() &&
      (entry.name.endsWith(".txt") || entry.name.endsWith(".html"))
    );
  });
}

async function detectExistingNovelOutputs(
  novel,
  selectedVolumeIndexesInput = [],
) {
  const layout = getNovelOutputLayout(novel, selectedVolumeIndexesInput);
  const hasNovelDir = await fs.pathExists(layout.novelDir);

  if (!hasNovelDir) {
    return {
      ...layout,
      isComplete: false,
      completedKinds: [],
      existingEpubFiles: [],
    };
  }

  const completedKinds = [];
  const existingEpubFiles = [];

  const hasSingleEpub = await fs.pathExists(layout.singleEpubPath);
  if (hasSingleEpub) {
    completedKinds.push("EPUB tổng");
    existingEpubFiles.push(layout.singleEpubPath);
  }

  let hasAllVolumeEpubs = layout.volumeOutputs.length > 0;
  let hasAllChapterCaches = layout.volumeOutputs.length > 0;

  for (const record of layout.volumeOutputs) {
    const hasVolumeEpub = await fs.pathExists(record.epubPath);
    if (hasVolumeEpub) {
      existingEpubFiles.push(record.epubPath);
    } else {
      hasAllVolumeEpubs = false;
    }

    if (!(await volumeDirHasChapterFiles(record.volumeDir))) {
      hasAllChapterCaches = false;
    }
  }

  if (hasAllVolumeEpubs) {
    completedKinds.push("EPUB theo tập");
  }

  if (hasAllChapterCaches) {
    completedKinds.push("TXT/HTML");
  }

  return {
    ...layout,
    isComplete: completedKinds.length > 0,
    completedKinds,
    existingEpubFiles: [...new Set(existingEpubFiles)],
  };
}

function hasRequestedNovelOutputs(existingOutput, epubModeInput) {
  const epubMode = ensureValidEpubMode(epubModeInput);

  if (epubMode === "0") {
    return existingOutput.completedKinds.includes("TXT/HTML");
  }

  if (epubMode === "1") {
    return existingOutput.completedKinds.includes("EPUB tổng");
  }

  if (epubMode === "2") {
    return existingOutput.completedKinds.includes("EPUB theo tập");
  }

  return (
    existingOutput.completedKinds.includes("EPUB tổng") &&
    existingOutput.completedKinds.includes("EPUB theo tập")
  );
}

function createTask(payload) {
  const task = {
    id: crypto.randomUUID(),
    status: "queued",
    progress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logs: [],
    payload,
  };

  tasks.set(task.id, task);
  return task;
}

function getTask(taskId) {
  return tasks.get(taskId);
}

function updateTask(taskId, patch) {
  const task = tasks.get(taskId);
  if (!task) return null;

  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  return task;
}

function pushTaskLog(taskId, message) {
  const task = tasks.get(taskId);
  if (!task) return;

  task.logs.push({
    at: new Date().toISOString(),
    message,
  });

  if (task.logs.length > 200) {
    task.logs.splice(0, task.logs.length - 200);
  }

  task.updatedAt = new Date().toISOString();
  console.log(`[${formatTaskId(taskId)}] ${message}`);
}

function serializeTask(task) {
  if (!task) return null;

  return {
    id: task.id,
    status: task.status,
    progress: task.progress,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.error,
    result: task.result,
    payload: task.payload,
    imagePrompt: task.imagePrompt || null,
    logs: task.logs,
  };
}

function ensureValidEpubMode(epubMode) {
  return EPUB_MODES.includes(epubMode) ? epubMode : "1";
}

function ensureBatchConcurrency(value) {
  const parsed = Number.parseInt(value, 10);
  return BATCH_CONCURRENCY_VALUES.includes(parsed) ? parsed : 2;
}

function resolveSelectedVolumeIndexes(volumes, selectedVolumeIndexes) {
  if (
    !Array.isArray(selectedVolumeIndexes) ||
    selectedVolumeIndexes.length === 0
  ) {
    return volumes.map((_, index) => index);
  }

  const indexes = selectedVolumeIndexes
    .map((value) => Number.parseInt(value, 10))
    .filter(
      (index) =>
        Number.isInteger(index) && index >= 0 && index < volumes.length,
    );

  return [...new Set(indexes)];
}

async function downloadNovelAssets(
  novel,
  selectedVolumeIndexesInput,
  epubModeInput,
  customTitle = "",
  useVolumeCover = {},
  handlers = {},
) {
  const selectedVolumeIndexes = resolveSelectedVolumeIndexes(
    novel.volumes,
    selectedVolumeIndexesInput,
  );
  const epubMode = ensureValidEpubMode(epubModeInput);

  if (selectedVolumeIndexes.length === 0) {
    throw new Error("Không có tập hợp lệ để tải.");
  }

  const totalChapters = selectedVolumeIndexes.reduce(
    (sum, volumeIndex) => sum + novel.volumes[volumeIndex].chapters.length,
    0,
  );

  // Use custom title if provided, otherwise use original title
  const finalTitle = customTitle.trim() || novel.title;
  const safeTitle = sanitizeFileName(finalTitle);
  const novelDir = path.join(DOWNLOADS_DIR, safeTitle);
  await fs.ensureDir(novelDir);

  handlers.onStart?.({
    novel,
    selectedVolumeIndexes,
    epubMode,
    totalChapters,
    novelDir,
  });

  handlers.onLog?.(`Bắt đầu tải: ${novel.title}`);

  let processedChapters = 0;
  const allEpubChapters = [];
  const volumeDirs = [];
  const tempImageDirs = [];

  if (epubMode !== "0") {
    await cleanupLegacyEpubOutputs(
      novel,
      selectedVolumeIndexes,
      novelDir,
      handlers,
    );
  }

  const generatedEpubs = [];
  const wantsPerVolumeEpub = epubMode === "2" || epubMode === "3";
  const wantsCombinedEpub = epubMode === "1" || epubMode === "3";

  for (const volumeIndex of selectedVolumeIndexes) {
    const volume = novel.volumes[volumeIndex];
    const safeVolumeTitle = sanitizeFileName(volume.title);
    const volumeDir = path.join(novelDir, safeVolumeTitle);
    await fs.ensureDir(volumeDir);
    volumeDirs.push(volumeDir);

    handlers.onLog?.(`Đang xử lý ${volume.title}`);

    const { epubChapters: chapters, tempDir } = await downloadChapters(
      volume,
      volumeDir,
      novel.author,
      {
        onChapterStart: (chapter, chapterIndex, volumeChapterCount) => {
          handlers.onChapterStart?.({
            novel,
            volume,
            chapter,
            chapterIndex,
            volumeChapterCount,
            processedChapters,
            totalChapters,
          });
        },
        onChapterDone: (chapter, chapterIndex, volumeChapterCount) => {
          processedChapters += 1;
          handlers.onChapterDone?.({
            novel,
            volume,
            chapter,
            chapterIndex,
            volumeChapterCount,
            processedChapters,
            totalChapters,
          });
        },
        onLog: (message) => {
          handlers.onLog?.(message);
        },
        onImageFailed: handlers.onImageFailed,
      },
    );

    allEpubChapters.push(...chapters);
    tempImageDirs.push(tempDir);

    if (wantsPerVolumeEpub && chapters.length > 0) {
      const epubPath = path.join(
        novelDir,
        `${safeTitle} - ${safeVolumeTitle}.epub`,
      );
      handlers.onLog?.(`Đang đóng gói EPUB ${safeVolumeTitle}...`);

      const shouldUseVolumeCover = useVolumeCover[volumeIndex] !== false;
      const volumeCover =
        shouldUseVolumeCover && volume.coverUrl
          ? volume.coverUrl
          : novel.coverUrl;

      await generateEpub(
        epubPath,
        `${finalTitle} - ${volume.title}`,
        novel.author,
        volumeCover,
        [...chapters],
        tempDir,
      );
      generatedEpubs.push(epubPath);
      handlers.onVolumeEpubDone?.({
        novel,
        volume,
        volumeIndex,
        epubPath,
        generatedEpubs: [...generatedEpubs],
      });
    }
  }

  if (wantsCombinedEpub && allEpubChapters.length > 0) {
    const epubPath = path.join(novelDir, `${safeTitle}.epub`);
    handlers.onLog?.("Đang đóng gói EPUB tổng...");
    const firstTempDir = tempImageDirs.length > 0 ? tempImageDirs[0] : null;
    await generateEpub(
      epubPath,
      finalTitle,
      novel.author,
      novel.coverUrl,
      [...allEpubChapters],
      firstTempDir,
    );
    generatedEpubs.push(epubPath);
    handlers.onCombinedEpubDone?.({
      novel,
      epubPath,
      generatedEpubs: [...generatedEpubs],
    });
  }

  if (epubMode === "3") {
    await cleanupIntermediateChapterFiles(volumeDirs, handlers);
  }

  // Keep temp image directories for debugging - DO NOT DELETE
  handlers.onLog?.(`Thư mục ảnh: ${tempImageDirs.join(", ")}`);

  return {
    mode: "single",
    novelTitle: novel.title,
    novelDir,
    epubFiles: generatedEpubs,
    epubItems: generatedEpubs.map((filePath) => ({
      name: path.basename(filePath),
      path: filePath,
      url: toDownloadUrl(filePath),
    })),
    downloadItems: generatedEpubs.map((filePath) => ({
      name: path.basename(filePath),
      path: filePath,
      url: toDownloadUrl(filePath),
    })),
    sourceUrl: novel.sourceUrl,
    selectedVolumeIndexes,
    totalChapters,
    processedChapters,
  };
}

async function writeBatchReport(report) {
  const reportsDir = path.join(DOWNLOADS_DIR, "_batch_reports");
  await fs.ensureDir(reportsDir);

  const fileName = `valvrare-batch-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const reportPath = path.join(reportsDir, fileName);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
  return reportPath;
}

async function performDownload(taskId, payload) {
  updateTask(taskId, {
    status: "running",
    startedAt: new Date().toISOString(),
    progress: 2,
  });

  pushTaskLog(taskId, "Đang lấy thông tin truyện...");

  const novel = await fetchNovelInfo(payload.url);
  let taskNovelDir = "";
  let selectedVolumeCount = 0;
  let generatedEpubCount = 0;

  const refreshPartialResult = (epubFiles) => {
    if (!taskNovelDir) return;
    updateTask(taskId, {
      result: buildDownloadResult(novel, taskNovelDir, epubFiles),
    });
  };

  const result = await downloadNovelAssets(
    novel,
    payload.selectedVolumeIndexes,
    payload.epubMode,
    payload.customTitle || "",
    payload.useVolumeCover || {},
    {
      onStart: ({ selectedVolumeIndexes, epubMode, novelDir }) => {
        taskNovelDir = novelDir;
        selectedVolumeCount = selectedVolumeIndexes.length;
        updateTask(taskId, {
          payload: {
            ...payload,
            selectedVolumeIndexes,
            epubMode,
            novelTitle: novel.title,
          },
          result: buildDownloadResult(novel, novelDir, []),
        });
      },
      onChapterStart: ({ chapter, chapterIndex, volumeChapterCount }) => {
        pushTaskLog(
          taskId,
          `Chương ${chapterIndex + 1}/${volumeChapterCount}: ${chapter.title}`,
        );
      },
      onChapterDone: ({ processedChapters, totalChapters }) => {
        const progress =
          totalChapters > 0
            ? Math.min(
                75,
                8 + Math.round((processedChapters / totalChapters) * 67),
              )
            : 50;
        updateTask(taskId, { progress });
      },
      onVolumeEpubDone: ({ generatedEpubs }) => {
        generatedEpubCount = generatedEpubs.length;
        const progress =
          selectedVolumeCount > 0
            ? Math.min(
                95,
                75 +
                  Math.round((generatedEpubCount / selectedVolumeCount) * 20),
              )
            : 85;
        updateTask(taskId, { progress });
        refreshPartialResult(generatedEpubs);
      },
      onCombinedEpubDone: ({ generatedEpubs }) => {
        updateTask(taskId, { progress: 98 });
        refreshPartialResult(generatedEpubs);
      },
      onLog: (message) => {
        pushTaskLog(taskId, message);
      },
      onImageFailed: (context) => waitForImageResolution(taskId, context),
    },
  );

  updateTask(taskId, {
    status: "completed",
    progress: 100,
    finishedAt: new Date().toISOString(),
    result,
  });

  pushTaskLog(taskId, "Hoàn tất.");
}

async function performBatchDownload(taskId, payload) {
  updateTask(taskId, {
    status: "running",
    startedAt: new Date().toISOString(),
    progress: 1,
  });

  const catalogUrl = normalizeWhitespace(payload.catalogUrl || "");
  if (!isValvrareDirectoryUrl(catalogUrl)) {
    throw new Error("URL danh mục Valvrare không hợp lệ.");
  }

  const epubMode = ensureValidEpubMode(String(payload.epubMode || "1"));
  const batchConcurrency = ensureBatchConcurrency(
    payload.batchConcurrency || 2,
  );
  pushTaskLog(taskId, "Đang crawl danh mục Valvrare...");

  const directory = await crawlValvrareDirectory();
  const items = directory.items || [];

  if (items.length === 0) {
    throw new Error("Danh mục Valvrare không có truyện nào để tải.");
  }

  updateTask(taskId, {
    payload: {
      ...payload,
      mode: "batch",
      epubMode,
      batchConcurrency,
      catalogUrl: directory.sourceUrl,
      totalNovels: items.length,
      currentNovelIndex: 0,
      currentNovelTitle: "",
      activeNovelCount: 0,
      completedNovelCount: 0,
    },
  });

  pushTaskLog(
    taskId,
    `Đã gom ${items.length} truyện từ ${directory.totalPages} trang. Chạy song song tối đa ${batchConcurrency} truyện.`,
  );

  const successes = [];
  const skipped = [];
  const failures = [];
  const activeTitles = new Map();
  const activeRatios = new Map();
  let completedCount = 0;
  let nextIndex = 0;

  const refreshBatchTaskState = () => {
    const currentPayload = getTask(taskId)?.payload || payload;
    const totalActiveRatio = [...activeRatios.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    const totalRatio =
      items.length > 0 ? (completedCount + totalActiveRatio) / items.length : 1;

    updateTask(taskId, {
      progress: Math.min(98, Math.max(2, 2 + Math.round(totalRatio * 96))),
      payload: {
        ...currentPayload,
        mode: "batch",
        epubMode,
        batchConcurrency,
        catalogUrl: directory.sourceUrl,
        totalNovels: items.length,
        currentNovelIndex: Math.min(
          items.length,
          completedCount + activeTitles.size,
        ),
        currentNovelTitle: [...activeTitles.values()].join(" | "),
        activeNovelCount: activeTitles.size,
        completedNovelCount: completedCount,
      },
    });
  };

  const processBatchItem = async (index, item) => {
    const currentIndex = index + 1;
    const indexLabel = `${currentIndex}/${items.length}`;
    activeTitles.set(index, item.title);
    activeRatios.set(index, 0);
    refreshBatchTaskState();

    try {
      pushTaskLog(taskId, `[${indexLabel}] Đang lấy thông tin: ${item.title}`);
      const novel = await fetchNovelInfo(item.url);
      activeTitles.set(index, novel.title);
      activeRatios.set(index, 0.05);
      refreshBatchTaskState();
      const existingOutput = await detectExistingNovelOutputs(novel, []);

      if (hasRequestedNovelOutputs(existingOutput, epubMode)) {
        skipped.push({
          title: novel.title,
          sourceUrl: novel.sourceUrl,
          novelDir: existingOutput.novelDir,
          completedKinds: existingOutput.completedKinds,
          epubFiles: existingOutput.existingEpubFiles,
        });

        pushTaskLog(
          taskId,
          `[${indexLabel}] Bỏ qua: ${novel.title} (đã có ${existingOutput.completedKinds.join(", ")})`,
        );
        return;
      }

      const result = await downloadNovelAssets(novel, [], epubMode, {
        onStart: ({ selectedVolumeIndexes, totalChapters }) => {
          activeTitles.set(index, novel.title);
          activeRatios.set(index, 0.08);
          refreshBatchTaskState();
          pushTaskLog(
            taskId,
            `[${indexLabel}] Bắt đầu tải ${novel.title} (${selectedVolumeIndexes.length} tập, ${totalChapters} chương)`,
          );
        },
        onChapterDone: ({ processedChapters, totalChapters }) => {
          const novelRatio =
            totalChapters > 0 ? processedChapters / totalChapters : 1;
          activeRatios.set(index, novelRatio);
          refreshBatchTaskState();
        },
        onLog: (message) => {
          if (message.startsWith("[ok]") || message.startsWith("[cache]"))
            return;
          pushTaskLog(taskId, `[${indexLabel}] ${message}`);
        },
      });

      successes.push({
        title: result.novelTitle,
        sourceUrl: result.sourceUrl,
        novelDir: result.novelDir,
        chapterCount: result.totalChapters,
        epubFiles: result.epubFiles,
      });

      pushTaskLog(taskId, `[${indexLabel}] Hoàn tất: ${result.novelTitle}`);
    } catch (error) {
      const formattedError = formatErrorMessage(error);
      failures.push({
        title: item.title,
        url: item.url,
        error: formattedError,
      });

      pushTaskLog(
        taskId,
        `[${indexLabel}] Thất bại: ${item.title} | ${formattedError}`,
      );
    } finally {
      activeTitles.delete(index);
      activeRatios.delete(index);
      completedCount += 1;
      refreshBatchTaskState();
    }
  };

  refreshBatchTaskState();

  const workers = Array.from(
    { length: Math.min(batchConcurrency, items.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;

        if (index >= items.length) {
          return;
        }

        await processBatchItem(index, items[index]);
      }
    },
  );

  await Promise.all(workers);

  const report = {
    generatedAt: new Date().toISOString(),
    catalogUrl: directory.sourceUrl,
    totalPages: directory.totalPages,
    totalItems: items.length,
    batchConcurrency,
    downloadedCount: successes.length,
    skippedCount: skipped.length,
    successCount: successes.length + skipped.length,
    failureCount: failures.length,
    epubMode,
    successes,
    skipped,
    failures,
  };

  const reportPath = await writeBatchReport(report);
  const reportItems = [
    {
      name: path.basename(reportPath),
      path: reportPath,
      url: toDownloadUrl(reportPath),
    },
  ];

  updateTask(taskId, {
    status: "completed",
    progress: 100,
    finishedAt: new Date().toISOString(),
    result: {
      mode: "batch",
      catalogUrl: directory.sourceUrl,
      totalPages: directory.totalPages,
      totalItems: items.length,
      batchConcurrency,
      downloadedCount: successes.length,
      skippedCount: skipped.length,
      successCount: successes.length + skipped.length,
      failureCount: failures.length,
      skippedItems: skipped.slice(0, 25),
      failedItems: failures.slice(0, 25),
      reportItems,
      downloadItems: reportItems,
    },
  });

  pushTaskLog(
    taskId,
    `Hoàn tất batch. Tải mới ${successes.length}, bỏ qua ${skipped.length}, thất bại ${failures.length}.`,
  );
}

function startDownloadTask(payload) {
  const task = createTask(payload);

  performDownload(task.id, payload).catch((error) => {
    clearImageResolutionWaiter(task.id);
    updateTask(task.id, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: formatErrorMessage(error),
    });
    pushTaskLog(task.id, `Thất bại: ${formatErrorMessage(error)}`);
  });

  return task;
}

function startBatchDownloadTask(payload) {
  const task = createTask(payload);

  performBatchDownload(task.id, payload).catch((error) => {
    updateTask(task.id, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: formatErrorMessage(error),
    });
    pushTaskLog(task.id, `Thất bại: ${formatErrorMessage(error)}`);
  });

  return task;
}

function parseSelectedVolumeIndexes(body) {
  if (!Array.isArray(body.selectedVolumeIndexes)) return [];
  return body.selectedVolumeIndexes.map((value) => Number.parseInt(value, 10));
}

app.get("/api/status", (req, res) => {
  res.json(getStatus());
});

app.get("/api/dns-profiles", (req, res) => {
  res.json({
    current: dnsProfile,
    profiles: Object.values(DNS_PROFILES),
  });
});

app.get("/api/docln-cookies", (req, res) => {
  res.json({
    status: getDoclnCookieStatus(),
  });
});

app.post("/api/docln-cookies", async (req, res) => {
  const rawInput = req.body?.cookie || req.body?.curl || req.body?.value || "";

  try {
    const status = setDoclnCookies(rawInput);
    await persistDoclnCookies();

    let testResult = null;
    let testError = "";

    try {
      testResult = await testDoclnCookies();
    } catch (error) {
      testError = formatErrorMessage(error);
    }

    res.json({
      ok: true,
      status,
      test: testResult,
      testError: testError || undefined,
    });
  } catch (error) {
    res.status(400).json({ error: formatErrorMessage(error) });
  }
});

app.post("/api/docln-cookies/test", async (req, res) => {
  try {
    const testResult = await testDoclnCookies();
    res.json({
      ok: testResult.ok,
      status: getDoclnCookieStatus(),
      test: testResult,
    });
  } catch (error) {
    res.status(400).json({ error: formatErrorMessage(error) });
  }
});

app.delete("/api/docln-cookies", async (req, res) => {
  await clearDoclnCookies();
  await persistDoclnCookies();
  res.json({ ok: true, status: getDoclnCookieStatus() });
});

app.post("/api/dns", (req, res) => {
  const { profileId, servers } = req.body || {};

  if (profileId && DNS_PROFILES[profileId]) {
    applyDnsProfile(DNS_PROFILES[profileId]);
    res.json({ ok: true, current: dnsProfile });
    return;
  }

  if (profileId === "custom") {
    const normalizedServers = Array.isArray(servers)
      ? servers.map((item) => String(item).trim()).filter(Boolean)
      : [];
    const invalidServers = normalizedServers.filter(
      (server) => net.isIP(server) === 0,
    );

    if (normalizedServers.length === 0 || invalidServers.length > 0) {
      res.status(400).json({
        error: `DNS không hợp lệ: ${invalidServers.join(", ") || "trống"}`,
      });
      return;
    }

    applyDnsProfile(
      createDnsProfile(
        `Tự nhập (${normalizedServers.join(", ")})`,
        normalizedServers,
      ),
    );
    res.json({ ok: true, current: dnsProfile });
    return;
  }

  res.status(400).json({ error: "Không nhận diện được cấu hình DNS." });
});

app.get("/api/recommendations", async (req, res) => {
  try {
    const items = await fetchHomepageRecommendations();
    res.json({ items, status: getStatus() });
  } catch (error) {
    res.status(500).json({ error: formatErrorMessage(error) });
  }
});

app.get("/api/catalog", async (req, res) => {
  const url = normalizeWhitespace(req.query.url || "");
  if (url && !isValvrareDirectoryUrl(url)) {
    res.status(400).json({ error: "URL danh mục Valvrare không hợp lệ." });
    return;
  }

  try {
    const directory = await crawlValvrareDirectory();
    res.json({
      items: directory.items,
      catalog: {
        sourceUrl: directory.sourceUrl,
        totalPages: directory.totalPages,
        totalItems: directory.totalItems,
      },
      status: getStatus(),
    });
  } catch (error) {
    res.status(500).json({ error: formatErrorMessage(error) });
  }
});

app.get("/api/search", async (req, res) => {
  const query = normalizeWhitespace(req.query.q || "");
  if (!query) {
    res.status(400).json({ error: "Từ khóa tìm kiếm không được để trống." });
    return;
  }

  try {
    const items = await searchNovels(query);
    res.json({ items, query, status: getStatus() });
  } catch (error) {
    res.status(500).json({ error: formatErrorMessage(error) });
  }
});

app.get("/api/novel", async (req, res) => {
  const url = normalizeWhitespace(req.query.url || "");
  if (!url) {
    res.status(400).json({ error: "Thiếu URL truyện." });
    return;
  }

  try {
    const novel = await fetchNovelInfo(url);
    res.json({ novel, status: getStatus() });
  } catch (error) {
    console.error(`[api/novel] ${url}: ${formatErrorMessage(error)}`);
    res.status(500).json({ error: formatErrorMessage(error) });
  }
});

app.post("/api/batch-download", (req, res) => {
  const catalogUrl = normalizeWhitespace(req.body?.catalogUrl || "");
  if (!catalogUrl || !isValvrareDirectoryUrl(catalogUrl)) {
    res.status(400).json({ error: "Thiếu hoặc sai URL danh mục Valvrare." });
    return;
  }

  const task = startBatchDownloadTask({
    mode: "batch",
    catalogUrl,
    epubMode: ensureValidEpubMode(String(req.body?.epubMode || "1")),
    batchConcurrency: ensureBatchConcurrency(req.body?.batchConcurrency || 2),
  });

  res.status(202).json({ task: serializeTask(task) });
});

app.post("/api/download", (req, res) => {
  const url = normalizeWhitespace(req.body?.url || "");
  if (!url) {
    res.status(400).json({ error: "Thiếu URL truyện." });
    return;
  }

  const task = startDownloadTask({
    url,
    epubMode: ensureValidEpubMode(String(req.body?.epubMode || "1")),
    selectedVolumeIndexes: parseSelectedVolumeIndexes(req.body || {}),
    customTitle: req.body?.customTitle || "",
    useVolumeCover: req.body?.useVolumeCover || {},
  });

  res.status(202).json({ task: serializeTask(task) });
});

app.get("/api/tasks/:taskId", (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: "Không tìm thấy task." });
    return;
  }

  res.json({ task: serializeTask(task) });
});

app.post(
  "/api/tasks/:taskId/image-resolution",
  express.json({ limit: "15mb" }),
  async (req, res) => {
    const task = getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Không tìm thấy task." });
      return;
    }

    try {
      await applyImageResolution(req.params.taskId, req.body || {});
      res.json({ ok: true, task: serializeTask(getTask(req.params.taskId)) });
    } catch (error) {
      res.status(400).json({ error: formatErrorMessage(error) });
    }
  },
);

app.get("/api/tasks", (req, res) => {
  res.json({
    tasks: [...tasks.values()].map(serializeTask),
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = Number.parseInt(process.env.PORT || "3000", 10);

keepProcessAliveForTerminal();

const server = app.listen(port, () => {
  const cookieStatus = getDoclnCookieStatus();
  logLine("");
  logLine(`HAKO web server đang chạy tại http://localhost:${port}`);
  logLine(
    `PID ${process.pid} — giữ NGUYÊN tab terminal này để xem log (Ctrl+C để dừng).`,
  );
  logLine(`Log file: ${LOG_FILE} (xem thêm: npm run logs)`);
  logLine(
    cookieStatus.isValid
      ? `Cookie docln: OK (cf_clearance + ln_session)`
      : cookieStatus.configured
        ? `Cookie docln: thiếu key bắt buộc (cần cf_clearance và ln_session)`
        : "Cookie docln: CHƯA có — bấm nút Cookie trên web hoặc POST /api/docln-cookies",
  );
  logLine(`Fetch docln: ${DOCLN_FETCH_MODE} | site: docln.sbs`);
  logLine("");
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    logError("");
    logError(`[server] Port ${port} đã có process khác đang dùng.`);
    logError(
      `[server] Có thể bạn đã chạy server nền từ lần trước — terminal trả prompt nhưng server vẫn chạy.`,
    );
    logError(`[server] Dừng server cũ: npm run stop`);
    logError(`[server] Hoặc: kill $(lsof -t -i:${port})`);
    logError(`[server] Sau đó chạy lại: npm start`);
    logError("");
    process.exit(1);
  }

  logError(`[server] Không thể khởi động: ${error.message}`);
  process.exit(1);
});
