const test = require('node:test');
const assert = require('node:assert');
const { generateKeyPair, idFromPublicKeyDer } = require('./extension-id');

test('idFromPublicKeyDer produces a 32-character id using only a-p', () => {
  const id = idFromPublicKeyDer(Buffer.from([1, 2, 3, 4, 5]));
  assert.strictEqual(id.length, 32);
  assert.match(id, /^[a-p]{32}$/);
});

test('idFromPublicKeyDer is deterministic for the same input', () => {
  const der = Buffer.from([9, 9, 9]);
  assert.strictEqual(idFromPublicKeyDer(der), idFromPublicKeyDer(der));
});

test('idFromPublicKeyDer differs for different input', () => {
  const a = idFromPublicKeyDer(Buffer.from([1, 2, 3]));
  const b = idFromPublicKeyDer(Buffer.from([4, 5, 6]));
  assert.notStrictEqual(a, b);
});

test('generateKeyPair returns a DER buffer and matching base64, and the id derived from it is stable', () => {
  const { publicKeyDer, publicKeyBase64 } = generateKeyPair();
  assert.ok(Buffer.isBuffer(publicKeyDer));
  assert.strictEqual(publicKeyBase64, publicKeyDer.toString('base64'));
  const id1 = idFromPublicKeyDer(publicKeyDer);
  const id2 = idFromPublicKeyDer(Buffer.from(publicKeyBase64, 'base64'));
  assert.strictEqual(id1, id2);
});
