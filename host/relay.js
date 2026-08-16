const crypto = require('crypto');

// Commands that act on the browser as a whole rather than on one of the
// session's own tabs. These must never trigger lazy tab provisioning.
const TABLESS_COMMANDS = new Set(['list_tabs']);

class Relay {
  constructor({ token, sendToExtension }) {
    this.token = token;
    this.sendToExtension = sendToExtension;
    this.pending = new Map();
    // sessionId -> clientState. A client whose socket drops (relay restart,
    // flaky connection) reconnects with the same sessionId and resumes its
    // existing tabs, instead of registering as a brand new session and
    // stranding them as orphans in the user's window.
    this.sessions = new Map();
  }

  handleClientConnected() {
    return {
      authenticated: false,
      id: crypto.randomUUID(),
      sessionId: null,
      tabs: new Set(),
      activeTabId: null,
      groupId: null,
    };
  }

  handleClientMessage(clientState, message, clientSend) {
    if (!clientState.authenticated) {
      if (message.type !== 'auth') return;
      if (message.token !== this.token) {
        clientSend({ type: 'auth_error' });
        return;
      }
      clientState.authenticated = true;
      this.resumeOrRegister(clientState, message.sessionId);
      // Deliberately no tab here. Most agent sessions never touch the browser,
      // and provisioning on connect meant every one of them dropped a blank tab
      // and a tab group into the user's window regardless. Tabs are created on
      // first actual use instead -- see the lazy branch below.
      clientSend({ type: 'auth_ok' });
      return;
    }

    if (message.type !== 'command') return;

    // Ownership applies to EVERY tab-targeting command, not just use_tab.
    // list_tabs hands out every tabId in the browser, so without this guard a
    // session could pass one explicitly and navigate/click/evaluate/close
    // against another session's tabs -- or the user's own.
    const requestedTabId = message.params && message.params.tabId;
    if (requestedTabId !== undefined && !clientState.tabs.has(requestedTabId)) {
      clientSend({ type: 'response', id: message.id, result: undefined, error: `not your tab: ${requestedTabId}` });
      return;
    }

    if (message.command === 'use_tab') {
      const tabId = message.params && message.params.tabId;
      if (!clientState.tabs.has(tabId)) {
        clientSend({ type: 'response', id: message.id, result: undefined, error: `not your tab: ${tabId}` });
        return;
      }
      clientState.activeTabId = tabId;
      clientSend({ type: 'response', id: message.id, result: { ok: true }, error: undefined });
      return;
    }

    if (message.command === 'list_my_tabs') {
      clientSend({
        type: 'response',
        id: message.id,
        result: { tabIds: [...clientState.tabs], activeTabId: clientState.activeTabId },
        error: undefined,
      });
      return;
    }

    if (message.command === 'new_tab') {
      const params = { ...message.params, ...this.groupParamsFor(clientState) };
      this.sendNewTab(clientState, params, message.id, clientSend);
      return;
    }

    if (message.command === 'close_tab') {
      const params = { ...message.params };
      if (params.tabId === undefined && clientState.activeTabId != null) {
        params.tabId = clientState.activeTabId;
      }
      const closedTabId = params.tabId;
      const internalId = crypto.randomUUID();
      this.pending.set(internalId, {
        clientState,
        command: 'close_tab',
        originalId: message.id,
        clientSend: (msg) => {
          if (!msg.error) {
            clientState.tabs.delete(closedTabId);
            if (clientState.activeTabId === closedTabId) {
              const remaining = [...clientState.tabs];
              clientState.activeTabId = remaining.length ? remaining[0] : null;
            }
            if (clientState.tabs.size === 0) {
              // Chrome auto-deletes a tab group once its last tab closes --
              // don't keep referencing a group that no longer exists.
              clientState.groupId = null;
            }
          }
          clientSend(msg);
        },
      });
      this.sendToExtension({ id: internalId, command: 'close_tab', params });
      return;
    }

    // First browser command of a session that owns no tab yet: create one, then
    // run the original command against it. Provisioning is invisible to the
    // caller -- omitting tabId still Just Works, it just no longer costs a tab
    // for sessions that never get here.
    if (requestedTabId === undefined && clientState.activeTabId == null && !TABLESS_COMMANDS.has(message.command)) {
      this.sendNewTab(clientState, this.groupParamsFor(clientState), null, (msg) => {
        if (msg.error) {
          clientSend({ type: 'response', id: message.id, result: undefined, error: msg.error });
          return;
        }
        this.forwardCommand(clientState, message, clientSend);
      });
      return;
    }

    this.forwardCommand(clientState, message, clientSend);
  }

  // Adopt a prior session's tabs when a reconnecting client presents the same
  // sessionId. Clients that send none (older adapters) simply get a fresh
  // session, exactly as before.
  resumeOrRegister(clientState, sessionId) {
    if (sessionId == null) return;
    clientState.sessionId = sessionId;
    const previous = this.sessions.get(sessionId);
    if (previous && previous !== clientState) {
      clientState.id = previous.id;
      clientState.tabs = previous.tabs;
      clientState.activeTabId = previous.activeTabId;
      clientState.groupId = previous.groupId;
    }
    this.sessions.set(sessionId, clientState);
  }

  groupParamsFor(clientState) {
    if (clientState.groupId != null) return { groupId: clientState.groupId };
    return { createGroup: true, groupTitle: `Agent session ${clientState.id.slice(0, 8)}` };
  }

  forwardCommand(clientState, message, clientSend) {
    const params = { ...message.params };
    if (params.tabId === undefined && clientState.activeTabId != null) {
      params.tabId = clientState.activeTabId;
    }
    const internalId = crypto.randomUUID();
    this.pending.set(internalId, { clientSend, clientState, command: message.command, originalId: message.id });
    this.sendToExtension({ id: internalId, command: message.command, params });
  }

  // Shared by initial session provisioning (on auth) and any client-issued
  // new_tab command: both need the same tabs/activeTabId/groupId bookkeeping
  // applied to the owning session once the extension responds.
  sendNewTab(clientState, params, originalId, onResult) {
    const internalId = crypto.randomUUID();
    this.pending.set(internalId, {
      clientState,
      command: 'new_tab',
      originalId,
      clientSend: (msg) => {
        if (!msg.error && msg.result) {
          clientState.tabs.add(msg.result.tabId);
          clientState.activeTabId = msg.result.tabId;
          if (msg.result.groupId != null) clientState.groupId = msg.result.groupId;
        }
        onResult(msg);
      },
    });
    this.sendToExtension({ id: internalId, command: 'new_tab', params });
  }

  handleExtensionMessage(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.clientSend({
      type: 'response',
      id: pending.originalId,
      result: message.result,
      error: message.error,
    });
  }

  handleClientDisconnected(clientState) {
    for (const [id, entry] of this.pending) {
      if (entry.clientState === clientState) {
        this.pending.delete(id);
      }
    }
    // Keep the session recorded so a reconnect can reclaim its tabs. A session
    // holding no tabs has nothing to resume, so drop it rather than let the
    // map grow for every session that ever connected.
    if (clientState.sessionId != null
      && clientState.tabs.size === 0
      && this.sessions.get(clientState.sessionId) === clientState) {
      this.sessions.delete(clientState.sessionId);
    }
  }
}

module.exports = { Relay };
