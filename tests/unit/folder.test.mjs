import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFolder, ensureReadPermission } from '../../src/browser.js';
import { collectSourceFiles } from '../../src/zip.js';
import { snapchat } from '../../src/snapchat.js';
import { LIMITS } from '../../src/util.js';
import { folderSelection, expected } from '../helpers/fixture.mjs';

/** A FileSystemDirectoryHandle stand-in built from `{relativePath: File}`. */
function fakeDirectory(name, files) {
  const tree = { name, kind: 'directory', children: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      if (!node.children.has(part)) node.children.set(part, { name: part, kind: 'directory', children: new Map() });
      node = node.children.get(part);
    }
    node.children.set(parts.at(-1), { name: parts.at(-1), kind: 'file', file });
  }
  const wrap = (node) => node.kind === 'file'
    ? { kind: 'file', name: node.name, getFile: async () => node.file }
    : {
      kind: 'directory',
      name: node.name,
      async *values() {
        for (const child of node.children.values()) yield wrap(child);
      },
    };
  return wrap(tree);
}

test('a remembered folder reads like a folder selection', async () => {
  const selection = await folderSelection();
  const root = selection[0].relativePath.split('/')[0];
  const handle = fakeDirectory(root, selection.map(({ file, relativePath }) => [relativePath.slice(root.length + 1), file]));
  const read = await readFolder(handle);
  assert.deepEqual(read.map((entry) => entry.relativePath), selection.map((entry) => entry.relativePath).sort());
  const { files } = await collectSourceFiles(read);
  const result = await snapchat.index(files);
  assert.equal(result.items.length, expected().items.length);
  assert.ok(result.items.every((item) => !item.dateApproximate || item.sourceItemId === expected().items.find((e) => e.dateApproximate).sourceItemId));
});

test('a folder over the entry limit is refused', async () => {
  const many = Array.from({ length: 5 }, (_, i) => [`f${i}.txt`, new File(['x'], `f${i}.txt`)]);
  await assert.rejects(readFolder(fakeDirectory('big', many), { limits: { ...LIMITS, maxEntries: 4 } }), /too many/);
});

test('read permission is asked for only when not already granted', async () => {
  const calls = [];
  const handle = (query, request) => ({
    queryPermission: async () => { calls.push('query'); return query; },
    requestPermission: async () => { calls.push('request'); return request; },
  });
  assert.equal(await ensureReadPermission(handle('granted', 'denied')), true);
  assert.deepEqual(calls.splice(0), ['query']);
  assert.equal(await ensureReadPermission(handle('prompt', 'granted')), true);
  assert.equal(await ensureReadPermission(handle('prompt', 'denied')), false);
});
