#!/usr/bin/env node
// Smoke test against any static host: page, CSS, CSP and a real conversion.
// Usage: node tests/e2e/static-page.mjs --url http://127.0.0.1:3141/

import assert from 'node:assert/strict';
import { Browser } from './browser.mjs';

const at = process.argv.indexOf('--url');
if (at < 0 || !process.argv[at + 1]) throw new Error('missing --url');
const browser = await Browser.launch();
try {
  const tab = await browser.newTab();
  await tab.enable();
  await tab.goto(process.argv[at + 1]);
  await tab.waitFor('document.querySelector(\'button#snapchat\') && document.styleSheets.length === 1');
  assert.equal(await tab.evaluate('getComputedStyle(document.querySelector(".shell")).paddingTop'), '24px');
  assert.equal(await tab.evaluate('document.fonts.ready.then(() => document.fonts.check(\'16px "Open Sans"\'))'), true);
  console.log('ok  static HTML, stylesheet and font load');

  const csp = await tab.evaluate(`(async () => {
    window.__inline = false;
    const script = document.createElement('script');
    script.textContent = 'window.__inline = true';
    document.body.append(script);
    const probe = document.createElement('div');
    probe.setAttribute('style', 'color: rgb(1, 2, 3)');
    document.body.append(probe);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const styled = getComputedStyle(probe).color === 'rgb(1, 2, 3)';
    probe.remove();
    return { inline: window.__inline, styled };
  })()`);
  assert.deepEqual(csp, { inline: false, styled: false });
  console.log('ok  CSP blocks inline scripts and style attributes');

  const result = await tab.evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    canvas.getContext('2d').fillRect(0, 0, 4, 4);
    const main = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const kek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const worker = new Worker(new URL('src/worker.js', location.href), { type: 'module' });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('conversion worker timed out')), 15000);
        worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)); };
        worker.onmessage = ({ data }) => {
          clearTimeout(timer);
          resolve({ ok: data.ok, message: data.message || '', bytes: data.prepared?.full.byteLength || 0 });
        };
        worker.postMessage({ id: 1, job: {
          lang: 'en', main, mediaId: '00000000-0000-4000-8000-000000000001',
          item: { kind: 'image', source: 'snapchat', sourceItemId: 'smoke-test', createdAt: 1735689600000 },
          grant: { kek, addition: 'cloud_media_key_import_00000000-0000-4000-8000-000000000001' },
        } });
      });
    } finally {
      worker.terminate();
    }
  })()`);
  assert.equal(result.ok, true, result.message);
  assert.ok(result.bytes > 0);
  console.log('ok  conversion worker produces encrypted image data');
} finally {
  await browser.close();
}
