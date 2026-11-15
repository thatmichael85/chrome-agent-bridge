const crypto = require('crypto');
const { sanitizeUrl, sanitizeCommandMeta } = require('../lib/activity-log');

// Commands that act on the browser as a whole rather than on one of the
// session's own tabs. These must never trigger lazy tab provisioning.
const TABLESS_COMMANDS = new Set(['list_tabs', 'reload_extension']);

const GROUP_REMOVED_MESSAGE = 'your tab group was removed by the user — call new_tab or navigate (without tabId) to respawn a fresh tab group and continue your work';

class Relay {
  constructor({ token, sendToExtension, activityLog = null, onActivity = null }) {
    this.token = token;
    this.sendToExtension = sendToExtension;
    this.activityLog = activityLog;
    this.onActivity = onActivity;
    this.extensionSubscribedToActivity = false;
    this.pending = new Map();
    // sessionId -> clientState. A client whose socket drops (relay restart,
    // flaky connection) reconnects with the same sessionId and resumes its
    // existing tabs, instead of registering as a brand new session and
    // stranding them as orphans in the user's window.
    this.sessions = new Map();
    this.clients = new Set();
    // tabId -> last logged canonical URL, to deduplicate repeated onUpdated
    // events for the same navigation on an agent-owned tab.
    this.lastLoggedUrlByTab = new Map();
  }

  handleClientConnected() {
    const state = {
      authenticated: false,
      id: crypto.randomUUID(),
      sessionId: null,
      model: null,
      tabs: new Set(),
      tabUrls: new Map(),
      tabTitles: new Map(),
      activeTabId: null,
      groupId: null,
      groupRemovedNoticePending: false,
    };
    this.clients.add(state);
    return state;
  }

  findOwnerByTabId(tabId) {
    if (tabId == null) return null;
    for (const state of this.clients) {
      if (state.tabs.has(tabId)) return state;
    }
    return null;
  }

  getActiveSessionsSnapshot() {
    const out = [];
    for (const state of this.clients) {
      if (!state.authenticated) continue;
      if (state.tabs.size === 0 && !state.sessionId) continue;
      const tabUrls = {};
      for (const [tId, u] of state.tabUrls.entries()) {
        if (state.tabs.has(tId)) tabUrls[tId] = u;
      }
      out.push({
        sessionId: state.sessionId || state.id,
        model: state.model || 'agent',
        groupTitle: this.groupTitleFor(state),
        tabIds: [...state.tabs],
        activeTabId: state.activeTabId,
        groupId: state.groupId,
        tabUrls,
      });
    }
    return out;
  }

  _emitActivity(rawEntry) {
    if (!this.activityLog && !this.onActivity && !this.extensionSubscribedToActivity) {
      return null;
    }
    let entry;
    if (this.activityLog) {
      entry = this.activityLog.record(rawEntry);
    } else {
      const ts = typeof rawEntry.ts === 'number' ? rawEntry.ts : Date.now();
      const { url, domain } = sanitizeUrl(rawEntry.url);
      entry = {
        ts,
        iso: new Date(ts).toISOString(),
        type: rawEntry.type || 'command',
        command: rawEntry.command || null,
        trigger: rawEntry.trigger || null,
        sessionId: rawEntry.sessionId || null,
        model: rawEntry.model || 'agent',
        groupTitle: rawEntry.groupTitle || null,
        tabId: rawEntry.tabId ?? null,
        groupId: rawEntry.groupId ?? null,
        url,
        domain: rawEntry.domain || domain || null,
        title: rawEntry.title || null,
        meta: rawEntry.meta || {},
        status: rawEntry.status || 'ok',
        error: rawEntry.error || null,
        durationMs: typeof rawEntry.durationMs === 'number' ? rawEntry.durationMs : null,
      };
    }

    if (this.onActivity) {
      try {
        this.onActivity(entry);
      } catch {}
    }

    if (this.extensionSubscribedToActivity) {
      try {
        this.sendToExtension({ event: 'activity_entry', entry });
      } catch {}
    }

    return entry;
  }

  _recordSiteVisitForTab(clientState, tabId, rawUrl, title = null, trigger = 'navigation') {
    if (!clientState || tabId == null || !rawUrl || rawUrl === 'about:blank') return;
    if (!/^https?:|^file:/i.test(rawUrl)) return;
    const { url: cleanUrl, domain } = sanitizeUrl(rawUrl);
    if (!cleanUrl) return;

    clientState.tabUrls.set(tabId, cleanUrl);
    if (title) {
      clientState.tabTitles.set(tabId, title);
    }

    if (this.lastLoggedUrlByTab.get(tabId) === cleanUrl) {
      // If we already logged this exact URL for this tab (e.g. from navigate)
      // and a subsequent tab_visit event now supplies the page title, update
      // the recent entry's title in-place if available.
      if (title && this.activityLog && this.activityLog.entries.length > 0) {
        for (let i = this.activityLog.entries.length - 1; i >= Math.max(0, this.activityLog.entries.length - 10); i--) {
          const prev = this.activityLog.entries[i];
          if (prev.tabId === tabId && prev.url === cleanUrl && !prev.title) {
            prev.title = title;
            break;
          }
        }
      }
      return;
    }

    this.lastLoggedUrlByTab.set(tabId, cleanUrl);
    this._emitActivity({
      type: 'site_visit',
      command: null,
      trigger,
      sessionId: clientState.sessionId || clientState.id,
      model: clientState.model || 'agent',
      groupTitle: this.groupTitleFor(clientState),
      tabId,
      groupId: clientState.groupId,
      url: cleanUrl,
      domain,
      title: title || clientState.tabTitles.get(tabId) || null,
      meta: { trigger },
      status: 'ok',
    });
  }

  handleClientMessage(clientState, message, clientSend) {
    if (!clientState.authenticated) {
      if (message.type !== 'auth') return;
      if (message.token !== this.token) {
        clientSend({ type: 'auth_error' });
        return;
      }
      clientState.authenticated = true;
      if (message.model) clientState.model = message.model;
      this.resumeOrRegister(clientState, message.sessionId);
      // Deliberately no tab here. Most agent sessions never touch the browser,
      // and provisioning on connect meant every one of them dropped a blank tab
      // and a tab group into the user's window regardless. Tabs are created on
      // first actual use instead -- see the lazy branch below.
      clientSend({ type: 'auth_ok' });
      return;
    }

    if (message.type !== 'command') return;

    if (message.params && message.params.model) {
      clientState.model = message.params.model;
    }

    // Ownership applies to EVERY tab-targeting command, not just use_tab.
    // list_tabs hands out every tabId in the browser, so without this guard a
    // session could pass one explicitly and navigate/click/evaluate/close
    // against another session's tabs -- or the user's own.
    const requestedTabId = message.params && message.params.tabId;
    if (requestedTabId !== undefined && !clientState.tabs.has(requestedTabId)) {
      if (clientState.groupRemovedNoticePending) {
        clientState.groupRemovedNoticePending = false;
        clientSend({ type: 'response', id: message.id, result: undefined, error: GROUP_REMOVED_MESSAGE });
        return;
      }
      const errText = `not your tab: ${requestedTabId}`;
      this._emitActivity({
        type: 'command',
        command: message.command,
        sessionId: clientState.sessionId || clientState.id,
        model: clientState.model || 'agent',
        groupTitle: this.groupTitleFor(clientState),
        tabId: requestedTabId,
        groupId: clientState.groupId,
        url: null,
        meta: sanitizeCommandMeta(message.command, message.params),
        status: 'rejected',
        error: errText,
        durationMs: 0,
      });
      clientSend({ type: 'response', id: message.id, result: undefined, error: errText });
      return;
    }

    if (clientState.groupRemovedNoticePending && !TABLESS_COMMANDS.has(message.command) && message.command !== 'list_my_tabs') {
      clientState.groupRemovedNoticePending = false;
      clientSend({ type: 'response', id: message.id, result: undefined, error: GROUP_REMOVED_MESSAGE });
      return;
    }

    if (message.command === 'use_tab') {
      const tabId = message.params && message.params.tabId;
      if (!clientState.tabs.has(tabId)) {
        const errText = `not your tab: ${tabId}`;
        this._emitActivity({
          type: 'command',
          command: 'use_tab',
          sessionId: clientState.sessionId || clientState.id,
          model: clientState.model || 'agent',
          groupTitle: this.groupTitleFor(clientState),
          tabId,
          groupId: clientState.groupId,
          url: null,
          meta: { tabId },
          status: 'rejected',
          error: errText,
          durationMs: 0,
        });
        clientSend({ type: 'response', id: message.id, result: undefined, error: errText });
        return;
      }
      clientState.activeTabId = tabId;
      this._emitActivity({
        type: 'command',
        command: 'use_tab',
        sessionId: clientState.sessionId || clientState.id,
        model: clientState.model || 'agent',
        groupTitle: this.groupTitleFor(clientState),
        tabId,
        groupId: clientState.groupId,
        url: clientState.tabUrls.get(tabId) || null,
        title: clientState.tabTitles.get(tabId) || null,
        meta: { tabId },
        status: 'ok',
        durationMs: 0,
      });
      clientSend({ type: 'response', id: message.id, result: { ok: true }, error: undefined });
      return;
    }

    if (message.command === 'list_my_tabs') {
      const result = { tabIds: [...clientState.tabs], activeTabId: clientState.activeTabId };
      this._emitActivity({
        type: 'command',
        command: 'list_my_tabs',
        sessionId: clientState.sessionId || clientState.id,
        model: clientState.model || 'agent',
        groupTitle: this.groupTitleFor(clientState),
        tabId: clientState.activeTabId,
        groupId: clientState.groupId,
        url: clientState.activeTabId != null ? (clientState.tabUrls.get(clientState.activeTabId) || null) : null,
        meta: sanitizeCommandMeta('list_my_tabs', message.params, result),
        status: 'ok',
        durationMs: 0,
      });
      clientSend({
        type: 'response',
        id: message.id,
        result,
        error: undefined,
      });
      return;
    }

    if (message.command === 'new_tab') {
      const { model, ...restParams } = message.params || {};
      const params = { ...restParams, ...this.groupParamsFor(clientState) };
      this.sendNewTab(clientState, params, message.id, clientSend);
      return;
    }

    if (message.command === 'close_tab') {
      const { model, ...params } = message.params || {};
      if (params.tabId === undefined && clientState.activeTabId != null) {
        params.tabId = clientState.activeTabId;
      }
      const closedTabId = params.tabId;
      const tabUrlAtStart = closedTabId != null ? (clientState.tabUrls.get(closedTabId) || null) : null;
      const tabTitleAtStart = closedTabId != null ? (clientState.tabTitles.get(closedTabId) || null) : null;
      // Remove from clientState.tabs before sending close_tab so the
      // extension's chrome.tabs.onRemoved ("tab_removed") event knows this was
      // an intentional agent-initiated close rather than the user deleting the
      // tab/group.
      clientState.tabs.delete(closedTabId);
      clientState.tabUrls.delete(closedTabId);
      clientState.tabTitles.delete(closedTabId);
      this.lastLoggedUrlByTab.delete(closedTabId);
      if (clientState.activeTabId === closedTabId) {
        const remaining = [...clientState.tabs];
        clientState.activeTabId = remaining.length ? remaining[0] : null;
      }
      if (clientState.tabs.size === 0) {
        // Chrome auto-deletes a tab group once its last tab closes --
        // don't keep referencing a group that no longer exists.
        clientState.groupId = null;
      }
      const internalId = crypto.randomUUID();
      this.pending.set(internalId, {
        clientState,
        command: 'close_tab',
        originalId: message.id,
        clientSend,
        startedAt: Date.now(),
        rawParams: params,
        tabId: closedTabId,
        tabUrlAtStart,
        tabTitleAtStart,
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
      clientState.tabUrls = previous.tabUrls || new Map();
      clientState.tabTitles = previous.tabTitles || new Map();
      clientState.activeTabId = previous.activeTabId;
      clientState.groupId = previous.groupId;
      clientState.groupRemovedNoticePending = previous.groupRemovedNoticePending;
      if (!clientState.model && previous.model) {
        clientState.model = previous.model;
      }
      this.clients.delete(previous);
    }
    this.sessions.set(sessionId, clientState);
  }

  groupTitleFor(clientState) {
    const model = (clientState.model || 'agent').trim() || 'agent';
    const shortSessionId = (clientState.sessionId || clientState.id).slice(0, 8);
    return `${model}-${shortSessionId}`;
  }

  groupParamsFor(clientState) {
    const groupTitle = this.groupTitleFor(clientState);
    if (clientState.groupId != null) return { groupId: clientState.groupId, groupTitle };
    return { createGroup: true, groupTitle };
  }

  forwardCommand(clientState, message, clientSend) {
    const { model, ...params } = message.params || {};
    if (params.tabId === undefined && clientState.activeTabId != null) {
      params.tabId = clientState.activeTabId;
    }
    if (message.command === 'navigate' && params.tabId != null) {
      // Allow re-logging if the agent explicitly navigates to the same URL again.
      this.lastLoggedUrlByTab.delete(params.tabId);
    }
    const internalId = crypto.randomUUID();
    this.pending.set(internalId, {
      clientSend,
      clientState,
      command: message.command,
      originalId: message.id,
      startedAt: Date.now(),
      rawParams: params,
      tabId: params.tabId ?? null,
      tabUrlAtStart: params.tabId != null ? (clientState.tabUrls.get(params.tabId) || null) : null,
      tabTitleAtStart: params.tabId != null ? (clientState.tabTitles.get(params.tabId) || null) : null,
    });
    this.sendToExtension({ id: internalId, command: message.command, params });
  }

  // Shared by initial session provisioning (on first command) and any client-issued
  // new_tab command: both need the same tabs/activeTabId/groupId bookkeeping
  // applied to the owning session once the extension responds.
  sendNewTab(clientState, params, originalId, onResult) {
    const internalId = crypto.randomUUID();
    this.pending.set(internalId, {
      clientState,
      command: 'new_tab',
      originalId,
      startedAt: Date.now(),
      rawParams: params,
      tabId: null,
      clientSend: (msg) => {
        if (!msg.error && msg.result) {
          const newTabId = msg.result.tabId;
          clientState.tabs.add(newTabId);
          clientState.activeTabId = newTabId;
          if (msg.result.groupId != null) clientState.groupId = msg.result.groupId;
          if (params && params.url && params.url !== 'about:blank') {
            this._recordSiteVisitForTab(clientState, newTabId, params.url, null, 'new_tab');
          }
        }
        onResult(msg);
      },
    });
    this.sendToExtension({ id: internalId, command: 'new_tab', params });
  }

  handleTabVisit(message) {
    const { tabId, url, title, trigger } = message;
    if (tabId == null || !url || url === 'about:blank') return;
    const owner = this.findOwnerByTabId(tabId);
    // Strict privacy boundary: never record browsing events for tabs not owned
    // by an agent session (i.e. the human user's personal tabs).
    if (!owner) return;
    this._recordSiteVisitForTab(owner, tabId, url, title || null, trigger || 'navigation');
  }

  handleExtensionMessage(message) {
    if (message.event === 'group_removed' && message.groupId != null) {
      this.handleGroupRemoved(message.groupId);
      return;
    }
    if (message.event === 'tab_removed' && message.tabId != null) {
      this.handleTabRemoved(message.tabId);
      return;
    }
    if (message.event === 'tab_visit' || message.event === 'tab_navigated') {
      this.handleTabVisit(message);
      return;
    }
    if (message.event === 'subscribe_activity') {
      this.extensionSubscribedToActivity = Boolean(message.enabled !== false);
      return;
    }
    if (message.event === 'get_activity') {
      const entries = this.activityLog ? this.activityLog.query(message.params || {}) : [];
      const summary = this.activityLog
        ? this.activityLog.getSummary({ activeSessions: this.getActiveSessionsSnapshot() })
        : {
          totalEntries: 0,
          totalSiteVisits: 0,
          totalCommands: 0,
          uniqueDomainsCount: 0,
          totalSessionsCount: 0,
          topDomains: [],
          sessions: this.getActiveSessionsSnapshot(),
        };
      this.sendToExtension({
        event: 'activity_response',
        id: message.id,
        result: { entries, summary },
      });
      return;
    }
    if (message.event === 'clear_activity') {
      if (this.activityLog) {
        this.activityLog.clear();
      }
      this.lastLoggedUrlByTab.clear();
      this.sendToExtension({
        event: 'activity_response',
        id: message.id,
        result: { ok: true },
      });
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);

    const durationMs = typeof pending.startedAt === 'number' ? Math.max(0, Date.now() - pending.startedAt) : null;
    const state = pending.clientState;

    if (message.error && /No tab with id|tab.*not found|No group with id/i.test(message.error)) {
      this.markGroupRemoved(state);
      if (pending.originalId != null) {
        this._emitActivity({
          type: 'command',
          command: pending.command,
          sessionId: state ? (state.sessionId || state.id) : null,
          model: state ? (state.model || 'agent') : 'agent',
          groupTitle: state ? this.groupTitleFor(state) : null,
          tabId: pending.tabId,
          groupId: state ? state.groupId : null,
          url: pending.tabUrlAtStart || null,
          title: pending.tabTitleAtStart || null,
          meta: sanitizeCommandMeta(pending.command, pending.rawParams),
          status: 'error',
          error: GROUP_REMOVED_MESSAGE,
          durationMs,
        });
      }
      pending.clientSend({
        type: 'response',
        id: pending.originalId,
        result: undefined,
        error: GROUP_REMOVED_MESSAGE,
      });
      return;
    }

    // Update known URL & record site_visit on successful explicit navigate
    if (!message.error && pending.command === 'navigate' && state) {
      const targetTabId = (message.result && message.result.tabId) || pending.tabId || state.activeTabId;
      const targetUrl = (message.result && message.result.url) || (pending.rawParams && pending.rawParams.url);
      if (targetTabId != null && targetUrl) {
        this._recordSiteVisitForTab(state, targetTabId, targetUrl, null, 'navigate');
      }
    }

    // Record command activity for client-issued commands (skip internal lazy-provisioning new_tab where originalId === null)
    if (pending.originalId != null && state) {
      const effectiveTabId = (message.result && message.result.tabId)
        || pending.tabId
        || (TABLESS_COMMANDS.has(pending.command) ? null : state.activeTabId);
      let effectiveUrl = null;
      if (pending.command === 'navigate' || pending.command === 'new_tab') {
        effectiveUrl = (message.result && message.result.url)
          || (pending.rawParams && pending.rawParams.url)
          || (effectiveTabId != null ? state.tabUrls.get(effectiveTabId) : null)
          || null;
      } else if (!TABLESS_COMMANDS.has(pending.command)) {
        effectiveUrl = pending.tabUrlAtStart
          || (effectiveTabId != null ? state.tabUrls.get(effectiveTabId) : null)
          || null;
      }
      const effectiveTitle = pending.tabTitleAtStart
        || (effectiveTabId != null ? state.tabTitles.get(effectiveTabId) : null)
        || null;

      this._emitActivity({
        type: 'command',
        command: pending.command,
        sessionId: state.sessionId || state.id,
        model: state.model || 'agent',
        groupTitle: this.groupTitleFor(state),
        tabId: effectiveTabId ?? null,
        groupId: (message.result && message.result.groupId != null) ? message.result.groupId : state.groupId,
        url: effectiveUrl,
        title: effectiveTitle,
        meta: sanitizeCommandMeta(pending.command, pending.rawParams, message.result),
        status: message.error ? 'error' : 'ok',
        error: message.error || null,
        durationMs,
      });
    }

    pending.clientSend({
      type: 'response',
      id: pending.originalId,
      result: message.result,
      error: message.error,
    });
  }

  markGroupRemoved(clientState) {
    if (!clientState) return;
    for (const tabId of clientState.tabs) {
      this.lastLoggedUrlByTab.delete(tabId);
    }
    clientState.tabs.clear();
    clientState.tabUrls.clear();
    clientState.tabTitles.clear();
    clientState.activeTabId = null;
    clientState.groupId = null;
    clientState.groupRemovedNoticePending = true;
  }

  handleGroupRemoved(groupId) {
    for (const state of this.clients) {
      if (state.groupId === groupId) {
        this.markGroupRemoved(state);
      }
    }
  }

  handleTabRemoved(tabId) {
    this.lastLoggedUrlByTab.delete(tabId);
    for (const state of this.clients) {
      if (!state.tabs.has(tabId)) continue;
      state.tabs.delete(tabId);
      state.tabUrls.delete(tabId);
      state.tabTitles.delete(tabId);
      if (state.activeTabId === tabId) {
        const remaining = [...state.tabs];
        state.activeTabId = remaining.length ? remaining[0] : null;
      }
      if (state.tabs.size === 0) {
        state.groupId = null;
        state.groupRemovedNoticePending = true;
      }
    }
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
      && !clientState.groupRemovedNoticePending
      && this.sessions.get(clientState.sessionId) === clientState) {
      this.sessions.delete(clientState.sessionId);
    }
    if (clientState.tabs.size === 0 && !clientState.groupRemovedNoticePending) {
      this.clients.delete(clientState);
    }
  }
}

module.exports = { Relay };
