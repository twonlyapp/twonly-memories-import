#!/usr/bin/env node
// Generates a large synthetic Snapchat "My Data" export for load tests: one
// ZIP64 archive (20 GiB by default) full of distinct photos and videos.
//
// Same layout and ZIP conventions as make-snapchat-fixture.mjs (deflated
// entries, data descriptors, local DOS times plus a UT extra field holding
// the record's UTC time, empty download links), but streamed to disk so the
// archive never has to fit in memory:
//   - photos: 1080x1920 noisy JPEGs (~1.3 MB), each a distinct frame of
//     ffmpeg's testsrc2, whose on-screen clock shows the photo's number
//   - videos: 720x1280 15 fps H.264/AAC, 3–45 s at 14 Mbit/s (~5–80 MB)
//   - about 8% of the memories have an overlay, about 40% a location
//   - entries past 4 GiB get ZIP64 offsets; json/memories_history.json is
//     written after the media, so the archive stops close to the target size
//
// Usage: node tests/helpers/make-large-snapchat-export.mjs [--gib N] [--out DIR] [--seed N]
// Writes DIR/mydata~<ts>.zip and DIR/summary.json. Needs ffmpeg with libx264
// and N GiB of free disk space plus some slack.

// More threads for parallel deflate; read when the threadpool first starts.
process.env.UV_THREADPOOL_SIZE ||= '6';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { berlinOffsetMinutes } from './zip-writer.mjs';
import { encodePng } from './png.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const gib = Number(option('--gib', '20'));
const targetBytes = Math.round(gib * 2 ** 30);
const outDir = path.resolve(option('--out', 'tests/fixtures/large-export'));
const seed = Number(option('--seed', '1'));
if (!(targetBytes > 0) || !Number.isInteger(seed)) throw new Error('--gib must be positive and --seed an integer');

const EXPORT_ID = 'mydata~1793577600000';
const zipPath = path.join(outDir, `${EXPORT_ID}.zip`);
const partialPath = `${zipPath}.partial`;
const workDir = path.join(outDir, '.work');

const VIDEO_SHARE = 0.2;
const OVERLAY_SHARE = 0.08;
const LOCATION_SHARE = 0.4;
const VIDEO_SECONDS = [3, 45];
const VIDEO_BITRATE = 14_000_000;
const IMAGE_ESTIMATE = 1_350_000;
const VIDEO_CONCURRENCY = 4;
const LOOKAHEAD = 32;
const FIRST = Date.UTC(2019, 0, 1);
const LAST = Date.UTC(2026, 9, 31);
const DEFLATE_LEVEL = 1;

const deflateRaw = promisify(zlib.deflateRaw);

function mulberry32(state) {
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(seed);

function makeMid() {
  let hex = '';
  for (let i = 0; i < 32; i++) hex += Math.floor(random() * 16).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function run(command, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr}`))));
  });
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * Length of the first complete baseline JPEG in `buf`, or 0 if it is not
 * complete yet. `state` remembers how far the scan got between calls.
 */
function jpegLength(buf, state) {
  if (buf.length < 4) return 0;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('ffmpeg did not produce a JPEG stream');
  let p = state.pos || 2;
  while (!state.scan) {
    if (p + 4 > buf.length) {
      state.pos = p;
      return 0;
    }
    if (buf[p] !== 0xff) throw new Error('malformed JPEG header from ffmpeg');
    const marker = buf[p + 1];
    const end = p + 2 + buf.readUInt16BE(p + 2);
    if (end > buf.length) {
      state.pos = p;
      return 0;
    }
    p = end;
    if (marker === 0xda) state.scan = true;
  }
  for (;;) {
    const ff = buf.indexOf(0xff, p);
    if (ff < 0 || ff + 1 >= buf.length) {
      state.pos = ff < 0 ? buf.length : ff;
      return 0;
    }
    const marker = buf[ff + 1];
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      p = ff + 2;
      continue;
    }
    if (marker !== 0xd9) throw new Error(`unexpected JPEG marker 0x${marker.toString(16)} from ffmpeg`);
    state.pos = 0;
    state.scan = false;
    return ff + 2;
  }
}

/** An endless stream of distinct 1080x1920 JPEGs from one ffmpeg process. */
class PhotoStream {
  constructor() {
    this.process = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=1,hue=h=t*37,noise=alls=25:allf=t',
      '-pix_fmt', 'yuvj420p', '-q:v', '2', '-f', 'image2pipe', '-c:v', 'mjpeg', '-',
    ], { stdio: ['ignore', 'pipe', 'ignore'] }); // stderr only reports the broken pipe on close
    this.chunks = this.process.stdout[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.state = {};
  }

  async next() {
    for (;;) {
      const length = jpegLength(this.buffer, this.state);
      if (length > 0) {
        const photo = Buffer.from(this.buffer.subarray(0, length));
        this.buffer = this.buffer.subarray(length);
        return photo;
      }
      const { value, done } = await this.chunks.next();
      if (done) throw new Error('ffmpeg stopped producing photos');
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, value]) : value;
    }
  }

  close() {
    this.process.stdout.destroy();
    this.process.kill();
  }
}

let freeVideoSlots = VIDEO_CONCURRENCY;
const videoWaiters = [];
async function withVideoSlot(task) {
  if (freeVideoSlots === 0) await new Promise((resolve) => videoWaiters.push(resolve));
  else freeVideoSlots--;
  try {
    return await task();
  } finally {
    const next = videoWaiters.shift();
    if (next) next();
    else freeVideoSlots++;
  }
}

async function makeVideo(item) {
  const file = path.join(workDir, `${item.mid}.mp4`);
  const hue = Math.floor(random() * 360);
  const frequency = 220 + Math.floor(random() * 660);
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    // 15 fps with heavier noise reaches the bitrate at ~40% less CPU than 30 fps.
    '-f', 'lavfi', '-i', `testsrc2=size=720x1280:rate=15:duration=${item.seconds},hue=h=t*20+${hue},noise=alls=20:allf=t`,
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${item.seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', String(VIDEO_BITRATE), '-maxrate', String(VIDEO_BITRATE),
    '-bufsize', String(VIDEO_BITRATE * 2), '-pix_fmt', 'yuv420p', '-threads', '4',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', file,
  ]);
  const data = fs.readFileSync(file);
  fs.rmSync(file);
  return data;
}

/** Opaque magenta band over the top quarter, transparent below; half the media size. */
function makeOverlay(width, height) {
  return encodePng(width, height, (x, y) => (y < height / 4 ? [255, 0, 255, 255] : [0, 0, 0, 0]));
}
const OVERLAYS = { image: makeOverlay(540, 960), video: makeOverlay(360, 640) };

// ---------------------------------------------------------------------------
// Streaming ZIP writer
// ---------------------------------------------------------------------------

const U32_MAX = 0xffffffff;

/**
 * Deflates on the libuv threadpool, so several entries compress at once while
 * ffmpeg runs. Incompressible media deflate at only ~30 MB/s per thread.
 */
async function prepare(data) {
  return { compressed: await deflateRaw(data, { level: DEFLATE_LEVEL }), crc: zlib.crc32(data) >>> 0, size: data.length };
}

function dosTime(time) {
  const d = new Date(time + berlinOffsetMinutes(time) * 60_000);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const clock = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  return { date, clock };
}

class ZipStream {
  constructor(file) {
    this.fd = fs.openSync(file, 'w');
    this.offset = 0;
    this.central = [];
  }

  write(buffer) {
    for (let done = 0; done < buffer.length;) done += fs.writeSync(this.fd, buffer, done, buffer.length - done);
    this.offset += buffer.length;
  }

  async add(entryPath, data, mtime) {
    this.addPrepared(entryPath, await prepare(data), mtime);
  }

  /** Writes an entry deflated beforehand by `prepare`. */
  addPrepared(entryPath, { compressed, crc, size }, mtime) {
    const name = Buffer.from(entryPath, 'utf8');
    const { date, clock } = dosTime(mtime);
    const flags = 0x0008 | 0x0800; // data descriptor, UTF-8 names
    const ut = Buffer.alloc(9);
    ut.writeUInt16LE(0x5455, 0);
    ut.writeUInt16LE(5, 2);
    ut.writeUInt8(1, 4);
    ut.writeUInt32LE(Math.floor(mtime / 1000), 5);
    const localOffset = this.offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(clock, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(ut.length, 28);
    this.write(Buffer.concat([local, name, ut]));
    this.write(compressed);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(size, 12);
    this.write(descriptor);

    // Only the offset can overflow 32 bits; entries stay far below 4 GiB.
    const zip64 = localOffset >= U32_MAX;
    let extra = ut;
    if (zip64) {
      const z = Buffer.alloc(12);
      z.writeUInt16LE(0x0001, 0);
      z.writeUInt16LE(8, 2);
      z.writeBigUInt64LE(BigInt(localOffset), 4);
      extra = Buffer.concat([ut, z]);
    }
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(zip64 ? 45 : 20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(clock, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt32LE(zip64 ? U32_MAX : localOffset, 42);
    this.central.push(Buffer.concat([header, name, extra]));
  }

  finish() {
    const count = this.central.length;
    const cdOffset = this.offset;
    for (const record of this.central) this.write(record);
    const cdSize = this.offset - cdOffset;
    if (cdOffset >= U32_MAX || count >= 0xffff) {
      const recordOffset = this.offset;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(cdSize), 40);
      record.writeBigUInt64LE(BigInt(cdOffset), 48);
      this.write(record);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(recordOffset), 8);
      locator.writeUInt32LE(1, 16);
      this.write(locator);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(Math.min(count, 0xffff), 8);
    eocd.writeUInt16LE(Math.min(count, 0xffff), 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(Math.min(cdOffset, U32_MAX), 16);
    this.write(eocd);
    fs.closeSync(this.fd);
    return this.offset;
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function planMemory() {
  const time = Math.floor((FIRST + random() * (LAST - FIRST)) / 1000) * 1000;
  const kind = random() < VIDEO_SHARE ? 'video' : 'image';
  const seconds = kind === 'video' ? VIDEO_SECONDS[0] + Math.floor(random() * (VIDEO_SECONDS[1] - VIDEO_SECONDS[0] + 1)) : 0;
  const location = random() < LOCATION_SHARE
    ? [Number((random() * 140 - 70).toFixed(6)), Number((random() * 360 - 180).toFixed(6))]
    : null;
  return {
    mid: makeMid(),
    time,
    kind,
    seconds,
    location,
    overlay: random() < OVERLAY_SHARE,
    estimate: kind === 'video' ? Math.round(seconds * (VIDEO_BITRATE + 96_000) / 8) : IMAGE_ESTIMATE,
  };
}

function utcText(time) {
  return new Date(time).toISOString().replace('T', ' ').slice(0, 19);
}

const html = (title) => Buffer.from(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`);

function formatBytes(bytes) {
  return `${(bytes / 2 ** 30).toFixed(2)} GiB`;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const { bavail, bsize } = fs.statfsSync(outDir);
  const free = bavail * bsize;
  if (free < targetBytes + 4 * 2 ** 30) {
    throw new Error(`Only ${formatBytes(free)} free in ${outDir}; need ${formatBytes(targetBytes)} plus 4 GiB slack`);
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.rmSync(zipPath, { force: true });

  const started = Date.now();
  const zip = new ZipStream(partialPath);
  const photos = new PhotoStream();
  const records = [];
  const counts = { images: 0, videos: 0, overlays: 0, locations: 0, imageBytes: 0, videoBytes: 0 };
  const overlays = { image: await prepare(OVERLAYS.image), video: await prepare(OVERLAYS.video) };
  const queue = [];
  // Bytes written so far plus the estimates of what is queued.
  let projected = 0;
  let nextReport = 2 ** 30;
  // Photos come off one ffmpeg stream, so they are taken one after another.
  let photoTurn = Promise.resolve();

  try {
    for (;;) {
      while (queue.length < LOOKAHEAD && projected < targetBytes) {
        const item = planMemory();
        let media;
        if (item.kind === 'video') {
          media = withVideoSlot(() => makeVideo(item));
        } else {
          media = photoTurn.then(() => photos.next());
          photoTurn = media.catch(() => {});
        }
        item.prepared = media.then(prepare);
        item.prepared.catch(() => {}); // awaited below; avoids an unhandled rejection meanwhile
        queue.push(item);
        projected += item.estimate;
      }
      if (queue.length === 0) break;

      const item = queue.shift();
      const entry = await item.prepared;
      const before = zip.offset;
      const day = utcText(item.time).slice(0, 10);
      const extension = item.kind === 'video' ? 'mp4' : 'jpg';
      zip.addPrepared(`memories/${day}_${item.mid}-main.${extension}`, entry, item.time);
      if (item.overlay) {
        zip.addPrepared(`memories/${day}_${item.mid}-overlay.png`, overlays[item.kind], item.time);
        counts.overlays++;
      }
      projected += zip.offset - before - item.estimate;

      if (item.kind === 'video') {
        counts.videos++;
        counts.videoBytes += entry.size;
      } else {
        counts.images++;
        counts.imageBytes += entry.size;
      }
      if (item.location) counts.locations++;
      records.push({
        time: item.time,
        record: {
          Date: `${utcText(item.time)} UTC`,
          'Media Type': item.kind === 'video' ? 'Video' : 'Image',
          Location: item.location ? `Latitude, Longitude: ${item.location[0]}, ${item.location[1]}` : 'Latitude, Longitude: 0.0, 0.0',
          'Download Link': '',
          'Media Download Url': '',
        },
      });

      if (zip.offset >= nextReport) {
        const seconds = (Date.now() - started) / 1000;
        console.log(`${formatBytes(zip.offset)} / ${formatBytes(targetBytes)}  ${counts.images} photos, ${counts.videos} videos  (${Math.round(seconds)} s)`);
        nextReport += 2 ** 30;
      }
    }
  } finally {
    photos.close();
  }

  // Metadata after the media, newest first as in the real export.
  records.sort((a, b) => b.time - a.time);
  const exportTime = Date.UTC(2026, 10, 1, 15, 55, 3);
  const historyJson = Buffer.from(JSON.stringify({ 'Saved Media': records.map((r) => r.record) }, null, 2));
  await zip.add('index.html', html('My Data'), exportTime);
  await zip.add('html/memories_history.html', html('Memories'), exportTime);
  await zip.add('json/memories_history.json', historyJson, exportTime);
  await zip.add('json/chat_history.json', Buffer.from('{}'), exportTime);
  await zip.add('memories/memories.html', html('Memories'), exportTime);
  const size = zip.finish();
  fs.renameSync(partialPath, zipPath);
  fs.rmSync(workDir, { recursive: true, force: true });

  const summary = {
    zip: zipPath,
    bytes: size,
    memories: counts.images + counts.videos,
    ...counts,
    oldest: utcText(records[records.length - 1].time),
    newest: utcText(records[0].time),
    seed,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Wrote ${zipPath}: ${formatBytes(size)}, ${summary.memories} memories `
    + `(${counts.images} photos, ${counts.videos} videos, ${counts.overlays} overlays, ${counts.locations} with location) `
    + `in ${Math.round((Date.now() - started) / 1000)} s`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
