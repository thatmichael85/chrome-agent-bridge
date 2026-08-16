# Chrome Agent Bridge

Lets Claude Code and Codex control your normal, already-open Chrome — no
`--remote-debugging-port`, no separate browser instance, no vendor lock-in.

## How it works

A Chrome extension (loaded unpacked, using `chrome.tabs`/`chrome.scripting` —
never `chrome.debugger`) talks to a native-messaging host process that Chrome
spawns automatically. That host bridges to a token-gated local WebSocket
server. A stdio MCP adapter — registered identically in both Claude Code and
Codex — is the thin client each agent spawns per session.

```
Claude Code / Codex CLI
      │  stdio (MCP)
      ▼
mcp-adapter/index.js
      │  WebSocket, 127.0.0.1:<port>, token-authenticated
      ▼
host/native-host.js   (spawned automatically by Chrome, not manually)
      │  native messaging (stdin/stdout, length-prefixed JSON)
      ▼
extension/background.js
      │  chrome.tabs / chrome.scripting
      ▼
your actual open tabs
```

See `docs/superpowers/specs/2026-08-13-chrome-agent-bridge-design.md` for the
full design and `docs/superpowers/plans/2026-08-13-chrome-agent-bridge.md` for
how it was built.

### Sessions, tabs, and concurrent agents

`host/relay.js` is the one persistent, shared piece — Chrome spawns it once
and it stays alive as long as the extension does, regardless of how many
agent sessions connect and disconnect. Because multiple agents (or multiple
Claude Code / Codex sessions) can be talking to it at once, it gives each
connecting session its own isolated default tab automatically:

- On connect (after auth), the relay opens a new tab for that session and
  puts it in its own labeled, colored Chrome tab group.
- Any tool call that omits `tabId` targets that session's current active
  tab — never an ambiguous "whatever tab is focused" shared with other
  agents.
- `new_tab` opens another tab in the *same* session's group and becomes its
  new active default.
- `use_tab({tabId})` switches which of your *own* tabs is the default,
  entirely relay-side — no browser round-trip. Trying to `use_tab` a tabId
  you don't own fails with `not your tab: <id>`.
- `list_my_tabs()` lists the tabIds you own and your current active tab,
  also with no round-trip.
- Two concurrent sessions never get the same default tab and can't
  `use_tab` each other's tabs — verified in `scripts/smoke.js` and
  `host/relay.test.js`.

**If you edit `host/relay.js` or `host/native-host.js`:** the running relay
process won't pick up the change — Chrome only respawns it when the
extension's native-messaging connection drops. After editing, kill the
running process (`pkill -f native-host.js`) and let the extension's
reconnect logic (in `background.js`) spawn a fresh one within ~2s.

## Setup

```bash
npm install
node scripts/install.js
```

This generates a stable extension keypair/ID, writes a host wrapper script
(`host/run-host.sh`, pinning the absolute node path — Chrome spawns
native-messaging hosts with a minimal PATH that won't find Homebrew's node),
writes the native-messaging-host manifest Chrome needs (into
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`), and
registers the MCP server with both `claude mcp add -s user` and `codex mcp add`.

Then load the extension unpacked (Chrome does not allow this step to be
scripted — it requires a manual toggle and click):
1. Open `chrome://extensions`
2. Enable Developer mode
3. "Load unpacked" → select the `extension/` directory
4. Confirm the extension's ID (shown under its name) matches the ID
   `install.js` printed

Re-running `node scripts/install.js` any time is safe — it reuses the
existing extension keypair/ID and re-registers the MCP servers.

## Tools

`navigate`, `click`, `type`, `press_key`, `screenshot`, `get_text`,
`get_html`, `evaluate`, `list_tabs`, `new_tab`, `switch_tab`, `close_tab`,
`wait_for`, `use_tab`, `list_my_tabs` — identical set, identical behavior,
in both Claude Code and Codex. On every tool that takes `tabId`, omitting it
targets your session's current active tab (see "Sessions, tabs, and
concurrent agents" above).

## Security

- The local WebSocket server binds `127.0.0.1` only, never `0.0.0.0`.
- Every WebSocket connection must authenticate with a random per-machine
  token (`~/.chrome-agent-bridge/config.json`) before any command is
  accepted.
- The extension never requests `chrome.debugger` — no CDP, no network
  interception, just page-level tab/DOM actions.
- The extension's ID is pinned via a generated RSA keypair embedded in
  `extension/manifest.json`, so the native-messaging-host manifest can name
  an exact, stable `chrome-extension://<id>/` in `allowed_origins`.

## Uninstalling

```bash
claude mcp remove chrome-agent-bridge -s user
codex mcp remove chrome-agent-bridge
rm "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromeagentbridge.host.json"
```

Then remove the extension from `chrome://extensions`.

## Tests

```bash
# Automated suite (no Chrome needed — includes a full-stack integration test
# that runs the real adapter + relay with a scripted fake extension):
node --test lib/*.test.js host/*.test.js mcp-adapter/*.test.js scripts/*.test.js

# Live smoke test against the real, running Chrome (extension loaded):
node scripts/smoke.js
```
