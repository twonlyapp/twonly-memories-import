#!/usr/bin/env node
// Generates a synthetic Snapchat "My Data" export for the tests.
//
// The fixture uses generated media and the following export structure:
//   - one or more complete ZIP parts: mydata~<ts>.zip, mydata~<ts>-2.zip
//   - index.html, html/*.html, json/*.json, memories/<date>_<mid>-main.jpg|mp4,
//     memories/<date>_<mid>-overlay.png and memories/memories.html
//   - every entry deflated, with data descriptors, local DOS times and a UT
//     extra field holding the exact UTC time, which equals the JSON "Date"
//   - "Download Link" and "Media Download Url" empty, "0.0, 0.0" for no location
//   - the filename date is the UTC date (a memory at 23:02 UTC in winter has
//     a local file time on the next day)
// On top of that it adds what the importer must cope with: an older record
// that still names its mid in a link, real locations, image and video
// overlays, a memory without a record, a record without a file, a decode bomb,
// a ZIP64 part, and HTML/script payloads in every text field.
//
// Usage: node tests/helpers/make-snapchat-fixture.mjs [--out DIR] [--extra N] [--folder]
//   --extra N   adds N more small photos (for load tests)
//   --folder    also writes the export unpacked, as loose files
// Writes DIR/zips/*.zip, DIR/expected.json and (with --folder) DIR/folder/.
// Needs ffmpeg with libx264.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeZip } from './zip-writer.mjs';
import { encodePng, oversizedPngHeader } from './png.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const outDir = path.resolve(option('--out', 'tests/fixtures/snapchat-export'));
const extra = Number(option('--extra', '0'));
const writeFolder = args.includes('--folder');
const EXPORT_ID = 'mydata~1778946903830';
const XSS = '<img src=x onerror="window.__xss=1">';

/** Snapchat mids look like UUIDs without the version bits. Deterministic here. */
function mid(index) {
  const hex = createHash('sha256').update(`twonly-fixture:${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The memories. `part` is the ZIP part the files land in. */
const MEMORIES = [
  { date: '2024-09-12 13:42:01', type: 'Video', size: [360, 640], part: 1 },
  { date: '2024-09-23 14:50:01', type: 'Image', size: [720, 1280], overlay: true, part: 1 },
  { date: '2024-09-23 15:24:55', type: 'Image', size: [1280, 720], part: 1 },
  { date: '2024-11-07 13:17:27', type: 'Video', size: [360, 640], overlay: true, part: 1 },
  { date: '2024-12-10 23:15:00', type: 'Image', size: [640, 480], part: 1, note: 'local file time is the next day' },
  { date: '2025-02-12 23:45:00', type: 'Video', size: [360, 640], part: 1, note: 'local file time is the next day' },
  { date: '2025-04-10 12:00:00', type: 'Image', size: [1080, 1920], location: [12.3456, 65.4321], part: 1 },
  { date: '2025-06-10 08:30:00', type: 'Image', size: [800, 600], location: [-23.4567, 123.4567], link: true, part: 1 },
  { date: '2025-06-02 09:15:00', type: 'Image', size: [800, 600], hostileLocation: true, part: 1 },
  { date: '2025-07-04 18:30:00', type: 'Image', size: [720, 1280], overlay: true, location: [40.7128, -74.006], part: 2 },
  { date: '2025-07-04 18:31:10', type: 'Image', size: [720, 1280], part: 2 },
  { date: '2025-08-15 12:00:00', type: 'Video', size: [640, 360], location: [48.1351, 11.582], part: 2 },
  { date: '2025-09-01 10:00:00', type: 'Image', size: [640, 640], noRecord: true, part: 2 },
  { date: '2025-09-02 10:00:00', type: 'Image', noFile: true },
  { date: '2025-09-03 10:00:00', type: 'Image', oversized: true, part: 2 },
];

function parseDate(text) {
  const [d, t] = text.split(' ');
  return Date.parse(`${d}T${t}Z`);
}

function ffmpeg(argv) {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    throw new Error(`ffmpeg failed (is ffmpeg with libx264 installed?): ${error.stderr || error.message}`);
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twonly-fixture-'));
const media = new Map();

function makeImage(index, [w, h], solid) {
  const file = path.join(work, `image-${index}.jpg`);
  const source = solid ? `color=c=0x22aa44:size=${w}x${h}:duration=1` : `testsrc2=size=${w}x${h}:duration=1,hue=h=${(index * 47) % 360}`;
  ffmpeg(['-f', 'lavfi', '-i', source, '-frames:v', '1', '-q:v', '4', '-bitexact', file]);
  return fs.readFileSync(file);
}

function makeVideo(index, [w, h]) {
  const file = path.join(work, `video-${index}.mp4`);
  ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=30:duration=2,hue=h=${(index * 71) % 360}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-threads', '1',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart', '-bitexact', file,
  ]);
  return fs.readFileSync(file);
}

/** Opaque magenta over the top quarter, transparent below; half the image size. */
function makeOverlay([w, h]) {
  const ow = Math.round(w / 2);
  const oh = Math.round(h / 2);
  return encodePng(ow, oh, (x, y) => (y < oh / 4 ? [255, 0, 255, 255] : [0, 0, 0, 0]));
}

const memories = MEMORIES.map((m, index) => ({ ...m, index, mid: mid(index), time: parseDate(m.date) }));
for (let i = 0; i < extra; i++) {
  const time = Date.UTC(2023, 0, 1) + i * 37 * 60 * 1000;
  memories.push({
    index: MEMORIES.length + i,
    mid: mid(MEMORIES.length + i),
    time,
    date: new Date(time).toISOString().replace('T', ' ').slice(0, 19),
    type: 'Image',
    size: [320, 240],
    part: 1 + (i % 2),
    bulk: true,
  });
}

let bulkJpeg = null;
for (const m of memories) {
  if (m.noFile) continue;
  if (m.oversized) {
    media.set(m.mid, { main: oversizedPngHeader(20_000, 20_000), ext: 'jpg' });
  } else if (m.type === 'Video') {
    media.set(m.mid, { main: makeVideo(m.index, m.size), ext: 'mp4', overlay: m.overlay ? makeOverlay(m.size) : null });
  } else if (m.bulk) {
    bulkJpeg = bulkJpeg || makeImage(m.index, m.size, false);
    media.set(m.mid, { main: bulkJpeg, ext: 'jpg' });
  } else {
    media.set(m.mid, { main: makeImage(m.index, m.size, m.overlay), ext: 'jpg', overlay: m.overlay ? makeOverlay(m.size) : null });
  }
}

// json/memories_history.json, newest first as in the real export.
const records = [];
for (const m of [...memories].sort((a, b) => b.time - a.time)) {
  if (m.noRecord) continue;
  const location = m.hostileLocation
    ? `Latitude, Longitude: ${XSS}`
    : m.location ? `Latitude, Longitude: ${m.location[0]}, ${m.location[1]}` : 'Latitude, Longitude: 0.0, 0.0';
  const link = m.link
    ? `https://app.snapchat.com/dmd/memories?uid=00000000-0000-0000-0000-000000000000&sid=${m.mid.toUpperCase()}&mid=${m.mid}&ts=${m.time}&sig=${XSS}`
    : '';
  records.push({ Date: `${m.date} UTC`, 'Media Type': m.type, Location: location, 'Download Link': link, 'Media Download Url': link });
}
// A record no adapter may accept.
records.push({ Date: '2025-05-05 05:05:05 UTC', 'Media Type': `<script>window.__xss=1</script>`, Location: XSS, 'Download Link': XSS, 'Media Download Url': '' });
const historyJson = Buffer.from(JSON.stringify({ 'Saved Media': records }, null, 2));

const html = (title) => Buffer.from(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title><script>window.__xss=1</script></head><body><h1>${title}</h1>${XSS}</body></html>`);
const exportTime = Date.UTC(2026, 4, 16, 15, 55, 3);

const parts = new Map([[1, []], [2, []]]);
parts.get(1).push(
  { path: 'index.html', data: html('My Data'), mtime: exportTime },
  { path: 'html/memories_history.html', data: html('Memories'), mtime: exportTime },
  { path: 'html/faq.html', data: html('FAQ'), mtime: exportTime },
  { path: 'json/memories_history.json', data: historyJson, mtime: exportTime },
  { path: 'json/chat_history.json', data: Buffer.from('{}'), mtime: exportTime },
);
for (const m of memories) {
  const file = media.get(m.mid);
  if (!file) continue;
  const day = new Date(m.time).toISOString().slice(0, 10);
  const list = parts.get(m.part);
  list.push({ path: `memories/${day}_${m.mid}-main.${file.ext}`, data: file.main, mtime: m.time });
  if (file.overlay) list.push({ path: `memories/${day}_${m.mid}-overlay.png`, data: file.overlay, mtime: m.time });
}
parts.get(2).push({ path: 'memories/memories.html', data: html('Memories'), mtime: exportTime });

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'zips'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'zips', `${EXPORT_ID}.zip`), writeZip(parts.get(1)));
// The second part uses ZIP64 records, as parts over 4 GB do.
fs.writeFileSync(path.join(outDir, 'zips', `${EXPORT_ID}-2.zip`), writeZip(parts.get(2), { zip64: true }));

if (writeFolder) {
  for (const list of parts.values()) {
    for (const entry of list) {
      const target = path.join(outDir, 'folder', EXPORT_ID, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.data);
      fs.utimesSync(target, entry.mtime / 1000, entry.mtime / 1000);
    }
  }
}

// What a correct import produces.
const expected = {
  source: 'snapchat',
  exportId: EXPORT_ID,
  items: memories.filter((m) => !m.noFile).map((m) => ({
    sourceItemId: m.mid,
    kind: m.type === 'Video' ? 'video' : 'image',
    createdAt: m.noRecord ? Math.floor((Math.floor(m.time / 86_400_000) * 86_400_000 + 43_200_000) / 1000) : Math.floor(m.time / 1000),
    dateApproximate: Boolean(m.noRecord),
    location: m.location ? { latitude: m.location[0], longitude: m.location[1] } : null,
    hasOverlay: Boolean(m.overlay),
    overlayComposited: Boolean(m.overlay) && m.type === 'Image',
    imported: !m.oversized,
    skipReason: m.oversized ? 'image too large' : null,
    size: m.size || null,
    mainBytes: media.get(m.mid).main.length,
  })),
  missingFiles: memories.filter((m) => m.noFile).length,
  invalidRecords: 1,
  overlayVideos: memories.filter((m) => m.overlay && m.type === 'Video').length,
};
fs.writeFileSync(path.join(outDir, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
fs.rmSync(work, { recursive: true, force: true });

const imported = expected.items.filter((item) => item.imported).length;
console.log(`Wrote ${outDir}: ${expected.items.length} memories in 2 ZIP parts (${imported} importable)`);
