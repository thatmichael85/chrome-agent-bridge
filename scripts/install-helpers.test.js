// scripts/install-helpers.test.js
const test = require('node:test');
const assert = require('node:assert');
const { buildNativeMessagingManifest, ensureManifestKey } = require('./install-helpers');

test('buildNativeMessagingManifest produces the shape Chrome requires', () => {
  const manifest = buildNativeMessagingManifest({
    extensionId: 'a'.repeat(32),
    hostScriptPath: '/some/path/host/native-host.js',
  });
  assert.strictEqual(manifest.name, 'com.chromeagentbridge.host');
  assert.strictEqual(manifest.type, 'stdio');
  assert.strictEqual(manifest.path, '/some/path/host/native-host.js');
  assert.deepStrictEqual(manifest.allowed_origins, [`chrome-extension://${'a'.repeat(32)}/`]);
});

test('ensureManifestKey generates and injects a key when none exists', () => {
  const { manifestObj, extensionId, changed } = ensureManifestKey({ manifest_version: 3, name: 'x' });
  assert.strictEqual(changed, true);
  assert.strictEqual(typeof manifestObj.key, 'string');
  assert.strictEqual(extensionId.length, 32);
  assert.match(extensionId, /^[a-p]{32}$/);
});

test('ensureManifestKey is idempotent: reuses an existing key and derives the same id', () => {
  const first = ensureManifestKey({ manifest_version: 3, name: 'x' });
  const second = ensureManifestKey({ ...first.manifestObj });
  assert.strictEqual(second.changed, false);
  assert.strictEqual(second.extensionId, first.extensionId);
  assert.strictEqual(second.manifestObj.key, first.manifestObj.key);
});
