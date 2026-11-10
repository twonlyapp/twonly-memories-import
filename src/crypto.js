// Everything cryptographic the page does.
//
// The page only ever encrypts: KEK_import is imported as an encrypt-only
// AES-GCM key and id_key as a sign-only HMAC key, both non-extractable, so
// code that gets hold of the handles can neither read them out nor unwrap a
// media key of this import.

import { xchacha20poly1305, chacha20poly1305, x25519 } from './vendor/noble.js';
import {
  ProtoWriter, readProto, concat, utf8, fromUtf8, isAllZero, wipe, randomBytes,
  isUuidV4, uuidFromBytes, toBase64Url, fromBase64Url,
} from './util.js';
import { t } from './i18n.js';

export const PROTOCOL_VERSION = 1;
export const PAIRING_INFO = 'twonly importer pairing v1';
export const PAIRING_LINK_BASE = 'https://me.twonly.eu/i/';
/** Longest a grant may live: 2 days, plus a minute of clock skew. */
const MAX_GRANT_SECONDS = 2 * 24 * 60 * 60 + 60;

export class CryptoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CryptoError';
  }
}

const subtle = () => globalThis.crypto.subtle;

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/**
 * A fresh X25519 key pair for one pairing. WebCrypto when the browser has it
 * (the private key then never exists as bytes), `@noble/curves` otherwise.
 * `forceFallback` exists for the tests of the fallback path.
 */
export async function generatePairingKeys({ forceFallback = false } = {}) {
  if (!forceFallback) {
    try {
      const pair = await subtle().generateKey({ name: 'X25519' }, false, ['deriveBits']);
      const publicKey = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
      return { kind: 'webcrypto', privateKey: pair.privateKey, publicKey };
    } catch {
      // Not supported: fall through.
    }
  }
  const privateKey = randomBytes(32);
  return { kind: 'noble', privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/**
 * X25519 with an explicit all-zero check. WebCrypto may throw for a
 * low-order peer key and a library may return zeros; both are refused here
 * instead of trusting either behaviour.
 */
export async function sharedSecret(keys, peerPublic) {
  if (!(peerPublic instanceof Uint8Array) || peerPublic.length !== 32) throw new CryptoError(t('cryptoPublicKey'));
  let secret;
  try {
    if (keys.kind === 'webcrypto') {
      const peer = await subtle().importKey('raw', peerPublic, { name: 'X25519' }, false, []);
      secret = new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: peer }, keys.privateKey, 256));
    } else {
      secret = x25519.getSharedSecret(keys.privateKey, peerPublic);
    }
  } catch {
    throw new CryptoError(t('cryptoEnvelopeKey'));
  }
  if (isAllZero(secret)) {
    wipe(secret);
    throw new CryptoError(t('cryptoEnvelopeKey'));
  }
  return secret;
}

export function dropPairingKeys(keys) {
  if (keys && keys.kind === 'noble') wipe(keys.privateKey);
  if (keys) keys.privateKey = null;
}

async function hkdf(ikm, salt, info, length = 32) {
  const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** The QR code and link: `https://me.twonly.eu/i/#v1/<pairing_id>/<b64url(p_pub)>`. */
export function pairingLink(pairingId, publicKey) {
  if (!isUuidV4(pairingId)) throw new CryptoError(t('cryptoPairingId'));
  return `${PAIRING_LINK_BASE}#v1/${pairingId}/${toBase64Url(publicKey)}`;
}

export function parsePairingLink(link) {
  const match = /^https:\/\/me\.twonly\.eu\/i\/#v1\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{43})$/.exec(link);
  if (!match || !isUuidV4(match[1])) throw new CryptoError(t('cryptoNotPairingLink'));
  const publicKey = fromBase64Url(match[2]);
  if (publicKey.length !== 32) throw new CryptoError(t('cryptoNotPairingLink'));
  return { pairingId: match[1], publicKey };
}

/** `ImporterEnvelope {bytes e_pub = 1; bytes nonce = 2; bytes ciphertext = 3}` */
export function decodeEnvelope(bytes) {
  const fields = readProto(bytes);
  const get = (n) => fields.get(n)?.[0]?.value;
  const ePub = get(1);
  const nonce = get(2);
  const ciphertext = get(3);
  if (!(ePub instanceof Uint8Array) || ePub.length !== 32) throw new CryptoError(t('cryptoEnvelope'));
  if (!(nonce instanceof Uint8Array) || nonce.length !== 24) throw new CryptoError(t('cryptoEnvelope'));
  if (!(ciphertext instanceof Uint8Array) || ciphertext.length < 17 || ciphertext.length > 4096) {
    throw new CryptoError(t('cryptoEnvelope'));
  }
  return { ePub, nonce, ciphertext };
}

export function encodeEnvelope({ ePub, nonce, ciphertext }) {
  return new ProtoWriter().bytes(1, ePub).bytes(2, nonce).bytes(3, ciphertext).finish();
}

function pairingAad(pairingId, ePub, pPub) {
  return concat(utf8(pairingId), ePub, pPub);
}

async function pairingKey(secret, pairingId, ePub, pPub) {
  return hkdf(secret, concat(ePub, pPub), concat(utf8(PAIRING_INFO), utf8(pairingId)));
}

/**
 * Seals a grant to the page's public key. This is the app's side;
 * the page never calls it, the tests and the fixture tooling do.
 */
export async function sealEnvelope({ pairingId, pagePublicKey, grantBytes }) {
  const ephemeral = randomBytes(32);
  const ePub = x25519.getPublicKey(ephemeral);
  const secret = x25519.getSharedSecret(ephemeral, pagePublicKey);
  wipe(ephemeral);
  if (isAllZero(secret)) throw new CryptoError(t('cryptoPageKey'));
  const key = await pairingKey(secret, pairingId, ePub, pagePublicKey);
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(key, nonce, pairingAad(pairingId, ePub, pagePublicKey)).encrypt(grantBytes);
  wipe(key);
  wipe(secret);
  return encodeEnvelope({ ePub, nonce, ciphertext });
}

/** Opens the envelope and returns the raw grant bytes. */
export async function openEnvelope({ pairingId, keys, envelopeBytes }) {
  const { ePub, nonce, ciphertext } = decodeEnvelope(envelopeBytes);
  const secret = await sharedSecret(keys, ePub);
  const key = await pairingKey(secret, pairingId, ePub, keys.publicKey);
  wipe(secret);
  try {
    return xchacha20poly1305(key, nonce, pairingAad(pairingId, ePub, keys.publicKey)).decrypt(ciphertext);
  } catch {
    throw new CryptoError(t('cryptoEnvelopeOpen'));
  } finally {
    wipe(key);
  }
}

// ---------------------------------------------------------------------------
// Grant
// ---------------------------------------------------------------------------

/**
 * `ImporterGrant {uint32 version = 1; string import_id = 2; string addition = 3;
 * bytes kek = 4; bytes id_key = 5; bytes importer_token = 6; string username = 7;
 * string display_name = 8; int64 expires_at = 9}`
 */
export function encodeGrant(grant) {
  return new ProtoWriter()
    .uint(1, grant.version)
    .string(2, grant.importId)
    .string(3, grant.addition)
    .bytes(4, grant.kek)
    .bytes(5, grant.idKey)
    .bytes(6, grant.importerToken)
    .string(7, grant.username)
    .string(8, grant.displayName)
    .uint(9, grant.expiresAt)
    .finish();
}

export function decodeGrant(bytes, { now = Date.now() } = {}) {
  const fields = readProto(bytes);
  const one = (n, wire) => {
    const list = fields.get(n);
    if (!list) return undefined;
    if (list.length !== 1 || list[0].wire !== wire) throw new CryptoError(t('cryptoGrant'));
    return list[0].value;
  };
  const text = (n, max) => {
    const value = one(n, 2);
    if (value === undefined) return '';
    if (value.length > max) throw new CryptoError(t('cryptoGrant'));
    return fromUtf8(value);
  };
  const key = (n) => {
    const value = one(n, 2);
    if (!(value instanceof Uint8Array) || value.length !== 32) throw new CryptoError(t('cryptoGrant'));
    // A copy: the caller wipes the grant bytes right after decoding.
    return value.slice();
  };
  const version = Number(one(1, 0) ?? 0n);
  if (version !== 1) throw new CryptoError(t('cryptoGrantVersion'));
  const importId = text(2, 36);
  const addition = text(3, 64);
  if (!isUuidV4(importId) || addition !== `import_${importId}`) throw new CryptoError(t('cryptoGrant'));
  const expiresAt = Number(one(9, 0) ?? 0n);
  const nowSeconds = Math.floor(now / 1000);
  if (!(expiresAt > nowSeconds) || expiresAt > nowSeconds + MAX_GRANT_SECONDS) throw new CryptoError(t('cryptoGrant'));
  const username = text(7, 64);
  if (!/^[a-z0-9._]{3,12}$/.test(username)) throw new CryptoError(t('cryptoGrant'));
  return {
    version,
    importId,
    addition,
    kek: key(4),
    idKey: key(5),
    importerToken: key(6),
    username,
    displayName: text(8, 256),
    expiresAt,
  };
}

/**
 * Turns the raw grant into what the page keeps: non-extractable, single-use
 * key handles. The raw key bytes are zeroed afterwards.
 */
export async function importGrant(grant) {
  try {
    const kek = await subtle().importKey('raw', grant.kek, { name: 'AES-GCM' }, false, ['encrypt']);
    const idKey = await subtle().importKey('raw', grant.idKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return {
      importId: grant.importId,
      addition: grant.addition,
      kek,
      idKey,
      importerToken: toBase64Url(grant.importerToken),
      claimedUsername: grant.username,
      displayName: grant.displayName,
      expiresAt: grant.expiresAt,
    };
  } finally {
    wipe(grant.kek);
    wipe(grant.idKey);
    wipe(grant.importerToken);
  }
}

// ---------------------------------------------------------------------------
// Per memory
// ---------------------------------------------------------------------------

/**
 * Stable twonly media id: HMAC(id_key, source || 0x00 || source_item_id),
 * first 16 bytes with version 4 and variant bits set. The same item gets the
 * same id across reloads and pairings; the server cannot link it back.
 */
export async function mediaIdFor(idKey, source, sourceItemId) {
  const mac = new Uint8Array(await subtle().sign('HMAC', idKey, concat(utf8(source), Uint8Array.of(0), utf8(sourceItemId))));
  const id = mac.slice(0, 16);
  id[6] = (id[6] & 0x0f) | 0x40;
  id[8] = (id[8] & 0x3f) | 0x80;
  return uuidFromBytes(id);
}

/**
 * `nonce12 || AES-256-GCM(KEK_import, nonce12, media_key)`, byte for byte what
 * `MainKey::encrypt_with_info` produces.
 */
export async function wrapMediaKey(kek, mediaKey) {
  const nonce = randomBytes(12);
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, kek, mediaKey));
  return concat(nonce, sealed);
}

/** `ImportedMemoryMetadata` (see proto/importer.proto). */
export function encodeMetadata({ source, mediaType, createdAt, location, hadOverlay }) {
  const writer = new ProtoWriter()
    .string(1, source)
    .uint(2, mediaType === 'video' ? 2 : 1)
    .uint(3, Math.floor(createdAt / 1000));
  if (location) writer.double(4, location.latitude).double(5, location.longitude);
  return writer.bool(6, hadOverlay).finish();
}

function protoLengthPrefix(field, length) {
  const writer = new ProtoWriter();
  writer.tag(field, 2);
  writer.varint(length);
  return writer.finish();
}

/**
 * Encrypts one object (full media or thumbnail) with ChaCha20-Poly1305 and
 * returns the `CloudMediaBackupEncrypted` payload:
 *   1 addition, 2 encrypted_media_key, 3 media_nonce, 4 media_ciphertext,
 *   5 encrypted_metadata (thumbnail only: nonce12 || ciphertext || tag)
 * The ciphertext is written straight into the payload buffer, so a large
 * video is not copied once more.
 */
export function encryptPayload({ addition, encryptedMediaKey, mediaKey, plaintext, metadata = null }) {
  const nonce = randomBytes(12);
  let encryptedMetadata = null;
  if (metadata) {
    const metadataNonce = randomBytes(12);
    encryptedMetadata = concat(metadataNonce, chacha20poly1305(mediaKey, metadataNonce).encrypt(metadata));
  }
  const head = new ProtoWriter().string(1, addition).bytes(2, encryptedMediaKey).bytes(3, nonce).finish();
  const cipherLength = plaintext.length + 16;
  const prefix = protoLengthPrefix(4, cipherLength);
  const tail = encryptedMetadata ? new ProtoWriter().bytes(5, encryptedMetadata).finish() : new Uint8Array(0);
  const out = new Uint8Array(head.length + prefix.length + cipherLength + tail.length);
  out.set(head, 0);
  out.set(prefix, head.length);
  const cipherStart = head.length + prefix.length;
  chacha20poly1305(mediaKey, nonce).encrypt(plaintext, out.subarray(cipherStart, cipherStart + cipherLength));
  out.set(tail, cipherStart + cipherLength);
  return out;
}

/** Reads a payload back. Used by the tests and the fixture tooling only. */
export function decodePayload(bytes) {
  const fields = readProto(bytes, { maxFields: 16 });
  const get = (n) => fields.get(n)?.[0]?.value;
  return {
    addition: get(1) ? fromUtf8(get(1)) : '',
    encryptedMediaKey: get(2),
    mediaNonce: get(3),
    mediaCiphertext: get(4),
    encryptedMetadata: get(5) || null,
  };
}

export function newMediaKey() {
  return randomBytes(32);
}

export function newPollSecret() {
  return randomBytes(32);
}
