const HOST_NAME = 'com.chromeagentbridge.host';

let port = null;
let reconnectTimer = null;

// Tabs an agent has asked the user to look at. switch_tab never changes focus;
// it raises a signal here, and the signal clears only when the user actually
// visits the tab (or closes it). See switch_tab below.
// tabId -> the group recolored for it. Storing the group (rather than looking
// it up on clear) means the highlight still gets undone when the signal clears
// because the tab was *closed*, at which point the tab can no longer be read.
const signalledTabs = new Map();
const GROUP_COLOR_IDLE = 'blue';
const GROUP_COLOR_SIGNALLED = 'orange';

async function clearSignal(tabId) {
  if (!signalledTabs.has(tabId)) return;
  const groupId = signalledTabs.get(tabId);
  signalledTabs.delete(tabId);
  if (groupId != null) {
    try {
      await chrome.tabGroups.update(groupId, { color: GROUP_COLOR_IDLE });
    } catch (err) {
      // Group is gone too (that was its last tab) -- nothing to un-highlight.
    }
  }
  if (signalledTabs.size === 0) {
    await chrome.action.setBadgeText({ text: '' });
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => clearSignal(tabId));
chrome.tabs.onRemoved.addListener((tabId) => {
  clearSignal(tabId);
  if (port) {
    try {
      port.postMessage({ event: 'tab_removed', tabId });
    } catch {}
  }
});
if (chrome.tabGroups && chrome.tabGroups.onRemoved) {
  chrome.tabGroups.onRemoved.addListener((group) => {
    if (port && group && group.id != null) {
      try {
        port.postMessage({ event: 'group_removed', groupId: group.id });
      } catch {}
    }
  });
}

function connect() {
  if (port) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const activePort = chrome.runtime.connectNative(HOST_NAME);
  port = activePort;
  activePort.onMessage.addListener((msg) => handleMessage(activePort, msg));
  activePort.onDisconnect.addListener(() => {
    if (port === activePort) port = null;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 2000);
    }
  });
}

async function handleMessage(activePort, message) {
  const { id, command, params } = message;
  try {
    const result = await runCommand(command, params || {});
    activePort.postMessage({ id, result });
  } catch (err) {
    activePort.postMessage({ id, error: String((err && err.message) || err) });
  }
}

async function targetTabId(params) {
  if (params.tabId) return params.tabId;
  // The relay injects the session's own tabId into every command, so a missing
  // one means the session currently owns no tab (e.g. it just closed its last).
  // Never silently fall back to whatever tab the user has focused — that would
  // run agent commands against their browsing. Fail loudly instead.
  throw new Error('no tab for this session — open one with new_tab, or pass an explicit tabId');
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
  async reload_extension() {
    setTimeout(() => chrome.runtime.reload(), 50);
    return { ok: true };
  },
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
    // Background by default: agent tabs must never steal focus from whatever
    // the user is doing. They still open in the user's window (visible in the
    // tab strip, in the session's labeled group) — just not focused. An agent
    // that genuinely needs the tab in front calls switch_tab explicitly.
    const tab = await chrome.tabs.create({ url: params.url, active: false });
    let groupId = null;
    if (params.groupId != null) {
      try {
        await chrome.tabs.group({ tabIds: [tab.id], groupId: params.groupId });
        groupId = params.groupId;
      } catch (err) {
        groupId = await chrome.tabs.group({ tabIds: [tab.id] });
        await chrome.tabGroups.update(groupId, { title: params.groupTitle || 'Agent session', color: 'blue' });
      }
    } else if (params.createGroup) {
      groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, { title: params.groupTitle || 'Agent session', color: 'blue' });
    }
    return { tabId: tab.id, groupId };
  },
  async switch_tab(params) {
    // Signals for attention; never focuses. The agent can say "look at this",
    // but only the user decides when to actually look -- so this must not
    // interrupt whatever they're currently doing. The badge is deliberately
    // global rather than per-tab: the user is by definition looking somewhere
    // else, so it has to be visible from wherever they are.
    const tabId = params.tabId;
    const tab = await chrome.tabs.get(tabId);
    const grouped = tab.groupId != null && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE;
    signalledTabs.set(tabId, grouped ? tab.groupId : null);
    await chrome.action.setBadgeText({ text: '●' });
    await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    if (grouped) {
      await chrome.tabGroups.update(tab.groupId, { color: GROUP_COLOR_SIGNALLED });
    }
    return { ok: true, focused: false, signalled: true };
  },
  async close_tab(params) {
    await chrome.tabs.remove(params.tabId);
    return { ok: true };
  },
  async screenshot(params) {
    const tabId = await targetTabId(params);
    const tab = await chrome.tabs.get(tabId);
    // captureVisibleTab can only ever capture the window's *active* tab. Agent
    // tabs open in the background, so without this the capture would silently
    // return whatever the user is looking at instead of the requested tab —
    // wrong result and a privacy leak. Focus the target for the capture only,
    // then hand the user's tab straight back.
    let restoreTabId = null;
    if (!tab.active) {
      const [userTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (userTab && userTab.id !== tabId) restoreTabId = userTab.id;
      await chrome.tabs.update(tabId, { active: true });
    }
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
    } finally {
      if (restoreTabId != null) await chrome.tabs.update(restoreTabId, { active: true });
    }
    // JPEG + downscale: a full-res Retina PNG base64s to hundreds of KB of
    // text in the consuming agent's context; ~1280px JPEG is 20-40x smaller
    // and still perfectly readable for layout/content checks.
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const maxWidth = 1280;
    if (bitmap.width <= maxWidth) return { dataUrl };
    const scale = maxWidth / bitmap.width;
    const canvas = new OffscreenCanvas(maxWidth, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    }
    return { dataUrl: `data:image/jpeg;base64,${btoa(binary)}` };
  },
  async get_text(params) {
    const tabId = await targetTabId(params);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector) => {
        const el = selector ? document.querySelector(selector) : document.body;
        if (!el) return null;
        return el.innerText || el.textContent || '';
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
