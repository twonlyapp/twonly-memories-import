import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { collectSourceFiles, readZip } from '../../src/zip.js';
import { snapchat, parseLocation, parseUtcDate, midFromLink } from '../../src/snapchat.js';
import { writeZip } from '../helpers/zip-writer.mjs';
import { expected, fixtureDir, folderSelection, zipSelection } from '../helpers/fixture.mjs';

function summarize(items) {
  return items
    .map((item) => ({
      sourceItemId: item.sourceItemId,
      kind: item.kind,
      createdAt: Math.floor(item.createdAt / 1000),
      dateApproximate: item.dateApproximate,
      location: item.location,
      hasOverlay: Boolean(item.overlay),
    }))
    .sort((a, b) => (a.sourceItemId < b.sourceItemId ? -1 : 1));
}

function expectedItems() {
  return expected()
    .items.map(({ sourceItemId, kind, createdAt, dateApproximate, location, hasOverlay }) => ({ sourceItemId, kind, createdAt, dateApproximate, location, hasOverlay }))
    .sort((a, b) => (a.sourceItemId < b.sourceItemId ? -1 : 1));
}

test('indexes the ZIP export: every memory with its exact date, type, location and overlay', async () => {
  const { files } = await collectSourceFiles(await zipSelection());
  assert.equal(snapchat.detect(files), true);
  const result = await snapchat.index(files);
  assert.deepEqual(summarize(result.items), expectedItems());
  assert.equal(result.missingFiles, expected().missingFiles);
  assert.equal(result.invalidRecords, expected().invalidRecords);
  assert.deepEqual(result.skipped, []);
  assert.ok(result.notes.some((note) => /videos? ha(s|ve) a caption/.test(note)));
  assert.ok(result.notes.some((note) => /not in the selected files/.test(note)));
  // Newest first.
  const times = result.items.map((item) => item.createdAt);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test('indexes the unpacked folder the same way', async () => {
  const { files } = await collectSourceFiles(await folderSelection());
  const result = await snapchat.index(files);
  assert.deepEqual(summarize(result.items), expectedItems());
});

test('joins by local file time when the UT field is missing', async () => {
  // Rewrite both parts without UT fields: only the local DOS times remain.
  const { files: original } = await collectSourceFiles(await zipSelection());
  const entries = [];
  for (const file of original) {
    const data = Buffer.from(await (await file.open(200 * 1024 * 1024)).arrayBuffer());
    entries.push({ path: file.path, data, mtime: file.mtimeEpoch });
  }
  const zip = writeZip(entries, { utExtra: false });
  const files = await readZip(Object.assign(new Blob([zip]), { name: 'no-ut.zip' }));
  assert.ok(files.every((file) => file.mtimeEpoch === null && file.mtimeNaive !== null));
  const result = await snapchat.index(files);
  assert.deepEqual(summarize(result.items), expectedItems());
});

test('without memories_history.json dates come from the file names', async () => {
  const { files } = await collectSourceFiles(await zipSelection());
  const withoutJson = files.filter((file) => file.name !== 'memories_history.json');
  assert.equal(snapchat.detect(withoutJson), true);
  const result = await snapchat.index(withoutJson);
  assert.equal(result.items.length, expected().items.length);
  assert.ok(result.items.every((item) => item.dateApproximate && item.location === null));
  assert.ok(result.notes.some((note) => /memories_history.json is missing/.test(note)));
});

test('another export is not detected as Snapchat', async () => {
  const zip = writeZip([{ path: 'Takeout/Google Photos/IMG_0001.jpg', data: Buffer.from('x'), mtime: Date.now() }]);
  const files = await readZip(Object.assign(new Blob([zip]), { name: 'takeout.zip' }));
  assert.equal(snapchat.detect(files), false);
});

test('hostile metadata never becomes data', async () => {
  const json = JSON.parse(fs.readFileSync(path.join(fixtureDir(), 'folder/mydata~1778946903830/json/memories_history.json'), 'utf8'));
  assert.ok(json['Saved Media'].some((r) => /onerror/.test(r.Location)));
  assert.equal(parseLocation('Latitude, Longitude: <img src=x onerror="alert(1)">'), null);
  assert.equal(parseLocation('Latitude, Longitude: 91.0, 10.0'), null);
  assert.equal(parseLocation('Latitude, Longitude: 0.0, 0.0'), null);
  assert.deepEqual(parseLocation('Latitude, Longitude: 52.52, -13.4'), { latitude: 52.52, longitude: -13.4 });
  assert.equal(parseUtcDate('2024-02-30 10:00:00 UTC'), null);
  assert.equal(parseUtcDate('<script>'), null);
  assert.equal(parseUtcDate('2024-02-29 10:00:00 UTC'), Date.UTC(2024, 1, 29, 10));
  assert.equal(midFromLink('javascript:alert(1)'), null);
  assert.equal(midFromLink('https://app.snapchat.com/dmd/memories?mid=<script>'), null);
  assert.equal(midFromLink('https://app.snapchat.com/dmd/memories?mid=abc-123'), 'abc-123');
  // __proto__ in the export must not reach any object.
  const zip = writeZip([
    { path: 'json/memories_history.json', data: Buffer.from('{"__proto__": {"polluted": true}, "Saved Media": [{"__proto__": {"x": 1}, "Date": "2024-01-01 00:00:00 UTC", "Media Type": "Image", "Location": "Latitude, Longitude: 0.0, 0.0"}]}'), mtime: Date.now() },
    { path: 'memories/2024-01-01_aaaa-main.jpg', data: Buffer.from('x'), mtime: Date.UTC(2024, 0, 1) },
  ]);
  const files = await readZip(Object.assign(new Blob([zip]), { name: 'proto.zip' }));
  const result = await snapchat.index(files);
  assert.equal(result.items.length, 1);
  assert.equal({}.polluted, undefined);
});

test('refuses metadata over the record limit and files with unexpected names', async () => {
  const records = Array.from({ length: 11 }, () => ({ Date: '2024-01-01 00:00:00 UTC', 'Media Type': 'Image' }));
  const zip = writeZip([
    { path: 'json/memories_history.json', data: Buffer.from(JSON.stringify({ 'Saved Media': records })), mtime: Date.now() },
    { path: 'memories/2024-01-01_aaaa-main.exe', data: Buffer.from('x'), mtime: Date.now() },
    { path: 'memories/<img src=x>-main.jpg', data: Buffer.from('x'), mtime: Date.now() },
  ]);
  const files = await readZip(Object.assign(new Blob([zip]), { name: 'x.zip' }));
  const { LIMITS } = await import('../../src/util.js');
  await assert.rejects(snapchat.index(files, { limits: { ...LIMITS, maxMetadataRecords: 10 } }), /too many records/);
  const result = await snapchat.index(files.filter((f) => !f.name.endsWith('.json')));
  assert.equal(result.items.length, 0);
  assert.equal(result.skipped.length, 2);
});
