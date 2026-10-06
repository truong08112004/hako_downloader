#!/usr/bin/env node
/**
 * Thay cover trong file EPUB đã build sẵn.
 *
 * node taskrieng/patch-epub-covers.js
 */

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { execFileSync } = require('child_process');

const OUTPUT_DIR = path.join(
  __dirname,
  'output',
  'Ore no Imouto ga Konna ni Kawaii Wake ga Nai',
);
const NOVEL_TITLE = 'Ore no Imouto ga Konna ni Kawaii Wake ga Nai';

const COVER_URLS = {
  5: 'https://static.wikia.nocookie.net/oreimo/images/2/29/Ore_no_Imouto_ga_Konnani_Kawaii_Wake_ga_Nai_Light_Novel_v05_cover.jpg/revision/latest?cb=20220905172839',
  7: 'https://static.wikia.nocookie.net/oreimo/images/3/32/Ore_no_Imouto_ga_Konnani_Kawaii_Wake_ga_Nai_Light_Novel_v07_cover.jpg/revision/latest?cb=20220905173436',
  9: 'https://static.wikia.nocookie.net/oreimo/images/d/d8/Ore_no_Imouto_ga_Konnani_Kawaii_Wake_ga_Nai_Light_Novel_v09_cover.jpg/revision/latest?cb=20220905173653',
  10: 'https://static.wikia.nocookie.net/oreimo/images/1/19/Ore_no_Imouto_ga_Konnani_Kawaii_Wake_ga_Nai_Light_Novel_v10_cover.jpg/revision/latest?cb=20220905174334',
  12: 'https://static.wikia.nocookie.net/sonako/images/8/87/Oreimo12_002.jpg/revision/latest?cb=20130809124659',
};

function guessImageExtension(buffer, url) {
  if (buffer?.length >= 4) {
    const hex = buffer.slice(0, 4).toString('hex');
    if (hex.startsWith('89504e47')) return '.png';
    if (hex.startsWith('ffd8ff')) return '.jpg';
    if (hex.startsWith('47494638')) return '.gif';
    if (hex.startsWith('52494646')) return '.webp';
  }
  const ext = path.extname(new URL(url).pathname.split('/revision/')[0]);
  return ext || '.jpg';
}

function mediaTypeForExt(ext) {
  switch (ext.toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}

async function downloadCover(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: {
      'User-Agent': 'hako-downloader-sonako/1.0',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });
  return Buffer.from(response.data);
}

function updateContentOpf(opfPath, coverFileName, mediaType) {
  let opf = fs.readFileSync(opfPath, 'utf-8');
  opf = opf.replace(
    /<item id="image_cover" href="[^"]+" media-type="[^"]+"\s*\/>/,
    `<item id="image_cover" href="${coverFileName}" media-type="${mediaType}" />`,
  );
  fs.writeFileSync(opfPath, opf, 'utf-8');
}

async function patchEpubCover(epubPath, buffer, sidecarPath) {
  const workDir = path.join(OUTPUT_DIR, '_patch_work', path.basename(epubPath, '.epub'));
  await fs.emptyDir(workDir);

  execFileSync('unzip', ['-oq', epubPath, '-d', workDir]);

  const ext = guessImageExtension(buffer, '');
  const coverFileName = `cover${ext}`;
  const oebpsDir = path.join(workDir, 'OEBPS');

  for (const oldCover of await fs.readdir(oebpsDir)) {
    if (/^cover\.(webp|jpg|jpeg|png|gif)$/i.test(oldCover)) {
      await fs.remove(path.join(oebpsDir, oldCover));
    }
  }

  await fs.writeFile(path.join(oebpsDir, coverFileName), buffer);
  if (sidecarPath) {
    await fs.writeFile(sidecarPath, buffer);
  }
  updateContentOpf(path.join(oebpsDir, 'content.opf'), coverFileName, mediaTypeForExt(ext));

  const tempEpub = `${epubPath}.tmp`;
  if (await fs.pathExists(tempEpub)) await fs.remove(tempEpub);

  const cwd = workDir;
  execFileSync('zip', ['-X0', tempEpub, 'mimetype'], { cwd });
  execFileSync(
    'zip',
    ['-Xr9', tempEpub, 'META-INF', 'OEBPS', '-x', '*.DS_Store'],
    { cwd },
  );

  await fs.move(tempEpub, epubPath, { overwrite: true });
  await fs.remove(path.join(OUTPUT_DIR, '_patch_work'));
}

async function main() {
  for (const [volume, coverUrl] of Object.entries(COVER_URLS)) {
    const volumeLabel = `Tập ${String(volume).padStart(2, '0')}`;
    const epubPath = path.join(
      OUTPUT_DIR,
      `${NOVEL_TITLE} - ${volumeLabel}.epub`,
    );

    if (!(await fs.pathExists(epubPath))) {
      console.log(`[bỏ qua] Không tìm thấy ${epubPath}`);
      continue;
    }

    console.log(`[patch] ${volumeLabel}...`);
    const buffer = await downloadCover(coverUrl);
    const ext = guessImageExtension(buffer, coverUrl);
    const sidecarPath = path.join(OUTPUT_DIR, `${volumeLabel}_cover${ext}`);

    await patchEpubCover(epubPath, buffer, sidecarPath);

    const stats = await fs.stat(epubPath);
    console.log(`  → ${epubPath} (${Math.round(stats.size / 1024)} KB)`);
  }

  console.log('Xong.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
