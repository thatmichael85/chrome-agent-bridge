#!/usr/bin/env node
// Live smoke test against the real, running Chrome (extension loaded).
// Exercises the exact path Claude Code / Codex use: spawns the MCP adapter
// as a stdio child and drives it as an MCP client.
// Usage: node scripts/smoke.js
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const ADAPTER_PATH = path.join(__dirname, '..', 'mcp-adapter', 'index.js');

function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

(async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ADAPTER_PATH] });
  const client = new Client({ name: 'smoke-test', version: '1.0.0' });
  try {
    await client.connect(transport);
  } catch (err) {
    check('connect to adapter/relay', false, `${err.message} — is Chrome open with the extension loaded?`);
    process.exit(1);
  }
  check('connect to adapter/relay', true);

  const tools = await client.listTools();
  check('13 tools exposed', tools.tools.length === 13, tools.tools.map((t) => t.name).join(', '));

  const lt = await client.callTool({ name: 'list_tabs', arguments: {} });
  const tabs = JSON.parse(lt.content[0].text);
  check('list_tabs returns real tabs', Array.isArray(tabs) && tabs.length > 0, `${tabs.length} tabs`);

  const nt = await client.callTool({ name: 'new_tab', arguments: { url: 'https://example.com' } });
  const { tabId } = JSON.parse(nt.content[0].text);
  check('new_tab', Number.isInteger(tabId), `tabId ${tabId}`);

  try {
    await client.callTool({ name: 'wait_for', arguments: { selector: 'h1', tabId } });
    const gt = await client.callTool({ name: 'get_text', arguments: { selector: 'h1', tabId } });
    const { text } = JSON.parse(gt.content[0].text);
    check('wait_for + get_text', text === 'Example Domain', JSON.stringify(text));

    const ev = await client.callTool({ name: 'evaluate', arguments: { expression: 'document.title', tabId } });
    const { result } = JSON.parse(ev.content[0].text);
    check('evaluate', result === 'Example Domain', JSON.stringify(result));

    const shot = await client.callTool({ name: 'screenshot', arguments: { tabId } });
    check('screenshot', shot.content[0].text.includes('data:image/png'), `${shot.content[0].text.length} chars`);

    const bad = await client.callTool({ name: 'click', arguments: { selector: '#does-not-exist', tabId } });
    check('click on missing selector fails cleanly', bad.isError === true, bad.content[0].text);
  } finally {
    await client.callTool({ name: 'close_tab', arguments: { tabId } });
    console.log('cleanup: scratch tab closed');
    await client.close();
  }
})().catch((err) => {
  console.error('smoke test crashed:', err.message);
  process.exit(1);
});
