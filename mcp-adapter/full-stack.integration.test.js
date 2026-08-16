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
    assert.strictEqual(tools.tools.length, 13);
    const names = tools.tools.map((t) => t.name);
    for (const expected of ['navigate', 'click', 'screenshot', 'list_tabs', 'evaluate', 'wait_for']) {
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
