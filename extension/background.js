const HOST_NAME = 'com.chromeagentbridge.host';

let port = null;

function connect() {
  port = chrome.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 2000);
  });
}

async function handleMessage(message) {
  const { id, command, params } = message;
  try {
    const result = await runCommand(command, params || {});
    port.postMessage({ id, result });
  } catch (err) {
    port.postMessage({ id, error: String((err && err.message) || err) });
  }
}

async function targetTabId(params) {
  if (params.tabId) return params.tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');
  return tab.id;
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
    const tab = await chrome.tabs.create({ url: params.url });
    return { tabId: tab.id };
  },
  async switch_tab(params) {
    await chrome.tabs.update(params.tabId, { active: true });
    return { ok: true };
  },
  async close_tab(params) {
    await chrome.tabs.remove(params.tabId);
    return { ok: true };
  },
  async screenshot(params) {
    const tabId = await targetTabId(params);
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { dataUrl };
  },
  async get_text(params) {
    const tabId = await targetTabId(params);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector) => {
        const el = selector ? document.querySelector(selector) : document.body;
        return el ? el.innerText : null;
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
