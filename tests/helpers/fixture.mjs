// Builds the synthetic Snapchat export once per test run and hands out its
// files as Blobs, the way a browser hands out File objects.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let cached = null;

export function fixtureDir() {
  if (cached) return cached;
  const dir = process.env.TWONLY_FIXTURE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'twonly-snapchat-'));
  if (!fs.existsSync(path.join(dir, 'expected.json'))) {
    execFileSync(process.execPath, [path.join(root, 'tests/helpers/make-snapchat-fixture.mjs'), '--out', dir, '--folder'], { stdio: 'inherit' });
  }
  cached = dir;
  return dir;
}

export function expected() {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir(), 'expected.json'), 'utf8'));
}

/** The ZIP parts as `{file, relativePath}` selections. */
export async function zipSelection() {
  const dir = path.join(fixtureDir(), 'zips');
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const blob = await fs.openAsBlob(path.join(dir, name));
    out.push({ file: Object.assign(blob, { name }), relativePath: name });
  }
  return out;
}

/** The unpacked folder as loose files with their modification times. */
export async function folderSelection() {
  const base = path.join(fixtureDir(), 'folder');
  const out = [];
  const walk = async (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        await walk(full);
        continue;
      }
      const blob = await fs.openAsBlob(full);
      const file = new File([blob], name, { lastModified: fs.statSync(full).mtimeMs });
      out.push({ file, relativePath: path.relative(base, full).split(path.sep).join('/') });
    }
  };
  await walk(base);
  return out;
}

export { root };
