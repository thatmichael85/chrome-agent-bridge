const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { encodeMessage, MessageDecoder } = require('../lib/framing');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// Full chain minus real Chrome: MCP client -> adapter (child process, stdio MCP)
// -> WebSocket -> native-host (child process) -> fake extension scripted on the
// host's stdin/stdout using real native-messaging framing.
test('full stack: MCP tool calls flow through adapter and relay to the extension protocol and back', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-fullstack-'));
  const config = { token: 'fullstack-token-' + Date.now(), port: 8890 + (process.pid % 100) };
  fs.writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify(config));

  const host = spawn(process.execPath, [path.join(__dirname, '..', 'host', 'native-host.js')], {
    env: { ...process.env, CHROME_AGENT_BRIDGE_HOME: tmpHome },
  });

  let client;
  try {
    // Fake extension: reply to list_tabs with canned tabs; error on click.
    const seenCommands = [];
    const decoder = new MessageDecoder((msg) => {
      seenCommands.push(msg.command);
      if (msg.command === 'list_tabs') {
        host.stdin.write(encodeMessage({ id: msg.id, result: [{ id: 1, url: 'https://example.com', title: 'Example', active: true }] }));
      } else if (msg.command === 'click') {
        host.stdin.write(encodeMessage({ id: msg.id, error: `no element matching selector: ${msg.params.selector}` }));
      } else {
        host.stdin.write(encodeMessage({ id: msg.id, result: { ok: true } }));
      }
    });
    host.stdout.on('data', (chunk) => decoder.push(chunk));

    // Wait for the relay's WebSocket server to accept connections.
    const WebSocket = require('ws');
    for (let i = 0; i < 50; i++) {
      const probe = new WebSocket(`ws://127.0.0.1:${config.port}`);
      const up = await new Promise((resolve) => {
        probe.once('open', () => resolve(true));
        probe.once('error', () => resolve(false));
      });
      probe.close();
      if (up) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, 'index.js')],
      env: { ...process.env, CHROME_AGENT_BRIDGE_HOME: tmpHome },
    });
    client = new Client({ name: 'fullstack-test', version: '1.0.0' });
    await client.connect(transport);

    const tools = await client.listTools();
    assert.strictEqual(tools.tools.length, 15);
    const names = tools.tools.map((t) => t.name);
    for (const expected of ['navigate', 'click', 'screenshot', 'list_tabs', 'evaluate', 'wait_for', 'use_tab', 'list_my_tabs']) {
      assert.ok(names.includes(expected), `missing tool: ${expected}`);
    }

    const listResult = await client.callTool({ name: 'list_tabs', arguments: {} });
    const tabs = JSON.parse(listResult.content[0].text);
    assert.deepStrictEqual(tabs, [{ id: 1, url: 'https://example.com', title: 'Example', active: true }]);
    assert.ok(seenCommands.includes('list_tabs'));

    const clickResult = await client.callTool({ name: 'click', arguments: { selector: '#missing' } });
    assert.strictEqual(clickResult.isError, true);
    assert.match(clickResult.content[0].text, /no element matching selector: #missing/);

    const navResult = await client.callTool({ name: 'navigate', arguments: { url: 'https://example.org' } });
    assert.deepStrictEqual(JSON.parse(navResult.content[0].text), { ok: true });
  } finally {
    if (client) await client.close().catch(() => {});
    host.kill();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// Every other tabId-taking tool (navigate, click, type, ...) declares tabId
// optional so an omitted tabId falls back to the session's active tab (see
// README "Sessions, tabs, and concurrent agents"). relay.js implements that
// same fallback for close_tab specifically -- but the MCP tool schema must
// actually allow omitting tabId for that fallback to ever be reachable from
// a real client.
test('close_tab: omitting tabId closes the session\'s current active tab (matches every other tabId-taking tool)', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-fullstack-closetab-'));
  const config = { token: 'fullstack-token-' + Date.now(), port: 8990 + (process.pid % 100) };
  fs.writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify(config));

  const host = spawn(process.execPath, [path.join(__dirname, '..', 'host', 'native-host.js')], {
    env: { ...process.env, CHROME_AGENT_BRIDGE_HOME: tmpHome },
  });

  let client;
  try {
    let nextTabId = 100;
    const closeTabCalls = [];
    const decoder = new MessageDecoder((msg) => {
      if (msg.command === 'new_tab') {
        host.stdin.write(encodeMessage({ id: msg.id, result: { tabId: nextTabId++, groupId: 1 } }));
      } else if (msg.command === 'close_tab') {
        closeTabCalls.push(msg.params);
        host.stdin.write(encodeMessage({ id: msg.id, result: { ok: true } }));
      } else {
        host.stdin.write(encodeMessage({ id: msg.id, result: { ok: true } }));
      }
    });
    host.stdout.on('data', (chunk) => decoder.push(chunk));

    const WebSocket = require('ws');
    for (let i = 0; i < 50; i++) {
      const probe = new WebSocket(`ws://127.0.0.1:${config.port}`);
      const up = await new Promise((resolve) => {
        probe.once('open', () => resolve(true));
        probe.once('error', () => resolve(false));
      });
      probe.close();
      if (up) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, 'index.js')],
      env: { ...process.env, CHROME_AGENT_BRIDGE_HOME: tmpHome },
    });
    client = new Client({ name: 'fullstack-closetab-test', version: '1.0.0' });
    await client.connect(transport);

    // Tabs are provisioned on first use, not at auth, so take one first --
    // this is what assigns tabId 100 as the session's active tab.
    await client.callTool({ name: 'navigate', arguments: { url: 'https://example.com' } });
    const closeResult = await client.callTool({ name: 'close_tab', arguments: {} });
    assert.notStrictEqual(closeResult.isError, true, `close_tab with no tabId should succeed: ${JSON.stringify(closeResult)}`);
    assert.deepStrictEqual(closeTabCalls, [{ tabId: 100 }]);
  } finally {
    if (client) await client.close().catch(() => {});
    host.kill();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('full stack eval: LLM session auto-creates <model>-<sessionid> tab group, gets notified when human deletes group, and respawns cleanly', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-fullstack-group-eval-'));
  const config = { token: 'fullstack-token-' + Date.now(), port: 9090 + (process.pid % 100) };
  fs.writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify(config));

  const host = spawn(process.execPath, [path.join(__dirname, '..', 'host', 'native-host.js')], {
    env: { ...process.env, CHROME_AGENT_BRIDGE_HOME: tmpHome },
  });

  let client;
  try {
    let nextTabId = 500;
    let nextGroupId = 10;
    const newTabCalls = [];
    const decoder = new MessageDecoder((msg) => {
      if (msg.command === 'new_tab') {
        newTabCalls.push(msg.params);
        host.stdin.write(encodeMessage({ id: msg.id, result: { tabId: nextTabId++, groupId: nextGroupId++ } }));
      } else {
        host.stdin.write(encodeMessage({ id: msg.id, result: { ok: true, tabId: msg.params && msg.params.tabId } }));
      }
    });
    host.stdout.on('data', (chunk) => decoder.push(chunk));

    const WebSocket = require('ws');
    for (let i = 0; i < 50; i++) {
      const probe = new WebSocket(`ws://127.0.0.1:${config.port}`);
      const up = await new Promise((resolve) => {
        probe.once('open', () => resolve(true));
        probe.once('error', () => resolve(false));
      });
      probe.close();
      if (up) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, 'index.js')],
      env: { ...process.env, CHROME_AGENT_BRIDGE_HOME: tmpHome, CHROME_AGENT_BRIDGE_MODEL: 'eval-llm-model' },
    });
    client = new Client({ name: 'eval-llm-client', version: '1.0.0' });
    await client.connect(transport);

    // 1. First command creates a tab group named eval-llm-model-<8hex>
    const nav1 = await client.callTool({ name: 'navigate', arguments: { url: 'https://first.example' } });
    assert.notStrictEqual(nav1.isError, true);
    assert.strictEqual(newTabCalls.length, 1);
    assert.strictEqual(newTabCalls[0].createGroup, true);
    assert.match(newTabCalls[0].groupTitle, /^eval-llm-model-[0-9a-f]{8}$/);

    // 2. Simulate human deleting the tab group in Chrome (extension sends group_removed)
    host.stdin.write(encodeMessage({ event: 'group_removed', groupId: 10 }));
    await new Promise((r) => setTimeout(r, 50));

    // 3. Next LLM command gets the explicit group-removed message instructing it to respawn
    const afterRemove = await client.callTool({ name: 'get_text', arguments: {} });
    assert.strictEqual(afterRemove.isError, true);
    assert.match(afterRemove.content[0].text, /tab group was removed by the user.*respawn/i);

    // 4. LLM respawns by calling navigate without tabId -> creates a brand-new tab group with same <model>-<sessionid> title
    const nav2 = await client.callTool({ name: 'navigate', arguments: { url: 'https://respawn.example' } });
    assert.notStrictEqual(nav2.isError, true);
    assert.strictEqual(newTabCalls.length, 2);
    assert.strictEqual(newTabCalls[1].createGroup, true);
    assert.strictEqual(newTabCalls[1].groupTitle, newTabCalls[0].groupTitle);
  } finally {
    if (client) await client.close().catch(() => {});
    host.kill();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
