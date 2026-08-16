#!/usr/bin/env node
const WebSocket = require('ws');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { loadOrCreateConfig } = require('../lib/config');
const { createRelayClient } = require('./relay-client');
const { formatResult } = require('./format-result');

// tabId is optional on most tools: omitting it targets your session's
// current active tab (auto-provisioned on connect, switchable with use_tab).
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
  ['new_tab', 'Open a new tab at a URL. It joins your session\'s tab group and becomes your active default tab.', { url: z.string() }],
  ['switch_tab', 'Signal that you want the user to look at one of your tabs (badges the extension icon, highlights your tab group). Does NOT change focus — the user decides when to look.', { tabId: z.number() }],
  ['close_tab', 'Close a tab by id. Omitting tabId closes your session\'s current active tab.', { tabId: z.number().optional() }],
  ['wait_for', 'Wait for a CSS selector to appear in the page', { selector: z.string(), timeoutMs: z.number().optional(), tabId: z.number().optional() }],
  ['use_tab', 'Switch which of your own tabs subsequent commands target by default when tabId is omitted. No browser round-trip.', { tabId: z.number() }],
  ['list_my_tabs', 'List the tabIds you own and your current active default tab. No browser round-trip.', {}],
];

async function main() {
  const config = loadOrCreateConfig();
  const createSocket = () => {
    const sock = new WebSocket(`ws://127.0.0.1:${config.port}`);
    sock.on('error', (err) => {
      process.stderr.write(`chrome-agent-bridge: cannot reach relay on 127.0.0.1:${config.port} (${err.message}). Is Chrome open with the extension loaded?\n`);
    });
    return sock;
  };
  // Stable for this adapter process, i.e. for the life of the agent session.
  // Reconnects present it so the relay resumes our tabs rather than opening new
  // ones and orphaning the old.
  const sessionId = require('crypto').randomUUID();
  const relay = createRelayClient({ createSocket, token: config.token, sessionId });

  await relay.ready;

  const server = new McpServer({ name: 'chrome-agent-bridge', version: '1.0.0' });

  for (const [name, description, inputSchema] of TOOLS) {
    server.registerTool(name, { description, inputSchema }, async (params) => {
      try {
        const result = await relay.sendCommand(name, params);
        return { content: formatResult(name, result) };
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
