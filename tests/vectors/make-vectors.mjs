#!/usr/bin/env node
// Writes the cross-implementation test vectors shared with the app's Rust
// tests (copy tests/vectors/*.json to twonly-app/rust/tests/fixtures/importer/):
//
//   exif.json      TIFF blocks the page writes; media_exif.rs must write the
//                  same bytes for the same input.
//   payloads.json  a main key, an import id, and an envelope and payloads made
//                  by this page's code; the app must open and decrypt them.
//
// Usage: node tests/vectors/make-vectors.mjs

import fs from 'node:fs';
import nodeCrypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tiffBlock } from '../../src/media.js';
import {
  encodeGrant, importGrant, mediaIdFor, wrapMediaKey, encryptPayload, encodeMetadata, sealEnvelope,
} from '../../src/crypto.js';
import { toHex } from '../../src/util.js';

const dir = fileURLToPath(new URL('./', import.meta.url));
fs.mkdirSync(dir, { recursive: true });

const exif = [
  { input: { createdAt: Date.UTC(2024, 10, 18, 23, 2, 20), location: null } },
  { input: { createdAt: Date.UTC(2025, 2, 20, 14, 30, 47), location: { latitude: 52.520008, longitude: 13.404954 } } },
  { input: { createdAt: Date.UTC(2025, 5, 1, 8, 0, 0), location: { latitude: -33.8688, longitude: -151.2093 } } },
].map(({ input }) => ({ input, tiffHex: toHex(tiffBlock(input)) }));
fs.writeFileSync(`${dir}exif.json`, `${JSON.stringify(exif, null, 2)}\n`);

const mainKey = Buffer.alloc(32, 42);
const importId = 'b0b1c2d3-e4f5-4a6b-8c7d-8e9fa0b1c2d3';
const derive = (info) => new Uint8Array(nodeCrypto.hkdfSync('sha256', mainKey, Buffer.alloc(0), Buffer.from(info), 32));
const raw = {
  version: 1,
  importId,
  addition: `import_${importId}`,
  kek: derive(`cloud_media_key_import_${importId}`),
  idKey: derive('memory_import_ids'),
  importerToken: new Uint8Array(32).fill(7),
  username: 'alice',
  displayName: 'Alice',
  expiresAt: 4102444800,
};
const grantBytes = encodeGrant(raw);
const grant = await importGrant({ ...raw, kek: Uint8Array.from(raw.kek), idKey: Uint8Array.from(raw.idKey), importerToken: Uint8Array.from(raw.importerToken) });
const mediaKey = new Uint8Array(32).fill(9);
const encryptedMediaKey = await wrapMediaKey(grant.kek, mediaKey);
const thumbnail = new TextEncoder().encode('thumbnail bytes');
const full = new TextEncoder().encode('full media bytes');
const metadata = encodeMetadata({ source: 'snapchat', mediaType: 'image', createdAt: Date.UTC(2025, 2, 20, 14, 30, 47), location: { latitude: 52.520008, longitude: 13.404954 }, hadOverlay: true });

// The page's X25519 key for the envelope vector (private key given so the app
// test can open it the way the page would).
const pagePrivate = new Uint8Array(32).fill(5);
const { x25519 } = await import('../../src/vendor/noble.js');
const pagePublic = x25519.getPublicKey(pagePrivate);
const pairingId = '3f1c7a52-9a4e-4c1b-8d2e-5b6a7c8d9e0f';

const payloads = {
  mainKeyHex: mainKey.toString('hex'),
  importId,
  addition: raw.addition,
  mediaId: await mediaIdFor(grant.idKey, 'snapchat', 'a6a5d315-caf9-cacc-b550-f4c50928a2e5'),
  sourceItemId: 'a6a5d315-caf9-cacc-b550-f4c50928a2e5',
  mediaKeyHex: toHex(mediaKey),
  encryptedMediaKeyHex: toHex(encryptedMediaKey),
  thumbnailPlainHex: toHex(thumbnail),
  fullPlainHex: toHex(full),
  thumbnailPayloadHex: toHex(encryptPayload({ addition: raw.addition, encryptedMediaKey, mediaKey, plaintext: thumbnail, metadata })),
  fullPayloadHex: toHex(encryptPayload({ addition: raw.addition, encryptedMediaKey, mediaKey, plaintext: full })),
  metadata: { source: 'snapchat', mediaType: 1, createdAt: Math.floor(Date.UTC(2025, 2, 20, 14, 30, 47) / 1000), latitude: 52.520008, longitude: 13.404954, hadOverlay: true },
  grantHex: toHex(grantBytes),
  pairingId,
  pagePrivateHex: toHex(pagePrivate),
  pagePublicHex: toHex(pagePublic),
  envelopeHex: toHex(await sealEnvelope({ pairingId, pagePublicKey: pagePublic, grantBytes })),
};
fs.writeFileSync(`${dir}payloads.json`, `${JSON.stringify(payloads, null, 2)}\n`);
console.log(`Wrote ${dir}exif.json and ${dir}payloads.json`);
