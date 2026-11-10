// Source adapters. Each one turns an export's files into a list of memories.
// A new platform needs an adapter in ADAPTERS, its export instructions
// (SOURCE_INFO in app.js), a fixture export for the tests and its display
// name in the app. No server change.

import { LIMITS } from './util.js';
import { t } from './i18n.js';

export class AdapterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdapterError';
  }
}

/**
 * Reads and parses one metadata JSON file within the size limit. The result
 * is plain data: adapters read fields with hasOwnProperty and never merge it
 * into application objects.
 */
export async function readJsonFile(file, limits = LIMITS) {
  if (file.size > limits.maxMetadataBytes) throw new AdapterError(t('fileTooLarge', file.name));
  const blob = await file.open(limits.maxMetadataBytes);
  if (blob.size > limits.maxMetadataBytes) throw new AdapterError(t('fileTooLarge', file.name));
  const text = await blob.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new AdapterError(t('fileNotJson', file.name));
  }
}

// ---------------------------------------------------------------------------
// Snapchat
// ---------------------------------------------------------------------------

// Snapchat "My Data" export with media files.
//
// Layout (one or more ZIP parts, or the unpacked folder):
//   memories/<YYYY-MM-DD>_<mid>-main.(jpg|mp4)
//   memories/<YYYY-MM-DD>_<mid>-overlay.png        (captions, stickers)
//   json/memories_history.json                     {"Saved Media": [...]}
//
// The filename date is the UTC date. The JSON has the exact UTC time, the
// media type and the location, and names the `mid` in its download links,
// but recent exports leave those links empty. Then a record is joined to its
// file by UTC date, media type and the file's modification time, which ZIP
// stores as local wall-clock time (an unknown whole-quarter-hour offset from
// UTC). The `mid` from the filename is the stable item id either way.

const FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})_([0-9A-Za-z][0-9A-Za-z-]{0,127})-(main|overlay)\.([A-Za-z0-9]{2,5})$/;
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov']);
const OVERLAY_EXTENSIONS = new Set(['png', 'webp']);
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/;
const LOCATION_PATTERN = /^Latitude, Longitude: (-?\d{1,3}(?:\.\d+)?), (-?\d{1,3}(?:\.\d+)?)$/;
const MID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z-]{0,127}$/;
const DAY = 24 * 60 * 60 * 1000;
const QUARTER_HOUR = 15 * 60 * 1000;
/** Furthest a file's local time can be from UTC (UTC-12 … UTC+14), plus slack. */
const MAX_ZONE_OFFSET = 15 * 60 * 60 * 1000;
/** How far the file time may drift from the record beyond a whole zone offset. */
const MAX_DRIFT = 5 * 60 * 1000;

function isMemoriesDir(dir) {
  const segments = dir.split('/');
  return segments[segments.length - 1] === 'memories';
}

function isHistoryJson(file) {
  return file.name === 'memories_history.json' && file.dir.split('/').pop() === 'json';
}

export function parseUtcDate(text) {
  const match = typeof text === 'string' ? DATE_PATTERN.exec(text) : null;
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const time = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(time);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  if (y < 2000 || time > Date.now() + DAY) return null;
  return time;
}

export function parseLocation(text) {
  const match = typeof text === 'string' ? LOCATION_PATTERN.exec(text.trim()) : null;
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  // Snapchat writes 0.0, 0.0 when it has no location.
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

/**
 * The `mid` query parameter of a download link. The link is parsed only for
 * this id and never fetched or shown.
 */
export function midFromLink(link) {
  if (typeof link !== 'string' || link.length === 0 || link.length > LIMITS.maxMetadataFieldChars) return null;
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const mid = url.searchParams.get('mid');
  return mid && MID_PATTERN.test(mid) ? mid : null;
}

function utcDay(time) {
  return Math.floor(time / DAY);
}

/**
 * How badly a file time fits a record. A ZIP time is local wall-clock, so
 * any whole quarter-hour offset within the zone range is free; what is left
 * over is drift. A loose file has a real instant, where the offset is 0.
 */
function matchCost(file, recordTime) {
  if (file.mtimeEpoch !== null && file.mtimeEpoch !== undefined) {
    const drift = Math.abs(file.mtimeEpoch - recordTime);
    if (drift <= MAX_DRIFT) return drift;
  }
  if (file.mtimeNaive !== null && file.mtimeNaive !== undefined) {
    const difference = file.mtimeNaive - recordTime;
    if (Math.abs(difference) <= MAX_ZONE_OFFSET) {
      const drift = Math.abs(difference - Math.round(difference / QUARTER_HOUR) * QUARTER_HOUR);
      if (drift <= MAX_DRIFT) return drift + Math.abs(difference) / 1e6;
    }
  }
  return Infinity;
}

function validateRecords(json, limits) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new AdapterError(t('historyFormat'));
  const list = Object.prototype.hasOwnProperty.call(json, 'Saved Media') ? json['Saved Media'] : null;
  if (!Array.isArray(list)) throw new AdapterError(t('historyNoList'));
  if (list.length > limits.maxMetadataRecords) throw new AdapterError(t('historyTooMany'));
  const records = [];
  let invalid = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      invalid++;
      continue;
    }
    const field = (name) => {
      const value = Object.prototype.hasOwnProperty.call(raw, name) ? raw[name] : undefined;
      return typeof value === 'string' && value.length <= limits.maxMetadataFieldChars ? value : null;
    };
    const time = parseUtcDate(field('Date'));
    const type = (field('Media Type') || '').toLowerCase();
    const kind = type === 'image' ? 'image' : type === 'video' ? 'video' : null;
    if (time === null || kind === null) {
      invalid++;
      continue;
    }
    records.push({
      time,
      kind,
      location: parseLocation(field('Location')),
      mid: midFromLink(field('Download Link')) || midFromLink(field('Media Download Url')),
      used: false,
    });
  }
  return { records, invalid };
}

export const snapchat = Object.freeze({
  id: 'snapchat',
  displayName: 'Snapchat',

  /** Whether the selection looks like a Snapchat export. */
  detect(files) {
    for (const file of files) {
      if (isHistoryJson(file)) return true;
      if (isMemoriesDir(file.dir) && FILE_PATTERN.test(file.name)) return true;
    }
    return false;
  },

  /**
   * Builds the item list. Reads only memories_history.json; media stay
   * references until the pipeline opens them.
   */
  async index(files, { limits = LIMITS } = {}) {
    const byMid = new Map();
    const skipped = [];
    let history = null;
    for (const file of files) {
      if (isHistoryJson(file)) {
        history = history || file;
        continue;
      }
      if (!isMemoriesDir(file.dir)) continue;
      const match = FILE_PATTERN.exec(file.name);
      if (!match) {
        if (file.name !== 'memories.html') skipped.push({ path: file.path, reason: t('skipUnrecognised') });
        continue;
      }
      const [, y, mo, d, mid, role, rawExtension] = match;
      const extension = rawExtension.toLowerCase();
      const dayTime = Date.UTC(Number(y), Number(mo) - 1, Number(d));
      if (!Number.isFinite(dayTime)) {
        skipped.push({ path: file.path, reason: t('skipInvalidDate') });
        continue;
      }
      const entry = byMid.get(mid) || { mid, day: utcDay(dayTime), main: null, overlay: null, kind: null };
      if (role === 'main') {
        const kind = IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : null;
        if (!kind) {
          skipped.push({ path: file.path, reason: t('skipUnsupportedType') });
          continue;
        }
        if (entry.main) {
          skipped.push({ path: file.path, reason: t('skipSecondMain') });
          continue;
        }
        entry.main = file;
        entry.kind = kind;
        entry.day = utcDay(dayTime);
      } else {
        if (!OVERLAY_EXTENSIONS.has(extension) || entry.overlay) {
          skipped.push({ path: file.path, reason: t('skipUnsupportedOverlay') });
          continue;
        }
        entry.overlay = file;
      }
      byMid.set(mid, entry);
    }

    let records = [];
    let invalidRecords = 0;
    if (history) {
      const parsed = validateRecords(await readJsonFile(history, limits), limits);
      records = parsed.records;
      invalidRecords = parsed.invalid;
    }

    const items = [];
    const pending = [];
    const recordsByMid = new Map();
    for (const record of records) if (record.mid && !recordsByMid.has(record.mid)) recordsByMid.set(record.mid, record);

    for (const entry of byMid.values()) {
      if (!entry.main) {
        skipped.push({ path: entry.overlay.path, reason: t('skipOverlayAlone') });
        continue;
      }
      const record = recordsByMid.get(entry.mid);
      if (record && record.kind === entry.kind && !record.used) {
        record.used = true;
        items.push(makeItem(entry, record));
      } else {
        pending.push(entry);
      }
    }

    // Join the rest by UTC day, kind and file time, best fits first. A record
    // on the neighbouring day is allowed when the same day has none left.
    const buckets = new Map();
    for (const record of records) {
      if (record.used) continue;
      const key = `${record.kind}:${utcDay(record.time)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(record);
    }
    const candidates = [];
    for (const entry of pending) {
      for (const day of [entry.day, entry.day - 1, entry.day + 1]) {
        for (const record of buckets.get(`${entry.kind}:${day}`) || []) {
          const dayDistance = Math.abs(day - entry.day);
          const cost = matchCost(entry.main, record.time);
          if (cost === Infinity && dayDistance !== 0) continue;
          candidates.push({ entry, record, rank: dayDistance * 1e12 + (cost === Infinity ? 1e11 : cost) });
        }
      }
    }
    candidates.sort((a, b) => a.rank - b.rank);
    const joined = new Set();
    for (const { entry, record } of candidates) {
      if (record.used || joined.has(entry)) continue;
      record.used = true;
      joined.add(entry);
      items.push(makeItem(entry, record));
    }
    for (const entry of pending) {
      if (joined.has(entry)) continue;
      // No record: the filename date is all there is.
      items.push(makeItem(entry, null));
    }

    items.sort((a, b) => b.createdAt - a.createdAt || (a.sourceItemId < b.sourceItemId ? -1 : 1));
    const missing = records.filter((record) => !record.used).length;
    const overlayVideos = items.filter((item) => item.kind === 'video' && item.overlay).length;
    const notes = [];
    if (overlayVideos > 0) {
      notes.push(t('noteOverlayVideos', overlayVideos));
    }
    if (missing > 0) {
      notes.push(t('noteMissing', missing));
    }
    if (!history) notes.push(t('noteNoHistory'));
    return { items, skipped, notes, invalidRecords, missingFiles: missing };
  },
});

function makeItem(entry, record) {
  return Object.freeze({
    source: 'snapchat',
    sourceItemId: entry.mid,
    kind: entry.kind,
    createdAt: record ? record.time : entry.day * DAY + 12 * 60 * 60 * 1000,
    dateApproximate: !record,
    location: record ? record.location : null,
    main: entry.main,
    overlay: entry.overlay,
  });
}

export const ADAPTERS = Object.freeze([snapchat]);
