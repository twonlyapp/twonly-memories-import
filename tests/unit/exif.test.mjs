import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  withExif, readExif, tiffBlock, webpChunks, webpDimensions, exifDate, imageDimensions, checkImageSize, ImageLimitError,
} from '../../src/media.js';
import { encodePng, oversizedPngHeader } from '../helpers/png.mjs';

function webp(width, height, { lossless = false, alpha = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twonly-webp-'));
  const png = path.join(dir, 'in.png');
  fs.writeFileSync(png, encodePng(width, height, (x) => [x % 255, 80, 160, alpha ? 128 : 255]));
  const out = path.join(dir, 'out.webp');
  execFileSync('cwebp', ['-quiet', ...(lossless ? ['-lossless'] : ['-q', '80']), png, '-o', out]);
  return new Uint8Array(fs.readFileSync(out));
}

const hasCwebp = (() => {
  try {
    execFileSync('cwebp', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const META = { createdAt: Date.UTC(2024, 10, 18, 23, 2, 20), location: { latitude: 52.520008, longitude: -13.404954 } };

test('writes DateTimeOriginal (UTC), OffsetTimeOriginal and GPS into a lossy WebP', { skip: !hasCwebp && 'cwebp missing' }, () => {
  const source = webp(64, 48);
  const out = withExif(source, META);
  const chunks = webpChunks(out);
  assert.equal(chunks[0].id, 'VP8X');
  assert.ok(chunks[0].payload[0] & 0x08, 'EXIF flag set');
  assert.deepEqual(webpDimensions(chunks), { width: 64, height: 48 });
  const exif = readExif(out);
  assert.equal(exif.dateTime, '2024:11:18 23:02:20');
  assert.equal(exif.dateTimeOriginal, '2024:11:18 23:02:20');
  assert.equal(exif.offsetTimeOriginal, '+00:00');
  assert.ok(Math.abs(exif.location.latitude - 52.520008) < 1e-6);
  assert.ok(Math.abs(exif.location.longitude + 13.404954) < 1e-6);
  // RIFF size covers the whole file.
  assert.equal(new DataView(out.buffer).getUint32(4, true) + 8, out.length);
});

test('keeps transparency and replaces instead of appending', { skip: !hasCwebp && 'cwebp missing' }, () => {
  const source = webp(20, 10, { lossless: true, alpha: true });
  const once = withExif(source, META);
  assert.ok(webpChunks(once)[0].payload[0] & 0x10, 'alpha flag set');
  const twice = withExif(once, { createdAt: Date.UTC(2020, 0, 1) });
  assert.equal(webpChunks(twice).filter((c) => c.id === 'EXIF').length, 1);
  assert.equal(webpChunks(twice).filter((c) => c.id === 'VP8X').length, 1);
  assert.equal(readExif(twice).dateTimeOriginal, '2020:01:01 00:00:00');
  assert.equal(readExif(twice).location, null);
  // cwebp's decoder still reads the result.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twonly-webp-'));
  fs.writeFileSync(path.join(dir, 'x.webp'), twice);
  execFileSync('dwebp', ['-quiet', path.join(dir, 'x.webp'), '-o', path.join(dir, 'x.png')]);
});

test('the TIFF block has the layout media_exif.rs writes', () => {
  // Vector shared with the app's Rust tests (tests/vectors/exif.json).
  const vector = JSON.parse(fs.readFileSync(new URL('../vectors/exif.json', import.meta.url), 'utf8'));
  for (const { input, tiffHex } of vector) {
    const block = tiffBlock({ createdAt: input.createdAt, location: input.location });
    assert.equal(Buffer.from(block).toString('hex'), tiffHex);
  }
  assert.equal(exifDate(Date.UTC(2025, 0, 2, 3, 4, 5)), '2025:01:02 03:04:05');
});

test('reads image dimensions from headers only, and refuses decode bombs', () => {
  assert.deepEqual(imageDimensions(encodePng(7, 9, () => [0, 0, 0, 0])), { type: 'png', width: 7, height: 9 });
  const bomb = imageDimensions(oversizedPngHeader(20_000, 20_000));
  assert.throws(() => checkImageSize(bomb), ImageLimitError);
  assert.throws(() => checkImageSize({ width: 10_000, height: 10_000 }), /too large/);
  assert.doesNotThrow(() => checkImageSize({ width: 4000, height: 6000 }));
  assert.throws(() => checkImageSize(null), ImageLimitError);
  // A JPEG made by ffmpeg in the fixture.
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108012c0190030122000211010311 01'.replace(/ /g, ''), 'hex');
  assert.deepEqual(imageDimensions(jpeg), { type: 'jpeg', width: 400, height: 300 });
});
