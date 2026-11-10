import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { test } from 'node:test';
import {
  generatePairingKeys, sharedSecret, sealEnvelope, openEnvelope, encodeEnvelope, decodeEnvelope,
  encodeGrant, decodeGrant, importGrant, mediaIdFor, wrapMediaKey, encryptPayload, decodePayload,
  encodeMetadata, pairingLink, parsePairingLink, CryptoError, newMediaKey,
} from '../../src/crypto.js';
import { randomBytes, readProto, isUuidV4, fromBase64Url } from '../../src/util.js';

const PAIRING_ID = '3f1c7a52-9a4e-4c1b-8d2e-5b6a7c8d9e0f';

/** What the app derives: HKDF-SHA256(main_key, info), no salt. */
function appDerive(mainKey, info) {
  return Buffer.from(nodeCrypto.hkdfSync('sha256', mainKey, Buffer.alloc(0), Buffer.from(info), 32));
}

function grantFor(mainKey, importId = nodeCrypto.randomUUID(), overrides = {}) {
  return {
    version: 1,
    importId,
    addition: `import_${importId}`,
    kek: appDerive(mainKey, `cloud_media_key_import_${importId}`),
    idKey: appDerive(mainKey, 'memory_import_ids'),
    importerToken: randomBytes(32),
    username: 'alice',
    displayName: 'Alice <b>',
    expiresAt: Math.floor(Date.now() / 1000) + 2 * 24 * 3600,
    ...overrides,
  };
}

for (const forceFallback of [false, true]) {
  const label = forceFallback ? '@noble/curves' : 'WebCrypto';

  test(`${label}: a sealed grant opens and decodes`, async () => {
    const keys = await generatePairingKeys({ forceFallback });
    assert.equal(keys.kind, forceFallback ? 'noble' : 'webcrypto');
    const mainKey = randomBytes(32);
    const grant = grantFor(mainKey);
    const envelopeBytes = await sealEnvelope({ pairingId: PAIRING_ID, pagePublicKey: keys.publicKey, grantBytes: encodeGrant(grant) });
    const opened = decodeGrant(await openEnvelope({ pairingId: PAIRING_ID, keys, envelopeBytes }));
    assert.equal(opened.importId, grant.importId);
    assert.equal(opened.addition, grant.addition);
    assert.deepEqual(Buffer.from(opened.kek), Buffer.from(grant.kek));
    assert.equal(opened.displayName, 'Alice <b>');
  });

  test(`${label}: an envelope bound to another pairing or tampered with does not open`, async () => {
    const keys = await generatePairingKeys({ forceFallback });
    const envelopeBytes = await sealEnvelope({ pairingId: PAIRING_ID, pagePublicKey: keys.publicKey, grantBytes: encodeGrant(grantFor(randomBytes(32))) });
    await assert.rejects(openEnvelope({ pairingId: '00000000-0000-4000-8000-000000000000', keys, envelopeBytes }), CryptoError);
    const { ePub, nonce, ciphertext } = decodeEnvelope(envelopeBytes);
    const flipped = Uint8Array.from(ciphertext);
    flipped[0] ^= 1;
    await assert.rejects(openEnvelope({ pairingId: PAIRING_ID, keys, envelopeBytes: encodeEnvelope({ ePub, nonce, ciphertext: flipped }) }), CryptoError);
  });

  test(`${label}: low-order ephemeral keys are refused (all-zero shared secret)`, async () => {
    const keys = await generatePairingKeys({ forceFallback });
    // u = 0 and u = 1 are low-order points on Curve25519; so is this one.
    const lowOrder = [
      new Uint8Array(32),
      Uint8Array.of(1, ...new Uint8Array(31)),
      Buffer.from('e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800', 'hex'),
    ];
    for (const point of lowOrder) {
      await assert.rejects(sharedSecret(keys, new Uint8Array(point)), CryptoError);
      const envelopeBytes = encodeEnvelope({ ePub: new Uint8Array(point), nonce: randomBytes(24), ciphertext: randomBytes(64) });
      await assert.rejects(openEnvelope({ pairingId: PAIRING_ID, keys, envelopeBytes }), /invalid key/);
    }
  });
}

test('the stored key handles encrypt or sign only and cannot be exported', async () => {
  const mainKey = randomBytes(32);
  const raw = grantFor(mainKey);
  const kekCopy = Buffer.from(raw.kek);
  const grant = await importGrant(raw);
  // The raw bytes are zeroed.
  assert.ok(raw.kek.every((b) => b === 0) && raw.idKey.every((b) => b === 0));
  assert.equal(grant.kek.extractable, false);
  assert.deepEqual(grant.kek.usages, ['encrypt']);
  assert.deepEqual(grant.idKey.usages, ['sign']);
  await assert.rejects(crypto.subtle.exportKey('raw', grant.kek));
  await assert.rejects(crypto.subtle.exportKey('raw', grant.idKey));
  const wrapped = await wrapMediaKey(grant.kek, newMediaKey());
  await assert.rejects(crypto.subtle.decrypt({ name: 'AES-GCM', iv: wrapped.subarray(0, 12) }, grant.kek, wrapped.subarray(12)));
  await assert.rejects(crypto.subtle.unwrapKey('raw', wrapped, grant.kek, { name: 'AES-GCM', iv: wrapped.subarray(0, 12) }, 'AES-GCM', true, ['encrypt']));
  await assert.rejects(crypto.subtle.verify('HMAC', grant.idKey, new Uint8Array(32), new Uint8Array(1)));
  assert.ok(kekCopy.some((b) => b !== 0));
});

test('a wrapped media key unwraps with the app derivation for this import only', async () => {
  const mainKey = randomBytes(32);
  const raw = grantFor(mainKey);
  const grant = await importGrant(raw);
  const mediaKey = newMediaKey();
  const wrapped = await wrapMediaKey(grant.kek, mediaKey);
  const unwrap = (info) => {
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', appDerive(mainKey, info), wrapped.subarray(0, 12));
    decipher.setAuthTag(wrapped.subarray(wrapped.length - 16));
    return Buffer.concat([decipher.update(wrapped.subarray(12, wrapped.length - 16)), decipher.final()]);
  };
  assert.deepEqual(unwrap(`cloud_media_key_${grant.addition}`), Buffer.from(mediaKey));
  assert.throws(() => unwrap('cloud_media_key_app'));
  assert.throws(() => unwrap(`cloud_media_key_import_${nodeCrypto.randomUUID()}`));
});

test('media ids are stable, version 4 and separate per source', async () => {
  const mainKey = randomBytes(32);
  const a = await importGrant(grantFor(mainKey));
  const b = await importGrant(grantFor(mainKey));
  const id = await mediaIdFor(a.idKey, 'snapchat', 'mid-1');
  assert.ok(isUuidV4(id));
  // A new pairing of the same account maps the item to the same id.
  assert.equal(await mediaIdFor(b.idKey, 'snapchat', 'mid-1'), id);
  assert.notEqual(await mediaIdFor(a.idKey, 'snapchat', 'mid-2'), id);
  assert.notEqual(await mediaIdFor(a.idKey, 'other', 'mid-1'), id);
  // Separator: ("snap", "chat…") and ("snapchat", "…") never collide.
  assert.notEqual(await mediaIdFor(a.idKey, 'snap', 'chatmid-1'), await mediaIdFor(a.idKey, 'snapchat', 'mid-1'));
  const expectedMac = nodeCrypto.createHmac('sha256', appDerive(mainKey, 'memory_import_ids')).update(Buffer.from('snapchat\0mid-1')).digest();
  expectedMac[6] = (expectedMac[6] & 0x0f) | 0x40;
  expectedMac[8] = (expectedMac[8] & 0x3f) | 0x80;
  assert.equal(id.replace(/-/g, ''), expectedMac.subarray(0, 16).toString('hex'));
});

test('payloads decrypt like the app does: ChaCha20-Poly1305, MAC appended, no AAD', async () => {
  const mainKey = randomBytes(32);
  const grant = await importGrant(grantFor(mainKey));
  const mediaKey = newMediaKey();
  const encryptedMediaKey = await wrapMediaKey(grant.kek, mediaKey);
  const plaintext = randomBytes(100_000);
  const metadata = encodeMetadata({ source: 'snapchat', mediaType: 'video', createdAt: Date.UTC(2024, 10, 18, 23, 2, 20), location: { latitude: 52.52, longitude: -13.4 }, hadOverlay: true });
  const payload = decodePayload(encryptPayload({ addition: grant.addition, encryptedMediaKey, mediaKey, plaintext, metadata }));
  assert.equal(payload.addition, grant.addition);
  assert.deepEqual(Buffer.from(payload.encryptedMediaKey), Buffer.from(encryptedMediaKey));
  const open = (nonce, sealed) => {
    const decipher = nodeCrypto.createDecipheriv('chacha20-poly1305', Buffer.from(mediaKey), nonce, { authTagLength: 16 });
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  };
  assert.deepEqual(open(payload.mediaNonce, payload.mediaCiphertext), Buffer.from(plaintext));
  const meta = readProto(open(payload.encryptedMetadata.subarray(0, 12), payload.encryptedMetadata.subarray(12)));
  assert.equal(Buffer.from(meta.get(1)[0].value).toString(), 'snapchat');
  assert.equal(meta.get(2)[0].value, 2n);
  assert.equal(meta.get(3)[0].value, BigInt(Date.UTC(2024, 10, 18, 23, 2, 20) / 1000));
  assert.equal(Buffer.from(meta.get(4)[0].value).readDoubleLE(0), 52.52);
  assert.equal(Buffer.from(meta.get(5)[0].value).readDoubleLE(0), -13.4);
  assert.equal(meta.get(6)[0].value, 1n);
  // The full object carries no metadata.
  assert.equal(decodePayload(encryptPayload({ addition: grant.addition, encryptedMediaKey, mediaKey, plaintext })).encryptedMetadata, null);
});

test('decoded grant keys survive wiping the grant bytes', () => {
  const raw = grantFor(randomBytes(32));
  const bytes = encodeGrant(raw);
  const decoded = decodeGrant(bytes);
  bytes.fill(0);
  assert.deepEqual(Buffer.from(decoded.kek), Buffer.from(raw.kek));
  assert.deepEqual(Buffer.from(decoded.importerToken), Buffer.from(raw.importerToken));
});

test('grants are validated before use', () => {
  const mainKey = randomBytes(32);
  const bad = (overrides) => () => decodeGrant(encodeGrant(grantFor(mainKey, undefined, overrides)));
  assert.doesNotThrow(bad({}));
  assert.throws(bad({ addition: 'app' }), CryptoError);
  assert.throws(bad({ importId: 'not-a-uuid', addition: 'import_not-a-uuid' }), CryptoError);
  assert.throws(bad({ version: 2 }), /version/);
  assert.throws(bad({ kek: randomBytes(16) }), CryptoError);
  assert.throws(bad({ expiresAt: Math.floor(Date.now() / 1000) - 1 }), CryptoError);
  assert.throws(bad({ expiresAt: Math.floor(Date.now() / 1000) + 3 * 24 * 3600 }), CryptoError);
  assert.throws(bad({ username: 'Alice<script>' }), CryptoError);
  assert.throws(() => decodeGrant(randomBytes(40)), Error);
});

test('pairing links round-trip and reject anything else', async () => {
  const keys = await generatePairingKeys();
  const link = pairingLink(PAIRING_ID, keys.publicKey);
  assert.match(link, /^https:\/\/me\.twonly\.eu\/i\/#v1\//);
  const parsed = parsePairingLink(link);
  assert.equal(parsed.pairingId, PAIRING_ID);
  assert.deepEqual(Buffer.from(parsed.publicKey), Buffer.from(keys.publicKey));
  for (const other of [link.replace('me.twonly.eu', 'evil.example'), link.replace('#v1', '#v2'), `${link}x`, 'javascript:alert(1)']) {
    assert.throws(() => parsePairingLink(other), CryptoError);
  }
  assert.equal(fromBase64Url(link.split('/').pop()).length, 32);
});
