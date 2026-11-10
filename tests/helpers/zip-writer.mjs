// Writes ZIP archives the way Snapchat's "My Data" export does: every entry
// deflated (media included), a data descriptor after each entry (bit 3), DOS
// times in local wall-clock time and an extended-timestamp (UT, 0x5455)
// field with the exact UTC time. `zip64: true` writes ZIP64 records even for
// small archives, so the reader's ZIP64 path runs in the tests.

import zlib from 'node:zlib';

/** Europe/Berlin offset in minutes: CET +60, CEST +120 (EU rules). */
export function berlinOffsetMinutes(time) {
  const d = new Date(time);
  const year = d.getUTCFullYear();
  const lastSunday = (month) => {
    const last = new Date(Date.UTC(year, month + 1, 0, 1, 0, 0));
    last.setUTCDate(last.getUTCDate() - last.getUTCDay());
    return last.getTime();
  };
  const start = lastSunday(2); // last Sunday of March, 01:00 UTC
  const end = lastSunday(9); // last Sunday of October, 01:00 UTC
  return time >= start && time < end ? 120 : 60;
}

function dosTime(time, offsetMinutes) {
  const d = new Date(time + offsetMinutes * 60_000);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const clock = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  return { date, clock };
}

/**
 * @param entries `[{path, data: Buffer, mtime: ms, method?: 'deflate'|'store'}]`
 * @param options `{zip64, offsetMinutes(time) => minutes, utExtra, comment}`
 */
export function writeZip(entries, { zip64 = false, offsetMinutes = berlinOffsetMinutes, utExtra = true, comment = '' } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  const push = (buffer) => {
    parts.push(buffer);
    offset += buffer.length;
  };

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const method = entry.method === 'store' ? 0 : 8;
    const compressed = method === 8 ? zlib.deflateRawSync(entry.data, { level: 6 }) : entry.data;
    const crc = zlib.crc32(entry.data) >>> 0;
    const { date, clock } = dosTime(entry.mtime, offsetMinutes(entry.mtime));
    const flags = 0x0008 | 0x0800; // data descriptor, UTF-8 names
    const ut = Buffer.alloc(utExtra ? 9 : 0);
    if (utExtra) {
      ut.writeUInt16LE(0x5455, 0);
      ut.writeUInt16LE(5, 2);
      ut.writeUInt8(1, 4);
      ut.writeUInt32LE(Math.floor(entry.mtime / 1000), 5);
    }
    const localOffset = offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(clock, 10);
    local.writeUInt16LE(date, 12);
    // crc and sizes follow in the data descriptor.
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(ut.length, 28);
    push(local);
    push(name);
    push(ut);
    push(compressed);

    const descriptor = Buffer.alloc(zip64 ? 24 : 16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    if (zip64) {
      descriptor.writeBigUInt64LE(BigInt(compressed.length), 8);
      descriptor.writeBigUInt64LE(BigInt(entry.data.length), 16);
    } else {
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(entry.data.length, 12);
    }
    push(descriptor);

    let extra = ut;
    if (zip64) {
      const z = Buffer.alloc(4 + 24);
      z.writeUInt16LE(0x0001, 0);
      z.writeUInt16LE(24, 2);
      z.writeBigUInt64LE(BigInt(entry.data.length), 4);
      z.writeBigUInt64LE(BigInt(compressed.length), 12);
      z.writeBigUInt64LE(BigInt(localOffset), 20);
      extra = Buffer.concat([ut, z]);
    }
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4); // made by MS-DOS
    header.writeUInt16LE(zip64 ? 45 : 20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(clock, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 20);
    header.writeUInt32LE(zip64 ? 0xffffffff : entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(zip64 ? 0xffffffff : localOffset, 42);
    central.push(header, name, extra);
  }

  const cdOffset = offset;
  for (const buffer of central) push(buffer);
  const cdSize = offset - cdOffset;
  const commentBytes = Buffer.from(comment, 'utf8');

  if (zip64) {
    const recordOffset = offset;
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(cdSize), 40);
    record.writeBigUInt64LE(BigInt(cdOffset), 48);
    push(record);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(recordOffset), 8);
    locator.writeUInt32LE(1, 16);
    push(locator);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cdSize, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cdOffset, 16);
  eocd.writeUInt16LE(commentBytes.length, 20);
  push(eocd);
  push(commentBytes);
  return Buffer.concat(parts);
}
