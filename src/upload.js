// Everything between an encrypted memory and the server: the importer API,
// the S3 upload, the reserve/upload/confirm queue and the import driver.

import { LIMITS, toBase64Url, fromBase64Url, wipe } from './util.js';
import { PROTOCOL_VERSION, mediaIdFor, wrapMediaKey, encodeMetadata, encryptPayload, newMediaKey } from './crypto.js';
import { t } from './i18n.js';

// ---------------------------------------------------------------------------
// Importer API
// ---------------------------------------------------------------------------

// The importer HTTP API on the twonly server. Every request goes out with
// `cache: 'no-store'` and `credentials: 'omit'`: nothing here may land in a
// browser cache, and no cookie is ever involved.

export class ApiError extends Error {
  constructor(kind, status, message) {
    super(message || (kind === 'bad_response' ? t('apiUnexpected') : kind));
    this.name = 'ApiError';
    /** 'grant_invalid' | 'outdated' | 'rate_limited' | 'gone' | 'server' | 'network' | 'bad_response' */
    this.kind = kind;
    this.status = status;
  }

  get transient() {
    return this.kind === 'network' || this.kind === 'server' || this.kind === 'rate_limited';
  }
}

export class ImporterApi {
  constructor({ baseUrl, fetchImpl = globalThis.fetch.bind(globalThis), version = PROTOCOL_VERSION }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.version = version;
  }

  async request(method, path, { bearer = null, body = undefined, signal = undefined } = {}) {
    const headers = { 'X-Twonly-Importer-Version': String(this.version) };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      throw new ApiError('network', 0, t('apiNetwork'));
    }
    if (response.status === 401) throw new ApiError('grant_invalid', 401, t('apiGrantInvalid'));
    if (response.status === 426) throw new ApiError('outdated', 426, t('apiOutdated'));
    if (response.status === 429) throw new ApiError('rate_limited', 429, t('apiRateLimited'));
    if (response.status === 410 || response.status === 404) throw new ApiError('gone', response.status, t('apiGone'));
    if (response.status >= 500) throw new ApiError('server', response.status, t('apiServer'));
    if (response.status === 204) return null;
    if (!response.ok) throw new ApiError('bad_response', response.status, t('apiUnexpectedStatus', response.status));
    try {
      return await response.json();
    } catch {
      throw new ApiError('bad_response', response.status, t('apiUnexpected'));
    }
  }

  /** Creates a pairing. `pollHash` is SHA-256(poll_secret). */
  async createPairing(pollHash) {
    const result = await this.request('POST', '/api/importer/pairings', {
      body: { poll_hash: toBase64Url(pollHash), version: this.version },
    });
    if (!result || typeof result.pairing_id !== 'string') throw new ApiError('bad_response', 200);
    return { pairingId: result.pairing_id, expiresAt: Number(result.expires_at) };
  }

  /** Long-polls the pairing. Returns null while it is unclaimed. */
  async pollPairing(pairingId, pollSecret, { signal } = {}) {
    const result = await this.request('GET', `/api/importer/pairings/${encodeURIComponent(pairingId)}`, {
      bearer: toBase64Url(pollSecret),
      signal,
    });
    if (result === null) return null;
    if (typeof result.envelope !== 'string' || typeof result.claimed_username !== 'string') {
      throw new ApiError('bad_response', 200);
    }
    return { envelope: fromBase64Url(result.envelope), claimedUsername: result.claimed_username };
  }

  usage(token) {
    return this.request('GET', '/api/importer/usage', { bearer: token });
  }

  /** At most three ready memories: `[{media_id, size, original_date}]`. */
  async reserve(token, items) {
    const result = await this.request('POST', '/api/importer/uploads', { bearer: token, body: { items } });
    if (!result || !Array.isArray(result.items)) throw new ApiError('bad_response', 200);
    return result.items;
  }

  /** Up to fifty media ids. */
  async confirm(token, mediaIds) {
    const result = await this.request('POST', '/api/importer/uploads/confirm', { bearer: token, body: { media_ids: mediaIds } });
    if (!result || !Array.isArray(result.items)) throw new ApiError('bad_response', 200);
    return result.items;
  }

  disconnect(token) {
    return this.request('DELETE', '/api/importer/session', { bearer: token });
  }
}

/** A thrown S3 failure. `transient` errors are retried with a fresh policy. */
export class UploadError extends Error {
  constructor(status, transient, message) {
    super(message || t('uploadFailedStatus', status));
    this.name = 'UploadError';
    this.status = status;
    this.transient = transient;
  }
}

/**
 * S3 POST with upload progress. The policy lives only in this call. An
 * expired policy (403 with "expired") is retried with a new one; other 4xx
 * are permanent.
 */
export function xhrUpload(policy, bytes, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(policy.fields)) form.append(key, value);
    form.append('file', new Blob([bytes]), 'file');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', policy.url);
    xhr.withCredentials = false;
    xhr.upload.onprogress = (event) => onProgress(event.loaded, event.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        const expired = xhr.status === 403 && /expired/i.test(xhr.responseText || '');
        reject(new UploadError(xhr.status, xhr.status >= 500 || expired, t('uploadRefused', xhr.status)));
      }
    };
    xhr.onerror = () => reject(new UploadError(0, true, t('uploadNetwork')));
    xhr.send(form);
  });
}

// ---------------------------------------------------------------------------
// Upload queue
// ---------------------------------------------------------------------------

// Reserve, upload, confirm.
//
// - At most `uploadConcurrency` memories transfer at once; each uploads its
//   thumbnail and its full object side by side.
// - Policies are requested only when an encrypted memory is ready and a
//   slot is free, for at most `reserveBatch` memories, used at once, kept
//   only in local variables for that attempt and dropped afterwards.
// - Confirmations go out at most `confirmDelayMs` after the first unconfirmed
//   upload (or once `confirmBatch` minus the transfers in flight are
//   waiting), so the server's cap on unconfirmed reservations is not reached
//   in normal operation.
// - Retries get a fresh policy, with exponential backoff. A reservation
//   refused only because confirmations are outstanding waits for them
//   instead, without using up an attempt.

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_ATTEMPTS = 6;

export class UploadQueue {
  /**
   * @param api ImporterApi
   * @param token the importer token (base64url)
   * @param upload (policy, bytes, onProgress) => Promise<void>
   * @param onEvent ({type, mediaId, ...}) => void; types: reserved, uploaded,
   *   done, already_uploaded, ownership_conflict, too_large, failed, retry,
   *   progress, stopped
   */
  constructor({ api, token, upload, onEvent = () => {}, limits = LIMITS, sleep = defaultSleep, now = () => Date.now(), confirmDelayMs = 1000 }) {
    this.api = api;
    this.token = token;
    this.upload = upload;
    this.onEvent = onEvent;
    this.limits = limits;
    this.sleep = sleep;
    this.now = now;
    this.confirmDelayMs = confirmDelayMs;
    this.ready = [];
    this.transfers = 0;
    this.reserving = false;
    this.toConfirm = [];
    this.confirming = null;
    this.confirmTimer = null;
    this.outstanding = 0;
    this.stopped = null;
    this.paused = false;
    this.idleWaiters = [];
    this.spaceWaiters = [];
  }

  /**
   * Free capacity for one more prepared memory. Producers await this. Up to
   * `uploadConcurrency` memories wait besides those transferring, which
   * bounds the encrypted bytes held here.
   */
  async waitForSpace() {
    while (!this.stopped && this.ready.length >= this.limits.uploadConcurrency) {
      await new Promise((resolve) => this.spaceWaiters.push(resolve));
    }
  }

  /**
   * Queues an encrypted memory: `{mediaId, originalDate, thumbnail, full}`.
   * Resolves once it is queued, not when it is uploaded.
   */
  async add(prepared) {
    await this.waitForSpace();
    if (this.stopped) return false;
    this.outstanding++;
    this.ready.push({ ...prepared, attempts: 0 });
    this.pump();
    return true;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.pump();
  }

  stop(reason, error = null) {
    if (this.stopped) return;
    this.stopped = { reason, error };
    clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    const left = this.ready.splice(0);
    for (const item of left) this.settle(item, 'not_uploaded', { reason });
    this.onEvent({ type: 'stopped', reason, error });
    this.wake();
  }

  /** Resolves when nothing is left to reserve, upload or confirm. */
  async finish() {
    for (;;) {
      if (this.outstanding === 0 && !this.confirming && this.toConfirm.length === 0) return this.stopped;
      if (this.toConfirm.length && !this.confirming && this.ready.length === 0 && this.transfers === 0) {
        await this.flushConfirm();
        continue;
      }
      await new Promise((resolve) => this.idleWaiters.push(resolve));
    }
  }

  wake() {
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
    if (this.ready.length < this.limits.uploadConcurrency || this.stopped) {
      for (const resolve of this.spaceWaiters.splice(0)) resolve();
    }
  }

  settle(item, type, extra = {}) {
    this.outstanding--;
    // Encrypted bytes are released as soon as the memory leaves the queue.
    item.full = null;
    item.thumbnail = null;
    this.onEvent({ type, mediaId: item.mediaId, sourceItemId: item.sourceItemId, ...extra });
    this.wake();
  }

  pump() {
    if (this.stopped || this.paused || this.reserving) return;
    const slots = this.limits.uploadConcurrency - this.transfers;
    if (slots <= 0 || this.ready.length === 0) return;
    const batch = this.ready.splice(0, Math.min(slots, this.limits.reserveBatch));
    this.reserving = true;
    this.transfers += batch.length;
    this.reserveAndTransfer(batch).finally(() => {
      this.reserving = false;
      this.pump();
    });
  }

  async reserveAndTransfer(batch) {
    let results;
    try {
      results = await this.api.reserve(this.token, batch.map((item) => ({
        media_id: item.mediaId,
        size: item.full.length,
        original_date: item.originalDate,
      })));
    } catch (error) {
      this.transfers -= batch.length;
      this.handleRequestError(error, batch);
      return;
    }
    const byId = new Map(results.map((result) => [result.media_id, result]));
    for (const item of batch) {
      const result = byId.get(item.mediaId);
      if (!result) {
        this.transfers--;
        this.retry(item, new ApiError('bad_response', 200, t('missingReservation')));
        continue;
      }
      switch (result.status) {
        case 'ok':
          this.onEvent({ type: 'reserved', mediaId: item.mediaId });
          // Not awaited: the transfers run side by side.
          this.transfer(item, result);
          break;
        case 'already_uploaded':
          this.transfers--;
          this.settle(item, 'already_uploaded');
          break;
        case 'ownership_conflict':
          this.transfers--;
          this.settle(item, 'ownership_conflict');
          break;
        case 'too_large':
          this.transfers--;
          this.settle(item, 'too_large');
          break;
        case 'too_many_pending':
          this.transfers--;
          this.afterConfirmations(item);
          break;
        case 'limit_reached':
          this.transfers--;
          this.ready.unshift(item);
          this.stop('limit_reached');
          break;
        default:
          this.transfers--;
          this.settle(item, 'failed', { reason: 'unexpected reservation answer' });
      }
    }
  }

  /**
   * Too many unconfirmed reservations on the server. While this queue has
   * transfers or confirmations of its own under way, the item waits for the
   * next confirmation and then goes back to the front, without using up an
   * attempt. Otherwise the pending reservations are not ours to confirm
   * (another importer, or attempts the server has not swept yet): a normal
   * retry with backoff.
   */
  async afterConfirmations(item) {
    for (;;) {
      if (this.stopped) break;
      if (this.confirming || this.toConfirm.length) {
        await this.flushConfirm();
        break;
      }
      if (this.transfers === 0) {
        this.retry(item, new ApiError('rate_limited', 200, t('waitingConfirmations')));
        return;
      }
      // A transfer of ours is still running: wait for it to finish (or fail).
      await new Promise((resolve) => this.idleWaiters.push(resolve));
    }
    if (this.stopped) {
      this.settle(item, 'not_uploaded', { reason: this.stopped.reason });
      return;
    }
    this.ready.unshift(item);
    this.pump();
  }

  async transfer(item, lease) {
    try {
      const expiresAt = Number(lease.expires_at) * 1000;
      const parts = [[lease.thumbnail_upload, item.thumbnail, 'thumbnail'], [lease.full_upload, item.full, 'full']];
      if (this.stopped) throw new UploadError(0, false, t('uploadStopped'));
      // An expired policy is never tried; the retry fetches a new one.
      if (parts.some(([policy]) => !policy) || !(this.now() < expiresAt)) throw new UploadError(0, true, t('uploadExpired'));
      // Both parts at once: for a photo, latency dominates, not bytes.
      const results = await Promise.allSettled(parts.map(([policy, bytes, part]) => this.upload(policy, bytes, (loaded, total) => {
        this.onEvent({ type: 'progress', mediaId: item.mediaId, part, loaded, total });
      })));
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      // A permanent failure wins over a transient one: retrying would not help.
      if (errors.length) throw errors.find((error) => !(error instanceof UploadError && error.transient)) || errors[0];
    } catch (error) {
      this.transfers--;
      if (this.stopped) {
        this.settle(item, 'not_uploaded', { reason: this.stopped.reason });
      } else if (error instanceof UploadError && error.transient) {
        this.retry(item, error);
      } else {
        this.settle(item, 'failed', { reason: error.message });
      }
      this.pump();
      return;
    } finally {
      // The lease is not referenced after this attempt.
      lease = null;
    }
    this.transfers--;
    this.onEvent({ type: 'uploaded', mediaId: item.mediaId });
    this.toConfirm.push(item);
    // The server allows 50 unconfirmed reservations per importer; uploads in
    // flight count too. The timer is not pushed back by later uploads, so a
    // steady stream of them still gets confirmed every `confirmDelayMs`.
    if (this.toConfirm.length >= this.limits.confirmBatch - this.limits.uploadConcurrency) {
      this.flushConfirm();
    } else if (!this.confirmTimer && !this.confirming) {
      this.confirmTimer = setTimeout(() => this.flushConfirm(), this.confirmDelayMs);
    }
    this.wake();
    this.pump();
  }

  retry(item, error) {
    item.attempts++;
    if (item.attempts >= MAX_ATTEMPTS) {
      this.settle(item, 'failed', { reason: error.message });
      return;
    }
    const delay = Math.min(60_000, 1000 * 2 ** (item.attempts - 1));
    this.onEvent({ type: 'retry', mediaId: item.mediaId, attempt: item.attempts, delay, reason: error.message });
    this.sleep(delay).then(() => {
      if (this.stopped) {
        this.settle(item, 'not_uploaded', { reason: this.stopped.reason });
        return;
      }
      this.ready.unshift(item);
      this.pump();
    });
  }

  handleRequestError(error, items) {
    if (error instanceof ApiError && (error.kind === 'grant_invalid' || error.kind === 'outdated')) {
      this.ready.unshift(...items);
      this.stop(error.kind, error);
      return;
    }
    if (error instanceof ApiError && error.transient) {
      for (const item of items) this.retry(item, error);
      return;
    }
    for (const item of items) this.settle(item, 'failed', { reason: error.message });
  }

  async flushConfirm() {
    clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    if (this.confirming) return this.confirming;
    if (this.toConfirm.length === 0) return;
    const batch = this.toConfirm.splice(0, this.limits.confirmBatch);
    this.confirming = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const results = await this.api.confirm(this.token, batch.map((item) => item.mediaId));
          const byId = new Map(results.map((result) => [result.media_id, result.status]));
          let limit = false;
          for (const item of batch) {
            const status = byId.get(item.mediaId);
            if (status === 'confirmed') this.settle(item, 'done');
            else if (status === 'limit_reached') {
              limit = true;
              this.settle(item, 'not_uploaded', { reason: 'limit_reached' });
            } else if (status === 'ownership_conflict') this.settle(item, 'ownership_conflict');
            else this.settle(item, 'failed', { reason: status || 'not confirmed' });
          }
          if (limit) this.stop('limit_reached');
          return;
        } catch (error) {
          if (error instanceof ApiError && error.transient && attempt < MAX_ATTEMPTS) {
            await this.sleep(Math.min(60_000, 1000 * 2 ** attempt));
            continue;
          }
          for (const item of batch) this.settle(item, 'failed', { reason: error.message });
          if (error instanceof ApiError && (error.kind === 'grant_invalid' || error.kind === 'outdated')) this.stop(error.kind, error);
          return;
        }
      }
    })();
    try {
      await this.confirming;
    } finally {
      this.confirming = null;
      this.wake();
    }
    if (this.toConfirm.length >= this.limits.confirmBatch) return this.flushConfirm();
    if (this.toConfirm.length) this.confirmTimer = setTimeout(() => this.flushConfirm(), this.confirmDelayMs);
  }
}

// ---------------------------------------------------------------------------
// Import driver
// ---------------------------------------------------------------------------

// From "here is one memory" to "queued for upload", the same for every source.
//
// `prepareMemory` is the per-memory work a worker does once the pixels are
// converted: wrap a fresh media key, encrypt full media, thumbnail and
// metadata. `runImport` drives the items through a converter and the upload
// queue with a byte budget, skipping what an earlier run finished.

/**
 * @param converted `{full: Uint8Array, thumbnail: Uint8Array, hadOverlay}` where
 *   images are WebP with EXIF and videos are the original bytes.
 */
export async function prepareMemory({ item, mediaId, grant, converted }) {
  const mediaKey = newMediaKey();
  try {
    const encryptedMediaKey = await wrapMediaKey(grant.kek, mediaKey);
    const metadata = encodeMetadata({
      source: item.source,
      mediaType: item.kind,
      createdAt: item.createdAt,
      location: item.location,
      hadOverlay: Boolean(item.overlay),
    });
    const thumbnail = encryptPayload({ addition: grant.addition, encryptedMediaKey, mediaKey, plaintext: converted.thumbnail, metadata });
    const full = encryptPayload({ addition: grant.addition, encryptedMediaKey, mediaKey, plaintext: converted.full });
    return {
      mediaId,
      sourceItemId: item.sourceItemId,
      originalDate: Math.floor(item.createdAt / 1000),
      thumbnail,
      full,
    };
  } finally {
    wipe(mediaKey);
  }
}

/** Waits until `bytes` fit in the budget, then holds them until `release`. */
export class ByteBudget {
  constructor(capacity = LIMITS.pipelineBudgetBytes) {
    this.capacity = capacity;
    this.used = 0;
    this.waiters = [];
  }

  async acquire(bytes) {
    // One item larger than the whole budget still runs, alone.
    const need = Math.min(bytes, this.capacity);
    while (this.used > 0 && this.used + need > this.capacity) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.used += need;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= need;
      for (const resolve of this.waiters.splice(0)) resolve();
    };
  }
}

/**
 * A live estimate of the time an import has left.
 *
 * Work is measured in source bytes (the export's file sizes), which tracks
 * both conversion and upload time. The rate comes from the last
 * `windowMs` of active time, so the estimate follows changes in the
 * connection, and paused time does not count. Items an earlier run already
 * uploaded are skipped instantly; `skip` takes them out of the work without
 * counting them as throughput, so a resumed import is not estimated too low.
 */
export class UploadEstimate {
  constructor({ totalBytes, now = () => Date.now(), windowMs = 2 * 60 * 1000, minActiveMs = 10_000 }) {
    this.remaining = Math.max(0, totalBytes);
    this.now = now;
    this.windowMs = windowMs;
    this.minActiveMs = minActiveMs;
    this.processed = 0;
    this.pausedTotal = 0;
    this.pausedAt = null;
    this.startedAt = now();
    /** `{at, processed}` in active time, oldest first; the first is the base. */
    this.samples = [{ at: 0, processed: 0 }];
  }

  /** Milliseconds of import time, without pauses. */
  active() {
    const paused = this.pausedTotal + (this.pausedAt === null ? 0 : this.now() - this.pausedAt);
    return this.now() - this.startedAt - paused;
  }

  /** An item finished (uploaded, skipped or failed) after real work. */
  finish(bytes) {
    this.processed += bytes;
    this.remaining = Math.max(0, this.remaining - bytes);
    this.samples.push({ at: this.active(), processed: this.processed });
    this.prune();
  }

  /** An item left the work without taking time (uploaded by an earlier run). */
  skip(bytes) {
    this.remaining = Math.max(0, this.remaining - bytes);
  }

  pause() {
    if (this.pausedAt === null) this.pausedAt = this.now();
  }

  resume() {
    if (this.pausedAt === null) return;
    this.pausedTotal += this.now() - this.pausedAt;
    this.pausedAt = null;
  }

  /** Keeps one sample at or before the window start as the base. */
  prune() {
    const start = this.active() - this.windowMs;
    while (this.samples.length > 1 && this.samples[1].at <= start) this.samples.shift();
  }

  /** Milliseconds left, or null while there is too little to go on. */
  estimate() {
    if (this.remaining === 0) return 0;
    const now = this.active();
    if (now < this.minActiveMs || this.processed === 0) return null;
    this.prune();
    const base = this.samples[0];
    let rate = (this.processed - base.processed) / (now - base.at);
    // Nothing finished within the window (one long video on a slow
    // connection): the average since the start is the best guess.
    if (!(rate > 0)) rate = this.processed / now;
    return this.remaining / rate;
  }
}

/**
 * The current upload speed: bytes sent to S3 over the last `windowMs`, from
 * the transfers' progress events. A retried transfer starts again from 0;
 * only bytes past what that part already reported are counted.
 */
export class UploadSpeed {
  constructor({ now = () => Date.now(), windowMs = 10_000 } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.startedAt = now();
    /** Bytes reported so far per `mediaId:part`. */
    this.sent = new Map();
    /** `{at, bytes}`, oldest first. */
    this.samples = [];
  }

  /** A progress event of one part (thumbnail or full) of one memory. */
  progress(mediaId, part, loaded) {
    const key = `${mediaId}:${part}`;
    const before = this.sent.get(key) ?? 0;
    // A lower value is a new attempt of the same part, starting from 0.
    const bytes = loaded >= before ? loaded - before : loaded;
    this.sent.set(key, loaded);
    if (bytes > 0) this.samples.push({ at: this.now(), bytes });
  }

  /** The memory left the queue: forget its parts. */
  forget(mediaId) {
    this.sent.delete(`${mediaId}:thumbnail`);
    this.sent.delete(`${mediaId}:full`);
  }

  /** Bytes per second, or null during the first seconds of the import. */
  rate() {
    const now = this.now();
    while (this.samples.length && this.samples[0].at <= now - this.windowMs) this.samples.shift();
    const span = Math.min(this.windowMs, now - this.startedAt);
    if (span < 2_000) return null;
    let bytes = 0;
    for (const sample of this.samples) bytes += sample.bytes;
    return (bytes / span) * 1000;
  }
}

/** Items in import order, after the user's date range. */
export function selectItems(items, { order = 'newest', from = null, to = null } = {}) {
  const selected = items.filter((item) => (from === null || item.createdAt >= from) && (to === null || item.createdAt < to));
  selected.sort((a, b) => (order === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
  return selected;
}

/** What an item costs in memory while it is between "read" and "uploaded". */
export function estimateBytes(item) {
  const media = item.main.size + (item.overlay ? item.overlay.size : 0);
  // Images: compressed input, decoded RGBA and canvas copies, WebP output and
  // its ciphertext. 12 MP × 4 × 2 bounds a typical phone photo.
  return item.kind === 'image' ? media * 3 + 96 * 1024 * 1024 : media * 3;
}

/**
 * Drives the import.
 *
 * @param convertAndPrepare (item, mediaId) => prepared memory (see prepareMemory)
 * @param progress `{isDone(mediaId), markQueued(mediaId)}`
 * @param onItem ({type: 'skipped_done'|'prepare_failed', item, mediaId, error}) => void
 */
export async function runImport({ items, grant, queue, convertAndPrepare, progress, budget = new ByteBudget(), concurrency = 2, onItem = () => {}, signal = null }) {
  let next = 0;
  const work = async () => {
    for (;;) {
      if (queue.stopped || (signal && signal.aborted)) return;
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      const mediaId = await mediaIdFor(grant.idKey, item.source, item.sourceItemId);
      if (progress.isDone(mediaId)) {
        onItem({ type: 'skipped_done', item, mediaId });
        continue;
      }
      const release = await budget.acquire(estimateBytes(item));
      let prepared;
      try {
        prepared = await convertAndPrepare(item, mediaId);
      } catch (error) {
        release();
        onItem({ type: 'prepare_failed', item, mediaId, error });
        continue;
      }
      // The budget covers the encrypted bytes until the queue has them; the
      // queue's own bound covers them after that.
      await queue.add(prepared);
      release();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, work));
  return queue.finish();
}
