const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const { encodeMessage, MessageDecoder } = require('../lib/framing');

test('native-host.js: real process relays an authenticated command to a fake extension and back', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-integration-'));
  // Pre-write a config with a non-default port: the real Chrome-spawned host
  // may own 8787 on this machine, and a second bind would silently leave the
  // test client talking to the real relay (whose token differs) -> auth_error.
  const config = { token: 'test-token-' + Date.now(), port: 8790 + (process.pid % 100) };
  fs.writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify(config));
  const child = spawn(process.execPath, [path.join(__dirname, 'native-host.js')], {
    env: { ...process.env, CHROME_AGENT_BRIDGE_HOME: tmpHome },
  });

  let ws;
  try {

    const decoder = new MessageDecoder((msg) => {
      child.stdin.write(encodeMessage({ id: msg.id, result: { echoed: msg.command } }));
    });
    child.stdout.on('data', (chunk) => decoder.push(chunk));

    for (let i = 0; i < 50; i++) {
      try {
        ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
        await new Promise((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', reject);
        });
        break;
      } catch {
        ws = null;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(ws, 'websocket connected');

    const responses = [];
    ws.on('message', (data) => responses.push(JSON.parse(data.toString())));

    ws.send(JSON.stringify({ type: 'auth', token: config.token }));
    await new Promise((r) => setTimeout(r, 200));
    assert.deepStrictEqual(responses[0], { type: 'auth_ok' });

    ws.send(JSON.stringify({ type: 'command', id: 'x1', command: 'navigate', params: { url: 'https://example.com' } }));
    await new Promise((r) => setTimeout(r, 200));

    // JSON.stringify drops keys whose value is undefined, so the `error` field
    // present in-memory (Task 4's relay.test.js) never reaches the wire here.
    assert.strictEqual(responses[1].type, 'response');
    assert.strictEqual(responses[1].id, 'x1');
    assert.deepStrictEqual(responses[1].result, { echoed: 'navigate' });
    assert.strictEqual(responses[1].error, undefined);
  } finally {
    if (ws) ws.close();
    child.kill();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
