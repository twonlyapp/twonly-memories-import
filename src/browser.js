// Browser plumbing for the page: IndexedDB storage, the remembered export
// folder, the conversion worker pool and the worker itself.
//
// The workers load src/worker.js, which calls startWorker().

import { LIMITS } from './util.js';
import { imageDimensions, checkImageSize, HEADER_BYTES, ImageLimitError, withExif } from './media.js';
import { prepareMemory } from './upload.js';
import { t, setLanguage } from './i18n.js';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

// IndexedDB: the grant (one record, with non-extractable CryptoKeys),
// per-memory progress `{state, bytes}` and the remembered export folder's
// handle. Never media, never upload policies,
// never the pairing private key or poll secret. Every access is wrapped: in
// a private window or with blocked site data the page keeps the grant in
// memory only.

const DB_NAME = 'twonly-importer';
const VERSION = 2;

let opening = null;

function open() {
  if (!opening) {
    opening = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('grant')) db.createObjectStore('grant');
          if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress');
          if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return opening;
}

function run(storeName, mode, action) {
  return open().then((db) => new Promise((resolve) => {
    if (!db) return resolve(undefined);
    try {
      const tx = db.transaction(storeName, mode);
      const result = action(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
}

let memoryGrant = null;

export const grantStore = {
  async load() {
    const stored = await run('grant', 'readonly', (store) => store.get('current'));
    const grant = stored || memoryGrant;
    if (!grant) return null;
    if (!(grant.expiresAt * 1000 > Date.now()) || !(grant.kek instanceof CryptoKey) || !(grant.idKey instanceof CryptoKey)) {
      await this.clear();
      return null;
    }
    return grant;
  },
  async save(grant) {
    memoryGrant = grant;
    await run('grant', 'readwrite', (store) => store.put(grant, 'current'));
  },
  async clear() {
    memoryGrant = null;
    await run('grant', 'readwrite', (store) => store.delete('current'));
  },
};

/** The export folder's directory handle, per source. */
export const folderStore = {
  async load(sourceId) {
    const handle = await run('handles', 'readonly', (store) => store.get(sourceId));
    return handle && handle.kind === 'directory' ? handle : null;
  },
  async save(sourceId, handle) {
    await run('handles', 'readwrite', (store) => store.put(handle, sourceId));
  },
  async clear() {
    await run('handles', 'readwrite', (store) => store.clear());
  },
};

/**
 * Progress per media id, kept in memory and written in batches (every 200
 * changes or every second).
 */
export class ProgressStore {
  constructor() {
    this.states = new Map();
    this.dirty = new Map();
    this.timer = null;
  }

  async load() {
    const all = await run('progress', 'readonly', (store) => store.getAll());
    const keys = await run('progress', 'readonly', (store) => store.getAllKeys());
    if (Array.isArray(all) && Array.isArray(keys)) {
      keys.forEach((key, i) => this.states.set(key, all[i]));
    }
    return this;
  }

  isDone(mediaId) {
    const state = this.states.get(mediaId);
    return Boolean(state && (state.state === 'done' || state.state === 'already_uploaded'));
  }

  set(mediaId, state, bytes = 0) {
    const value = { state, bytes };
    this.states.set(mediaId, value);
    this.dirty.set(mediaId, value);
    if (this.dirty.size >= 200) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 1000);
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.dirty.size === 0) return;
    const batch = [...this.dirty];
    this.dirty.clear();
    await run('progress', 'readwrite', (store) => {
      for (const [key, value] of batch) store.put(value, key);
    });
  }

  async forget() {
    this.states.clear();
    this.dirty.clear();
    await run('progress', 'readwrite', (store) => store.clear());
  }
}

// ---------------------------------------------------------------------------
// Remembered export folder
// ---------------------------------------------------------------------------

// A remembered export folder (File System Access API). After a reload the
// page can read the same folder again with one click instead of a new
// selection. Only the directory handle is stored (IndexedDB); the browser asks
// for read permission again on a new visit.
//
// Not every browser offers this: Firefox and Safari do not, and Brave has it
// switched off by default (brave://flags/#file-system-access-api). Those use
// the normal folder or ZIP selection.

const MAX_DEPTH = 16;

/**
 * Whether this browser can encode WebP, which the conversion workers need.
 * Safari cannot: it returns PNG when asked for 'image/webp'. Synchronous on
 * purpose: the page must never wait on this check (an async encode that
 * never settles would leave the page blank).
 */
export function canEncodeWebp() {
  try {
    if (typeof OffscreenCanvas !== 'function') return false;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    return canvas.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    return false;
  }
}

export function supportsFolderHandles() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

export async function pickFolder() {
  return globalThis.showDirectoryPicker({ id: 'twonly-export', mode: 'read' });
}

/** True when the page may read the folder; asks if needed (needs a click). */
export async function ensureReadPermission(handle) {
  const options = { mode: 'read' };
  if ((await handle.queryPermission(options)) === 'granted') return true;
  return (await handle.requestPermission(options)) === 'granted';
}

/**
 * Every file below `handle` as `{file, relativePath}`, the shape a folder
 * selection gives, with the folder's own name as the first path segment.
 * Bounded by the entry limit and a depth limit.
 */
export async function readFolder(handle, { limits = LIMITS } = {}) {
  const out = [];
  const walk = async (directory, prefix, depth) => {
    if (depth > MAX_DEPTH) return;
    for await (const entry of directory.values()) {
      const path = `${prefix}/${entry.name}`;
      if (entry.kind === 'file') {
        if (out.length >= limits.maxEntries) throw new Error(t('tooManyInFolder'));
        out.push({ file: await entry.getFile(), relativePath: path });
      } else if (entry.kind === 'directory') {
        await walk(entry, path, depth + 1);
      }
    }
  };
  await walk(handle, handle.name, 0);
  out.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Worker pool (page side)
// ---------------------------------------------------------------------------

// A pool of conversion workers. A job that stalls is abandoned: its worker is
// terminated and replaced.

/** A memory that is skipped (too large, unreadable…) rather than failed. */
export class SkippedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkippedError';
  }
}

export class WorkerPool {
  /** `url` is the worker module, src/worker.js. */
  static async create({ url, size }) {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error(t('workerNotLoaded'));
    return new WorkerPool(url, size);
  }

  constructor(url, size) {
    this.url = url;
    this.size = size;
    this.idle = [];
    this.waiting = [];
    this.nextId = 1;
    for (let i = 0; i < size; i++) this.idle.push(this.spawn());
  }

  spawn() {
    return new Worker(this.url, { type: 'module', name: 'twonly-importer-worker' });
  }

  async acquire() {
    if (this.idle.length) return this.idle.pop();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(worker) {
    const next = this.waiting.shift();
    if (next) next(worker);
    else this.idle.push(worker);
  }

  /** Runs one job; transfers `transfer`. Rejects with SkippedError for items to skip. */
  async run(job, transfer = [], timeoutMs = LIMITS.operationTimeoutMs * 2) {
    let worker = await this.acquire();
    const id = this.nextId++;
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          // A stuck decode or encode: replace the worker.
          worker.terminate();
          worker = this.spawn();
          reject(new SkippedError(t('tookTooLong')));
        }, timeoutMs);
        worker.onmessage = ({ data }) => {
          if (data.id !== id) return;
          clearTimeout(timer);
          if (data.ok) resolve(data.prepared);
          else reject(data.skip ? new SkippedError(data.message) : new Error(data.message));
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          event.preventDefault();
          worker.terminate();
          worker = this.spawn();
          reject(new Error(t('workerFailed')));
        };
        worker.postMessage({ id, job }, transfer);
      });
    } finally {
      this.release(worker);
    }
  }

}

/**
 * One frame of a video for its thumbnail, from a hidden <video> on the main
 * thread (workers have no video element). Checks the duration limit.
 */
export async function videoFrame(blob, { timeoutMs = LIMITS.operationTimeoutMs } = {}) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const cleanup = () => {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  };
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SkippedError(t('videoTimeout'))), timeoutMs);
      const fail = () => {
        clearTimeout(timer);
        reject(new SkippedError(t('videoCannotPlay')));
      };
      video.onerror = fail;
      video.onloadedmetadata = () => {
        if (!Number.isFinite(video.duration) || video.duration > LIMITS.maxVideoSeconds) {
          clearTimeout(timer);
          reject(new SkippedError(t('videoTooLong')));
          return;
        }
        if (video.videoWidth > LIMITS.maxImageDimension || video.videoHeight > LIMITS.maxImageDimension) {
          clearTimeout(timer);
          reject(new SkippedError(t('videoTooLarge')));
          return;
        }
        video.currentTime = Math.min(0.5, video.duration / 2);
      };
      video.onseeked = async () => {
        try {
          const frame = await createImageBitmap(video);
          clearTimeout(timer);
          resolve(frame);
        } catch {
          fail();
        }
      };
      video.src = url;
    });
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Worker (worker side)
// ---------------------------------------------------------------------------

// Converts and encrypts one memory per message. Receives Blobs (cheap to
// clone), the grant's non-extractable KEK handle and, for videos, one decoded
// frame. Sends back only ciphertext, with its ArrayBuffers transferred.

async function headerOf(blob) {
  return new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer());
}

async function encodeWebp(canvas, quality) {
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
  // Safari returns PNG when it cannot encode WebP.
  if (blob.type !== 'image/webp') throw new SkippedError(t('noWebp'));
  return new Uint8Array(await blob.arrayBuffer());
}

function scaled(width, height, longSide) {
  const scale = Math.min(1, longSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function thumbnail(source, width, height, metadata) {
  const size = scaled(width, height, LIMITS.thumbnailLongSide);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d');
  context.drawImage(source, 0, 0, size.width, size.height);
  for (const quality of [0.8, 0.65, 0.5, 0.35, 0.2]) {
    const webp = withExif(await encodeWebp(canvas, quality), metadata);
    if (webp.length <= LIMITS.thumbnailMaxBytes) return webp;
  }
  throw new SkippedError(t('thumbnailTooLarge'));
}

async function convertImage({ main, overlay, item }) {
  const metadata = { createdAt: item.createdAt, location: item.location };
  try {
    checkImageSize(imageDimensions(await headerOf(main)));
    if (overlay) checkImageSize(imageDimensions(await headerOf(overlay)));
  } catch (error) {
    if (error instanceof ImageLimitError) throw new SkippedError(error.message);
    throw error;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(main, { imageOrientation: 'from-image' });
  } catch {
    throw new SkippedError(t('photoUnreadable'));
  }
  const { width, height } = bitmap;
  if (width * height > LIMITS.maxImagePixels) throw new SkippedError(t('photoTooLarge'));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  if (overlay) {
    try {
      const layer = await createImageBitmap(overlay);
      // Overlays are stretched to the photo, as the platform shows them.
      context.drawImage(layer, 0, 0, width, height);
      layer.close();
    } catch {
      throw new SkippedError(t('overlayUnreadable'));
    }
  }
  const full = withExif(await encodeWebp(canvas, 0.9), metadata);
  const thumb = await thumbnail(canvas, width, height, metadata);
  return { full, thumbnail: thumb };
}

async function convertVideo({ main, frame, item }) {
  if (!frame) throw new SkippedError(t('noFrame'));
  const metadata = { createdAt: item.createdAt, location: item.location };
  const thumb = await thumbnail(frame, frame.width, frame.height, metadata);
  frame.close();
  // Videos are uploaded unchanged.
  const full = new Uint8Array(await main.arrayBuffer());
  return { full, thumbnail: thumb };
}

export function startWorker() {
  self.onmessage = async ({ data }) => {
    const { id, job } = data;
    setLanguage(job.lang);
    try {
      const converted = job.item.kind === 'video' ? await convertVideo(job) : await convertImage(job);
      const prepared = await prepareMemory({ item: job.item, mediaId: job.mediaId, grant: job.grant, converted });
      self.postMessage({ id, ok: true, prepared }, [prepared.full.buffer, prepared.thumbnail.buffer]);
    } catch (error) {
      self.postMessage({ id, ok: false, skip: error instanceof SkippedError, message: String((error && error.message) || error) });
    }
  };
}
