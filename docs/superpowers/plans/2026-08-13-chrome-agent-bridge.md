# Chrome Agent Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let both Claude Code and Codex control the user's normal, already-open Chrome via one shared MCP server, with no `--remote-debugging-port` flag anywhere in the flow.

**Architecture:** A Chrome extension (no `chrome.debugger`, uses `chrome.tabs`/`chrome.scripting`) talks to a native-messaging host process that Chrome auto-spawns; that host bridges to a token-gated local WebSocket server; a stdio MCP adapter (registered identically in Claude Code and Codex) is the thin client both agents spawn.

**Tech Stack:** Node.js (v25.9.0 confirmed installed, CommonJS), `ws` 8.21.3, `@modelcontextprotocol/sdk` 1.30.0, `zod` for tool schemas, Node's built-in `node:test` for tests (no test framework dependency needed).

## Global Constraints

- No `chrome.debugger` / CDP anywhere — page-level extension APIs only (per spec's Non-goals).
- WebSocket server binds `127.0.0.1` only, never `0.0.0.0`.
- Every WebSocket connection must send `{type:'auth', token}` and be accepted before any `command` message is processed.
- Extension ID must be pinned via a generated keypair embedded in `manifest.json`'s `"key"` field — never rely on Chrome's path-derived unpacked-extension ID.
- `scripts/install.js` must be idempotent: re-running it must not regenerate the extension keypair/ID if one already exists in `extension/manifest.json`.
- MCP server registration goes through `claude mcp add ... -s user` and `codex mcp add ...` (confirmed available at `/opt/homebrew/bin/claude` and `/opt/homebrew/bin/codex`) — never hand-edit `~/.claude.json` or `~/.codex/config.toml` directly.
- Repo root: `/Users/michaelolimpo/agents_workdir/chrome-agent-bridge` (git repo already initialized, spec already committed at `docs/superpowers/specs/2026-08-13-chrome-agent-bridge-design.md`).

---

### Task 1: Project scaffold + shared config module

**Files:**
- Create: `package.json`
- Create: `lib/config.js`
- Test: `lib/config.test.js`

**Interfaces:**
- Produces: `loadOrCreateConfig(explicitDir?: string) -> {token: string, port: number}`. Later tasks (`host/native-host.js`, `mcp-adapter/index.js`) call this with no argument to get the shared token/port; tests call it with a temp dir.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "chrome-agent-bridge",
  "version": "1.0.0",
  "private": true,
  "description": "Local MCP server letting Claude Code and Codex control the user's normal Chrome, no debug port.",
  "scripts": {
    "test": "node --test lib/**/*.test.js host/**/*.test.js scripts/**/*.test.js",
    "install-bridge": "node scripts/install.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "ws": "^8.21.3",
    "zod": "^3.23.8"
  }
}
```

- [ ] **Step 2: Run `npm install`**

Run: `cd /Users/michaelolimpo/agents_workdir/chrome-agent-bridge && npm install`
Expected: installs succeed, `node_modules/` created, `package-lock.json` created.

- [ ] **Step 3: Write the failing test for `lib/config.js`**

```js
// lib/config.test.js
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
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test lib/config.test.js`
Expected: FAIL — `Cannot find module './config'`

- [ ] **Step 5: Write `lib/config.js`**

```js
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.chrome-agent-bridge');

function resolveConfigDir(explicitDir) {
  return explicitDir || process.env.CHROME_AGENT_BRIDGE_HOME || DEFAULT_CONFIG_DIR;
}

function loadOrCreateConfig(explicitDir) {
  const configDir = resolveConfigDir(explicitDir);
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  const config = {
    token: crypto.randomBytes(24).toString('hex'),
    port: 8787,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return config;
}

module.exports = { DEFAULT_CONFIG_DIR, resolveConfigDir, loadOrCreateConfig };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test lib/config.test.js`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
cd /Users/michaelolimpo/agents_workdir/chrome-agent-bridge
git add package.json package-lock.json lib/config.js lib/config.test.js
git commit -m "feat: add shared config module for token/port"
```

---

### Task 2: Extension ID / keypair generator

**Files:**
- Create: `lib/extension-id.js`
- Test: `lib/extension-id.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `generateKeyPair() -> {publicKeyDer: Buffer, publicKeyBase64: string}` and `idFromPublicKeyDer(der: Buffer) -> string` (32-char `a`–`p` string). Task 7's `scripts/install.js` calls both.

- [ ] **Step 1: Write the failing tests**

```js
// lib/extension-id.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/extension-id.test.js`
Expected: FAIL — `Cannot find module './extension-id'`

- [ ] **Step 3: Write `lib/extension-id.js`**

```js
const crypto = require('crypto');

function generateKeyPair() {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  return { publicKeyDer, publicKeyBase64: publicKeyDer.toString('base64') };
}

function idFromPublicKeyDer(der) {
  const hash = crypto.createHash('sha256').update(der).digest();
  const first16 = hash.subarray(0, 16);
  let id = '';
  for (const byte of first16) {
    const high = byte >> 4;
    const low = byte & 0x0f;
    id += String.fromCharCode(97 + high) + String.fromCharCode(97 + low);
  }
  return id;
}

module.exports = { generateKeyPair, idFromPublicKeyDer };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/extension-id.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/extension-id.js lib/extension-id.test.js
git commit -m "feat: add extension keypair/id generator"
```

---

### Task 3: Native messaging framing utility

**Files:**
- Create: `lib/framing.js`
- Test: `lib/framing.test.js`

**Interfaces:**
- Produces: `encodeMessage(obj) -> Buffer` (4-byte little-endian length prefix + UTF-8 JSON) and `class MessageDecoder { constructor(onMessage: (obj)=>void); push(chunk: Buffer): void }`. Used by `host/native-host.js` (Task 4) for both directions of native-messaging stdio.

- [ ] **Step 1: Write the failing tests**

```js
// lib/framing.test.js
const test = require('node:test');
const assert = require('node:assert');
const { encodeMessage, MessageDecoder } = require('./framing');

test('round-trips a single message', () => {
  const received = [];
  const decoder = new MessageDecoder((msg) => received.push(msg));
  decoder.push(encodeMessage({ hello: 'world' }));
  assert.deepStrictEqual(received, [{ hello: 'world' }]);
});

test('handles a message split across multiple chunks', () => {
  const received = [];
  const decoder = new MessageDecoder((msg) => received.push(msg));
  const encoded = encodeMessage({ a: 1, b: 'x'.repeat(100) });
  decoder.push(encoded.subarray(0, 5));
  decoder.push(encoded.subarray(5));
  assert.deepStrictEqual(received, [{ a: 1, b: 'x'.repeat(100) }]);
});

test('handles multiple messages arriving in one chunk', () => {
  const received = [];
  const decoder = new MessageDecoder((msg) => received.push(msg));
  const combined = Buffer.concat([encodeMessage({ n: 1 }), encodeMessage({ n: 2 })]);
  decoder.push(combined);
  assert.deepStrictEqual(received, [{ n: 1 }, { n: 2 }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/framing.test.js`
Expected: FAIL — `Cannot find module './framing'`

- [ ] **Step 3: Write `lib/framing.js`**

```js
function encodeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

class MessageDecoder {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 4) return;
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) return;
      const json = this.buffer.subarray(4, 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);
      this.onMessage(JSON.parse(json));
    }
  }
}

module.exports = { encodeMessage, MessageDecoder };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/framing.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/framing.js lib/framing.test.js
git commit -m "feat: add native-messaging framing codec"
```

---

### Task 4: Relay routing logic + native host process

**Files:**
- Create: `host/relay.js`
- Test: `host/relay.test.js`
- Create: `host/native-host.js`
- Test: `host/native-host.integration.test.js`

**Interfaces:**
- Consumes: `loadOrCreateConfig` from `lib/config.js` (Task 1), `encodeMessage`/`MessageDecoder` from `lib/framing.js` (Task 3).
- Produces: `class Relay { constructor({token, sendToExtension}); handleClientConnected() -> {authenticated: boolean}; handleClientMessage(state, message, clientSend); handleExtensionMessage(message) }`. `host/native-host.js` is the executable entrypoint Task 7's install script points Chrome's native-messaging manifest at. WebSocket message contract (consumed by Task 6's `mcp-adapter`): client sends `{type:'auth', token}` first, receives `{type:'auth_ok'}` or `{type:'auth_error'}`; then sends `{type:'command', id, command, params}`, receives `{type:'response', id, result?, error?}`.

- [ ] **Step 1: Write the failing tests for `host/relay.js`**

```js
// host/relay.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Relay } = require('./relay');

test('rejects commands before auth', () => {
  const relay = new Relay({ token: 'secret', sendToExtension: () => { throw new Error('should not be called'); } });
  const state = relay.handleClientConnected();
  const sent = [];
  relay.handleClientMessage(state, { type: 'command', id: '1', command: 'navigate', params: {} }, (m) => sent.push(m));
  assert.strictEqual(sent.length, 0);
});

test('authenticates with the correct token', () => {
  const relay = new Relay({ token: 'secret', sendToExtension: () => {} });
  const state = relay.handleClientConnected();
  const sent = [];
  relay.handleClientMessage(state, { type: 'auth', token: 'secret' }, (m) => sent.push(m));
  assert.deepStrictEqual(sent, [{ type: 'auth_ok' }]);
  assert.strictEqual(state.authenticated, true);
});

test('rejects the wrong token', () => {
  const relay = new Relay({ token: 'secret', sendToExtension: () => {} });
  const state = relay.handleClientConnected();
  const sent = [];
  relay.handleClientMessage(state, { type: 'auth', token: 'wrong' }, (m) => sent.push(m));
  assert.deepStrictEqual(sent, [{ type: 'auth_error' }]);
  assert.strictEqual(state.authenticated, false);
});

test('forwards an authenticated command to the extension and routes the response back to the right client', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const state = relay.handleClientConnected();
  relay.handleClientMessage(state, { type: 'auth', token: 'secret' }, () => {});
  const sent = [];
  relay.handleClientMessage(state, { type: 'command', id: 'abc', command: 'navigate', params: { url: 'https://x.com' } }, (m) => sent.push(m));
  assert.strictEqual(toExtension.length, 1);
  assert.strictEqual(toExtension[0].command, 'navigate');
  assert.deepStrictEqual(toExtension[0].params, { url: 'https://x.com' });
  const internalId = toExtension[0].id;
  relay.handleExtensionMessage({ id: internalId, result: { ok: true } });
  assert.deepStrictEqual(sent, [{ type: 'response', id: 'abc', result: { ok: true }, error: undefined }]);
});

test('two clients get their own responses routed correctly', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const stateA = relay.handleClientConnected();
  const stateB = relay.handleClientConnected();
  relay.handleClientMessage(stateA, { type: 'auth', token: 'secret' }, () => {});
  relay.handleClientMessage(stateB, { type: 'auth', token: 'secret' }, () => {});
  const sentA = [];
  const sentB = [];
  relay.handleClientMessage(stateA, { type: 'command', id: 'a1', command: 'list_tabs', params: {} }, (m) => sentA.push(m));
  relay.handleClientMessage(stateB, { type: 'command', id: 'b1', command: 'list_tabs', params: {} }, (m) => sentB.push(m));
  relay.handleExtensionMessage({ id: toExtension[0].id, result: 'fromA' });
  relay.handleExtensionMessage({ id: toExtension[1].id, result: 'fromB' });
  assert.strictEqual(sentA[0].result, 'fromA');
  assert.strictEqual(sentB[0].result, 'fromB');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/relay.test.js`
Expected: FAIL — `Cannot find module './relay'`

- [ ] **Step 3: Write `host/relay.js`**

```js
const crypto = require('crypto');

class Relay {
  constructor({ token, sendToExtension }) {
    this.token = token;
    this.sendToExtension = sendToExtension;
    this.pending = new Map();
  }

  handleClientConnected() {
    return { authenticated: false };
  }

  handleClientMessage(clientState, message, clientSend) {
    if (!clientState.authenticated) {
      if (message.type === 'auth' && message.token === this.token) {
        clientState.authenticated = true;
        clientSend({ type: 'auth_ok' });
      } else {
        clientSend({ type: 'auth_error' });
      }
      return;
    }
    if (message.type === 'command') {
      const internalId = crypto.randomUUID();
      this.pending.set(internalId, { clientSend, originalId: message.id });
      this.sendToExtension({ id: internalId, command: message.command, params: message.params });
    }
  }

  handleExtensionMessage(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.clientSend({
      type: 'response',
      id: pending.originalId,
      result: message.result,
      error: message.error,
    });
  }
}

module.exports = { Relay };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test host/relay.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Write `host/native-host.js`**

```js
#!/usr/bin/env node
const WebSocket = require('ws');
const { encodeMessage, MessageDecoder } = require('../lib/framing');
const { loadOrCreateConfig } = require('../lib/config');
const { Relay } = require('./relay');

function main() {
  const config = loadOrCreateConfig();

  const relay = new Relay({
    token: config.token,
    sendToExtension: (msg) => {
      process.stdout.write(encodeMessage(msg));
    },
  });

  const decoder = new MessageDecoder((msg) => relay.handleExtensionMessage(msg));
  process.stdin.on('data', (chunk) => decoder.push(chunk));
  process.stdin.on('end', () => process.exit(0));

  const wss = new WebSocket.Server({ host: '127.0.0.1', port: config.port });
  wss.on('connection', (ws) => {
    const state = relay.handleClientConnected();
    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      relay.handleClientMessage(state, message, (reply) => {
        ws.send(JSON.stringify(reply));
      });
    });
  });

  return { wss, config };
}

if (require.main === module) {
  main();
}

module.exports = { main };
```

- [ ] **Step 6: Write the integration test — spawns the real process, drives it with a real WebSocket client, and fakes the extension side over stdio**

```js
// host/native-host.integration.test.js
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
  const child = spawn(process.execPath, [path.join(__dirname, 'native-host.js')], {
    env: { ...process.env, CHROME_AGENT_BRIDGE_HOME: tmpHome },
  });

  const configPath = path.join(tmpHome, 'config.json');
  for (let i = 0; i < 50 && !fs.existsSync(configPath); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Fake extension: read framed commands from the child's stdout, reply on its stdin.
  const decoder = new MessageDecoder((msg) => {
    child.stdin.write(encodeMessage({ id: msg.id, result: { echoed: msg.command } }));
  });
  child.stdout.on('data', (chunk) => decoder.push(chunk));

  let ws;
  for (let i = 0; i < 50; i++) {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      break;
    } catch {
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

  assert.deepStrictEqual(responses[1], { type: 'response', id: 'x1', result: { echoed: 'navigate' }, error: undefined });

  ws.close();
  child.kill();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test host/native-host.integration.test.js`
Expected: PASS (1 test). If it hangs or fails, check: is port 8787 already in use by a leftover process (`lsof -i :8787`)? Kill it and rerun.

- [ ] **Step 8: Run the full test suite so far**

Run: `node --test lib/*.test.js host/*.test.js`
Expected: all PASS

- [ ] **Step 9: Commit**

```bash
chmod +x host/native-host.js
git add host/relay.js host/relay.test.js host/native-host.js host/native-host.integration.test.js
git commit -m "feat: add relay routing logic and native messaging host process"
```

---

### Task 5: Chrome extension

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/background.js`

**Interfaces:**
- Consumes: connects to native host named `com.chromeagentbridge.host` (this exact string must match Task 7's generated native-messaging-host manifest `name` field).
- Produces: the 13-command surface (`navigate`, `list_tabs`, `new_tab`, `switch_tab`, `close_tab`, `screenshot`, `get_text`, `get_html`, `click`, `type`, `press_key`, `evaluate`, `wait_for`) that `mcp-adapter/index.js` (Task 6) calls by name.

No `chrome.*` APIs are unit-testable outside a real browser — this task is verified manually (Step 3 below) rather than with `node:test`.

- [ ] **Step 1: Write `extension/manifest.json`** (no `"key"` field yet — Task 7's install script injects it)

```json
{
  "manifest_version": 3,
  "name": "Chrome Agent Bridge",
  "version": "1.0.0",
  "description": "Lets local MCP agents (Claude Code, Codex) control this browser via a local relay. No debug port.",
  "permissions": ["tabs", "scripting", "activeTab", "nativeMessaging"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_title": "Chrome Agent Bridge"
  }
}
```

- [ ] **Step 2: Write `extension/background.js`**

```js
const HOST_NAME = 'com.chromeagentbridge.host';

let port = null;

function connect() {
  port = chrome.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 2000);
  });
}

async function handleMessage(message) {
  const { id, command, params } = message;
  try {
    const result = await runCommand(command, params || {});
    port.postMessage({ id, result });
  } catch (err) {
    port.postMessage({ id, error: String((err && err.message) || err) });
  }
}

async function targetTabId(params) {
  if (params.tabId) return params.tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');
  return tab.id;
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

const commands = {
  async navigate(params) {
    const tabId = await targetTabId(params);
    await chrome.tabs.update(tabId, { url: params.url });
    await waitForLoad(tabId);
    return { tabId, url: params.url };
  },
  async list_tabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }));
  },
  async new_tab(params) {
    const tab = await chrome.tabs.create({ url: params.url });
    return { tabId: tab.id };
  },
  async switch_tab(params) {
    await chrome.tabs.update(params.tabId, { active: true });
    return { ok: true };
  },
  async close_tab(params) {
    await chrome.tabs.remove(params.tabId);
    return { ok: true };
  },
  async screenshot(params) {
    const tabId = await targetTabId(params);
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { dataUrl };
  },
  async get_text(params) {
    const tabId = await targetTabId(params);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector) => {
        const el = selector ? document.querySelector(selector) : document.body;
        return el ? el.innerText : null;
      },
      args: [params.selector || null],
    });
    return { text: result };
  },
  async get_html(params) {
    const tabId = await targetTabId(params);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector) => {
        const el = selector ? document.querySelector(selector) : document.documentElement;
        return el ? el.outerHTML : null;
      },
      args: [params.selector || null],
    });
    return { html: result };
  },
  async click(params) {
    const tabId = await targetTabId(params);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      },
      args: [params.selector],
    });
    if (!result) throw new Error(`no element matching selector: ${params.selector}`);
    return { ok: true };
  },
  async type(params) {
    const tabId = await targetTabId(params);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector, text) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        el.focus();
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) {
          setter.set.call(el, text);
        } else {
          el.value = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      args: [params.selector, params.text],
    });
    if (!result) throw new Error(`no element matching selector: ${params.selector}`);
    return { ok: true };
  },
  async press_key(params) {
    const tabId = await targetTabId(params);
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (key) => {
        const el = document.activeElement || document.body;
        el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      },
      args: [params.key],
    });
    return { ok: true };
  },
  async evaluate(params) {
    const tabId = await targetTabId(params);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (expression) => (0, eval)(expression),
      args: [params.expression],
    });
    return { result };
  },
  async wait_for(params) {
    const tabId = await targetTabId(params);
    const timeoutMs = params.timeoutMs || 10000;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (selector, timeoutMs) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (document.querySelector(selector)) return true;
          await new Promise((r) => setTimeout(r, 200));
        }
        return false;
      },
      args: [params.selector, timeoutMs],
    });
    if (!result) throw new Error(`timed out waiting for selector: ${params.selector}`);
    return { ok: true };
  },
};

async function runCommand(command, params) {
  const handler = commands[command];
  if (!handler) throw new Error(`unknown command: ${command}`);
  return handler(params);
}

connect();
chrome.runtime.onStartup.addListener(connect);
```

- [ ] **Step 3: Manual verification (deferred until Task 7's install script has run, since the extension needs its `"key"` and the native host needs to be registered first)**

Documented here for reference; actually performed in Task 8.

- [ ] **Step 4: Commit**

```bash
git add extension/manifest.json extension/background.js
git commit -m "feat: add chrome extension (tabs/scripting-based, no debugger API)"
```

---

### Task 6: MCP adapter

**Files:**
- Create: `mcp-adapter/index.js`
- Test: `mcp-adapter/relay-client.test.js`
- Create: `mcp-adapter/relay-client.js`

**Interfaces:**
- Consumes: `loadOrCreateConfig` from `lib/config.js` (Task 1). Connects over WebSocket to `host/native-host.js` (Task 4) using the `{type:'auth'}` / `{type:'command'}` / `{type:'response'}` contract defined there.
- Produces: registers MCP tools `navigate`, `click`, `type`, `press_key`, `screenshot`, `get_text`, `get_html`, `evaluate`, `list_tabs`, `new_tab`, `switch_tab`, `close_tab`, `wait_for` — these are the tool names both Claude Code and Codex will see once registered (Task 7).

The WebSocket-client logic (`relay-client.js`) is pure enough to unit test against a fake WebSocket; the MCP tool registration (`index.js`) is thin wiring, verified manually end-to-end in Task 8.

- [ ] **Step 1: Write the failing test for `mcp-adapter/relay-client.js`**

```js
// mcp-adapter/relay-client.test.js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createRelayClient } = require('./relay-client');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

test('sendCommand resolves with the result once a matching response arrives', async () => {
  const socket = new FakeSocket();
  const client = createRelayClient({ socket, token: 'secret' });
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth_ok' })));
  await client.ready;

  const promise = client.sendCommand('navigate', { url: 'https://x.com' });
  const sentCommand = socket.sent.find((m) => m.type === 'command');
  assert.strictEqual(sentCommand.command, 'navigate');

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response', id: sentCommand.id, result: { ok: true } })));
  const result = await promise;
  assert.deepStrictEqual(result, { ok: true });
});

test('sendCommand rejects when the response carries an error', async () => {
  const socket = new FakeSocket();
  const client = createRelayClient({ socket, token: 'secret' });
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth_ok' })));
  await client.ready;

  const promise = client.sendCommand('click', { selector: '#missing' });
  const sentCommand = socket.sent.find((m) => m.type === 'command');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response', id: sentCommand.id, error: 'no element matching selector: #missing' })));

  await assert.rejects(promise, /no element matching selector/);
});

test('ready rejects when the relay sends auth_error', async () => {
  const socket = new FakeSocket();
  const client = createRelayClient({ socket, token: 'wrong' });
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth_error' })));
  await assert.rejects(client.ready, /auth/);
});

test('ready rejects when the socket errors before auth completes (e.g. relay not running)', async () => {
  const socket = new FakeSocket();
  const client = createRelayClient({ socket, token: 'secret' });
  socket.emit('error', new Error('ECONNREFUSED'));
  await assert.rejects(client.ready, /ECONNREFUSED/);
});

test('sendCommand rejects if the socket closes while a command is still pending', async () => {
  const socket = new FakeSocket();
  const client = createRelayClient({ socket, token: 'secret' });
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth_ok' })));
  await client.ready;

  const promise = client.sendCommand('navigate', { url: 'https://x.com' });
  socket.emit('close');
  await assert.rejects(promise, /connection closed/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test mcp-adapter/relay-client.test.js`
Expected: FAIL — `Cannot find module './relay-client'`

- [ ] **Step 3: Write `mcp-adapter/relay-client.js`**

```js
const crypto = require('crypto');

function createRelayClient({ socket, token }) {
  const pending = new Map();
  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = () => { settled = true; resolve(); };
    rejectReady = (err) => { settled = true; reject(err); };
  });

  socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'auth', token }));
  });

  socket.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'auth_ok') {
      resolveReady();
    } else if (msg.type === 'auth_error') {
      rejectReady(new Error('relay rejected auth token'));
    } else if (msg.type === 'response') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  });

  socket.on('error', (err) => {
    if (!settled) rejectReady(err);
  });

  socket.on('close', () => {
    if (!settled) rejectReady(new Error('relay connection closed before authenticating'));
    for (const [id, p] of pending) {
      pending.delete(id);
      p.reject(new Error('relay connection closed'));
    }
  });

  function sendCommand(command, params) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type: 'command', id, command, params }));
    });
  }

  return { ready, sendCommand };
}

module.exports = { createRelayClient };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test mcp-adapter/relay-client.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Write `mcp-adapter/index.js`**

```js
#!/usr/bin/env node
const WebSocket = require('ws');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { loadOrCreateConfig } = require('../lib/config');
const { createRelayClient } = require('./relay-client');

const TOOLS = [
  ['navigate', 'Navigate a tab to a URL', { url: z.string(), tabId: z.number().optional() }],
  ['click', 'Click an element matching a CSS selector', { selector: z.string(), tabId: z.number().optional() }],
  ['type', 'Type text into an element matching a CSS selector', { selector: z.string(), text: z.string(), tabId: z.number().optional() }],
  ['press_key', 'Dispatch a key press to the active element', { key: z.string(), tabId: z.number().optional() }],
  ['screenshot', 'Capture a PNG screenshot of the visible tab (returns a data URL)', { tabId: z.number().optional() }],
  ['get_text', 'Get innerText of an element or the whole page', { selector: z.string().optional(), tabId: z.number().optional() }],
  ['get_html', 'Get outerHTML of an element or the whole page', { selector: z.string().optional(), tabId: z.number().optional() }],
  ['evaluate', 'Evaluate a JS expression in the page context and return the result', { expression: z.string(), tabId: z.number().optional() }],
  ['list_tabs', 'List all open tabs', {}],
  ['new_tab', 'Open a new tab at a URL', { url: z.string() }],
  ['switch_tab', 'Focus a tab by id', { tabId: z.number() }],
  ['close_tab', 'Close a tab by id', { tabId: z.number() }],
  ['wait_for', 'Wait for a CSS selector to appear in the page', { selector: z.string(), timeoutMs: z.number().optional(), tabId: z.number().optional() }],
];

async function main() {
  const config = loadOrCreateConfig();
  const socket = new WebSocket(`ws://127.0.0.1:${config.port}`);
  const relay = createRelayClient({ socket, token: config.token });

  socket.on('error', (err) => {
    process.stderr.write(`chrome-agent-bridge: cannot reach relay on 127.0.0.1:${config.port} (${err.message}). Is Chrome open with the extension loaded?\n`);
  });

  await relay.ready;

  const server = new McpServer({ name: 'chrome-agent-bridge', version: '1.0.0' });

  for (const [name, description, inputSchema] of TOOLS) {
    server.registerTool(name, { description, inputSchema }, async (params) => {
      try {
        const result = await relay.sendCommand(name, params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true };
      }
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`chrome-agent-bridge mcp adapter failed to start: ${err.message}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: Run the full test suite so far**

Run: `node --test lib/*.test.js host/*.test.js mcp-adapter/*.test.js`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
chmod +x mcp-adapter/index.js
git add mcp-adapter/index.js mcp-adapter/relay-client.js mcp-adapter/relay-client.test.js
git commit -m "feat: add MCP adapter exposing chrome-agent-bridge tools"
```

---

### Task 7: Install script (keypair/ID, native messaging manifest, MCP registration)

**Files:**
- Create: `scripts/install.js`
- Create: `scripts/install-helpers.js`
- Test: `scripts/install-helpers.test.js`

**Interfaces:**
- Consumes: `generateKeyPair`/`idFromPublicKeyDer` from `lib/extension-id.js` (Task 2).
- Produces: `buildNativeMessagingManifest({extensionId, hostScriptPath}) -> object` and `ensureManifestKey(manifestObj) -> {manifestObj, extensionId, changed: boolean}` — pure functions tested directly; `scripts/install.js` is the thin orchestrating entrypoint (manual-run, not unit tested, since it touches the filesystem outside the repo and shells out to `claude`/`codex`).

- [ ] **Step 1: Write the failing tests for the pure helpers**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/install-helpers.test.js`
Expected: FAIL — `Cannot find module './install-helpers'`

- [ ] **Step 3: Write `scripts/install-helpers.js`**

```js
const { generateKeyPair, idFromPublicKeyDer } = require('../lib/extension-id');

function buildNativeMessagingManifest({ extensionId, hostScriptPath }) {
  return {
    name: 'com.chromeagentbridge.host',
    description: 'Chrome Agent Bridge native messaging host',
    path: hostScriptPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

function ensureManifestKey(manifestObj) {
  if (manifestObj.key) {
    const der = Buffer.from(manifestObj.key, 'base64');
    return { manifestObj, extensionId: idFromPublicKeyDer(der), changed: false };
  }
  const { publicKeyDer, publicKeyBase64 } = generateKeyPair();
  const updated = { ...manifestObj, key: publicKeyBase64 };
  return { manifestObj: updated, extensionId: idFromPublicKeyDer(publicKeyDer), changed: true };
}

module.exports = { buildNativeMessagingManifest, ensureManifestKey };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/install-helpers.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Write `scripts/install.js`**

```js
#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildNativeMessagingManifest, ensureManifestKey } = require('./install-helpers');

const REPO_ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'extension', 'manifest.json');
const HOST_SCRIPT_PATH = path.join(REPO_ROOT, 'host', 'native-host.js');
const ADAPTER_PATH = path.join(REPO_ROOT, 'mcp-adapter', 'index.js');
const NATIVE_HOSTS_DIR = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'
);

function step(label, fn) {
  process.stdout.write(`- ${label}... `);
  try {
    fn();
    process.stdout.write('done\n');
  } catch (err) {
    process.stdout.write(`FAILED: ${err.message}\n`);
  }
}

function main() {
  const rawManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const { manifestObj, extensionId, changed } = ensureManifestKey(rawManifest);
  if (changed) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifestObj, null, 2) + '\n');
  }
  console.log(`Extension id: ${extensionId}${changed ? ' (newly generated)' : ' (reused existing key)'}`);

  fs.chmodSync(HOST_SCRIPT_PATH, 0o755);
  fs.chmodSync(ADAPTER_PATH, 0o755);

  step('write native messaging host manifest', () => {
    fs.mkdirSync(NATIVE_HOSTS_DIR, { recursive: true });
    const hostManifest = buildNativeMessagingManifest({ extensionId, hostScriptPath: HOST_SCRIPT_PATH });
    fs.writeFileSync(
      path.join(NATIVE_HOSTS_DIR, `${hostManifest.name}.json`),
      JSON.stringify(hostManifest, null, 2) + '\n'
    );
  });

  step('register MCP server with Claude Code (user scope)', () => {
    execFileSync('claude', ['mcp', 'remove', 'chrome-agent-bridge', '-s', 'user'], { stdio: 'ignore' });
  });
  step('add MCP server to Claude Code', () => {
    execFileSync('claude', ['mcp', 'add', 'chrome-agent-bridge', '-s', 'user', '--', 'node', ADAPTER_PATH], { stdio: 'inherit' });
  });

  step('remove any existing Codex MCP registration', () => {
    execFileSync('codex', ['mcp', 'remove', 'chrome-agent-bridge'], { stdio: 'ignore' });
  });
  step('add MCP server to Codex', () => {
    execFileSync('codex', ['mcp', 'add', 'chrome-agent-bridge', '--', 'node', ADAPTER_PATH], { stdio: 'inherit' });
  });

  console.log('\nNext step: load the extension unpacked.');
  console.log('  1. Open chrome://extensions');
  console.log('  2. Enable Developer mode (top right)');
  console.log(`  3. Click "Load unpacked" and select: ${path.join(REPO_ROOT, 'extension')}`);
  console.log(`  4. Confirm its ID matches: ${extensionId}`);
}

main();
```

Note: the `claude mcp remove` / `codex mcp remove` calls are wrapped with `stdio: 'ignore'` and no error handling around `execFileSync` failure on purpose — `execFileSync` throws on nonzero exit, and a "not found, nothing to remove" exit is expected and fine to ignore on a first run. `step()` catches and reports failures without crashing the rest of the script, so re-running `install.js` after the extension is reloaded is always safe.

- [ ] **Step 6: Run the full test suite**

Run: `cd /Users/michaelolimpo/agents_workdir/chrome-agent-bridge && node --test lib/*.test.js host/*.test.js mcp-adapter/*.test.js scripts/*.test.js`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/install.js scripts/install-helpers.js scripts/install-helpers.test.js
git commit -m "feat: add install script (keypair, native host manifest, MCP registration)"
```

---

### Task 8: Run install, load extension, end-to-end manual verification, README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Run the install script**

Run: `cd /Users/michaelolimpo/agents_workdir/chrome-agent-bridge && node scripts/install.js`
Expected: prints a generated extension id, writes the native messaging host manifest, and reports adding the MCP server to both Claude Code and Codex (`claude mcp add` / `codex mcp add` output visible).

- [ ] **Step 2: Verify the MCP registrations**

Run: `claude mcp get chrome-agent-bridge`
Expected: shows the server pointing at `node <repo>/mcp-adapter/index.js`.

Run: `codex mcp get chrome-agent-bridge`
Expected: shows the same.

- [ ] **Step 3: Load the extension in Chrome**

1. Open `chrome://extensions`.
2. Enable "Developer mode".
3. Click "Load unpacked", select the `extension/` directory.
4. Confirm the extension's ID (shown under its name) matches the id `install.js` printed.
5. Open the extension's service worker console (chrome://extensions → "service worker" link under the extension) and confirm no errors — it should have called `connectNative` without throwing.

- [ ] **Step 4: Manual smoke test against the running relay (bypassing MCP, direct WebSocket)**

Run this against your real, already-open Chrome (extension loaded from Step 3):

```bash
node -e "
const WebSocket = require('ws');
const { loadOrCreateConfig } = require('./lib/config');
const config = loadOrCreateConfig();
const ws = new WebSocket('ws://127.0.0.1:' + config.port);
ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: config.token })));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log(msg);
  if (msg.type === 'auth_ok') {
    ws.send(JSON.stringify({ type: 'command', id: '1', command: 'list_tabs', params: {} }));
  }
  if (msg.id === '1') process.exit(0);
});
"
```

Expected: prints `{type:'auth_ok'}` then a `{type:'response', id:'1', result:[...]}` listing your actual open Chrome tabs. If it hangs after `auth_ok`, the extension likely isn't connected — check the service worker console from Step 3.

- [ ] **Step 5: End-to-end test through the real MCP adapter**

Run: `node mcp-adapter/index.js` in one terminal (it will sit waiting for stdio input — that's expected, it's how Claude Code/Codex will drive it).

In a second terminal, confirm Claude Code sees the tools:

Run: `claude mcp get chrome-agent-bridge` (already done in Step 2) — then, in an actual Claude Code session, ask it to call the `navigate` tool with a URL and confirm your real, already-open Chrome tab navigates.

Do the same in a Codex session, calling the same tool by the same name, confirming it also drives the same Chrome tab.

- [ ] **Step 6: Write `README.md`**

```markdown
# Chrome Agent Bridge

Lets Claude Code and Codex control your normal, already-open Chrome — no
`--remote-debugging-port`, no separate browser instance, no vendor lock-in.

## How it works

A Chrome extension (loaded unpacked, using `chrome.tabs`/`chrome.scripting` —
never `chrome.debugger`) talks to a native-messaging host process that Chrome
spawns automatically. That host bridges to a token-gated local WebSocket
server. A stdio MCP adapter — registered identically in both Claude Code and
Codex — is the thin client each agent spawns per session.

See `docs/superpowers/specs/2026-08-13-chrome-agent-bridge-design.md` for the
full design and `docs/superpowers/plans/2026-08-13-chrome-agent-bridge.md` for
how it was built.

## Setup

```bash
npm install
node scripts/install.js
```

Then load the extension unpacked:
1. Open `chrome://extensions`
2. Enable Developer mode
3. "Load unpacked" → select the `extension/` directory

Re-running `node scripts/install.js` any time is safe — it reuses the
existing extension keypair/ID and re-registers the MCP servers.

## Tools

`navigate`, `click`, `type`, `press_key`, `screenshot`, `get_text`,
`get_html`, `evaluate`, `list_tabs`, `new_tab`, `switch_tab`, `close_tab`,
`wait_for` — identical set, identical behavior, in both Claude Code and
Codex.

## Tests

```bash
node --test lib/*.test.js host/*.test.js mcp-adapter/*.test.js scripts/*.test.js
```
```

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```
