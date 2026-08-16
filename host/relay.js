const crypto = require('crypto');

class Relay {
  constructor({ token, sendToExtension }) {
    this.token = token;
    this.sendToExtension = sendToExtension;
    this.pending = new Map();
  }

  handleClientConnected() {
    return {
      authenticated: false,
      id: crypto.randomUUID(),
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
      this.sendNewTab(
        clientState,
        { createGroup: true, groupTitle: `Agent session ${clientState.id.slice(0, 8)}` },
        null,
        () => clientSend({ type: 'auth_ok' })
      );
      return;
    }

    if (message.type !== 'command') return;

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
      const params = { ...message.params };
      if (clientState.groupId != null) {
        params.groupId = clientState.groupId;
      } else {
        params.createGroup = true;
        params.groupTitle = `Agent session ${clientState.id.slice(0, 8)}`;
      }
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
          }
          clientSend(msg);
        },
      });
      this.sendToExtension({ id: internalId, command: 'close_tab', params });
      return;
    }

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
  }
}

module.exports = { Relay };
