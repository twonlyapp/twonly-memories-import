// Image formats: dimensions from a file header (before any decode) and EXIF
// for the WebP files this page writes. Pure byte handling, no browser APIs.

import { LIMITS } from './util.js';
import { t } from './i18n.js';

// ---------------------------------------------------------------------------
// Image header
// ---------------------------------------------------------------------------

// Image dimensions from the first bytes of a file, before any decode, so an
// oversized image is skipped instead of allocating its pixels.

export class ImageLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageLimitError';
  }
}

/** Bytes to read from the start of a file to find its dimensions. */
export const HEADER_BYTES = 256 * 1024;

export function imageDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: signature, then IHDR.
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452) {
    return { type: 'png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: walk the markers to the first SOFn.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker === 0xff) {
        offset++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = view.getUint16(offset + 2);
      if (length < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (offset + 9 > bytes.length) return null;
        return { type: 'jpeg', height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
    return null;
  }
  // WebP.
  if (bytes.length >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const id = String.fromCharCode(...bytes.subarray(12, 16));
    if (id === 'VP8X') return { type: 'webp', width: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1, height: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1 };
    if (id === 'VP8 ') return { type: 'webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (id === 'VP8L') {
      const bits = view.getUint32(21, true);
      return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/** Throws unless the image is within the per-dimension and pixel limits. */
export function checkImageSize(dimensions, limits = LIMITS) {
  if (!dimensions) throw new ImageLimitError(t('imageUnsupported'));
  const { width, height } = dimensions;
  if (!(width > 0 && height > 0)) throw new ImageLimitError(t('imageNoSize'));
  if (width > limits.maxImageDimension || height > limits.maxImageDimension || width * height > limits.maxImagePixels) {
    throw new ImageLimitError(t('imageTooLarge', width, height));
  }
  return dimensions;
}

// ---------------------------------------------------------------------------
// EXIF for WebP
// ---------------------------------------------------------------------------

// EXIF for WebP, in the same TIFF layout as the app's `media_exif.rs::tiff_block`
// (little endian, IFD0 with DateTime and pointers, an Exif IFD, a GPS IFD).
// One addition: OffsetTimeOriginal "+00:00", since the times are UTC.

const TAG_DATE_TIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_DATE_TIME_DIGITIZED = 0x9004;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_GPS_VERSION = 0x0000;
const TAG_GPS_LATITUDE_REF = 0x0001;
const TAG_GPS_LATITUDE = 0x0002;
const TAG_GPS_LONGITUDE_REF = 0x0003;
const TAG_GPS_LONGITUDE = 0x0004;
const TYPE_BYTE = 1;
const TYPE_ASCII = 2;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;
const FLAG_EXIF = 0b0000_1000;
const FLAG_ALPHA = 0b0001_0000;

const ascii = (text) => {
  const out = new Uint8Array(text.length + 1);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
};

const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};

function pad(n) {
  return String(n).padStart(2, '0');
}

/** `YYYY:MM:DD HH:MM:SS` in UTC. */
export function exifDate(time) {
  const d = new Date(time);
  return `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function rational(value) {
  const DENOMINATOR = 1_000_000;
  const numerator = Math.min(0xffffffff, Math.max(0, Math.round(value * DENOMINATOR)));
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, numerator, true);
  view.setUint32(4, DENOMINATOR, true);
  return out;
}

function coordinate(value) {
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutesFull = (abs - degrees) * 60;
  const minutes = Math.floor(minutesFull);
  const seconds = (minutesFull - minutes) * 60;
  const out = new Uint8Array(24);
  out.set(rational(degrees), 0);
  out.set(rational(minutes), 8);
  out.set(rational(seconds), 16);
  return out;
}

function componentCount(kind, data) {
  if (kind === TYPE_LONG) return data.length / 4;
  if (kind === TYPE_RATIONAL) return data.length / 8;
  return data.length;
}

function ifdSize(entries, extra) {
  if (entries.length === 0 && extra === 0) return 0;
  let values = 0;
  for (const [, , data] of entries) if (data.length > 4) values += data.length + (data.length & 1);
  return 2 + (entries.length + extra) * 12 + 4 + values;
}

function serializeIfd(entries, start) {
  if (entries.length === 0) return new Uint8Array(0);
  const size = ifdSize(entries, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint16(0, entries.length, true);
  let valueOffset = start + 2 + entries.length * 12 + 4;
  let valueCursor = 2 + entries.length * 12 + 4;
  entries.forEach(([tag, kind, data], i) => {
    const at = 2 + i * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, kind, true);
    view.setUint32(at + 4, componentCount(kind, data), true);
    if (data.length <= 4) {
      out.set(data, at + 8);
    } else {
      view.setUint32(at + 8, valueOffset, true);
      out.set(data, valueCursor);
      const padded = data.length + (data.length & 1);
      valueCursor += padded;
      valueOffset += padded;
    }
  });
  view.setUint32(2 + entries.length * 12, 0, true);
  return out;
}

/** The TIFF block for an EXIF chunk. `metadata = {createdAt, location}`. */
export function tiffBlock({ createdAt = null, location = null }) {
  const ifd0 = [];
  const exif = [];
  const gps = [];
  if (createdAt !== null && createdAt !== undefined) {
    const text = ascii(exifDate(createdAt));
    ifd0.push([TAG_DATE_TIME, TYPE_ASCII, text]);
    exif.push([TAG_DATE_TIME_ORIGINAL, TYPE_ASCII, text]);
    exif.push([TAG_DATE_TIME_DIGITIZED, TYPE_ASCII, text]);
    exif.push([TAG_OFFSET_TIME_ORIGINAL, TYPE_ASCII, ascii('+00:00')]);
  }
  if (location && Number.isFinite(location.latitude) && Number.isFinite(location.longitude)) {
    gps.push([TAG_GPS_VERSION, TYPE_BYTE, Uint8Array.of(2, 3, 0, 0)]);
    gps.push([TAG_GPS_LATITUDE_REF, TYPE_ASCII, ascii(location.latitude < 0 ? 'S' : 'N')]);
    gps.push([TAG_GPS_LATITUDE, TYPE_RATIONAL, coordinate(location.latitude)]);
    gps.push([TAG_GPS_LONGITUDE_REF, TYPE_ASCII, ascii(location.longitude < 0 ? 'W' : 'E')]);
    gps.push([TAG_GPS_LONGITUDE, TYPE_RATIONAL, coordinate(location.longitude)]);
  }
  const pointers = (exif.length ? 1 : 0) + (gps.length ? 1 : 0);
  const exifOffset = 8 + ifdSize(ifd0, pointers);
  const gpsOffset = exifOffset + ifdSize(exif, 0);
  if (exif.length) ifd0.push([TAG_EXIF_IFD, TYPE_LONG, u32(exifOffset)]);
  if (gps.length) ifd0.push([TAG_GPS_IFD, TYPE_LONG, u32(gpsOffset)]);
  const parts = [Uint8Array.of(0x49, 0x49, 0x2a, 0x00), u32(8), serializeIfd(ifd0, 8), serializeIfd(exif, exifOffset), serializeIfd(gps, gpsOffset)];
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export class WebpError extends Error {}

/** RIFF chunks of a WebP file. */
export function webpChunks(webp) {
  if (webp.length < 12 || String.fromCharCode(...webp.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...webp.subarray(8, 12)) !== 'WEBP') {
    throw new WebpError('not a WebP file');
  }
  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= webp.length) {
    const id = String.fromCharCode(...webp.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > webp.length) throw new WebpError('WebP chunk runs past the end of the file');
    chunks.push({ id, payload: webp.subarray(start, end) });
    offset = end + (size & 1);
  }
  return chunks;
}

export function webpDimensions(chunks) {
  for (const { id, payload } of chunks) {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    if (id === 'VP8X' && payload.length >= 10) {
      return { width: (payload[4] | (payload[5] << 8) | (payload[6] << 16)) + 1, height: (payload[7] | (payload[8] << 8) | (payload[9] << 16)) + 1 };
    }
    if (id === 'VP8 ' && payload.length >= 10) {
      return { width: view.getUint16(6, true) & 0x3fff, height: view.getUint16(8, true) & 0x3fff };
    }
    if (id === 'VP8L' && payload.length >= 5) {
      const bits = view.getUint32(1, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  throw new WebpError('WebP file has no bitstream chunk');
}

function hasAlpha({ id, payload }) {
  if (id === 'ALPH') return true;
  if (id === 'VP8L' && payload.length >= 5) {
    const bits = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(1, true);
    return ((bits >>> 28) & 1) === 1;
  }
  return false;
}

function writeChunk(parts, id, payload) {
  const header = new Uint8Array(8);
  for (let i = 0; i < 4; i++) header[i] = id.charCodeAt(i);
  new DataView(header.buffer).setUint32(4, payload.length, true);
  parts.push(header, payload);
  if (payload.length & 1) parts.push(new Uint8Array(1));
}

/**
 * Returns the WebP with an `EXIF` chunk, converting a simple file to the
 * extended layout. An existing VP8X or EXIF chunk is replaced, not appended.
 */
export function withExif(webp, metadata) {
  const chunks = webpChunks(webp);
  const { width, height } = webpDimensions(chunks);
  let flags = (chunks.find((c) => c.id === 'VP8X')?.payload[0] ?? 0) | FLAG_EXIF;
  if (chunks.some(hasAlpha)) flags |= FLAG_ALPHA;
  const vp8x = new Uint8Array(10);
  vp8x[0] = flags;
  vp8x[4] = (width - 1) & 0xff;
  vp8x[5] = ((width - 1) >> 8) & 0xff;
  vp8x[6] = ((width - 1) >> 16) & 0xff;
  vp8x[7] = (height - 1) & 0xff;
  vp8x[8] = ((height - 1) >> 8) & 0xff;
  vp8x[9] = ((height - 1) >> 16) & 0xff;
  const parts = [];
  writeChunk(parts, 'VP8X', vp8x);
  for (const chunk of chunks) if (chunk.id !== 'VP8X' && chunk.id !== 'EXIF') writeChunk(parts, chunk.id, chunk.payload);
  writeChunk(parts, 'EXIF', tiffBlock(metadata));
  let bodyLength = 0;
  for (const part of parts) bodyLength += part.length;
  const out = new Uint8Array(12 + bodyLength);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(out.buffer).setUint32(4, bodyLength + 4, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  let offset = 12;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Reads back the fields this module writes. Used by tests. */
export function readExif(webp) {
  const chunk = webpChunks(webp).find((c) => c.id === 'EXIF');
  if (!chunk) return null;
  const tiff = chunk.payload;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(0, true) !== 0x4949) throw new WebpError('unexpected byte order');
  const readIfd = (offset) => {
    const entries = new Map();
    const count = view.getUint16(offset, true);
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      const tag = view.getUint16(at, true);
      const kind = view.getUint16(at + 2, true);
      const n = view.getUint32(at + 4, true);
      const size = kind === TYPE_RATIONAL ? n * 8 : kind === TYPE_LONG ? n * 4 : n;
      const dataAt = size <= 4 ? at + 8 : view.getUint32(at + 8, true);
      entries.set(tag, { kind, data: tiff.subarray(dataAt, dataAt + size), value: view.getUint32(at + 8, true) });
    }
    return entries;
  };
  const text = (e) => (e ? String.fromCharCode(...e.data).replace(/\0+$/, '') : null);
  const rationals = (e) => {
    const out = [];
    for (let i = 0; i < e.data.length; i += 8) {
      const d = new DataView(e.data.buffer, e.data.byteOffset + i, 8);
      out.push(d.getUint32(0, true) / d.getUint32(4, true));
    }
    return out;
  };
  const ifd0 = readIfd(view.getUint32(4, true));
  const exif = ifd0.has(TAG_EXIF_IFD) ? readIfd(ifd0.get(TAG_EXIF_IFD).value) : new Map();
  const gps = ifd0.has(TAG_GPS_IFD) ? readIfd(ifd0.get(TAG_GPS_IFD).value) : new Map();
  let location = null;
  if (gps.has(TAG_GPS_LATITUDE)) {
    const [ld, lm, ls] = rationals(gps.get(TAG_GPS_LATITUDE));
    const [od, om, os] = rationals(gps.get(TAG_GPS_LONGITUDE));
    location = {
      latitude: (ld + lm / 60 + ls / 3600) * (text(gps.get(TAG_GPS_LATITUDE_REF)) === 'S' ? -1 : 1),
      longitude: (od + om / 60 + os / 3600) * (text(gps.get(TAG_GPS_LONGITUDE_REF)) === 'W' ? -1 : 1),
    };
  }
  return {
    dateTime: text(ifd0.get(TAG_DATE_TIME)),
    dateTimeOriginal: text(exif.get(TAG_DATE_TIME_ORIGINAL)),
    offsetTimeOriginal: text(exif.get(TAG_OFFSET_TIME_ORIGINAL)),
    location,
  };
}
