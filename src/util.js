// Shared by every other file: input and processing limits, byte and base64
// helpers, and the minimal protobuf reader and writer.

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

// Input and processing bounds. Changing a cap requires checking peak decoded
// memory again.

const MiB = 1024 * 1024;

export const LIMITS = Object.freeze({
  /** Entries across every selected archive and loose file together. */
  maxEntries: 100_000,
  /** Bytes of one archive's central directory. */
  maxCentralDirectoryBytes: 64 * MiB,
  /** UTF-8 bytes of one entry path. */
  maxPathBytes: 4096,
  /** Decompressed bytes of one media entry. */
  maxMediaBytes: 100 * MiB,
  /** Bytes of one metadata JSON file. */
  maxMetadataBytes: 64 * MiB,
  /** Records in one metadata file. */
  maxMetadataRecords: 100_000,
  /** Characters of one string field in a metadata record. */
  maxMetadataFieldChars: 4096,
  /** Pixels per image side, overlays included. */
  maxImageDimension: 16_384,
  /** Pixels per image, overlays included. */
  maxImagePixels: 32_000_000,
  /** Seconds of one video. */
  maxVideoSeconds: 3600,
  /** Milliseconds for one inflate, decode, thumbnail or encode step. */
  operationTimeoutMs: 30_000,
  /** The server's `THUMBNAIL_MAX_BYTES`. */
  thumbnailMaxBytes: 300_000,
  /** Long side of a thumbnail in pixels. */
  thumbnailLongSide: 400,
  /** Bytes held between "read" and "uploaded", decoded buffers included. */
  pipelineBudgetBytes: 512 * MiB,
  /**
   * Memories transferring at once. Each sends its thumbnail and full object
   * side by side, so S3 sees up to twice as many requests.
   */
  uploadConcurrency: 6,
  /** Memories per reservation request. */
  reserveBatch: 3,
  /** Media IDs per confirmation request. */
  confirmBatch: 50,
});

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

export function utf8(text) {
  return encoder.encode(text);
}

export function fromUtf8(bytes) {
  return decoder.decode(bytes);
}

export function concat(...parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function isAllZero(bytes) {
  let acc = 0;
  for (let i = 0; i < bytes.length; i++) acc |= bytes[i];
  return acc === 0;
}

export function wipe(bytes) {
  if (bytes && typeof bytes.fill === 'function') bytes.fill(0);
}

export function randomBytes(length) {
  const out = new Uint8Array(length);
  // getRandomValues is limited to 65536 bytes per call.
  for (let offset = 0; offset < length; offset += 65536) {
    crypto.getRandomValues(out.subarray(offset, Math.min(length, offset + 65536)));
  }
  return out;
}

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new Error('invalid base64');
  }
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new Error('invalid base64url');
  }
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

export function toHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A canonical, lower-case, hyphenated version 4 UUID. */
export function isUuidV4(text) {
  return typeof text === 'string' && UUID_V4.test(text);
}

export function uuidFromBytes(bytes) {
  const hex = toHex(bytes.subarray(0, 16));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Protobuf
// ---------------------------------------------------------------------------

/** Minimal protobuf encoding: enough for the few messages this page writes. */
export class ProtoWriter {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  push(bytes) {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  varint(value) {
    let v = BigInt(value);
    if (v < 0n) v = (1n << 64n) + v;
    const out = [];
    do {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v !== 0n) byte |= 0x80;
      out.push(byte);
    } while (v !== 0n);
    this.push(Uint8Array.from(out));
  }

  tag(field, wire) {
    this.varint((field << 3) | wire);
  }

  uint(field, value) {
    if (!value) return this;
    this.tag(field, 0);
    this.varint(value);
    return this;
  }

  bool(field, value) {
    if (!value) return this;
    this.tag(field, 0);
    this.varint(1);
    return this;
  }

  double(field, value) {
    if (value === undefined || value === null) return this;
    this.tag(field, 1);
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, value, true);
    this.push(out);
    return this;
  }

  bytes(field, value) {
    if (!value || value.length === 0) return this;
    this.tag(field, 2);
    this.varint(value.length);
    this.push(value);
    return this;
  }

  string(field, value) {
    if (!value) return this;
    return this.bytes(field, utf8(value));
  }

  finish() {
    return concat(...this.parts);
  }
}

/**
 * Reads a protobuf message into `{field: [values]}`. Varints come back as
 * BigInt, fixed64 as raw 8 bytes, length-delimited fields as subarrays.
 * Groups and fixed32 are refused: none of our messages use them.
 */
export function readProto(bytes, { maxFields = 64 } = {}) {
  const fields = new Map();
  let offset = 0;
  let count = 0;
  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw new Error('truncated varint');
      const byte = bytes[offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error('varint too long');
  };
  while (offset < bytes.length) {
    if (++count > maxFields) throw new Error('too many fields');
    const key = readVarint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    let value;
    if (wire === 0) {
      value = readVarint();
    } else if (wire === 1) {
      if (offset + 8 > bytes.length) throw new Error('truncated fixed64');
      value = bytes.subarray(offset, offset + 8);
      offset += 8;
    } else if (wire === 2) {
      const length = readVarint();
      if (length > BigInt(bytes.length - offset)) throw new Error('truncated field');
      value = bytes.subarray(offset, offset + Number(length));
      offset += Number(length);
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push({ wire, value });
  }
  return fields;
}
