import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { readZip, collectSourceFiles, normalizePath, inflate, ZipError, crc32 } from '../../src/zip.js';
import { writeZip } from '../helpers/zip-writer.mjs';
import { LIMITS } from '../../src/util.js';
import { zipSelection } from '../helpers/fixture.mjs';

const blobOf = (buffer, name = 'test.zip') => Object.assign(new Blob([buffer]), { name });
const entry = (path, text, mtime = Date.UTC(2024, 10, 18, 23, 2, 20), method) => ({ path, data: Buffer.from(text), mtime, method });

test('reads names, sizes, times and contents of deflated and stored entries', async () => {
  const zip = writeZip([entry('a/one.txt', 'hello world'), entry('b.bin', 'stored bytes', undefined, 'store')]);
  const files = await readZip(blobOf(zip));
  assert.deepEqual(files.map((f) => f.path), ['a/one.txt', 'b.bin']);
  assert.equal(files[0].name, 'one.txt');
  assert.equal(files[0].dir, 'a');
  assert.equal(files[0].size, 11);
  // The UT field gives the exact UTC time; the DOS time is local (CET, +1 h).
  assert.equal(files[0].mtimeEpoch, Date.UTC(2024, 10, 18, 23, 2, 20));
  assert.equal(files[0].mtimeNaive, Date.UTC(2024, 10, 19, 0, 2, 20));
  assert.equal(await (await files[0].open(1000)).text(), 'hello world');
  assert.equal(await (await files[1].open(1000)).text(), 'stored bytes');
});

test('reads ZIP64 archives', async () => {
  const zip = writeZip([entry('x/y.txt', 'zip64 content'), entry('z.txt', 'second')], { zip64: true });
  const files = await readZip(blobOf(zip));
  assert.deepEqual(files.map((f) => [f.path, f.size]), [['x/y.txt', 13], ['z.txt', 6]]);
  assert.equal(await (await files[1].open(100)).text(), 'second');
});

test('reads the fixture export parts, the second one ZIP64', async () => {
  const selection = await zipSelection();
  const { files, problems } = await collectSourceFiles(selection);
  assert.deepEqual(problems, []);
  assert.ok(files.some((f) => f.path === 'json/memories_history.json'));
  assert.ok(files.some((f) => f.archive.endsWith('-2.zip') && f.name.endsWith('-main.mp4')));
});

test('stops inflating once the output passes the limit, whatever the header says', async () => {
  const bomb = Buffer.alloc(5 * 1024 * 1024);
  const zip = writeZip([{ path: 'memories/bomb.jpg', data: bomb, mtime: Date.now() }]);
  const [file] = await readZip(blobOf(zip));
  await assert.rejects(file.open(1024 * 1024), (error) => error instanceof ZipError && /too large/.test(error.message));
  // Raw inflate of a stream whose size nobody declared.
  const deflated = new Blob([zlib.deflateRawSync(bomb)]);
  await assert.rejects(inflate(deflated, 4096), ZipError);
});

test('detects corrupted data through the checksum', async () => {
  const zip = writeZip([{ path: 'a.txt', data: Buffer.from('a'.repeat(1000)), mtime: Date.now() }]);
  const [file] = await readZip(blobOf(zip));
  const good = await file.open(10_000);
  assert.equal((await good.text()).length, 1000);
  const tampered = Buffer.from(zip);
  // Flip a bit inside the compressed data (after the 30-byte header, 5-byte name, 9-byte UT field).
  tampered[30 + 5 + 9 + 1] ^= 0x01;
  const [broken] = await readZip(blobOf(tampered));
  await assert.rejects(broken.open(10_000), ZipError);
});

test('refuses traversal, absolute paths and control characters', () => {
  for (const bad of ['../etc/passwd', 'a/../../b', '/abs', 'C:\\win', 'a\u0000b', 'x\ny']) {
    assert.throws(() => normalizePath(bad), ZipError, bad);
  }
  assert.equal(normalizePath('a\\b\\c.jpg'), 'a/b/c.jpg');
  assert.equal(normalizePath('./a//b'), 'a/b');
  assert.equal(normalizePath('dir/'), null);
  assert.throws(() => normalizePath('x'.repeat(LIMITS.maxPathBytes + 1)), ZipError);
});

test('refuses archives with traversal entries, duplicates or overlapping data', async () => {
  await assert.rejects(readZip(blobOf(writeZip([entry('../evil.txt', 'x')]))), /traversal/);
  await assert.rejects(readZip(blobOf(writeZip([entry('a.txt', 'x'), entry('./a.txt', 'y')]))), /duplicate/);

  // Point the second central entry at the first entry's data.
  const zip = Buffer.from(writeZip([entry('a.txt', 'aaaa'), entry('b.txt', 'bbbb')]));
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cdOffset = zip.readUInt32LE(eocd + 16);
  const firstLength = 46 + zip.readUInt16LE(cdOffset + 28) + zip.readUInt16LE(cdOffset + 30);
  zip.writeUInt32LE(10, cdOffset + firstLength + 42);
  await assert.rejects(readZip(blobOf(zip)), /overlapping|offset/);
});

test('refuses offsets beyond the file and entries over the count limit', async () => {
  const zip = Buffer.from(writeZip([entry('a.txt', 'x')]));
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const broken = Buffer.from(zip);
  broken.writeUInt32LE(zip.length + 100, eocd + 16);
  await assert.rejects(readZip(blobOf(broken)), ZipError);

  const many = writeZip(Array.from({ length: 5 }, (_, i) => entry(`f${i}.txt`, 'x')));
  await assert.rejects(readZip(blobOf(many), { limits: { ...LIMITS, maxEntries: 4 } }), /too many/);
});

test('refuses a non-ZIP file and a truncated one', async () => {
  await assert.rejects(readZip(blobOf(Buffer.from('not a zip at all'))), /not a ZIP/);
  const zip = writeZip([entry('a.txt', 'x')]);
  await assert.rejects(readZip(blobOf(zip.subarray(0, zip.length - 30))), ZipError);
});

test('marks encrypted entries as unsupported and refuses to open them', async () => {
  const zip = Buffer.from(writeZip([entry('a.txt', 'secret')]));
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cdOffset = zip.readUInt32LE(eocd + 16);
  zip.writeUInt16LE(zip.readUInt16LE(cdOffset + 8) | 1, cdOffset + 8);
  const [file] = await readZip(blobOf(zip));
  assert.equal(file.supported, false);
  await assert.rejects(file.open(100), /encrypted/);
});

test('a broken part is reported without hiding the others', async () => {
  const good = blobOf(writeZip([entry('memories/a.txt', 'x')]), 'good.zip');
  const bad = blobOf(Buffer.from('garbage'), 'bad.zip');
  const { files, problems } = await collectSourceFiles([{ file: good, relativePath: 'good.zip' }, { file: bad, relativePath: 'bad.zip' }]);
  assert.equal(files.length, 1);
  assert.deepEqual(problems.map((p) => p.path), ['bad.zip']);
});

test('crc32 matches zlib', () => {
  const data = Buffer.from('The quick brown fox jumps over the lazy dog');
  assert.equal(crc32(data), zlib.crc32(data) >>> 0);
});
