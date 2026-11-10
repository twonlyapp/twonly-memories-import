// The importer page. index.html loads this file as an ES module; it imports
// the other modules in src/. The conversion workers run src/worker.js.

import qrcode from './vendor/qrcode.js';
import { LIMITS, sha256, wipe } from './util.js';
import {
  generatePairingKeys, dropPairingKeys, newPollSecret, pairingLink, openEnvelope, decodeGrant,
  importGrant, CryptoError, mediaIdFor,
} from './crypto.js';
import { collectSourceFiles } from './zip.js';
import { ADAPTERS, AdapterError } from './snapchat.js';
import { ImporterApi, ApiError, UploadQueue, xhrUpload, runImport, selectItems, ByteBudget, UploadEstimate, UploadSpeed } from './upload.js';
import {
  grantStore, ProgressStore, folderStore, supportsFolderHandles, pickFolder, ensureReadPermission, readFolder,
  WorkerPool, SkippedError, videoFrame, canEncodeWebp,
} from './browser.js';
import { t, setLanguage, language, locale, preferredLanguage, LANGUAGES } from './i18n.js';

/** This script's own <script> element. */
const SELF = document.querySelector('script[data-api]');
const PRODUCTION_API = 'https://api.twonly.eu';
const DEV_API = 'https://dev-api.twonly.eu';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
/**
 * The API the page talks to. A page loaded from this computer talks to the
 * dev server instead of production, unless index.html names another API.
 */
function apiBase() {
  const configured = SELF?.dataset.api || PRODUCTION_API;
  if (configured === PRODUCTION_API && LOCAL_HOSTS.includes(location.hostname)) return DEV_API;
  return configured;
}
const CONFIG = {
  apiBase: apiBase(),
  repoUrl: SELF?.dataset.repo || 'https://github.com/twonlyapp/twonly-memories-import',
};
const api = new ImporterApi({ baseUrl: CONFIG.apiBase });

let root = null;
const state = {
  adapter: null,
  step: null,
  /** Whether this browser can create WebP images (Safari cannot). */
  webp: true,
  files: [],
  problems: [],
  index: null,
  grant: null,
  progress: new ProgressStore(),
  pool: null,
  pairingAbort: null,
  /** Draws the current screen again (after a language switch); null while uploading. */
  view: null,
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

// The only way this page creates DOM. Text goes through textContent, never
// innerHTML; attributes are from a fixed allow-list; event handlers are
// functions, never attribute strings. Nothing from an export, an account or
// an error message can become markup.

const ALLOWED_ATTRIBUTES = new Set([
  'class', 'type', 'accept', 'multiple', 'disabled', 'value', 'min', 'max', 'for', 'id', 'name',
  'href', 'target', 'rel', 'role', 'aria-label', 'aria-live', 'aria-hidden', 'aria-current', 'width', 'height',
  'title', 'checked', 'webkitdirectory', 'tabindex',
]);

const SAFE_HREF = /^(https:\/\/github\.com\/|https:\/\/twonly\.eu\/|https:\/\/help\.snapchat\.com\/hc\/|#)/;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'ref') {
      value(el);
    } else if (ALLOWED_ATTRIBUTES.has(key)) {
      if (key === 'href' && !SAFE_HREF.test(String(value))) throw new Error('unexpected link');
      el.setAttribute(key, value === true ? '' : String(value));
    } else {
      throw new Error(`attribute ${key} is not allowed`);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function replace(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

function svg(tag, attributes = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, String(value));
  for (const child of children) el.append(child);
  return el;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = value < 10 && unit > 0 ? 1 : 0;
  const number = new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  return `${number} ${units[unit]}`;
}

function formatCount(n) {
  return new Intl.NumberFormat(locale()).format(n);
}

/** Bytes per second in MB/s, the unit macOS and Windows show. */
function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond === null) return '–';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** The same in Mbit/s, the unit internet speed tests use. */
function formatMbit(bytesPerSecond) {
  if (bytesPerSecond === null) return '';
  const mbit = (bytesPerSecond * 8) / 1_000_000;
  const digits = mbit < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(mbit)} Mbit/s`;
}

/** The upload screen's time-left line; coarse, so it does not flicker. */
function formatTimeLeft(ms) {
  if (ms === null) return t('etaEstimating');
  if (ms < 60_000) return t('etaLessThanMinute');
  if (ms < 60 * 60_000) return t('etaMinutes', Math.ceil(ms / 60_000));
  // Over an hour: to the nearest 5 minutes.
  const minutes = Math.round(ms / (5 * 60_000)) * 5;
  return t('etaHours', Math.floor(minutes / 60), minutes % 60);
}

function formatDate(time) {
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(time));
}

/** Batches UI updates to one per animation frame. */
function frameScheduler(render) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

// Descriptions for the grid and instructions for the export step.

const SOURCE_INFO = Object.freeze({
  snapchat: () => ({
    tagline: t('snapchatTagline'),
    helpUrl: t('snapchatHelpUrl'),
    steps: t('snapchatSteps'),
  }),
});

// ---------------------------------------------------------------- styling

const THEMES = ['system', 'light', 'dark'];
function readTheme() {
  try {
    const value = localStorage.getItem('theme');
    return THEMES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}
function applyTheme(theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // Storage blocked: the choice lasts for this visit.
  }
}

// ---------------------------------------------------------------- layout

const IMPORT_STEPS = [
  { id: 'export', key: 'Export' },
  { id: 'select', key: 'Select' },
  { id: 'review', key: 'Review' },
  { id: 'connect', key: 'Connect' },
  { id: 'plan', key: 'Plan' },
  { id: 'upload', key: 'Upload' },
  { id: 'results', key: 'Results' },
];

function importProgress() {
  const current = IMPORT_STEPS.findIndex((step) => step.id === state.step);
  return h('aside', { class: 'import-sidebar', 'aria-label': t('importProgress') },
    h('p', { class: 'import-source', text: t('importFrom', state.adapter.displayName) }),
    h('p', { class: 'small muted', 'aria-live': 'polite', text: t('stepOf', current + 1, IMPORT_STEPS.length) }),
    h('ol', { class: 'import-steps' }, IMPORT_STEPS.map((step, index) => {
      const status = index < current ? 'complete' : index === current ? 'current' : 'pending';
      return h('li', { class: `import-step ${status}`, 'aria-current': index === current ? 'step' : undefined },
        h('span', { class: 'step-marker', 'aria-hidden': 'true', text: index < current ? '✓' : index + 1 }),
        h('div', {},
          h('span', { class: 'step-title', text: t(`step${step.key}Title`) }),
          h('span', { class: 'step-description', text: t(`step${step.key}Description`) })));
    })));
}

function importLayout(step, ...content) {
  state.step = step;
  layout(...content);
}

function layout(...content) {
  const theme = readTheme();
  const themeButton = h('button', {
    class: 'clickable button small',
    title: t('themeTitle'),
    onclick: () => {
      const next = THEMES[(THEMES.indexOf(readTheme()) + 1) % THEMES.length];
      applyTheme(next);
      themeButton.textContent = t('theme', next);
    },
    text: t('theme', theme),
  });
  const actions = [themeButton];
  // Not while uploading: that screen cannot be drawn again.
  if (state.view) {
    actions.push(h('button', { class: 'clickable button small', title: t('languageTitle'), onclick: () => switchLanguage(), text: t('languageSwitch') }));
  }
  if (state.grant) {
    actions.push(h('button', { class: 'clickable button small danger', onclick: () => disconnect(), text: t('disconnect') }));
  }
  replace(root,
    h('header', { class: 'topbar' },
      h('div', { class: 'brand-row' },
        h('a', { class: 'clickable brand', href: '#', 'aria-label': 'twonly', onclick: (event) => { event.preventDefault(); showLanding(); } },
          h('span', { text: 'two' }), h('span', { class: 'brand__only', text: 'nly' })),
        h('span', { class: 'brand-label', text: t('brandLabel') })),
      h('div', { class: 'topbar-actions' }, actions)),
    h('main', { class: state.step ? 'import-layout' : undefined },
      state.step ? importProgress() : null,
      h('div', { class: 'page-content' }, ...content)),
    h('footer', { class: 'footer' },
      footerLink(CONFIG.repoUrl, t('footerGithub')),
      footerLink(t('imprintUrl'), t('footerImprint')),
      footerLink(t('privacyUrl'), t('footerPrivacy'))));
}

// ---------------------------------------------------------------- language

function readLanguage() {
  try {
    const value = localStorage.getItem('lang');
    if (LANGUAGES.includes(value)) return value;
  } catch {
    // Storage blocked: follow the browser.
  }
  return preferredLanguage(navigator.languages || [navigator.language]);
}

function applyLanguage(lang) {
  setLanguage(lang);
  document.documentElement.lang = language();
  document.title = t('pageTitle');
}

function switchLanguage() {
  const next = LANGUAGES[(LANGUAGES.indexOf(language()) + 1) % LANGUAGES.length];
  applyLanguage(next);
  try {
    localStorage.setItem('lang', next);
  } catch {
    // Storage blocked: the choice lasts for this visit.
  }
  state.view?.();
}

function footerLink(href, text) {
  return h('a', { class: 'clickable', href, rel: 'noopener noreferrer', target: '_blank', text });
}

function notice(kind, ...text) {
  const symbol = kind === 'ok' ? 'M8 12l2.5 2.5L16 9' : kind === 'error' || kind === 'warning' ? 'M12 8v5m0 3h.01' : 'M12 11v5m0-8h.01';
  return h('div', { class: `notice notice-message ${kind}`, role: kind === 'error' ? 'alert' : undefined },
    svg('svg', {
      class: 'notice-icon', viewBox: '0 0 24 24', width: 20, height: 20,
      fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    },
    svg('circle', { cx: 12, cy: 12, r: 9 }),
    svg('path', { d: symbol })),
    h('div', { class: 'notice-content' }, ...text));
}

// ---------------------------------------------------------------- landing

function privacyPanel() {
  return h('section', { class: 'panel privacy' },
    h('h2', { text: t('privacyTitle') }),
    h('p', { text: t('privacyBody') }));
}

function showLanding() {
  stopPairing();
  state.adapter = null;
  state.step = null;
  state.view = showLanding;
  layout(
    h('h1', { text: t('landingTitle') }),
    h('p', { class: 'lead', text: t('landingLead') }),
    state.webp ? null : notice('error', h('span', { text: t('unsupportedBrowser') })),
    privacyPanel(),
    h('div', { class: 'grid source-grid' }, ADAPTERS.map((adapter) => {
      const info = SOURCE_INFO[adapter.id]();
      return h('button', {
        type: 'button', class: 'clickable panel source-card', id: adapter.id,
        disabled: !state.webp,
        onclick: () => showExport(adapter),
      },
      h('span', { class: 'source-name', text: adapter.displayName }),
      h('span', { class: 'muted', text: info.tagline }));
    })),
  );
}

function showExport(adapter) {
  state.adapter = adapter;
  state.view = () => showExport(adapter);
  const info = SOURCE_INFO[adapter.id]();
  importLayout('export',
    h('h1', { text: t('exportTitle') }),
    h('p', { class: 'lead', text: t('exportLead', adapter.displayName) }),
    h('section', { class: 'panel' },
      h('h2', { text: t('exportGetFiles', adapter.displayName) }),
      h('ol', { class: 'steps' }, info.steps.map((step) => h('li', { text: step }))),
      info.helpUrl ? h('p', {}, h('a', { class: 'clickable',
        href: info.helpUrl, target: '_blank', rel: 'noopener noreferrer',
        text: t('exportGuide', adapter.displayName),
      })) : null,
      h('div', { class: 'row' },
        h('button', { class: 'clickable button primary', onclick: () => showSelect(adapter), text: t('exportHave') }))));
}

// ---------------------------------------------------------------- select

async function showSelect(adapter) {
  state.adapter = adapter;
  state.view = () => showSelect(adapter);
  const status = h('div', { 'aria-live': 'polite' });
  const fromFileList = (fileList, folder) => [...fileList].map((file) => ({ file, relativePath: folder ? file.webkitRelativePath || file.name : file.name }));
  const onFiles = async (selection) => {
    if (selection.length === 0) return;
    replace(status, notice('ok', t('readingFiles', selection.length, formatCount(selection.length))));
    try {
      const { files, problems } = await collectSourceFiles(selection);
      if (!adapter.detect(files)) {
        replace(status, notice('error', t('notAnExport', adapter.displayName)));
        return;
      }
      state.files = files;
      state.problems = problems;
      state.index = await adapter.index(files);
      showSummary();
    } catch (error) {
      const message = error instanceof AdapterError || error.name === 'ZipError' ? error.message : t('selectionUnreadable');
      replace(status, notice('error', message));
    }
  };
  const zipInput = h('input', { type: 'file', accept: '.zip,application/zip', multiple: true, class: 'hidden', onchange: (event) => onFiles(fromFileList(event.target.files, false)) });
  const folderInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, class: 'hidden', onchange: (event) => onFiles(fromFileList(event.target.files, true)) });
  // With a folder handle the page can read the same folder after a reload
  // with one click; without one it falls back to the plain folder input.
  const openFolder = async (handle) => {
    try {
      if (!(await ensureReadPermission(handle))) {
        replace(status, notice('error', t('folderNotAllowed')));
        return;
      }
      replace(status, notice('ok', t('readingFolder', handle.name)));
      await onFiles(await readFolder(handle));
    } catch {
      replace(status, notice('error', t('folderUnreadable')));
    }
  };
  const selectFolder = async () => {
    if (!supportsFolderHandles()) {
      folderInput.click();
      return;
    }
    let handle;
    try {
      handle = await pickFolder();
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      folderInput.click();
      return;
    }
    await folderStore.save(adapter.id, handle);
    await openFolder(handle);
  };
  const remembered = supportsFolderHandles() ? await folderStore.load(adapter.id) : null;
  const drop = h('div', { class: 'dropzone', text: t('dropHere') });
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('active');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('active'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('active');
    onFiles(fromFileList(event.dataTransfer.files, false));
  });
  importLayout('select',
    h('h1', { text: t('importFrom', adapter.displayName) }),
    h('section', { class: 'panel' },
      h('h2', { text: t('selectTitle') }),
      h('p', { class: 'muted', text: t('selectHint') }),
      remembered ? h('div', { class: 'notice ok' },
        h('p', {}, t('lastFolderBefore'), h('strong', { text: remembered.name }), t('lastFolderAfter')),
        h('div', { class: 'row' },
          h('button', { class: 'clickable button primary', onclick: () => openFolder(remembered), text: t('continueFolder') }),
          h('button', { class: 'clickable button small', onclick: async () => { await folderStore.clear(); showSelect(adapter); }, text: t('forgetFolder') }))) : null,
      drop,
      h('div', { class: 'row' },
        h('button', { class: remembered ? 'clickable button' : 'clickable button primary', onclick: () => zipInput.click(), text: t('selectZips') }),
        h('button', { class: 'clickable button', onclick: selectFolder, text: t('selectFolder') }),
        h('button', { class: 'clickable button', onclick: () => showExport(adapter), text: t('exportInstructions') })),
      supportsFolderHandles() ? h('p', { class: 'small muted', text: t('folderReopenHint') }) : null,
      zipInput, folderInput, status));
}

// ---------------------------------------------------------------- summary

function summaryStats(items) {
  const photos = items.filter((item) => item.kind === 'image').length;
  const videos = items.length - photos;
  const located = items.filter((item) => item.location).length;
  const bytes = items.reduce((sum, item) => sum + item.main.size, 0);
  const times = items.map((item) => item.createdAt);
  return { photos, videos, located, bytes, from: Math.min(...times), to: Math.max(...times) };
}

function stat(value, label) {
  return h('div', { class: 'stat' }, h('div', { class: 'value', text: value }), h('div', { class: 'label', text: label }));
}

function skippedList(rows) {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, 200);
  return h('div', {},
    h('div', { class: 'list' }, shown.map((row) => h('div', { class: 'list-row' }, h('span', { class: 'path', text: row.path }), h('span', { class: 'muted', text: row.reason })))),
    rows.length > shown.length ? h('p', { class: 'small muted', text: t('andMore', formatCount(rows.length - shown.length)) }) : null);
}

function showSummary() {
  const { items, notes, skipped } = state.index;
  const s = summaryStats(items);
  const problems = [...state.problems, ...skipped];
  state.view = showSummary;
  importLayout('review',
    h('h1', { text: t('importFrom', state.adapter.displayName) }),
    h('section', { class: 'panel' },
      h('h2', { text: t('foundTitle') }),
      items.length === 0 ? notice('error', t('noneFound')) : h('div', { class: 'stats' },
        stat(formatCount(s.photos), t('statPhotos')),
        stat(formatCount(s.videos), t('statVideos')),
        stat(formatCount(s.located), t('statLocated')),
        stat(formatBytes(s.bytes), t('statToUpload'))),
      items.length ? h('p', { class: 'muted', text: t('fromTo', formatDate(s.from), formatDate(s.to)) }) : null,
      notes.map((note) => notice('', note)),
      problems.length ? h('h3', { text: t('notRecognised', problems.length, formatCount(problems.length)) }) : null,
      skippedList(problems),
      h('div', { class: 'row' },
        h('button', { class: 'clickable button primary', disabled: items.length === 0, onclick: () => continueToAccount(), text: t('continue') }),
        h('button', { class: 'clickable button', onclick: () => showSelect(state.adapter), text: t('selectOther') }))));
}

async function continueToAccount() {
  const grant = await grantStore.load();
  if (grant) {
    state.grant = grant;
    try {
      await api.usage(grant.importerToken);
      if (grant.confirmed) return showPlan();
      return showConfirm();
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'grant_invalid') {
        await forgetGrant();
      } else {
        return showFatal(error);
      }
    }
  }
  showPairing();
}

// ---------------------------------------------------------------- pairing

function stopPairing() {
  if (state.pairingAbort) state.pairingAbort.abort();
  state.pairingAbort = null;
}

function drawQr(canvas, text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const scale = Math.floor(240 / (count + 8)) || 1;
  const size = (count + 8) * scale;
  canvas.width = size;
  canvas.height = size;
  canvas.style.width = '240px';
  canvas.style.height = '240px';
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size, size);
  context.fillStyle = '#000000';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) context.fillRect((col + 4) * scale, (row + 4) * scale, scale, scale);
    }
  }
}

async function showPairing(messageKey = null) {
  stopPairing();
  state.view = () => showPairing(messageKey);
  const abort = new AbortController();
  state.pairingAbort = abort;
  const canvas = h('canvas', { width: 240, height: 240, 'aria-label': t('pairingCode') });
  const status = h('p', { class: 'muted', 'aria-live': 'polite', text: t('creatingCode') });
  importLayout('connect',
    h('h1', { text: t('connectTitle') }),
    messageKey ? notice('error', t(messageKey)) : null,
    h('section', { class: 'panel' },
      h('h2', { text: t('scanTitle') }),
      h('div', { class: 'qr-wrap' },
        h('div', { class: 'qr' }, canvas),
        h('div', {},
          h('ol', { class: 'steps' },
            h('li', { text: t('scanStep1') }),
            h('li', { text: t('scanStep2') })))),
      status));

  while (!abort.signal.aborted) {
    let keys = null;
    let pollSecret = null;
    try {
      keys = await generatePairingKeys();
      pollSecret = newPollSecret();
      const { pairingId } = await api.createPairing(await sha256(pollSecret));
      const link = pairingLink(pairingId, keys.publicKey);
      drawQr(canvas, link);
      status.textContent = '';
      const deadline = Date.now() + 10 * 60 * 1000 - 15_000;
      let result = null;
      while (!abort.signal.aborted && Date.now() < deadline && !result) {
        try {
          result = await api.pollPairing(pairingId, pollSecret, { signal: abort.signal });
        } catch (error) {
          if (error.name === 'AbortError') return;
          if (error instanceof ApiError && error.kind === 'gone') break;
          if (error instanceof ApiError && error.kind === 'outdated') throw error;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      if (abort.signal.aborted) return;
      if (!result) {
        status.textContent = t('codeExpired');
        continue;
      }
      status.textContent = t('openingConnection');
      const grantBytes = await openEnvelope({ pairingId, keys, envelopeBytes: result.envelope });
      dropPairingKeys(keys);
      keys = null;
      let decoded;
      try {
        decoded = decodeGrant(grantBytes);
      } finally {
        wipe(grantBytes);
      }
      // The server saw this account claim the code. The envelope must say the same.
      if (decoded.username !== result.claimedUsername) {
        throw new CryptoError(t('accountMismatch'));
      }
      const grant = await importGrant(decoded);
      state.grant = { ...grant, confirmed: false };
      await grantStore.save(state.grant);
      state.pairingAbort = null;
      showConfirm();
      return;
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      showFatal(error);
      return;
    } finally {
      if (keys) dropPairingKeys(keys);
      if (pollSecret) wipe(pollSecret);
    }
  }
}

function showConfirm() {
  const grant = state.grant;
  state.view = showConfirm;
  importLayout('connect',
    h('h1', { text: t('confirmTitle') }),
    h('section', { class: 'panel' },
      h('p', { class: 'muted', text: t('connectedAs') }),
      h('div', { class: 'account', text: `@${grant.claimedUsername}` }),
      grant.displayName ? h('p', { class: 'display-name' }, h('span', { text: grant.displayName }), h('span', { class: 'small', text: t('nameChosen') })) : null,
      notice('warning', t('notYouWarning')),
      h('p', { class: 'small muted', text: t('staysConnected') }),
      h('div', { class: 'row' },
        h('button', {
          class: 'clickable button primary',
          onclick: async () => {
            state.grant = { ...state.grant, confirmed: true };
            await grantStore.save(state.grant);
            showPlan();
          },
          text: t('thisIsMe'),
        }),
        h('button', { class: 'clickable button danger', onclick: () => disconnect(), text: t('notMe') }))));
}

// ---------------------------------------------------------------- plan

async function showPlan() {
  state.view = showPlan;
  let usage;
  try {
    usage = await api.usage(state.grant.importerToken);
  } catch (error) {
    return handleGrantError(error);
  }
  await state.progress.load();
  const all = state.index.items;
  const doneBefore = await countDone(all);
  const remainingBytes = all.reduce((sum, item) => sum + item.main.size, 0);
  const free = Math.max(0, usage.max_bytes - usage.current_bytes);
  const fits = remainingBytes <= free;
  const order = h('select', { class: 'clickable', id: 'order' }, h('option', { value: 'newest', text: t('newestFirst') }), h('option', { value: 'oldest', text: t('oldestFirst') }));
  const from = h('input', { type: 'date', class: 'clickable', id: 'from' });
  const to = h('input', { type: 'date', class: 'clickable', id: 'to' });
  importLayout('plan',
    h('h1', { text: t('planTitle') }),
    h('section', { class: 'panel' },
      h('h2', { text: t('storage') }),
      h('div', { class: 'stats' },
        stat(formatBytes(usage.current_bytes), t('statUsed')),
        stat(formatBytes(usage.max_bytes), t('statOfPlan')),
        stat(formatBytes(remainingBytes), t('statThisImport')),
        stat(formatCount(doneBefore), t('statAlreadyImported'))),
      fits
        ? notice('ok', t('fits'))
        : notice('error', t('mayNotFit')),
      h('div', { class: 'grid' },
        h('div', { class: 'field' }, h('label', { for: 'order', text: t('order') }), order),
        h('div', { class: 'field' }, h('label', { for: 'from', text: t('fromOptional') }), from),
        h('div', { class: 'field' }, h('label', { for: 'to', text: t('untilOptional') }), to)),
      h('p', {}),
      h('div', { class: 'row' },
        h('button', {
          class: 'clickable button primary',
          onclick: () => startUpload({
            order: order.value,
            from: from.value ? Date.parse(`${from.value}T00:00:00Z`) : null,
            to: to.value ? Date.parse(`${to.value}T00:00:00Z`) + 86_400_000 : null,
            usage,
          }),
          text: t('startUpload'),
        }))));
}

async function countDone(items) {
  let done = 0;
  for (const item of items) {
    if (state.progress.isDone(await mediaIdFor(state.grant.idKey, item.source, item.sourceItemId))) done++;
  }
  return done;
}

// ---------------------------------------------------------------- upload

async function startUpload({ order, from, to, usage }) {
  state.view = null;
  const items = selectItems(state.index.items, { order, from, to });
  const counters = { total: items.length, done: 0, already: 0, skipped: 0, failed: 0, conflicts: 0, notUploaded: 0, bytes: 0, uploadedBytes: 0 };
  const skipped = [];
  const failed = [];
  const bar = h('div', { class: 'progress-bar' });
  const values = {};
  const labels = {};
  const statEl = (key, label) => {
    values[key] = h('div', { class: 'value', text: '0' });
    labels[key] = h('div', { class: 'label', text: label });
    return h('div', { class: 'stat' }, values[key], labels[key]);
  };
  const statusLine = h('p', { class: 'muted', 'aria-live': 'polite', text: t('preparing') });
  // Not aria-live: it changes every few seconds and would keep interrupting.
  const etaLine = h('p', { class: 'small muted', text: t('etaEstimating') });
  const problemList = h('div', {});
  let shownProblems = 0;
  /** Source bytes per item, the estimate's unit of work. */
  const workOf = (item) => item.main.size + (item.overlay ? item.overlay.size : 0);
  const workById = new Map(items.map((item) => [item.sourceItemId, workOf(item)]));
  const estimate = new UploadEstimate({ totalBytes: items.reduce((sum, item) => sum + workOf(item), 0) });
  const speed = new UploadSpeed();
  const finishWork = (sourceItemId) => {
    const bytes = workById.get(sourceItemId);
    if (bytes === undefined) return;
    workById.delete(sourceItemId);
    estimate.finish(bytes);
  };
  let paused = false;
  const pauseButton = h('button', {
    class: 'clickable button',
    onclick: () => {
      paused = !paused;
      if (paused) {
        queue.pause();
        estimate.pause();
      } else {
        queue.resume();
        estimate.resume();
      }
      pauseButton.textContent = paused ? t('resume') : t('pause');
      statusLine.textContent = paused ? t('paused') : t('uploading');
    },
    text: t('pause'),
  });
  importLayout('upload',
    h('h1', { text: t('uploadTitle') }),
    notice('warning', t('keepOpen')),
    h('section', { class: 'panel' },
      h('div', { class: 'progress' }, bar),
      statusLine,
      etaLine,
      h('div', { class: 'stats' },
        statEl('done', t('statUploaded')), statEl('already', t('statAlreadyInTwonly')), statEl('skipped', t('statSkipped')), statEl('failed', t('statFailed')), statEl('left', t('statLeft')), statEl('speed', t('statUploadSpeed'))),
      h('div', { class: 'row' }, pauseButton),
      problemList));

  const render = frameScheduler(() => {
    const finished = counters.done + counters.already + counters.skipped + counters.failed + counters.conflicts + counters.notUploaded;
    bar.style.width = `${counters.total ? Math.round((finished / counters.total) * 100) : 100}%`;
    values.done.textContent = formatCount(counters.done);
    values.already.textContent = formatCount(counters.already);
    values.skipped.textContent = formatCount(counters.skipped + counters.conflicts);
    values.failed.textContent = formatCount(counters.failed);
    values.left.textContent = formatCount(Math.max(0, counters.total - finished));
    const rate = speed.rate();
    values.speed.textContent = formatSpeed(rate);
    const mbit = formatMbit(rate);
    labels.speed.textContent = mbit ? `${t('statUploadSpeed')} (${mbit})` : t('statUploadSpeed');
    const eta = formatTimeLeft(estimate.estimate());
    if (etaLine.textContent !== eta) etaLine.textContent = eta;
    // Rebuilt only when it grows: progress events render many times a second.
    if (skipped.length + failed.length !== shownProblems) {
      shownProblems = skipped.length + failed.length;
      replace(problemList, shownProblems ? [h('h3', { text: t('notImportedTitle') }), skippedList([...failed, ...skipped])] : []);
    }
  });

  let wakeLock = null;
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // Not available; the upload still runs.
  }
  const beforeUnload = (event) => {
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  // The estimate moves with time too, not only when a memory finishes.
  const etaTimer = setInterval(render, 1000);

  const pathOf = new Map(items.map((item) => [item.sourceItemId, item.main.path]));
  const queue = new UploadQueue({
    api,
    token: state.grant.importerToken,
    upload: (policy, bytes, onProgress) => xhrUpload(policy, bytes, onProgress),
    onEvent: (event) => {
      if (event.type === 'progress') speed.progress(event.mediaId, event.part, event.loaded);
      // A retry uploads both parts again from the start.
      if (event.type === 'retry') speed.forget(event.mediaId);
      if (['done', 'already_uploaded', 'ownership_conflict', 'too_large', 'failed', 'not_uploaded'].includes(event.type)) {
        finishWork(event.sourceItemId);
        speed.forget(event.mediaId);
      }
      switch (event.type) {
        case 'done':
          counters.done++;
          state.progress.set(event.mediaId, 'done');
          break;
        case 'already_uploaded':
          counters.already++;
          state.progress.set(event.mediaId, 'already_uploaded');
          break;
        case 'ownership_conflict':
          counters.conflicts++;
          skipped.push({ path: pathOf.get(event.sourceItemId) || event.mediaId, reason: t('reasonConflict') });
          break;
        case 'too_large':
          counters.skipped++;
          skipped.push({ path: pathOf.get(event.sourceItemId) || event.mediaId, reason: t('reasonTooLargeForPlan') });
          break;
        case 'failed':
          counters.failed++;
          failed.push({ path: pathOf.get(event.sourceItemId) || event.mediaId, reason: event.reason || t('reasonUploadFailed') });
          break;
        case 'not_uploaded':
          counters.notUploaded++;
          break;
        case 'uploaded':
          statusLine.textContent = t('uploading');
          break;
        default:
          break;
      }
      render();
    },
  });

  if (!state.pool) {
    state.pool = await WorkerPool.create({ url: new URL('./worker.js', import.meta.url), size: Math.max(1, Math.min((navigator.hardwareConcurrency || 2) - 1, 4)) });
  }
  const grant = { kek: state.grant.kek, addition: state.grant.addition };
  const maxSingle = Number(usage.max_single_media) || LIMITS.maxMediaBytes;

  const stopped = await runImport({
    items,
    grant: state.grant,
    queue,
    progress: state.progress,
    budget: new ByteBudget(),
    concurrency: state.pool.size,
    convertAndPrepare: async (item, mediaId) => {
      const main = await item.main.open(LIMITS.maxMediaBytes);
      if (item.kind === 'video' && main.size > maxSingle) throw new SkippedError(t('videoLargerThan', formatBytes(maxSingle)));
      const overlay = item.kind === 'image' && item.overlay ? await item.overlay.open(LIMITS.maxMediaBytes) : null;
      const frame = item.kind === 'video' ? await videoFrame(main) : null;
      const plain = {
        source: item.source,
        sourceItemId: item.sourceItemId,
        kind: item.kind,
        createdAt: item.createdAt,
        location: item.location,
        overlay: Boolean(item.overlay),
      };
      return state.pool.run({ item: plain, mediaId, grant, main, overlay, frame, lang: language() }, frame ? [frame] : []);
    },
    onItem: ({ type, item, error }) => {
      if (type === 'skipped_done') {
        // Uploaded by an earlier run: no work, and no throughput either.
        workById.delete(item.sourceItemId);
        estimate.skip(workOf(item));
      } else {
        finishWork(item.sourceItemId);
      }
      if (type === 'skipped_done') counters.already++;
      else if (error instanceof SkippedError || (error && error.name === 'ZipError')) {
        counters.skipped++;
        skipped.push({ path: item.main.path, reason: error.message });
      } else {
        counters.failed++;
        failed.push({ path: item.main.path, reason: (error && error.message) || t('reasonNotPrepared') });
      }
      render();
    },
  });
  clearInterval(etaTimer);
  await state.progress.flush();
  window.removeEventListener('beforeunload', beforeUnload);
  try {
    await wakeLock?.release();
  } catch {
    // Already released.
  }
  if (stopped && (stopped.reason === 'grant_invalid' || stopped.reason === 'outdated')) {
    return handleGrantError(stopped.error || new ApiError(stopped.reason, 401));
  }
  showDone({ counters, skipped, failed, stopped });
}

function showDone({ counters, skipped, failed, stopped }) {
  state.view = () => showDone({ counters, skipped, failed, stopped });
  const limit = stopped && stopped.reason === 'limit_reached';
  const notDone = counters.total - counters.done - counters.already;
  importLayout('results',
    h('h1', { text: limit ? t('storageFull') : t('done') }),
    h('section', { class: 'panel' },
      h('div', { class: 'stats' },
        stat(formatCount(counters.done), t('statUploadedNow')),
        stat(formatCount(counters.already), t('statAlreadyInTwonly')),
        stat(formatCount(Math.max(0, notDone)), t('statNotImported'))),
      limit ? notice('error', t('didNotFit', formatCount(Math.max(0, notDone)))) : null,
      notice('ok', t('openTwonly')),
      skippedList([...failed, ...skipped]),
      h('div', { class: 'row' },
        h('button', { class: 'clickable button danger', onclick: () => disconnect(), text: t('disconnect') }))));
}

// ---------------------------------------------------------------- errors

async function forgetGrant() {
  state.grant = null;
  await grantStore.clear();
}

async function handleGrantError(error) {
  if (error instanceof ApiError && error.kind === 'grant_invalid') {
    await forgetGrant();
    return showPairing('noLongerConnectedRescan');
  }
  return showFatal(error);
}

function showFatal(error) {
  const message = error instanceof ApiError || error instanceof CryptoError ? error.message : t('somethingWrong');
  console.error(error);
  state.view = () => showFatal(error);
  layout(
    h('h1', { text: t('importStopped') }),
    notice('error', h('span', { text: message })),
    h('div', { class: 'row' }, h('button', { class: 'clickable button', onclick: () => location.reload(), text: t('reload') })));
}

function showInsecure() {
  state.view = showInsecure;
  layout(
    h('h1', { text: t('insecureTitle') }),
    notice('error', h('span', { text: t('insecureContext') })));
}

/** Ends the connection and removes everything this importer stored in the browser. */
async function disconnect() {
  stopPairing();
  const grant = state.grant || (await grantStore.load());
  if (grant) {
    try {
      await api.disconnect(grant.importerToken);
    } catch {
      // The record is deleted locally either way.
    }
  }
  await forgetGrant();
  await state.progress.forget();
  await folderStore.clear();
  showLanding();
}

// ---------------------------------------------------------------- start

async function main() {
  applyTheme(readTheme());
  applyLanguage(readLanguage());
  root = h('div', { class: 'shell' });
  document.body.append(root);
  // Without a secure context the browser hides crypto.subtle, and pairing
  // would fail with a bare TypeError.
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) return showInsecure();
  // Checked up front, so Safari users learn it on the landing page, before
  // requesting an export, not after every photo is skipped.
  state.webp = canEncodeWebp();
  state.grant = await grantStore.load();
  const hash = location.hash.slice(1);
  const adapter = ADAPTERS.find((candidate) => candidate.id === hash);
  if (adapter && state.webp) showExport(adapter);
  else showLanding();
}

main();
