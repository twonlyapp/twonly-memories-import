#!/usr/bin/env node
// Drives the real importer page in a headless browser for the end-to-end
// test. The app side (twonly-app/rust/tests/api/memories_importer.rs) starts
// this process and talks to it line by line:
//
//   driver → test   PAIRING <link>          the QR code's link is on screen
//   driver → test   ACCOUNT <text>          the confirm screen's account name
//   driver → test   RESULT <json>           what the done screen shows
//   driver → test   PAIRING_SCREEN          a new pairing is asked for
//   driver → test   OK <what> / ERROR <message>
//   test → driver   rerun                   reload, select the export again, upload
//   test → driver   expect-pairing          reload, select the export, expect a new pairing
//   test → driver   check-csp               confirm the page runs under its CSP
//   test → driver   forget-progress         drop this browser's per-memory progress, so
//                                           a rerun asks the server about every memory
//   test → driver   quit
//
// The driver reads the page the way a person does: buttons by their English
// text and the numbers on screen. The page has no test hooks; the pairing
// link is recorded by serving the page a QR library that also notes the text
// it encodes.
//
// Usage: node tests/e2e/page-driver.mjs --url http://127.0.0.1:3141 --zips DIR --username NAME

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Browser } from './browser.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  if (at < 0) throw new Error(`missing ${name}`);
  return args[at + 1];
};
const url = option('--url');
const zipsDir = path.resolve(option('--zips'));
const username = option('--username');
const zips = fs.readdirSync(zipsDir).filter((name) => name.endsWith('.zip')).sort().map((name) => path.join(zipsDir, name));

const say = (line) => process.stdout.write(`${line}\n`);
const log = (line) => process.stderr.write(`[driver] ${line}\n`);

let browser;
let tab;

/** The vendored QR library, with every encoded text noted in `__pairingLink`. */
function recordPairingLink(source) {
  const marker = 'export default qrcode;';
  if (!source.includes(marker)) throw new Error('qrcode.js no longer ends in its default export');
  return source.replace(marker, `
const recordingQrcode = (...args) => {
  const qr = qrcode(...args);
  const addData = qr.addData;
  qr.addData = (data, ...rest) => {
    globalThis.__pairingLink = data;
    return addData.call(qr, data, ...rest);
  };
  return qr;
};
export default recordingQrcode;`);
}

const pairingLink = () => tab.waitFor('globalThis.__pairingLink', { what: 'the pairing code' });

async function openAndSelect() {
  await tab.goto(url);
  await tab.waitFor('document.styleSheets.length === 1', { what: 'the stylesheet' });
  await tab.click('button#snapchat');
  await tab.clickButton('I have my export');
  const zipInput = 'input[type="file"][accept=".zip,application/zip"]';
  await tab.waitFor(`document.querySelector('${zipInput}')`, { what: 'the ZIP selection' });
  await tab.setFiles(zipInput, zips);
  await tab.clickButton('Continue');
}

/** The done screen's heading, numbers and list of memories that were not imported. */
async function waitForResult() {
  await tab.clickButton('Start upload');
  const result = await tab.waitFor(`(() => {
    const heading = document.querySelector('h1')?.textContent;
    if (heading !== 'Done' && heading !== 'Your storage is full') return null;
    const stats = Object.fromEntries([...document.querySelectorAll('.stat')].map((el) => [
      el.querySelector('.label').textContent,
      Number(el.querySelector('.value').textContent.replace(/[^0-9]/g, '')),
    ]));
    return {
      heading,
      uploaded: stats['uploaded now'],
      alreadyUploaded: stats['already in twonly'],
      notImported: stats['not imported'],
      notImportedList: [...document.querySelectorAll('.list-row')].map((row) => ({
        path: row.querySelector('.path').textContent,
        reason: row.querySelector('.muted').textContent,
      })),
    };
  })()`, { timeoutMs: 600_000, what: 'the upload to finish' });
  say(`RESULT ${JSON.stringify(result)}`);
}

async function firstRun() {
  await openAndSelect();
  say(`PAIRING ${await pairingLink()}`);
  const account = await tab.waitFor('document.querySelector(\'.account\')?.textContent', { timeoutMs: 120_000, what: 'the confirm screen' });
  say(`ACCOUNT ${account}`);
  if (account !== `@${username}`) throw new Error(`connected as ${account}, expected @${username}`);
  await tab.clickButton('This is me');
  await waitForResult();
}

async function checkCsp() {
  // Nothing from the page may run outside its policy: an inline script and
  // a style attribute added now must have no effect.
  const verdict = await tab.evaluate(`(async () => {
    window.__inline = false;
    const script = document.createElement('script');
    script.textContent = 'window.__inline = true';
    document.body.append(script);
    const probe = document.createElement('div');
    probe.setAttribute('style', 'color: rgb(1, 2, 3)');
    document.body.append(probe);
    await new Promise((r) => setTimeout(r, 100));
    const styled = getComputedStyle(probe).color === 'rgb(1, 2, 3)';
    probe.remove();
    return { inline: window.__inline, styled, sheets: document.styleSheets.length, adopted: document.adoptedStyleSheets.length };
  })()`);
  if (verdict.inline || verdict.styled || verdict.sheets !== 1 || verdict.adopted !== 0) {
    throw new Error(`CSP did not hold: ${JSON.stringify(verdict)}`);
  }
  say(`OK check-csp ${JSON.stringify(verdict)}`);
}

async function main() {
  browser = await Browser.launch();
  tab = await browser.newTab();
  await tab.enable();
  await tab.interceptScript('/src/vendor/qrcode.js', recordPairingLink);
  await firstRun();

  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    const command = line.trim();
    if (command === 'quit') break;
    if (command === 'rerun') {
      await openAndSelect();
      await waitForResult();
    } else if (command === 'expect-pairing') {
      await openAndSelect();
      await pairingLink();
      say('PAIRING_SCREEN');
    } else if (command === 'forget-progress') {
      await tab.evaluate(`new Promise((resolve, reject) => {
        const open = indexedDB.open('twonly-importer');
        open.onsuccess = () => {
          const tx = open.result.transaction('progress', 'readwrite');
          tx.objectStore('progress').clear();
          tx.oncomplete = () => { open.result.close(); resolve(true); };
          tx.onerror = reject;
        };
        open.onerror = reject;
      })`);
      say('OK forget-progress');
    } else if (command === 'check-csp') {
      await checkCsp();
    } else {
      say(`ERROR unknown command ${command}`);
    }
  }
  await browser.close();
}

main().catch(async (error) => {
  say(`ERROR ${String(error && error.message).split('\n')[0]}`);
  log(error && error.stack);
  if (tab) log(tab.console.join('\n'));
  if (browser) await browser.close().catch(() => {});
  process.exit(1);
});
