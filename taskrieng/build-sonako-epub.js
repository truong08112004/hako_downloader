#!/usr/bin/env node
/**
 * Tải light novel từ Sonako (Fandom wiki) và build EPUB
 * theo cấu trúc output của hako_downloader.
 *
 * Ví dụ:
 *   node taskrieng/build-sonako-epub.js "https://sonako.fandom.com/vi/wiki/Boku_wa_Tomodachi_ga_Sukunai"
 *   node taskrieng/build-sonako-epub.js "..." --volumes 1 --epub-mode 2
 *   node taskrieng/build-sonako-epub.js "..." --list
 */

const axios = require('axios');
const cheerio = require('cheerio');
const EpubGen = require('epub-gen-memory').default;
const fs = require('fs-extra');
const path = require('path');

const EPUB_CHAPTER_CSS = [
  'body { margin: 0; padding: 0; }',
  '.galley-rw { margin: 0; padding: 0; }',
  '.body-rw { margin: 0; padding: 0; }',
  '.image_full { margin: 0; padding: 0; text-align: center; }',
  '.image_full img { display: block; width: 100%; max-width: 100%; height: auto; margin: 0 auto; }',
].join('\n');

const EPUB_MODES = new Set(['0', '1', '2', '3']);
const DEFAULT_DELAY_MS = 500;
const SKIP_HEADING_PATTERN = /theo dõi|thanh chuyển|lưu pocket|xuất pdf|xuất epub|danh sách theo dõi/i;

function parseArgs(argv) {
  const args = {
    url: '',
    volumes: null,
    epubMode: '2',
    delayMs: DEFAULT_DELAY_MS,
    listOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--volumes') {
      const raw = argv[i + 1] || '';
      args.volumes = raw
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);
      i += 1;
      continue;
    }
    if (token === '--epub-mode') {
      args.epubMode = argv[i + 1] || '2';
      i += 1;
      continue;
    }
    if (token === '--delay') {
      args.delayMs = Number(argv[i + 1]) || DEFAULT_DELAY_MS;
      i += 1;
      continue;
    }
    if (token === '--list') {
      args.listOnly = true;
      continue;
    }
    if (!token.startsWith('-') && !args.url) {
      args.url = token;
    }
  }

  if (!EPUB_MODES.has(args.epubMode)) {
    args.epubMode = '2';
  }

  return args;
}

function sanitizeFileName(value) {
  const normalized = String(value || '').normalize('NFC');
  const sanitized = normalized
    .replace(/[\/\\?%*:|"<>]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  const safeValue = sanitized || 'untitled';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(safeValue)
    ? `_${safeValue}`
    : safeValue;
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeHtmlAttr(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseWikiUrl(input) {
  const url = new URL(input);
  const wikiPrefix = '/vi/wiki/';
  const wikiIndex = url.pathname.indexOf(wikiPrefix);
  if (wikiIndex === -1) {
    throw new Error('URL phải trỏ tới trang wiki Sonako, ví dụ: https://sonako.fandom.com/vi/wiki/Ten_Truyen');
  }

  const pageTitle = decodeURIComponent(url.pathname.slice(wikiIndex + wikiPrefix.length));
  const wikiOrigin = `${url.protocol}//${url.host}`;

  return {
    wikiOrigin,
    apiUrl: `${wikiOrigin}/api.php`,
    pageTitle,
    pageUrl: `${wikiOrigin}/vi/wiki/${encodeURIComponent(pageTitle).replace(/%20/g, '_')}`,
  };
}

async function apiRequest(apiUrl, params, delayMs) {
  const response = await axios.get(apiUrl, {
    params,
    timeout: 60000,
    headers: {
      'User-Agent': 'hako-downloader-sonako/1.0',
    },
  });

  if (response.data?.error) {
    throw new Error(response.data.error.info || response.data.error.code || 'MediaWiki API error');
  }

  if (delayMs > 0) {
    await delay(delayMs);
  }

  return response.data;
}

async function parseWikiPage(apiUrl, pageTitle, delayMs) {
  const data = await apiRequest(
    apiUrl,
    {
      action: 'parse',
      page: pageTitle,
      format: 'json',
      prop: 'text|links|displaytitle|images',
      redirects: 1,
    },
    delayMs,
  );

  if (!data.parse) {
    throw new Error(`Không tìm thấy trang wiki: ${pageTitle}`);
  }

  return data.parse;
}

function stripDisplayTitle(displayTitle) {
  const $ = cheerio.load(displayTitle || '', null, false);
  return normalizeWhitespace($('.mw-page-title-main').text() || $.text());
}

function extractAuthorFromHtml(html) {
  const $ = cheerio.load(html, null, false);
  const heading = normalizeWhitespace($('h3').first().text());
  const headingMatch = heading.match(/tác giả\s+(.+)$/i);
  if (headingMatch) {
    return normalizeAuthor(headingMatch[1]);
  }

  const bodyText = normalizeWhitespace($('.mw-parser-output').text());
  const inlineMatch = bodyText.match(/được viết bởi\s+([^,.]+)/i);
  if (inlineMatch) return normalizeAuthor(inlineMatch[1]);

  return 'Sonako';
}

function normalizeAuthor(raw) {
  return normalizeWhitespace(
    String(raw || '')
      .replace(/\s+và\s+vẽ.*$/i, '')
      .replace(/\s+vẽ minh họa.*$/i, ''),
  );
}

function extractSummaryFromHtml(html) {
  const $ = cheerio.load(html, null, false);
  const headings = $('h2 .mw-headline').toArray();
  for (const heading of headings) {
    const title = normalizeWhitespace($(heading).text());
    if (/^t[oó]m tắt$/i.test(title)) {
      const parts = [];
      let node = $(heading).parent().next();
      while (node.length) {
        if (node.is('h2')) break;
        const text = normalizeWhitespace(node.text());
        if (text) parts.push(text);
        node = node.next();
      }
      return parts.join('\n\n');
    }
  }
  return '';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickMainVolumePrefix(volumeList) {
  const counts = new Map();

  for (const volume of volumeList) {
    const match = volume.pageTitle.match(/^(.+? Volume)\d+$/);
    if (!match) continue;
    const prefix = match[1];
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }

  let bestPrefix = '';
  let bestCount = 0;
  for (const [prefix, count] of counts.entries()) {
    if (count > bestCount) {
      bestPrefix = prefix;
      bestCount = count;
    }
  }

  return bestPrefix;
}

function discoverVolumes(novelSlug, links) {
  const volumes = new Map();

  const upsertVolume = (number, pageTitle) => {
    if (!Number.isFinite(number) || number <= 0) return;
    if (!volumes.has(number)) {
      volumes.set(number, {
        number,
        pageTitle,
        title: `Tập ${String(number).padStart(2, '0')}`,
      });
    }
  };

  for (const link of links) {
    const title = link['*'] || link;

    const tapIndex = title.match(new RegExp(`^${escapeRegExp(novelSlug)}:Tập (\\d+)$`));
    if (tapIndex) {
      upsertVolume(Number(tapIndex[1]), title);
      continue;
    }

    const volumeIndex = title.match(/^(.+ Volume)(\d+)$/);
    if (volumeIndex) {
      upsertVolume(Number(volumeIndex[2]), title);
      continue;
    }

    const tapChapter = title.match(new RegExp(`^${escapeRegExp(novelSlug)}:Tập (\\d+) `));
    if (tapChapter) {
      upsertVolume(Number(tapChapter[1]), `${novelSlug}:Tập ${tapChapter[1]}`);
      continue;
    }

    const volumeChapter = title.match(/^(.+ Volume\d+): /);
    if (volumeChapter) {
      const pageTitle = volumeChapter[1];
      const number = Number(pageTitle.match(/Volume(\d+)$/)?.[1]);
      upsertVolume(number, pageTitle);
    }
  }

  let result = [...volumes.values()];
  const mainPrefix = pickMainVolumePrefix(result);
  if (mainPrefix) {
    result = result.filter((volume) => volume.pageTitle.startsWith(mainPrefix));
  }

  return result.sort((a, b) => a.number - b.number);
}

function chapterSortKey(suffix) {
  const normalized = normalizeWhitespace(suffix);
  if (/^illustration$/i.test(normalized) || /^hình minh họa$/i.test(normalized)) {
    return { group: 0, order: 0, label: 'Hình minh họa' };
  }
  if (/^lời bạt$/i.test(normalized) || /^afterword$/i.test(normalized)) {
    return { group: 2, order: 9999, label: 'Lời bạt' };
  }
  if (/^epilogue$/i.test(normalized) || /^epilougue$/i.test(normalized)) {
    return { group: 2, order: 9998, label: 'Epilogue' };
  }

  const chapterMatch = normalized.match(/^(?:chương|chapter)\s*(\d+)$/i);
  if (chapterMatch) {
    return {
      group: 1,
      order: Number(chapterMatch[1]),
      label: `Chương ${chapterMatch[1]}`,
    };
  }

  return { group: 1, order: 5000, label: normalized };
}

function discoverChapters(volume, links) {
  const tapPrefix = `${volume.pageTitle} `;
  const volumePrefix = `${volume.pageTitle}: `;
  const chapters = new Map();

  for (const link of links) {
    const title = link['*'] || link;
    let suffix = '';

    if (title.startsWith(volumePrefix)) {
      suffix = title.slice(volumePrefix.length).trim();
    } else if (title.startsWith(tapPrefix)) {
      suffix = title.slice(tapPrefix.length).trim();
    } else {
      continue;
    }

    if (!suffix) continue;

    const sortMeta = chapterSortKey(suffix);
    chapters.set(title, {
      pageTitle: title,
      suffix,
      defaultTitle: sortMeta.label,
      sortGroup: sortMeta.group,
      sortOrder: sortMeta.order,
    });
  }

  return [...chapters.values()].sort((a, b) => {
    if (a.sortGroup !== b.sortGroup) return a.sortGroup - b.sortGroup;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.defaultTitle.localeCompare(b.defaultTitle, 'vi');
  });
}

function extractChapterTitle(html, fallbackTitle) {
  const $ = cheerio.load(html, null, false);
  const headings = $('h2').toArray();

  for (const heading of headings) {
    const $heading = $(heading);
    if ($heading.closest('.print-no, .dotEPUBremove, .entry-unrelated, .noprint').length) {
      continue;
    }

    const headline = normalizeWhitespace(
      $heading.find('.mw-headline').first().text() || $heading.text().replace(/\s*\[.*$/, ''),
    );
    if (!headline || SKIP_HEADING_PATTERN.test(headline)) continue;
    return headline;
  }

  return fallbackTitle;
}

function normalizeWikiFileName(value) {
  return String(value || '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase();
}

function wikiFileTitleFromHref(href) {
  if (!href) return '';

  try {
    const decoded = decodeURIComponent(href);
    const match = decoded.match(/\/wiki\/[^:]+:([^#?]+)/i);
    return match ? match[1] : '';
  } catch {
    const match = String(href).match(/\/wiki\/[^:]+:([^#?]+)/i);
    return match ? decodeURIComponent(match[1]) : '';
  }
}

function upgradeThumbnailUrl(url) {
  if (!url || url.startsWith('data:')) return '';
  return url
    .replace(/\/scale-to-width-down\/\d+/g, '')
    .replace(/\/scale-to-height-down\/\d+/g, '')
    .replace(/\/scale-to-width-down\//g, '/');
}

function collectImageFileNames($) {
  const names = new Set();

  $('a.image.lightbox[href]').each((_, anchor) => {
    const fileName = wikiFileTitleFromHref($(anchor).attr('href'));
    if (fileName) names.add(fileName);
  });

  $('img').each((_, img) => {
    const $img = $(img);
    const dataName = $img.attr('data-image-name') || $img.attr('data-image-key') || '';
    if (dataName) names.add(dataName);

    for (const attr of ['data-src', 'src']) {
      const raw = $img.attr(attr) || '';
      const upgraded = upgradeThumbnailUrl(raw);
      const fileMatch = upgraded.match(/\/([^/]+\.(?:jpg|jpeg|png|gif|webp))(?:\/|$)/i);
      if (fileMatch) names.add(fileMatch[1]);
    }
  });

  return [...names];
}

async function resolveFileUrls(apiUrl, fileTitles, delayMs) {
  const unique = [...new Set(fileTitles.filter(Boolean))];
  const map = new Map();
  if (unique.length === 0) return map;

  const batchSize = 20;
  for (let offset = 0; offset < unique.length; offset += batchSize) {
    const batch = unique.slice(offset, offset + batchSize);
    const data = await apiRequest(
      apiUrl,
      {
        action: 'query',
        titles: batch.map((file) => `File:${file}`).join('|'),
        prop: 'imageinfo',
        iiprop: 'url',
        format: 'json',
      },
      delayMs,
    );

    for (const page of Object.values(data.query?.pages || {})) {
      const title = page.title || '';
      const fileName = title.replace(/^[^:]+:/, '');
      const url = page.imageinfo?.[0]?.url;
      if (fileName && url) {
        map.set(fileName, url);
      }
    }
  }

  return map;
}

function lookupResolvedImageUrl(fileName, fileUrlMap) {
  if (!fileName) return '';

  if (fileUrlMap.has(fileName)) {
    return fileUrlMap.get(fileName);
  }

  const target = normalizeWikiFileName(fileName);
  for (const [key, value] of fileUrlMap.entries()) {
    if (normalizeWikiFileName(key) === target) {
      return value;
    }
  }

  return '';
}

async function prepareImagesInHtml(html, apiUrl, delayMs) {
  const $ = cheerio.load(html, null, false);

  $('noscript').each((_, el) => {
    const inner = $(el).html();
    if (!inner) {
      $(el).remove();
      return;
    }

    const $inner = cheerio.load(inner, null, false);
    const img = $inner('img').first();
    if (img.length) {
      $(el).replaceWith(img);
    } else {
      $(el).remove();
    }
  });

  const fileUrlMap = await resolveFileUrls(apiUrl, collectImageFileNames($), delayMs);

  $('a.image.lightbox[href]').each((_, anchor) => {
    const $anchor = $(anchor);
    const fileName = wikiFileTitleFromHref($anchor.attr('href'));
    const alt = $anchor.attr('title') || fileName || 'Image';
    const resolved = lookupResolvedImageUrl(fileName, fileUrlMap);

    if (resolved) {
      $anchor.replaceWith(
        `<p class="sonako-image"><img src="${escapeHtmlAttr(resolved)}" alt="${escapeHtmlAttr(alt)}"/></p>`,
      );
      return;
    }

    const $img = $anchor.find('img').first();
    const fallback = upgradeThumbnailUrl($img.attr('data-src') || $img.attr('src') || '');
    if (fallback) {
      $anchor.replaceWith(
        `<p class="sonako-image"><img src="${escapeHtmlAttr(fallback)}" alt="${escapeHtmlAttr(alt)}"/></p>`,
      );
      return;
    }

    $anchor.remove();
  });

  $('img').each((_, img) => {
    const $img = $(img);
    const fileName = $img.attr('data-image-name') || $img.attr('data-image-key') || '';
    const resolved =
      lookupResolvedImageUrl(fileName, fileUrlMap) ||
      upgradeThumbnailUrl($img.attr('data-src') || '') ||
      upgradeThumbnailUrl($img.attr('src') || '');

    if (!resolved || resolved.startsWith('data:')) {
      $img.remove();
      return;
    }

    $img.attr('src', resolved);
    $img.removeAttr('data-src data-image-name data-image-key class width height decoding loading');
  });

  $('.wikia-gallery, .wikia-gallery-item, .thumb, .gallery-image-wrapper').each((_, el) => {
    const $el = $(el);
    if ($el.find('img').length === 0 && normalizeWhitespace($el.text()) === '') {
      $el.replaceWith($el.contents());
    }
  });

  return ($.root().html() || '').trim();
}

function cleanSonakoHtml(html) {
  const $ = cheerio.load(html, null, false);
  const root = $('.mw-parser-output');
  const scope = root.length ? root : $.root();

  scope.find(
    '.mw-editsection, .noprint, .print-no, .entry-unrelated, .dotEPUBremove, .navbox, .references, .reference, .followerBar, .followButton, .unfollowButton, script, style',
  ).remove();
  scope.find('table.wikitable').remove();
  scope.find('div[style*="display:none"]').remove();
  scope.find('h2').each((_, heading) => {
    const title = normalizeWhitespace($(heading).text());
    if (SKIP_HEADING_PATTERN.test(title)) {
      $(heading).nextUntil('h2').remove();
      $(heading).remove();
    }
  });
  scope.find('sup.reference').each((_, el) => {
    const note = normalizeWhitespace($(el).text());
    if (note) {
      $(el).replaceWith(`[${note.replace(/^\[|\]$/g, '')}]`);
    } else {
      $(el).remove();
    }
  });

  scope.find('p').each((_, p) => {
    const text = $(p).html();
    if (!text || /^<br\s*\/?>$/i.test(text.trim())) {
      $(p).remove();
    }
  });

  return (scope.html() || '').trim();
}

function stripNonContentMarkup(html) {
  const $ = cheerio.load(html, null, false);
  $(
    '.wikia-gallery-caption, .wikia-gallery-item:empty, .thumb:empty, .gallery-image-wrapper:empty, a.image.lightbox:empty',
  ).remove();
  $('.wikia-gallery, .wikia-gallery-item, .thumb, .gallery-image-wrapper').each((_, el) => {
    const $el = $(el);
    if ($el.find('img').length === 0 && normalizeWhitespace($el.text()) === '') {
      $el.remove();
    }
  });
  return ($.html() || '').trim();
}

function hasMeaningfulHtml(html) {
  if (!html || !String(html).trim()) return false;
  const cleaned = stripNonContentMarkup(html);
  const $ = cheerio.load(cleaned, null, false);
  if (normalizeWhitespace($.text()).length > 0) return true;
  return $('img, svg, video').length > 0;
}

function buildImageChapterContent(alt, filePath) {
  const src = `file:///${filePath.replace(/\\/g, '/')}`;
  return `<div class="image_full"><img alt="${escapeHtmlAttr(alt || 'Image')}" src="${src}"/></div>`;
}

function buildTextChapterContent(html) {
  return `<div class="galley-rw">
<section class="body-rw Chapter-rw" epub:type="bodymatter chapter">
${html}
</section>
</div>`;
}

function pushEpubSegmentsFromChapter(epubChapters, segments, meta) {
  const baseTitle = `${meta.volumeTitle} - ${meta.chapterTitle}`;
  let tocEntryAdded = false;
  let chapterTitleShown = false;

  for (const segment of segments) {
    if (segment.type === 'image') {
      const isFirstTocEntry = !tocEntryAdded;
      if (isFirstTocEntry) tocEntryAdded = true;

      epubChapters.push({
        title: baseTitle,
        author: [],
        content: buildImageChapterContent(segment.alt, segment.filePath),
        excludeFromToc: !isFirstTocEntry,
        prependChapterTitles: false,
      });
      continue;
    }

    if (!hasMeaningfulHtml(segment.html)) {
      continue;
    }

    const isFirstTocEntry = !tocEntryAdded;
    if (isFirstTocEntry) tocEntryAdded = true;

    const showChapterTitle = !chapterTitleShown;
    if (showChapterTitle) chapterTitleShown = true;

    epubChapters.push({
      title: baseTitle,
      author: showChapterTitle ? meta.author : [],
      content: buildTextChapterContent(segment.html),
      excludeFromToc: !isFirstTocEntry,
      prependChapterTitles: showChapterTitle,
    });
  }
}

function guessImageExtension(buffer, url) {
  if (buffer?.length >= 4) {
    const hex = buffer.slice(0, 4).toString('hex');
    if (hex.startsWith('89504e47')) return '.png';
    if (hex.startsWith('ffd8ff')) return '.jpg';
    if (hex.startsWith('47494638')) return '.gif';
    if (hex.startsWith('52494646')) return '.webp';
  }
  const ext = path.extname(new URL(url).pathname);
  return ext || '.jpg';
}

async function downloadBinary(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    headers: {
      'User-Agent': 'hako-downloader-sonako/1.0',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });
  return Buffer.from(response.data);
}

async function embedImagesInHtml(contentHtml, tempDir, delayMs) {
  const $doc = cheerio.load(contentHtml, null, false);
  const images = $doc('img').toArray();
  const embeddedRecords = new Map();

  await fs.ensureDir(tempDir);

  for (let index = 0; index < images.length; index += 1) {
    const img = images[index];
    const alt = $doc(img).attr('alt') || '';
    const imageUrl = $doc(img).attr('src') || '';

    if (!imageUrl || imageUrl.startsWith('data:') || imageUrl.startsWith('file:')) {
      $doc(img).remove();
      continue;
    }

    try {
      const buffer = await downloadBinary(imageUrl);
      if (buffer.length < 100) {
        $doc(img).remove();
        continue;
      }

      const ext = guessImageExtension(buffer, imageUrl);
      const filePath = path.join(tempDir, `img_${Date.now()}_${index}${ext}`);
      await fs.writeFile(filePath, buffer);
      const sourceMatch = imageUrl.match(/\/([^/?#]+\.(?:jpg|jpeg|png|gif|webp))(?:[/?#]|$)/i);
      embeddedRecords.set(index, {
        filePath,
        alt,
        sourceFileName: sourceMatch?.[1] || '',
      });
      $doc(img).replaceWith(`<!--EPUB_IMG_${index}-->`);

      if (delayMs > 0) {
        await delay(Math.min(delayMs, 300));
      }
    } catch {
      $doc(img).remove();
    }
  }

  $doc('figure, a.mw-file-description, a.image').each((_, el) => {
    const $el = $doc(el);
    if ($el.find('img').length === 0 && normalizeWhitespace($el.text()) === '') {
      $el.remove();
    }
  });

  const segments = [];
  const markerPattern = /<!--EPUB_IMG_(\d+)-->/g;
  const marked = $doc.html() || '';
  let lastIndex = 0;
  let match;

  while ((match = markerPattern.exec(marked))) {
    const textPart = marked.slice(lastIndex, match.index);
    if (hasMeaningfulHtml(textPart)) {
      segments.push({ type: 'text', html: textPart.trim() });
    }
    const record = embeddedRecords.get(Number(match[1]));
    if (record) segments.push({ type: 'image', ...record });
    lastIndex = match.index + match[0].length;
  }

  const tail = marked.slice(lastIndex);
  if (hasMeaningfulHtml(tail)) {
    segments.push({ type: 'text', html: tail.trim() });
  }

  if (segments.length === 0 && hasMeaningfulHtml(contentHtml)) {
    segments.push({ type: 'text', html: contentHtml });
  }

  return segments;
}

function buildChapterText(volumeTitle, chapterTitle, segments) {
  let text = `${volumeTitle}\n\n${chapterTitle}\n\n`;
  for (const segment of segments) {
    if (segment.type === 'image') {
      text += `[Anh: ${segment.filePath}]\n\n`;
      continue;
    }
    const $ = cheerio.load(segment.html, null, false);
    $('p, div, h1, h2, h3, h4').each((_, el) => {
      const line = normalizeWhitespace($(el).text());
      if (line) text += `${line}\n\n`;
    });
  }
  return text.trim() + '\n';
}

async function generateEpub(epubPath, title, author, coverPath, chapters) {
  const options = {
    title,
    author,
    publisher: 'Hako Downloader',
    tocTitle: 'Mục lục',
    lang: 'vi',
    css: EPUB_CHAPTER_CSS,
    numberChaptersInTOC: true,
    ignoreFailedDownloads: true,
  };

  if (coverPath && (await fs.pathExists(coverPath))) {
    options.cover = `file:///${coverPath.replace(/\\/g, '/')}`;
  }

  try {
    const buffer = await EpubGen(options, chapters);
    await fs.writeFile(epubPath, buffer);
    return epubPath;
  } catch (error) {
    const fallback = chapters.map((chapter) => {
      const $chapter = cheerio.load(chapter.content);
      $chapter('img').remove();
      return { ...chapter, content: $chapter.html() };
    });
    delete options.cover;
    const buffer = await EpubGen(options, fallback);
    await fs.writeFile(epubPath, buffer);
    return epubPath;
  }
}

async function resolveCoverImage(apiUrl, volumeNumber, images, delayMs) {
  const padded = String(volumeNumber).padStart(2, '0');
  const patterns = [
    new RegExp(`cover.*volume[_ ]*0*${volumeNumber}\\b`, 'i'),
    new RegExp(`vol0*${volumeNumber}.*cover`, 'i'),
    new RegExp(`volume[_ ]*0*${volumeNumber}.*cover`, 'i'),
    new RegExp(`Oikk_v0*${padded}_001`, 'i'),
    new RegExp(`_v0*${padded}_001`, 'i'),
  ];

  const candidate = (images || []).find((name) => patterns.some((pattern) => pattern.test(name)));
  if (!candidate) return null;

  const data = await apiRequest(
    apiUrl,
    {
      action: 'query',
      titles: `File:${candidate}`,
      prop: 'imageinfo',
      iiprop: 'url',
      format: 'json',
    },
    delayMs,
  );

  const pages = data.query?.pages || {};
  const page = Object.values(pages)[0];
  return page?.imageinfo?.[0]?.url || null;
}

function isIllustrationCoverFileName(fileName, volumeNumber = null) {
  if (!fileName) return false;
  const normalized = normalizeWikiFileName(fileName);
  if (!/_001\.(jpg|jpeg|png|gif|webp)$/.test(normalized)) return false;

  if (!volumeNumber) return true;

  const vol = String(volumeNumber);
  const padded = vol.padStart(2, '0');
  const volPatterns = [
    new RegExp(`_v0*${vol}_001\\.(jpg|jpeg|png|gif|webp)$`),
    new RegExp(`_v${padded}_001\\.(jpg|jpeg|png|gif|webp)$`),
    new RegExp(`volume0*${vol}.*_001\\.(jpg|jpeg|png|gif|webp)$`),
  ];
  return volPatterns.some((pattern) => pattern.test(normalized));
}

function findCoverIllustrationFileName($, volumeNumber) {
  const candidates = [];

  $('a.image.lightbox[href]').each((_, anchor) => {
    const fileName = wikiFileTitleFromHref($(anchor).attr('href'));
    if (fileName) candidates.push(fileName);
  });

  for (const fileName of collectImageFileNames($)) {
    candidates.push(fileName);
  }

  const unique = [...new Set(candidates)];
  const volumeMatch = unique.find((fileName) => isIllustrationCoverFileName(fileName, volumeNumber));
  if (volumeMatch) return volumeMatch;

  return unique.find((fileName) => isIllustrationCoverFileName(fileName)) || null;
}

function pickIllustrationCoverFromSegments(segments, volumeNumber) {
  const images = segments.filter((segment) => segment.type === 'image');

  for (const image of images) {
    const names = [
      image.sourceFileName,
      path.basename(image.filePath || ''),
      image.alt,
    ];
    if (names.some((name) => isIllustrationCoverFileName(name, volumeNumber))) {
      return image.filePath;
    }
  }

  for (const image of images) {
    const names = [image.sourceFileName, path.basename(image.filePath || ''), image.alt];
    if (names.some((name) => isIllustrationCoverFileName(name))) {
      return image.filePath;
    }
  }

  return null;
}

async function resolveIllustrationCover(apiUrl, chapters, volumeNumber, delayMs) {
  const illustration = chapters.find((chapter) => /illustration/i.test(chapter.suffix));
  if (!illustration) return null;

  try {
    const page = await parseWikiPage(apiUrl, illustration.pageTitle, delayMs);
    const html = page.text?.['*'] || '';
    const $ = cheerio.load(html, null, false);
    const fileName = findCoverIllustrationFileName($, volumeNumber);
    if (!fileName) return null;

    const map = await resolveFileUrls(apiUrl, [fileName], delayMs);
    return lookupResolvedImageUrl(fileName, map) || null;
  } catch {
    return null;
  }
}

async function downloadCover(coverUrl, coverPath, delayMs) {
  if (!coverUrl) return null;
  try {
    const buffer = await downloadBinary(coverUrl);
    if (buffer.length < 100) return null;
    const ext = guessImageExtension(buffer, coverUrl);
    const finalPath = coverPath.replace(/\.[^.]+$/, '') + ext;
    await fs.writeFile(finalPath, buffer);
    if (delayMs > 0) await delay(delayMs);
    return finalPath;
  } catch {
    return null;
  }
}

async function inspectNovel(wiki, delayMs) {
  const mainPage = await parseWikiPage(wiki.apiUrl, wiki.pageTitle, delayMs);
  const novelTitle = stripDisplayTitle(mainPage.displaytitle) || wiki.pageTitle.replace(/_/g, ' ');
  const html = mainPage.text?.['*'] || '';
  const author = extractAuthorFromHtml(html);
  const summary = extractSummaryFromHtml(html);
  const novelSlug = mainPage.title;
  const volumes = discoverVolumes(novelSlug, mainPage.links || []);

  const chapterMap = new Map();
  for (const volume of volumes) {
    chapterMap.set(volume.number, discoverChapters(volume, mainPage.links || []));
  }

  for (const volume of volumes) {
    if (chapterMap.get(volume.number)?.length) continue;

    try {
      const volumePage = await parseWikiPage(wiki.apiUrl, volume.pageTitle, delayMs);
      chapterMap.set(volume.number, discoverChapters(volume, volumePage.links || []));
    } catch {
      chapterMap.set(volume.number, []);
    }
  }

  return {
    novelSlug: mainPage.title,
    novelTitle,
    author,
    summary,
    volumes,
    chapterMap,
    mainImages: mainPage.images || [],
  };
}

async function downloadChapter(chapter, wiki, volume, volumeDir, tempDir, author, delayMs) {
  let page;
  try {
    page = await parseWikiPage(wiki.apiUrl, chapter.pageTitle, delayMs);
  } catch (error) {
    console.log(`  [bỏ qua] ${chapter.defaultTitle}: ${error.message}`);
    return null;
  }

  const rawHtml = page.text?.['*'] || '';
  const cleanedHtml = cleanSonakoHtml(rawHtml);
  const preparedHtml = cleanedHtml
    ? await prepareImagesInHtml(cleanedHtml, wiki.apiUrl, delayMs)
    : '';
  const chapterTitle = extractChapterTitle(rawHtml, chapter.defaultTitle);
  const safeChapterTitle = sanitizeFileName(chapterTitle);

  const htmlPath = path.join(volumeDir, `${safeChapterTitle}.html`);
  const txtPath = path.join(volumeDir, `${safeChapterTitle}.txt`);

  const segments = preparedHtml
    ? await embedImagesInHtml(preparedHtml, tempDir, delayMs)
    : [];

  if (segments.length === 0) {
    console.log(`  [bỏ qua] ${chapterTitle} (rỗng)`);
    return null;
  }

  await fs.writeFile(htmlPath, preparedHtml, 'utf-8');
  await fs.writeFile(
    txtPath,
    buildChapterText(volume.title, chapterTitle, segments),
    'utf-8',
  );

  return {
    chapterTitle,
    segments,
    author: [author],
  };
}

async function processVolume(novel, volume, chapters, wiki, outputDir, epubMode, delayMs) {
  const volumeDir = path.join(outputDir, sanitizeFileName(volume.title));
  const tempDir = path.join(volumeDir, '_temp_epub_images');
  await fs.ensureDir(volumeDir);

  const coverPath = path.join(
    outputDir,
    `${sanitizeFileName(volume.title)}_cover.jpg`,
  );
  let coverUrl = await resolveCoverImage(
    wiki.apiUrl,
    volume.number,
    novel.mainImages,
    delayMs,
  );
  if (!coverUrl) {
    coverUrl = await resolveIllustrationCover(wiki.apiUrl, chapters, volume.number, delayMs);
    if (coverUrl) {
      console.log(`  [cover] dùng ảnh _001 từ chương minh họa`);
    }
  }
  let localCover = await downloadCover(coverUrl, coverPath, delayMs);

  const epubChapters = [];
  const author = [novel.author];
  let illustrationCoverPath = null;

  for (const chapter of chapters) {
    console.log(`  [tải] ${volume.title} / ${chapter.defaultTitle}`);
    const result = await downloadChapter(
      chapter,
      wiki,
      volume,
      volumeDir,
      tempDir,
      novel.author,
      delayMs,
    );

    if (!result) {
      continue;
    }

    if (
      !illustrationCoverPath &&
      /illustration|hình minh họa/i.test(chapter.defaultTitle)
    ) {
      illustrationCoverPath = pickIllustrationCoverFromSegments(result.segments, volume.number);
    }

    if (result.segments.length > 0) {
      pushEpubSegmentsFromChapter(epubChapters, result.segments, {
        volumeTitle: volume.title,
        chapterTitle: result.chapterTitle,
        author,
      });
    }
  }

  if (!localCover && illustrationCoverPath) {
    await fs.copy(illustrationCoverPath, coverPath);
    localCover = coverPath;
    console.log(`  [cover] dùng ảnh _001 đã tải từ minh họa`);
  }

  const generated = [];
  if ((epubMode === '2' || epubMode === '3') && epubChapters.length > 0) {
    const epubOut = path.join(
      outputDir,
      `${sanitizeFileName(novel.novelTitle)} - ${sanitizeFileName(volume.title)}.epub`,
    );
    await generateEpub(
      epubOut,
      `${novel.novelTitle} - ${volume.title}`,
      novel.author,
      localCover,
      epubChapters,
    );
    generated.push(epubOut);
    console.log(`  → ${epubOut}`);
  }

  return { epubChapters, generated, coverPath: localCover };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.log(`Cách dùng:
  node taskrieng/build-sonako-epub.js <sonako-wiki-url> [tuỳ chọn]

Tuỳ chọn:
  --volumes 1,2,3     Chỉ build các tập chỉ định (mặc định: tất cả)
  --epub-mode 0|1|2|3 0=chỉ TXT/HTML, 1=EPUB tổng, 2=EPUB từng tập, 3=cả hai
  --delay 500         Độ trễ giữa các request (ms)
  --list              Chỉ liệt kê tập/chương, không tải

Ví dụ:
  node taskrieng/build-sonako-epub.js "https://sonako.fandom.com/vi/wiki/Boku_wa_Tomodachi_ga_Sukunai" --volumes 1
`);
    process.exit(1);
  }

  const wiki = parseWikiUrl(args.url);
  console.log(`Wiki: ${wiki.pageUrl}`);
  console.log('Đang đọc metadata...\n');

  const novel = await inspectNovel(wiki, args.delayMs);
  const selectedVolumes = args.volumes?.length
    ? novel.volumes.filter((volume) => args.volumes.includes(volume.number))
    : novel.volumes;

  if (selectedVolumes.length === 0) {
    throw new Error('Không tìm thấy tập nào phù hợp.');
  }

  console.log(`Truyện: ${novel.novelTitle}`);
  console.log(`Tác giả: ${novel.author}`);
  if (novel.summary) {
    console.log(`Tóm tắt: ${novel.summary.slice(0, 120)}${novel.summary.length > 120 ? '...' : ''}`);
  }
  console.log('');

  for (const volume of selectedVolumes) {
    const chapters = novel.chapterMap.get(volume.number) || [];
    console.log(`${volume.title} (${chapters.length} chương)`);
    for (const chapter of chapters) {
      console.log(`  - ${chapter.defaultTitle}`);
    }
    console.log('');
  }

  if (args.listOnly) {
    return;
  }

  const outputDir = path.join(__dirname, 'output', sanitizeFileName(novel.novelTitle));
  await fs.ensureDir(outputDir);
  console.log(`Output: ${outputDir}\n`);

  const allEpubChapters = [];
  const generatedEpubs = [];
  let combinedCover = null;

  for (const volume of selectedVolumes) {
    const chapters = novel.chapterMap.get(volume.number) || [];
    if (chapters.length === 0) {
      console.log(`[bỏ qua] ${volume.title}: không có chương`);
      continue;
    }

    console.log(`=== ${volume.title} ===`);
    const result = await processVolume(
      novel,
      volume,
      chapters,
      wiki,
      outputDir,
      args.epubMode,
      args.delayMs,
    );
    allEpubChapters.push(...result.epubChapters);
    generatedEpubs.push(...result.generated);
    if (!combinedCover && result.coverPath) {
      combinedCover = result.coverPath;
    }
    console.log('');
  }

  if ((args.epubMode === '1' || args.epubMode === '3') && allEpubChapters.length > 0) {
    const epubOut = path.join(outputDir, `${sanitizeFileName(novel.novelTitle)}.epub`);
    console.log('=== EPUB tổng ===');
    await generateEpub(
      epubOut,
      novel.novelTitle,
      novel.author,
      combinedCover,
      allEpubChapters,
    );
    generatedEpubs.push(epubOut);
    console.log(`  → ${epubOut}\n`);
  }

  console.log(`Hoàn tất. ${generatedEpubs.length} file EPUB.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
