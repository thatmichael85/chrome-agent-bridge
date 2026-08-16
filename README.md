# Chrome Agent Bridge

Lets Claude Code and Codex control your normal, already-open Chrome — no
`--remote-debugging-port`, no separate browser instance, no vendor lock-in.

> **If you're an AI agent reading this to figure out how to use the bridge**,
> jump to [For agents: using the tools](#for-agents-using-the-tools). Everyone
> else, keep reading top to bottom.

## Why this exists

The obvious ways to give an agent control of a browser both have a catch:

- **CDP debug port** (`--remote-debugging-port`, Playwright/Puppeteer style):
  requires launching Chrome specially or relaunching your existing window,
  which kills your current tabs/session.
- **Vendor extensions** ("Claude in Chrome", Codex's Browser Plugin): work
  fine, but each is a separate, proprietary mechanism locked to one vendor's
  agent. An agent built on a different harness can't use it.

This project is a third option: one Chrome extension + one small local
relay, exposed as a standard MCP server. Any MCP-capable agent — Claude
Code, Codex, or anything else — gets the identical tool set, driving the
Chrome window you already have open, with your real cookies and logins.

## Architecture

```
Claude Code / Codex CLI
      │  stdio (MCP)
      ▼
mcp-adapter/index.js          — one process per agent session, thin MCP↔WebSocket translator
      │  WebSocket, 127.0.0.1:<port>, token-authenticated
      ▼
host/native-host.js           — spawned automatically by Chrome; the one persistent,
      │                          shared process; owns all session/tab state
      │  native messaging (stdin/stdout, length-prefixed JSON)
      ▼
extension/background.js       — chrome.tabs / chrome.scripting only, never chrome.debugger
      ▼
your actual open tabs
```

Four layers, each with a different lifetime:

| Layer | Lifetime | Notes |
|---|---|---|
| Chrome itself | however long you keep it open | your real profile, cookies, logins |
| `native-host.js` (the relay) | spawned once by Chrome when the extension connects; survives across every agent session | holds per-session tab/group state (see below) |
| the extension's tab | per tab, until closed | just a normal Chrome tab |
| `mcp-adapter/index.js` | one per connecting agent session | spawned fresh by Claude Code/Codex at session start, dies when the session ends |

The relay is deliberately the *only* long-lived, shared piece — everything
above it (adapters, agent sessions) is cheap and disposable; everything
below it (Chrome, tabs) is the user's actual browser and is never touched
except through explicit commands.

## Setup

```bash
npm install
node scripts/install.js
```

This generates a stable extension keypair/ID, writes a host wrapper script
(`host/run-host.sh` — pins the absolute `node` path, since Chrome spawns
native-messaging hosts with a minimal `PATH` that won't find Homebrew's
node), writes the native-messaging-host manifest Chrome needs (into
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`), and
registers the MCP server with both `claude mcp add -s user` and
`codex mcp add`.

Then load the extension unpacked — Chrome does not allow this step to be
scripted, it requires a manual toggle and click:
1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` directory
4. Confirm the extension's ID (shown under its name) matches the ID
   `install.js` printed

Re-running `node scripts/install.js` any time is safe — it reuses the
existing extension keypair/ID and re-registers the MCP servers.

**After a fresh install (or a fresh Claude Code / Codex session), the
`chrome-agent-bridge` tools only show up in *new* sessions** — MCP servers
connect at startup, so a session that was already running when you ran
`install.js` won't see them until it restarts.

## For agents: using the tools

You have 15 tools, identical whether you're Claude Code or Codex:

| Tool | Params | What it does |
|---|---|---|
| `navigate` | `url`, `tabId?` | Navigate a tab to a URL |
| `click` | `selector`, `tabId?` | Click the first element matching a CSS selector |
| `type` | `selector`, `text`, `tabId?` | Set an input/textarea's value and fire `input`/`change` |
| `press_key` | `key`, `tabId?` | Dispatch a keydown/keyup to the active element |
| `screenshot` | `tabId?` | Capture the visible tab as a PNG data URL |
| `get_text` | `selector?`, `tabId?` | `innerText` of an element, or the whole page |
| `get_html` | `selector?`, `tabId?` | `outerHTML` of an element, or the whole page |
| `evaluate` | `expression`, `tabId?` | Run arbitrary JS in the page's own context, return the result |
| `wait_for` | `selector`, `timeoutMs?`, `tabId?` | Poll until a selector appears (default 10s timeout) |
| `list_tabs` | — | List **every** open tab in the browser (not just yours) |
| `new_tab` | `url` | Open a tab **in the background**; joins your session's tab group, becomes your new active tab |
| `switch_tab` | `tabId` | Signal for the user's attention on one of your tabs (badge + group highlight). Never changes focus |
| `close_tab` | `tabId` | Close a tab |
| `use_tab` | `tabId` | Switch your active default among tabs *you already own* — no browser round-trip |
| `list_my_tabs` | — | List the tabIds you own + your current active one — no browser round-trip |

**The one thing worth internalizing:** on every tool that takes `tabId`,
*omitting it targets your session's active tab* — you don't need to track
or pass a tabId at all for straight-line, single-tab work. Just call
`navigate`, `click`, `get_text`, etc. and they land on your own tab.

You get that tab automatically, on first use — the first command that
needs one creates it (in the background, in its own labeled tab group so
the user can see which tabs are yours) and runs against it. Connecting
alone opens nothing: a session that never browses costs the user no tabs,
which matters because every agent session connects whether or not it ever
touches Chrome. Call `list_my_tabs` any time to check what you own and
which one is currently active, with no network/browser cost — it returns
an empty list until your first browser command.

**Agent tabs never steal focus — this is enforced, not advisory.** Tabs
you open are created in the background: visible in the user's tab strip,
in your labeled group, but not focused. No tool can move the user off the
tab they're on. When you want to show them something, `switch_tab` raises
a signal — it badges the extension icon and turns your tab group orange —
and the user clicks over when they're ready; it returns `focused: false`
to say so plainly. The signal clears once they visit the tab.
(`screenshot` is the one exception: it briefly focuses your tab because
Chrome can only capture the visible one, then restores theirs.)

**Working with more than one tab:** call `new_tab` to open another — it
joins your existing group and becomes the new active default. Switch back
and forth with `use_tab({tabId})`, which is pure bookkeeping in the relay
(no round-trip to the browser), unlike `switch_tab` which actually changes
what's visually focused in the user's window. If you `use_tab` a tabId you
don't own, you get `error: not your tab: <id>` — you cannot accidentally
(or deliberately) reach into another agent's session this way.

**You are not alone in the browser.** Other agent sessions may be
connected at the same time, each with their own tab(s) and group. Nothing
you do to your own tabs affects theirs, and `list_tabs` (unlike
`list_my_tabs`) will show you tabs that aren't yours — don't assume every
tab you see belongs to you.

**Errors are explicit, not silent.** A `click`/`type`/`wait_for` on a
selector that doesn't match returns an MCP error naming the selector, not
a silent no-op. If the extension isn't loaded or Chrome isn't running, the
adapter fails to start with a clear stderr message rather than hanging.

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
- Tab ownership is enforced relay-side on **every** tab-targeting command,
  not just `use_tab`: passing an explicit `tabId` you don't own is rejected
  with `not your tab: <id>`. A session cannot navigate, click, type,
  evaluate, screenshot, or close another session's tabs — or any of the
  user's own tabs — even though `list_tabs` reveals their ids.
- No tool can pull the user's focus. Agent tabs open in the background and
  `switch_tab` only raises a passive signal.

## Troubleshooting

**"Failed to connect" / "Connection closed" from `claude mcp get
chrome-agent-bridge`:** nothing is listening on the relay port yet. This is
normal before the extension is loaded — it self-resolves once you load it
(step 3 of Setup) and Chrome spawns the relay.

**You edited `host/relay.js` or `host/native-host.js` and the change isn't
taking effect:** the relay is long-lived — Chrome only respawns it when the
extension's native-messaging connection drops, it does **not** hot-reload.
Run `pkill -f native-host.js` and wait ~2s for the extension's reconnect
logic (in `background.js`) to trigger Chrome into spawning a fresh one.

**A command silently hangs until an MCP timeout (~60s), no error logged
anywhere:** almost certainly a relay-internal pending-request entry that
forgot to carry the original client request id through to the eventual
response, so it never resolves the waiting promise. This exact class of
bug has bitten this codebase more than once — see `host/relay.test.js` for
the regression tests guarding against it.

**Values silently go missing across the WebSocket/native-messaging
boundary:** `JSON.stringify` drops object keys whose value is `undefined`
(not `null`) — a field present in-memory can simply vanish on the wire.
Check for this before assuming a field was never set.

**Extension shows an error after loading:** open its service worker
console (`chrome://extensions` → "service worker" link under the
extension's card). A common cause is `Native host has exited` /
`Access to the specified native messaging host is forbidden` — usually
means the native-messaging-host manifest's `allowed_origins` doesn't match
the extension's actual loaded ID, or the host script isn't executable.
Re-run `node scripts/install.js` and reload the extension.

## Repo layout

```
lib/              pure logic, no Chrome dependency — config, extension-id
                   keypair generation, native-messaging framing codec
host/             the relay: routing/session/tab logic (relay.js, unit
                   tested) + the process Chrome actually spawns
                   (native-host.js) + the wrapper script install.js
                   generates (run-host.sh, gitignored — machine-specific)
extension/        the MV3 Chrome extension (manifest.json, background.js)
mcp-adapter/      the stdio MCP server agents spawn (index.js) + its
                   WebSocket client logic (relay-client.js, unit tested)
scripts/          install.js (one-time setup), smoke.js (live verification
                   against real Chrome), amazon-search.js (example of a
                   one-off task script driving the bridge directly)
docs/superpowers/ the original spec and implementation plan
```

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

# Live verification against your real, running Chrome (extension loaded):
node scripts/smoke.js
```
