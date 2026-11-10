// ZIP reader over a Blob. Reads only the central directory up front and each
// entry on demand, so a 10 GB export part never has to fit in memory.
//
// Supports ZIP64 (parts over 4 GB or over 65,535 entries), stored entries as a
// zero-copy Blob slice and deflate through DecompressionStream('deflate-raw').
// Every structural value is validated before it is used: offsets must lie in
// the file, entries must not overlap, paths must be relative and unique.

import { LIMITS, utf8 } from './util.js';
import { t } from './i18n.js';

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;

async function readRange(blob, start, end) {
  if (start < 0 || end > blob.size || start > end) throw new ZipError(t('zipReadOutside'));
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

function safeNumber(big, what) {
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError(t('zipOutOfRange', what));
  return Number(big);
}

/**
 * Normalizes an entry path and refuses anything that could escape the export
 * or confuse lookups: absolute paths, drive letters, `..`, NUL and control
 * characters. Returns null for directories.
 */
export function normalizePath(raw, limits = LIMITS) {
  if (typeof raw !== 'string') throw new ZipError(t('zipInvalidPath'));
  if (utf8(raw).length > limits.maxPathBytes) throw new ZipError(t('zipPathTooLong'));
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new ZipError(t('zipPathControl'));
  let path = raw.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new ZipError(t('zipAbsolutePath'));
  const segments = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw new ZipError(t('zipTraversal'));
    segments.push(segment);
  }
  if (path.endsWith('/') || segments.length === 0) return null;
  return segments.join('/');
}

function dosDateTime(date, time) {
  const year = 1980 + (date >> 9);
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  const hour = time >> 11;
  const minute = (time >> 5) & 0x3f;
  const second = (time & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  // DOS times are local wall-clock time without a zone. Kept "naive": the
  // fields read as if they were UTC. The Snapchat adapter knows how to
  // compare this against real UTC timestamps.
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

async function findEndOfCentralDirectory(blob) {
  const tailStart = Math.max(0, blob.size - (22 + MAX_COMMENT));
  const tail = await readRange(blob, tailStart, blob.size);
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) !== SIG_EOCD) continue;
    const commentLength = tail.getUint16(i + 20, true);
    // The comment must reach exactly to the end of the file, or this is a
    // signature inside some other data.
    if (i + 22 + commentLength !== tail.byteLength) continue;
    return { offset: tailStart + i, view: new DataView(tail.buffer, i, 22) };
  }
  throw new ZipError(t('zipNotZip'));
}

/**
 * Lists the files in one ZIP archive. `blob` is a File or Blob. Returns the
 * entries as source files (see `sourceFile` below).
 */
export async function readZip(blob, { archiveName = blob.name || 'archive.zip', limits = LIMITS } = {}) {
  const eocd = await findEndOfCentralDirectory(blob);
  const v = eocd.view;
  if (v.getUint16(4, true) !== 0 || v.getUint16(6, true) !== 0) {
    throw new ZipError(t('zipMultiDisk'));
  }
  let count = v.getUint16(10, true);
  let cdSize = v.getUint32(12, true);
  let cdOffset = v.getUint32(16, true);
  let cdEnd = eocd.offset;

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    if (eocd.offset < 20) throw new ZipError(t('zipNoLocator'));
    const locator = await readRange(blob, eocd.offset - 20, eocd.offset);
    if (locator.getUint32(0, true) !== SIG_ZIP64_LOCATOR) throw new ZipError(t('zipNoLocator'));
    const recordOffset = safeNumber(locator.getBigUint64(8, true), 'ZIP64 record offset');
    if (recordOffset + 56 > eocd.offset - 20) throw new ZipError(t('zipRecordOutside'));
    const record = await readRange(blob, recordOffset, recordOffset + 56);
    if (record.getUint32(0, true) !== SIG_ZIP64_EOCD) throw new ZipError(t('zipInvalidRecord'));
    count = safeNumber(record.getBigUint64(32, true), 'entry count');
    cdSize = safeNumber(record.getBigUint64(40, true), 'central directory size');
    cdOffset = safeNumber(record.getBigUint64(48, true), 'central directory offset');
    cdEnd = recordOffset;
  }

  if (count > limits.maxEntries) throw new ZipError(t('zipTooManyEntries'));
  if (cdSize > limits.maxCentralDirectoryBytes) throw new ZipError(t('zipDirectoryTooLarge'));
  if (cdOffset + cdSize > cdEnd) throw new ZipError(t('zipDirectoryOutside'));

  // Read the directory in pieces; sizes from the archive never drive one
  // big allocation.
  const CHUNK = 1024 * 1024;
  let buffer = new Uint8Array(0);
  let bufferStart = cdOffset;
  let readUpTo = cdOffset;
  const cdStop = cdOffset + cdSize;
  const ensure = async (absolute, length) => {
    while (absolute + length > bufferStart + buffer.length) {
      if (readUpTo >= cdStop) throw new ZipError(t('zipDirectoryTruncated'));
      const next = Math.min(cdStop, readUpTo + CHUNK);
      const chunk = new Uint8Array(await blob.slice(readUpTo, next).arrayBuffer());
      const keepFrom = absolute - bufferStart;
      const merged = new Uint8Array(buffer.length - keepFrom + chunk.length);
      merged.set(buffer.subarray(keepFrom));
      merged.set(chunk, buffer.length - keepFrom);
      buffer = merged;
      bufferStart = absolute;
      readUpTo = next;
    }
    return new DataView(buffer.buffer, buffer.byteOffset + (absolute - bufferStart), length);
  };

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const entries = [];
  const seen = new Set();
  let position = cdOffset;
  for (let index = 0; index < count; index++) {
    const header = await ensure(position, 46);
    if (header.getUint32(0, true) !== SIG_CENTRAL) throw new ZipError(t('zipInvalidEntry'));
    const flags = header.getUint16(8, true);
    const method = header.getUint16(10, true);
    const time = header.getUint16(12, true);
    const date = header.getUint16(14, true);
    const crc = header.getUint32(16, true);
    let compressedSize = header.getUint32(20, true);
    let size = header.getUint32(24, true);
    const nameLength = header.getUint16(28, true);
    const extraLength = header.getUint16(30, true);
    const commentLength = header.getUint16(32, true);
    let disk = header.getUint16(34, true);
    let localOffset = header.getUint32(42, true);
    let utcMtime = null;
    const variable = await ensure(position + 46, nameLength + extraLength + commentLength);
    const nameBytes = new Uint8Array(variable.buffer, variable.byteOffset, nameLength);
    const extra = new DataView(variable.buffer, variable.byteOffset + nameLength, extraLength);

    // ZIP64 extended information: only the fields saturated in the header
    // are present, in this order.
    for (let p = 0; p + 4 <= extraLength;) {
      const id = extra.getUint16(p, true);
      const length = extra.getUint16(p + 2, true);
      if (p + 4 + length > extraLength) throw new ZipError(t('zipInvalidExtra'));
      if (id === 0x5455 && length >= 5 && (extra.getUint8(p + 4) & 1)) {
        // Extended timestamp: the exact modification time in UTC seconds.
        utcMtime = extra.getUint32(p + 5, true) * 1000;
      }
      if (id === 0x0001) {
        let q = p + 4;
        const take = (what) => {
          if (q + 8 > p + 4 + length) throw new ZipError(t('zipTruncatedExtra'));
          const value = safeNumber(extra.getBigUint64(q, true), what);
          q += 8;
          return value;
        };
        if (size === 0xffffffff) size = take('entry size');
        if (compressedSize === 0xffffffff) compressedSize = take('compressed size');
        if (localOffset === 0xffffffff) localOffset = take('entry offset');
        if (disk === 0xffff) {
          if (q + 4 > p + 4 + length) throw new ZipError(t('zipTruncatedExtra'));
          disk = extra.getUint32(q, true);
        }
      }
      p += 4 + length;
    }
    position += 46 + nameLength + extraLength + commentLength;

    const rawName = decoder.decode(nameBytes);
    const path = normalizePath(rawName, limits);
    if (path === null) continue;
    if (seen.has(path)) throw new ZipError(t('zipDuplicate', path));
    seen.add(path);
    if (disk !== 0) throw new ZipError(t('zipMultiDisk'));
    if (localOffset + 30 > cdOffset) throw new ZipError(t('zipEntryOffset'));
    entries.push({
      path,
      rawNameBytes: nameBytes.slice(),
      flags,
      method,
      crc,
      compressedSize,
      size,
      localOffset,
      mtime: dosDateTime(date, time),
      utcMtime,
      encrypted: (flags & 0x0001) !== 0,
    });
  }

  // Entries must not overlap: each needs at least its fixed local header and
  // its compressed bytes before the next one (or the directory) starts.
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 0; i < byOffset.length; i++) {
    const entry = byOffset[i];
    const boundary = i + 1 < byOffset.length ? byOffset[i + 1].localOffset : cdOffset;
    if (entry.localOffset + 30 + entry.compressedSize > boundary) {
      throw new ZipError(t('zipOverlapping', entry.path));
    }
    entry.boundary = boundary;
  }

  return entries.map((entry) => sourceFile({
    path: entry.path,
    size: entry.size,
    mtimeNaive: entry.mtime,
    mtimeEpoch: entry.utcMtime,
    archive: archiveName,
    supported: !entry.encrypted && (entry.method === 0 || entry.method === 8),
    open: (maxBytes) => openEntry(blob, entry, maxBytes),
  }));
}

async function openEntry(blob, entry, maxBytes) {
  if (entry.encrypted) throw new ZipError(t('zipEncrypted'));
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError(t('zipCompression'));
  const local = await readRange(blob, entry.localOffset, entry.localOffset + 30);
  if (local.getUint32(0, true) !== SIG_LOCAL) throw new ZipError(t('zipInvalidLocal'));
  const method = local.getUint16(8, true);
  const nameLength = local.getUint16(26, true);
  const extraLength = local.getUint16(28, true);
  if (method !== entry.method) throw new ZipError(t('zipLocalMismatch'));
  if (nameLength !== entry.rawNameBytes.length) throw new ZipError(t('zipLocalMismatch'));
  const localName = new Uint8Array(
    await blob.slice(entry.localOffset + 30, entry.localOffset + 30 + nameLength).arrayBuffer(),
  );
  for (let i = 0; i < nameLength; i++) {
    if (localName[i] !== entry.rawNameBytes[i]) throw new ZipError(t('zipLocalMismatch'));
  }
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > entry.boundary) throw new ZipError(t('zipDataOverlaps'));

  if (entry.method === 0) {
    if (entry.compressedSize > maxBytes) throw new ZipError(t('zipEntryTooLarge'));
    return blob.slice(dataStart, dataEnd);
  }
  return inflate(blob.slice(dataStart, dataEnd), maxBytes, entry.crc);
}

/**
 * Inflates raw deflate data with a hard output bound. The size from the
 * archive is not trusted: decompression stops as soon as the output passes
 * `maxBytes`, before the oversized buffer is collected.
 */
export async function inflate(compressed, maxBytes, expectedCrc = null) {
  const reader = compressed.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  let crc = expectedCrc === null ? null : 0xffffffff;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new ZipError(t('zipEntryTooLarge'));
      if (crc !== null) crc = crc32Update(crc, value);
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    if (error instanceof ZipError) throw error;
    throw new ZipError(t('zipCorrupt'));
  }
  if (crc !== null && ((crc ^ 0xffffffff) >>> 0) !== expectedCrc) throw new ZipError(t('zipChecksum'));
  return new Blob(chunks);
}

let crcTable = null;
export function crc32Update(crc, bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

export function crc32(bytes) {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

/**
 * The one shape adapters see, for ZIP entries and loose files alike.
 * `mtimeNaive` is a wall-clock time read as UTC (ZIP), `mtimeEpoch` a real
 * instant (a loose file's lastModified). Either may be null.
 */
export function sourceFile({ path, size, mtimeNaive, mtimeEpoch, archive, supported = true, open }) {
  const slash = path.lastIndexOf('/');
  return Object.freeze({
    path,
    name: path.slice(slash + 1),
    dir: slash < 0 ? '' : path.slice(0, slash),
    size,
    mtimeNaive,
    mtimeEpoch,
    archive,
    supported,
    open,
  });
}

/** A loose file from a folder selection (webkitRelativePath) or a drop. */
export function looseFile(file, relativePath, limits = LIMITS) {
  const path = normalizePath(relativePath || file.name, limits);
  if (path === null) return null;
  return sourceFile({
    path,
    size: file.size,
    mtimeNaive: null,
    mtimeEpoch: Number.isFinite(file.lastModified) ? file.lastModified : null,
    archive: null,
    open: async (maxBytes) => {
      if (file.size > maxBytes) throw new ZipError(t('zipFileTooLarge'));
      return file;
    },
  });
}

/**
 * Turns a selection (ZIP parts and/or loose files) into one list of source
 * files. Snapchat splits large exports into several complete ZIP files; a
 * path in two parts is accepted only when both copies have the same size.
 */
export async function collectSourceFiles(selection, { limits = LIMITS } = {}) {
  const files = new Map();
  const problems = [];
  let total = 0;
  const add = (file) => {
    const existing = files.get(file.path);
    if (existing) {
      if (existing.size !== file.size) problems.push({ path: file.path, reason: t('zipConflictingCopies') });
      return;
    }
    if (++total > limits.maxEntries) throw new ZipError(t('zipTooManyFiles'));
    files.set(file.path, file);
  };
  for (const { file, relativePath } of selection) {
    const name = (relativePath || file.name || '').toLowerCase();
    if (name.endsWith('.zip')) {
      try {
        for (const entry of await readZip(file, { archiveName: relativePath || file.name, limits })) add(entry);
      } catch (error) {
        if (!(error instanceof ZipError)) throw error;
        problems.push({ path: relativePath || file.name, reason: error.message });
      }
    } else {
      try {
        const loose = looseFile(file, relativePath, limits);
        if (loose) add(loose);
      } catch (error) {
        if (!(error instanceof ZipError)) throw error;
        problems.push({ path: relativePath || file.name, reason: error.message });
      }
    }
  }
  return { files: [...files.values()], problems };
}
