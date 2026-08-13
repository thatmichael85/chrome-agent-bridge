const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadOrCreateConfig } = require('./config');

test('creates a new config with token and port on first call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-test-'));
  const config = loadOrCreateConfig(dir);
  assert.match(config.token, /^[0-9a-f]{48}$/);
  assert.strictEqual(config.port, 8787);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('returns the same config on subsequent calls (idempotent)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-test-'));
  const first = loadOrCreateConfig(dir);
  const second = loadOrCreateConfig(dir);
  assert.strictEqual(first.token, second.token);
  assert.strictEqual(first.port, second.port);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uses CHROME_AGENT_BRIDGE_HOME env var when no explicit dir given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-test-'));
  const prev = process.env.CHROME_AGENT_BRIDGE_HOME;
  process.env.CHROME_AGENT_BRIDGE_HOME = dir;
  try {
    const config = loadOrCreateConfig();
    assert.ok(fs.existsSync(path.join(dir, 'config.json')));
    assert.strictEqual(typeof config.token, 'string');
  } finally {
    if (prev === undefined) delete process.env.CHROME_AGENT_BRIDGE_HOME;
    else process.env.CHROME_AGENT_BRIDGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
