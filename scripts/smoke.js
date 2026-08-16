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
  check('15 tools exposed', tools.tools.length === 15, tools.tools.map((t) => t.name).join(', '));

  const lt = await client.callTool({ name: 'list_tabs', arguments: {} });
  const tabs = JSON.parse(lt.content[0].text);
  check('list_tabs returns real tabs', Array.isArray(tabs) && tabs.length > 0, `${tabs.length} tabs`);

  const lmt = await client.callTool({ name: 'list_my_tabs', arguments: {} });
  const owned = JSON.parse(lmt.content[0].text);
  check('connecting alone opens no tab (provisioning is lazy)', owned.tabIds.length === 0, JSON.stringify(owned));

  const navDefault = await client.callTool({ name: 'navigate', arguments: { url: 'https://example.com' } });
  check('navigate with no tabId provisions a tab on demand and targets it', !navDefault.isError, JSON.stringify(JSON.parse(navDefault.content[0].text)));

  const lmtAfter = await client.callTool({ name: 'list_my_tabs', arguments: {} });
  const ownedAfter = JSON.parse(lmtAfter.content[0].text);
  check('the session now owns exactly the one tab it needed', ownedAfter.tabIds.length === 1, JSON.stringify(ownedAfter));
  const defaultTabId = ownedAfter.activeTabId;

  const nt = await client.callTool({ name: 'new_tab', arguments: { url: 'https://example.com' } });
  const { tabId, groupId } = JSON.parse(nt.content[0].text);
  check('new_tab returns a tabId and joins a tab group', Number.isInteger(tabId) && Number.isInteger(groupId), `tabId ${tabId}, groupId ${groupId}`);

  const useTab = await client.callTool({ name: 'use_tab', arguments: { tabId: defaultTabId } });
  check('use_tab switches the active default with no browser round-trip', !useTab.isError, JSON.stringify(JSON.parse(useTab.content[0].text)));

  const badUse = await client.callTool({ name: 'use_tab', arguments: { tabId: 999999999 } });
  check('use_tab rejects a tabId this session does not own', badUse.isError === true, badUse.content[0].text);

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
    console.log('cleanup: scratch tab closed (session default tab is left open, per policy)');
  }

  // Second concurrent client, simulating a second agent, to prove isolation.
  const transport2 = new StdioClientTransport({ command: process.execPath, args: [ADAPTER_PATH] });
  const client2 = new Client({ name: 'smoke-test-2', version: '1.0.0' });
  await client2.connect(transport2);
  // Give it a tab of its own first -- with lazy provisioning it owns nothing
  // until it browses, which would make the comparison below vacuous.
  await client2.callTool({ name: 'navigate', arguments: { url: 'https://example.org' } });
  const lmt2 = await client2.callTool({ name: 'list_my_tabs', arguments: {} });
  const owned2 = JSON.parse(lmt2.content[0].text);
  check('a second concurrent session gets a DIFFERENT default tab than the first', owned2.activeTabId != null && owned2.activeTabId !== defaultTabId, `first=${defaultTabId} second=${owned2.activeTabId}`);
  const crossUse = await client2.callTool({ name: 'use_tab', arguments: { tabId: defaultTabId } });
  check('a second session cannot claim the first session\'s tab via use_tab', crossUse.isError === true, crossUse.content[0].text);
  await client2.close();

  await client.close();
})().catch((err) => {
  console.error('smoke test crashed:', err.message);
  process.exit(1);
});
