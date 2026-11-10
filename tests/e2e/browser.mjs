// A small Chrome DevTools Protocol client: starts a headless Chromium-based
// browser with a fresh profile and drives one tab. No Puppeteer, no download.
//
// Browser: $CHROME_PATH, else Brave or another Chromium-based browser from
// its usual install location.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/brave-browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
];

export function findBrowser() {
  const found = [process.env.CHROME_PATH, ...CANDIDATES].find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error('No Chromium-based browser found; set CHROME_PATH.');
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Browser {
  static async launch({ profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twonly-e2e-profile-')), headless = process.env.HEADFUL !== '1' } = {}) {
    const executable = findBrowser();
    const child = spawn(executable, [
      ...(headless ? ['--headless=new'] : []),
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,900',
      // The tests expect the page in English, whatever the system language.
      '--accept-lang=en-US',
      '--lang=en-US',
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume();
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await sleep(100);
    if (!fs.existsSync(portFile)) throw new Error('the browser did not start');
    const [port] = fs.readFileSync(portFile, 'utf8').split('\n');
    const browser = new Browser(child, Number(port), profileDir);
    return browser;
  }

  constructor(child, port, profileDir) {
    this.child = child;
    this.port = port;
    this.profileDir = profileDir;
  }

  async newTab() {
    const response = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT' });
    const target = await response.json();
    const tab = new Tab(target.webSocketDebuggerUrl);
    await tab.ready;
    return tab;
  }

  async close() {
    this.child.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(this.profileDir, { recursive: true, force: true });
  }
}

export class Tab {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.console = [];
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} ${message.error.data || ''}`));
        else resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        this.console.push(`${message.params.type}: ${message.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
      } else if (message.method === 'Log.entryAdded') {
        this.console.push(`${message.params.entry.level}: ${message.params.entry.text}`);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.console.push(`exception: ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
      }
      for (const listener of this.listeners) listener(message);
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async enable() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
  }

  async goto(url) {
    const loaded = new Promise((resolve) => {
      const listener = (message) => {
        if (message.method === 'Page.loadEventFired') {
          this.listeners = this.listeners.filter((l) => l !== listener);
          resolve();
        }
      };
      this.listeners.push(listener);
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  /** Evaluates an expression in the page and returns its value. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  /** Waits until `expression` is truthy and returns its value. */
  async waitFor(expression, { timeoutMs = 60_000, what = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.evaluate(expression).catch(() => null);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${this.console.slice(-20).join('\n')}`);
      await sleep(200);
    }
  }

  async click(selector) {
    await this.waitFor(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el && !el.disabled; })()`, { what: selector });
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }

  /** Clicks the enabled button whose visible text is exactly `text`. */
  async clickButton(text) {
    const find = `[...document.querySelectorAll('button')].find((el) => el.textContent.trim() === ${JSON.stringify(text)} && !el.disabled)`;
    await this.waitFor(`Boolean(${find})`, { what: `the button "${text}"` });
    await this.evaluate(`${find}.click()`);
  }

  /**
   * Serves every script whose URL ends in `suffix` as `transform(source)`,
   * bypassing the cache. For instrumenting the page in tests only.
   */
  async interceptScript(suffix, transform) {
    this.listeners.push(async (message) => {
      if (message.method !== 'Fetch.requestPaused') return;
      const { requestId, responseStatusCode, responseHeaders } = message.params;
      try {
        const { body, base64Encoded } = await this.send('Fetch.getResponseBody', { requestId });
        const source = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
        await this.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: responseStatusCode,
          responseHeaders,
          body: Buffer.from(transform(source)).toString('base64'),
        });
      } catch (error) {
        this.console.push(`intercept ${suffix}: ${error.message}`);
        await this.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
      }
    });
    await this.send('Network.enable');
    await this.send('Network.setCacheDisabled', { cacheDisabled: true });
    await this.send('Fetch.enable', { patterns: [{ urlPattern: `*${suffix}`, requestStage: 'Response' }] });
  }

  async setFiles(selector, files) {
    const { result } = await this.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
    if (!result.objectId) throw new Error(`no element ${selector}`);
    await this.send('DOM.setFileInputFiles', { files, objectId: result.objectId });
  }

  text(selector) {
    return this.evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || null`);
  }
}
