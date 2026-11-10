import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UploadQueue, ApiError, UploadError, UploadEstimate, UploadSpeed } from '../../src/upload.js';
import { LIMITS } from '../../src/util.js';

/** A server and S3 in memory, with the importer API's semantics. */
function fakeServer({ limitBytes = Infinity, existing = new Set(), foreign = new Set() } = {}) {
  const state = { reserveCalls: [], confirmCalls: [], leases: new Map(), stored: new Map(), confirmed: new Set(), inFlight: 0, maxInFlight: 0, failNext: 0, issued: 0, used: new Set(), expireNext: 0, unauthorized: false, usedBytes: 0 };
  let leaseCounter = 0;
  const api = {
    async reserve(token, items) {
      if (state.unauthorized) throw new ApiError('grant_invalid', 401);
      assert.ok(items.length <= LIMITS.reserveBatch, 'at most three per reservation');
      state.reserveCalls.push(items.map((i) => i.media_id));
      return items.map((item) => {
        if (state.confirmed.has(item.media_id) || existing.has(item.media_id)) return { media_id: item.media_id, status: 'already_uploaded' };
        if (foreign.has(item.media_id)) return { media_id: item.media_id, status: 'ownership_conflict' };
        if (state.usedBytes + item.size > limitBytes) return { media_id: item.media_id, status: 'limit_reached' };
        const id = ++leaseCounter;
        state.issued++;
        const expired = state.expireNext > 0 && state.expireNext--;
        const lease = { media_id: item.media_id, status: 'ok', expires_at: expired ? Math.floor(Date.now() / 1000) - 1 : Math.floor(Date.now() / 1000) + 300, thumbnail_upload: { url: 'https://s3.test/', fields: { key: `thumb/${item.media_id}`, lease: String(id) } }, full_upload: { url: 'https://s3.test/', fields: { key: `full/${item.media_id}`, lease: String(id) } } };
        state.leases.set(id, item.media_id);
        return lease;
      });
    },
    async confirm(token, ids) {
      assert.ok(ids.length <= LIMITS.confirmBatch, 'at most fifty per confirmation');
      state.confirmCalls.push(ids);
      return ids.map((id) => {
        if (!state.stored.has(`full/${id}`) || !state.stored.has(`thumb/${id}`)) return { media_id: id, status: 'missing_upload' };
        const size = state.stored.get(`full/${id}`);
        if (!state.confirmed.has(id) && state.usedBytes + size > limitBytes) return { media_id: id, status: 'limit_reached' };
        if (!state.confirmed.has(id)) state.usedBytes += size;
        state.confirmed.add(id);
        return { media_id: id, status: 'confirmed' };
      });
    },
  };
  const upload = async (policy, bytes) => {
    const marker = `${policy.fields.lease}/${policy.fields.key}`;
    assert.ok(!state.used.has(marker), 'a policy is never reused');
    state.used.add(marker);
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    state.inFlight--;
    if (state.failNext > 0) {
      state.failNext--;
      throw new UploadError(503, true);
    }
    state.stored.set(policy.fields.key, bytes.length);
  };
  return { api, upload, state };
}

const prepared = (i, size = 100) => ({ mediaId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, sourceItemId: `item-${i}`, originalDate: 1700000000 + i, thumbnail: new Uint8Array(10), full: new Uint8Array(size) });

async function run(queue, count, size) {
  const events = [];
  queue.onEvent = (event) => events.push(event);
  let refused = 0;
  for (let i = 0; i < count; i++) if (!(await queue.add(prepared(i, size)))) refused++;
  const stopped = await queue.finish();
  return { events, stopped, refused, byType: (type) => events.filter((e) => e.type === type) };
}

const noSleep = () => Promise.resolve();

test('uploads everything with bounded transfers and never stockpiles policies', async () => {
  const { api, upload, state } = fakeServer();
  const queue = new UploadQueue({ api, token: 't', upload, sleep: noSleep, confirmDelayMs: 5 });
  const { byType, stopped } = await run(queue, 120);
  assert.equal(stopped, null);
  assert.equal(byType('done').length, 120);
  assert.equal(state.confirmed.size, 120);
  // Thumbnail and full object of each memory go side by side.
  assert.ok(state.maxInFlight <= LIMITS.uploadConcurrency * 2, `max in flight ${state.maxInFlight}`);
  assert.ok(state.maxInFlight > LIMITS.uploadConcurrency, `transfers run in parallel (${state.maxInFlight})`);
  // Every issued lease was used right away: one per memory, none spare.
  assert.equal(state.issued, 120);
  assert.ok(state.confirmCalls.every((ids) => ids.length <= 50));
});

test('a full pending cap waits for confirmations instead of using up attempts', async () => {
  const { api, upload, state } = fakeServer();
  // The server's cap on unconfirmed reservations, scaled down.
  const cap = 4;
  const pending = new Set();
  let refusals = 0;
  const reserve = api.reserve;
  api.reserve = async (token, items) => {
    const answers = [];
    for (const item of items) {
      if (!pending.has(item.media_id) && !state.confirmed.has(item.media_id) && pending.size >= cap) {
        refusals++;
        answers.push({ media_id: item.media_id, status: 'too_many_pending' });
        continue;
      }
      const [answer] = await reserve(token, [item]);
      if (answer.status === 'ok') pending.add(item.media_id);
      answers.push(answer);
    }
    return answers;
  };
  const confirm = api.confirm;
  api.confirm = async (token, ids) => {
    const answers = await confirm(token, ids);
    for (const id of ids) pending.delete(id);
    return answers;
  };
  const queue = new UploadQueue({ api, token: 't', upload, sleep: noSleep, confirmDelayMs: 50 });
  const { byType } = await run(queue, 40);
  assert.ok(refusals > 0, 'the cap was reached');
  assert.equal(byType('done').length, 40);
  assert.equal(byType('failed').length, 0);
  assert.equal(byType('retry').length, 0, 'no backoff while our own confirmations are outstanding');
});

test('skips what is already uploaded and reports ownership conflicts', async () => {
  const { api, upload, state } = fakeServer({ existing: new Set([prepared(1).mediaId]), foreign: new Set([prepared(2).mediaId]) });
  const queue = new UploadQueue({ api, token: 't', upload, sleep: noSleep, confirmDelayMs: 5 });
  const { byType } = await run(queue, 5);
  assert.deepEqual(byType('already_uploaded').map((e) => e.mediaId), [prepared(1).mediaId]);
  assert.deepEqual(byType('ownership_conflict').map((e) => e.mediaId), [prepared(2).mediaId]);
  assert.equal(byType('done').length, 3);
  assert.ok(!state.stored.has(`full/${prepared(2).mediaId}`), 'nothing uploaded over another import');
});

test('retries a failed transfer with a fresh policy', async () => {
  const { api, upload, state } = fakeServer();
  state.failNext = 2;
  const queue = new UploadQueue({ api, token: 't', upload, sleep: noSleep, confirmDelayMs: 5 });
  const { byType } = await run(queue, 4);
  assert.equal(byType('done').length, 4);
  assert.ok(byType('retry').length >= 1);
  assert.ok(state.issued > 4, 'retries reserved again');
});

test('an expired policy is never used', async () => {
  const { api, upload, state } = fakeServer();
  state.expireNext = 1;
  const queue = new UploadQueue({ api, token: 't', upload, sleep: noSleep, confirmDelayMs: 5 });
  const { byType } = await run(queue, 2);
  assert.equal(byType('done').length, 2);
  assert.equal(byType('retry')[0].reason, 'upload permission expired');
  assert.equal(state.used.size, 4, 'only the fresh policies were used');
});

test('stops cleanly at the storage limit and reports what did not fit', async () => {
  const { api, upload } = fakeServer({ limitBytes: 1000 });
  const queue = new UploadQueue({ api, token: 't', upload, sleep: noSleep, confirmDelayMs: 5 });
  const { byType, stopped, refused } = await run(queue, 30, 100);
  assert.equal(stopped.reason, 'limit_reached');
  const done = byType('done').length;
  assert.ok(done >= 8 && done <= 10, `done ${done}`);
  // Every memory is accounted for: confirmed, stopped in the queue, or refused after the stop.
  assert.equal(done + byType('not_uploaded').length + refused, 30);
});

test('a revoked grant stops the queue', async () => {
  const { api, upload, state } = fakeServer();
  state.unauthorized = true;
  const queue = new UploadQueue({ api, token: 't', upload, sleep: noSleep, confirmDelayMs: 5 });
  const { stopped, byType } = await run(queue, 3);
  assert.equal(stopped.reason, 'grant_invalid');
  assert.equal(byType('done').length, 0);
});

test('pause holds new reservations until resume', async () => {
  const { api, upload, state } = fakeServer();
  const queue = new UploadQueue({ api, token: 't', upload, sleep: noSleep, confirmDelayMs: 5 });
  queue.pause();
  await queue.add(prepared(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.reserveCalls.length, 0);
  queue.resume();
  await queue.finish();
  assert.equal(state.confirmed.size, 1);
});

// ---------------------------------------------------------------------------
// Time-left estimate
// ---------------------------------------------------------------------------

function clock() {
  let time = 1_000_000;
  return { now: () => time, advance: (ms) => { time += ms; } };
}

test('the estimate waits for data, then follows the throughput', () => {
  const c = clock();
  const eta = new UploadEstimate({ totalBytes: 1000, now: c.now });
  assert.equal(eta.estimate(), null, 'nothing finished yet');
  c.advance(5_000);
  eta.finish(50);
  assert.equal(eta.estimate(), null, 'too little time to go on');
  c.advance(5_000);
  eta.finish(50);
  // 100 bytes in 10 s, 900 left: 90 s.
  assert.equal(eta.estimate(), 90_000);
});

test('items uploaded by an earlier run do not count as throughput', () => {
  const c = clock();
  const eta = new UploadEstimate({ totalBytes: 10_000, now: c.now });
  eta.skip(9_000);
  c.advance(10_000);
  eta.finish(100);
  // 100 bytes in 10 s, 900 left: 90 s, not "done in a moment".
  assert.equal(eta.estimate(), 90_000);
});

test('paused time does not slow the estimate down', () => {
  const c = clock();
  const eta = new UploadEstimate({ totalBytes: 1000, now: c.now });
  c.advance(10_000);
  eta.finish(100);
  eta.pause();
  c.advance(60 * 60_000);
  assert.equal(eta.estimate(), 90_000, 'frozen while paused');
  eta.resume();
  assert.equal(eta.estimate(), 90_000, 'the pause is not counted');
});

test('the estimate reaches zero when everything is done', () => {
  const c = clock();
  const eta = new UploadEstimate({ totalBytes: 1000, now: c.now });
  c.advance(10_000);
  eta.finish(600);
  eta.skip(400);
  assert.equal(eta.estimate(), 0);
});

test('a slow connection follows the recent rate', () => {
  const c = clock();
  const eta = new UploadEstimate({ totalBytes: 1_000_000, now: c.now, windowMs: 60_000 });
  for (let i = 0; i < 120; i++) {
    c.advance(1_000);
    eta.finish(1_000);
  }
  for (let i = 0; i < 120; i++) {
    c.advance(1_000);
    eta.finish(100);
  }
  // 868,000 bytes left at the recent 100 bytes per second, not the
  // 550 bytes per second average since the start.
  const left = eta.estimate();
  assert.ok(Math.abs(left - 8_680_000) < 200_000, `estimate ${left}`);
});

test('a long gap without finished items falls back to the overall average', () => {
  const c = clock();
  const eta = new UploadEstimate({ totalBytes: 2_000, now: c.now, windowMs: 60_000 });
  c.advance(20_000);
  eta.finish(1_000);
  c.advance(180_000);
  // Nothing finished in the last minute: 1,000 bytes in 200 s overall.
  assert.equal(eta.estimate(), 200_000);
});

// ---------------------------------------------------------------------------
// Upload speed
// ---------------------------------------------------------------------------

test('upload speed counts each byte once, over the recent window', () => {
  const c = clock();
  const speed = new UploadSpeed({ now: c.now, windowMs: 10_000 });
  assert.equal(speed.rate(), null, 'no figure in the first seconds');
  // Two parts in parallel, progress reported cumulatively.
  for (let s = 1; s <= 10; s++) {
    c.advance(1_000);
    speed.progress('a', 'full', s * 100_000);
    speed.progress('b', 'full', s * 50_000);
  }
  // 1,000,000 + 500,000 bytes in 10 s.
  assert.equal(speed.rate(), 150_000);
  // Nothing sent for 10 s: the speed drops to 0.
  c.advance(10_000);
  assert.equal(speed.rate(), 0);
});

test('a retried part is counted from its new start', () => {
  const c = clock();
  const speed = new UploadSpeed({ now: c.now, windowMs: 10_000 });
  c.advance(5_000);
  speed.progress('a', 'full', 400_000);
  speed.forget('a');
  speed.progress('a', 'full', 100_000);
  assert.equal(speed.rate(), 100_000, '500,000 bytes sent in 5 s');
});
