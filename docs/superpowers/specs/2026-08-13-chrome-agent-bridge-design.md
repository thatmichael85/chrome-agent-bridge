# Chrome Agent Bridge — Design

## Problem

Both Claude Code and Codex agents need to control the user's everyday Chrome browser
(the one already open, already logged into sites) — without:

- Launching Chrome with `--remote-debugging-port` (kills the current session or
  forces a separate profile/instance).
- Depending on a single vendor's proprietary extension (Anthropic's "Claude in
  Chrome" only serves Claude Code/claude.ai; OpenAI's Browser Plugin only serves
  Codex/ChatGPT). The user explicitly wants one mechanism usable by *any*
  MCP-capable agent, not two vendor-locked ones.

## Goals

- One Chrome extension, loaded unpacked, running in the user's normal Chrome
  profile, controlling real tabs.
- One local relay process that Chrome auto-spawns (via native messaging) — no
  manual daemon start, no login item.
- One MCP server ("chrome-agent-bridge") registered identically in Claude Code
  (`claude mcp add ... -s user`) and Codex (`codex mcp add ...`), exposing the
  same tool set to both.
- No CDP debug port at any point in the flow.

## Non-goals

- Raw network interception/mocking (CDP `Network` domain). Out of scope — the
  extension uses `chrome.tabs`/`chrome.scripting`, not `chrome.debugger`.
- Multi-browser support (Firefox, Safari). Chrome/Chromium only.
- Publishing the extension to the Chrome Web Store. Loaded unpacked, locally.

## Architecture

```
Claude Code  --stdio(MCP)-->  mcp-adapter/index.js  --WebSocket(localhost, token)-->  host/native-host.js  --native messaging(stdin/stdout)-->  extension/background.js  --chrome.tabs / chrome.scripting-->  real Chrome tabs
Codex        --stdio(MCP)-->  (same adapter script, separate process)  -------------------------^
```

- **`extension/`** — MV3 extension. `background.js` connects to the native host
  via `chrome.runtime.connectNative`, receives `{id, command, params}`, executes
  it against a target tab using standard extension APIs, replies
  `{id, result}` / `{id, error}`. No `chrome.debugger` permission, so no
  "this extension is debugging your browser" banner.
- **`host/native-host.js`** — spawned automatically by Chrome the moment the
  extension calls `connectNative` (Chrome manages its lifecycle; no manual
  start). Bridges native-messaging framing (4-byte length prefix + JSON) on
  stdin/stdout to a WebSocket server on `127.0.0.1:<port>`. Requires a token
  (generated once, stored in `~/.chrome-agent-bridge/config.json`) on every
  WebSocket connection before accepting commands.
- **`mcp-adapter/index.js`** — stdio MCP server (using
  `@modelcontextprotocol/sdk`). Claude Code and Codex each spawn their own
  copy per session; every copy connects to the same relay over the token-gated
  WebSocket. Registers one MCP tool per bridge command.
- **`scripts/install.js`** — one-time setup: generates a stable extension
  keypair/ID, writes the native-messaging-host manifest Chrome needs, and
  registers the MCP server with both `claude mcp add` and `codex mcp add`.

## Tool surface (identical for both agents)

`navigate(url, tabId?)`, `click(selector, tabId?)`, `type(selector, text, tabId?)`,
`press_key(key, tabId?)`, `screenshot(tabId?)`, `get_text(selector?, tabId?)`,
`get_html(selector?, tabId?)`, `evaluate(expression, tabId?)`, `list_tabs()`,
`new_tab(url)`, `switch_tab(tabId)`, `close_tab(tabId)`,
`wait_for(selector, timeoutMs?, tabId?)`.

## Security

- WebSocket server binds `127.0.0.1` only (not `0.0.0.0`).
- A random 48-hex-char token (`crypto.randomBytes(24)`) is required as the
  first message on every WebSocket connection; the relay ignores all commands
  from unauthenticated connections.
- The extension has no `chrome.debugger` permission — command surface is
  limited to page-level DOM/tab actions, not full CDP (network interception,
  cross-origin target attachment, etc.).
- The extension's ID is pinned via a generated RSA keypair embedded as
  `"key"` in `manifest.json`, so the native-messaging host manifest's
  `allowed_origins` can name an exact, stable `chrome-extension://<id>/`
  rather than trusting whatever ID Chrome would otherwise assign.

## Setup flow (one-time, for the user)

1. `npm install` at repo root.
2. `node scripts/install.js` — generates the keypair/token, writes the native
   messaging host manifest, registers the MCP server with `claude mcp add`
   and `codex mcp add`.
3. Load the extension unpacked in `chrome://extensions` (developer mode →
   "Load unpacked" → select `extension/`).

After that, no flags, no separate browser instance — agents use the Chrome
window already open.

## Error handling

- If the extension isn't loaded/connected when an MCP tool is called, the
  relay's WebSocket accepts the connection but has no live native-messaging
  port to forward to; `sendToExtension` failures surface as a clear MCP tool
  error ("extension not connected — open Chrome and confirm the extension is
  loaded") rather than hanging.
- If a `click`/`type`/`wait_for` selector doesn't match, the tool call
  returns an error naming the selector, not a silent no-op.

## Testing strategy

- Pure logic (config, extension-id derivation, native-messaging framing,
  relay routing) gets real automated unit tests (Node's built-in
  `node:test`), since none of it touches Chrome APIs.
- The native host relay gets an automated integration test: spawn
  `native-host.js` as a real child process, feed it framed stdin, and drive
  it with a real WebSocket client — no Chrome required.
- The extension's `background.js` and true end-to-end behavior (real tab
  control) cannot be unit tested without a real Chrome instance; those are
  covered by documented manual verification steps in the plan and README.

## Open trade-offs (accepted)

- No raw network interception — same limitation the official vendor
  extensions already accept; acceptable since the goal is page-level control,
  not devtools-grade inspection.
- `evaluate` runs arbitrary JS in the page's `MAIN` world — powerful and
  matches what a debug-port-based tool would allow anyway; scoped to the
  user's own local agents, not exposed off-machine (WebSocket is
  localhost + token only).
