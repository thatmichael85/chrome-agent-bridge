---
name: chrome-agent-bridge
description: Browse, scrape, or act on real websites through the user's actual logged-in Chrome via MCP tools (navigate, click, type, get_text, evaluate, screenshot…). Use for any "go to <site>", "check my <email/dashboard>", form-filling, price/listing scraping, or "my browser"/Chrome request. Confirm before the first browser action unless the request explicitly asked for browser use.
metadata:
  short-description: Control the user's real Chrome via MCP tools; always confirm before using it.
---

# Chrome Agent Bridge

## What this is

A local MCP server that lets you control the user's real, already-open Chrome
browser — the one they use every day, with their real cookies and logins —
without any debug-port flag or separate browser instance. Full architecture,
tool reference, and troubleshooting live in
`~/agents_workdir/chrome-agent-bridge/README.md` — read it if you need
detail beyond what's here.

## Before you touch the browser: ask first

This controls the user's **real** browser — their actual logged-in
sessions, actual tabs, actual accounts (email, banking, work systems,
whatever they happen to have open or logged into). A wrong click or
navigation here is a real-world action against a real account, not
something happening in a disposable sandbox.

So: before calling any chrome-agent-bridge tool for the first time in a
conversation, confirm with the user that it's okay to use their real
browser for this task — **unless their request already explicitly asked
for it** ("go to amazon and find me X", "open my email and check Y" *is*
the ask; don't ask again, that's just friction). When it's genuinely
ambiguous whether browser automation is the right approach for a task —
versus, say, a web search or answering from what you know — ask which they
want. When they've clearly asked for real browser interaction, proceed.

## Check the tools are actually available

Look for tools named `navigate`, `click`, `list_my_tabs`, `evaluate`, etc.
If you don't see them, this session likely started before the MCP server
was registered (it connects at startup) — tell the user to start a new
session. If they're present but every call fails to connect, the
extension probably isn't loaded — tell the user to check
`chrome://extensions` for "Chrome Agent Bridge".

## How to use it (Tab Groups & Session Lifecycle)

You get your own dedicated Chrome tab group (`<model>-<sessionid>`)
automatically on first use: the first browser command needing a tab
creates it in the background, places it inside your session's labeled
tab group, and runs against it. Connecting alone costs nothing, so
`list_my_tabs` is empty until your first actual browser command.

**Simple, single-tab work:** just call tools and **omit `tabId` every
time** — `navigate`, `click`, `get_text`, etc. all default to your
session's active tab and ensure it starts in your session's tab group.
Never grab a `tabId` from `list_tabs()` to start your work.

**If the user deletes your tab group (or closes all its tabs):**
Your next browser command will return:
`error: your tab group was removed by the user — call new_tab or navigate (without tabId) to respawn a fresh tab group and continue your work`.
When you see this error, do not keep passing the old `tabId` — simply
call `navigate({url})` (without `tabId`) or `new_tab({url})` to respawn
a fresh `<model>-<sessionid>` tab group and continue.

**You cannot steal focus.** Your tabs open in the background and no tool
moves the user off the tab they're on. To show them something, call
`switch_tab({tabId})` — it badges the extension icon and highlights your
tab group orange, returning `focused: false`. They come look when ready;
don't expect them to be on your tab afterward.

**Multi-tab work:** `new_tab({url})` opens another tab, joins your
existing `<model>-<sessionid>` tab group, and becomes your new active
default. Switch back and forth with `use_tab({tabId})` — instant,
relay-side bookkeeping only, no browser round-trip. Check what you
currently own with `list_my_tabs()`, also instant.

**You are not alone in the browser.** Other agent sessions may be
connected at the same time, each with their own tab group, and the user
has their own tabs open too. `list_tabs()` shows *every* open tab, not
just yours — seeing a tabId does not mean you may touch it. Passing a
tabId you don't own to any command (`navigate`, `click`, `evaluate`,
`close_tab`, `use_tab`, …) is rejected with `not your tab: <id>`. The
relay enforces this; it isn't a convention you could bend.

**Errors are real errors, not silent no-ops.** A `click`/`type`/`wait_for`
on a selector that doesn't match returns an explicit error naming the
selector. If a call fails with something connection-shaped, the extension
probably isn't running — tell the user rather than retrying blindly.

## Common patterns

**Read a page:** `navigate({url})` → `wait_for({selector})` for the
content you need → `get_text({selector})` or `evaluate({expression})`.

**Fill and submit a form:** `navigate` → `wait_for` the form →
`type({selector, text})` per field → `click({selector})` for submit.

**Look at something visually:** `screenshot()` returns a downscaled JPEG
image block of the current active tab.

**Scrape structured data (search results, listings, prices):** prefer one
`evaluate` call with a JS expression that maps over the matching elements
and returns an array of objects, over many individual `get_text` calls —
one round-trip instead of N. Real page markup is often messier than it
looks: duplicate-looking elements, a brand name in a separate span from
the actual title, prices in hidden/offscreen elements rather than visible
text. Inspect the actual DOM with a quick `evaluate` before trusting a
selector guess, especially on sites you haven't scraped before — but
check the site recipe cache (below) first, since a prior session may
have already paid that discovery cost.

## Site recipe cache

Discovering a site's selectors and URL scheme is the expensive part of
scraping. Recipes at `~/.chrome-agent-bridge/site-cache/<domain>.json`
(shared across all sessions and agents) save that work.

**Before scraping a domain, check for its recipe file.** If it exists:
navigate, run its `validate` expression in one `evaluate` call (it
returns a ~15-token fingerprint, not content), and compare against
`validateExpect`. Match → use the cached `selectors`/`searchUrl`
directly. Mismatch → the site changed; discover normally and overwrite
the recipe.

**After discovering a new site (or fixing a stale recipe), write its
file.** Compact single-line JSON, only what skips re-discovery: search
URL pattern, field selectors, cheap validate check. Never cache scraped
data itself. `www.sgcarmart.com.json` there is a working example.

## Keep results small

Text results are capped (~20k chars) at the adapter — a truncated
result means narrow with a selector or return fewer fields, not retry.
Prefer one `evaluate` returning only needed fields over `get_html`/
`get_text` dumps; return ids, not long URLs, when scraping many rows.
`screenshot` returns a downscaled JPEG as a true image block — fine to
use when you actually need to see the page, but a targeted `evaluate`
is still cheaper for pulling data.
