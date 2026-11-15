const fs = require('fs');
const path = require('path');
const { resolveConfigDir } = require('./config');

const SENSITIVE_QUERY_PARAM_RE = /^(token|access_token|id_token|refresh_token|auth|key|api_key|apikey|secret|password|passwd|code|session|session_id|sig|signature|jwt)$/i;
const SENSITIVE_HASH_RE = /(access_token|id_token|refresh_token|token|secret|password|passwd|api_key|apikey|code|jwt)=/i;

function sanitizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { url: null, domain: null };
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { url: null, domain: null };
  }
  if (/^data:/i.test(trimmed)) {
    return { url: 'data:[inline]', domain: 'data:' };
  }
  if (/^about:/i.test(trimmed)) {
    return { url: trimmed, domain: null };
  }
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    let domain = parsed.hostname ? parsed.hostname.toLowerCase() : null;
    if (!domain && (protocol === 'file:' || protocol === 'chrome:' || protocol === 'chrome-extension:')) {
      domain = `${protocol}//${parsed.host || 'local'}`;
    }

    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }

    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAM_RE.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }

    if (parsed.hash && SENSITIVE_HASH_RE.test(parsed.hash)) {
      parsed.hash = '#[REDACTED]';
    }

    return { url: parsed.toString(), domain };
  } catch {
    return { url: trimmed.slice(0, 500), domain: null };
  }
}

function isSinglePrintableChar(key) {
  if (typeof key !== 'string') return false;
  return [...key].length === 1 && key.charCodeAt(0) >= 32;
}

function sanitizeExpression(expression) {
  if (typeof expression !== 'string') return null;
  const collapsed = expression.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 120) return collapsed;
  return `${collapsed.slice(0, 117)}...`;
}

function sanitizeCommandMeta(command, params = {}, result = undefined) {
  switch (command) {
    case 'type':
      return {
        selector: params.selector || null,
        textLength: typeof params.text === 'string' ? params.text.length : 0,
        redacted: true,
      };
    case 'press_key':
      return {
        key: isSinglePrintableChar(params.key) ? '[REDACTED_CHAR]' : (params.key || null),
      };
    case 'evaluate':
      return {
        expressionLength: typeof params.expression === 'string' ? params.expression.length : 0,
        expressionPreview: sanitizeExpression(params.expression),
      };
    case 'click':
      return {
        selector: params.selector || null,
      };
    case 'wait_for':
      return {
        selector: params.selector || null,
        timeoutMs: params.timeoutMs || 10000,
      };
    case 'get_text':
      return {
        selector: params.selector || 'body',
        returnedChars: result && typeof result.text === 'string' ? result.text.length : undefined,
      };
    case 'get_html':
      return {
        selector: params.selector || 'documentElement',
        returnedBytes: result && typeof result.html === 'string' ? result.html.length : undefined,
      };
    case 'screenshot':
      return {
        captured: Boolean(result && result.dataUrl),
      };
    case 'list_tabs':
      return {
        returnedTabCount: Array.isArray(result) ? result.length : undefined,
      };
    case 'list_my_tabs':
      return {
        tabCount: result && Array.isArray(result.tabIds) ? result.tabIds.length : undefined,
        activeTabId: result ? result.activeTabId : undefined,
      };
    case 'new_tab':
      return {
        groupId: (result && result.groupId != null) ? result.groupId : (params.groupId ?? null),
        groupTitle: params.groupTitle || null,
        autoProvisioned: Boolean(params.autoProvisioned),
      };
    case 'navigate':
      return {
        targetUrl: sanitizeUrl(params.url).url,
      };
    case 'use_tab':
    case 'switch_tab':
    case 'close_tab':
      return {
        tabId: params.tabId ?? null,
      };
    default:
      return {};
  }
}

class ActivityLog {
  constructor(options = {}) {
    const configDir = resolveConfigDir(options.configDir);
    this.logPath = options.logPath || path.join(configDir, 'activity.jsonl');
    this.maxBytes = options.maxBytes || 5 * 1024 * 1024; // 5 MB default rotation
    this.maxMemoryEntries = options.maxMemoryEntries || 5000;
    this.entries = [];
    this._nextSeq = 1;
    this._ensureLoaded();
  }

  _ensureLoaded() {
    try {
      const dir = path.dirname(this.logPath);
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(this.logPath)) {
        fs.writeFileSync(this.logPath, '', { mode: 0o600 });
        try { fs.chmodSync(this.logPath, 0o600); } catch {}
        return;
      }
      this.reloadFromDisk();
    } catch {
      // Telemetry must never crash the host
    }
  }

  reloadFromDisk() {
    try {
      if (!fs.existsSync(this.logPath)) {
        this.entries = [];
        return;
      }
      const raw = fs.readFileSync(this.logPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (item && typeof item === 'object') {
            parsed.push(item);
            if (typeof item.seq === 'number' && item.seq >= this._nextSeq) {
              this._nextSeq = item.seq + 1;
            }
          }
        } catch {}
      }
      this.entries = parsed.slice(-this.maxMemoryEntries);
    } catch {}
  }

  _rotateIfNeeded() {
    try {
      if (!fs.existsSync(this.logPath)) return;
      const stat = fs.statSync(this.logPath);
      if (stat.size >= this.maxBytes) {
        const rotatedPath = `${this.logPath}.1`;
        fs.renameSync(this.logPath, rotatedPath);
        fs.writeFileSync(this.logPath, '', { mode: 0o600 });
        try { fs.chmodSync(this.logPath, 0o600); } catch {}
      }
    } catch {}
  }

  record(rawEntry = {}) {
    const ts = typeof rawEntry.ts === 'number' ? rawEntry.ts : Date.now();
    const { url, domain } = sanitizeUrl(rawEntry.url);
    const entry = {
      seq: this._nextSeq++,
      ts,
      iso: new Date(ts).toISOString(),
      type: rawEntry.type || 'command', // 'site_visit' | 'command' | 'lifecycle'
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
      status: rawEntry.status || 'ok', // 'ok' | 'error' | 'rejected'
      error: rawEntry.error || null,
      durationMs: typeof rawEntry.durationMs === 'number' ? rawEntry.durationMs : null,
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxMemoryEntries) {
      this.entries.splice(0, this.entries.length - this.maxMemoryEntries);
    }

    try {
      this._rotateIfNeeded();
      fs.appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {}

    return entry;
  }

  query(filters = {}) {
    const {
      limit = 200,
      sessionId = null,
      domain = null,
      type = null,
      command = null,
      status = null,
      search = null,
      sinceTs = null,
      sitesOnly = false,
    } = filters;

    const searchLower = search ? String(search).toLowerCase() : null;
    const domainLower = domain ? String(domain).toLowerCase() : null;
    const sessionLower = sessionId ? String(sessionId).toLowerCase() : null;

    const results = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (sinceTs != null && e.ts < sinceTs) continue;
      if (sitesOnly) {
        const isSiteEntry = e.type === 'site_visit'
          || (e.type === 'command' && (e.command === 'navigate' || e.command === 'new_tab') && e.url && e.url !== 'about:blank');
        if (!isSiteEntry) continue;
      }
      if (type && e.type !== type) continue;
      if (command && e.command !== command) continue;
      if (status && e.status !== status) continue;
      if (domainLower && (!e.domain || !e.domain.toLowerCase().includes(domainLower))) continue;
      if (sessionLower) {
        const sidMatch = (e.sessionId && e.sessionId.toLowerCase().includes(sessionLower))
          || (e.groupTitle && e.groupTitle.toLowerCase().includes(sessionLower));
        if (!sidMatch) continue;
      }
      if (searchLower) {
        const hay = [
          e.url || '',
          e.domain || '',
          e.title || '',
          e.command || '',
          e.groupTitle || '',
          e.sessionId || '',
          e.meta && e.meta.selector ? e.meta.selector : '',
          e.error || '',
        ].join(' ').toLowerCase();
        if (!hay.includes(searchLower)) continue;
      }
      results.push(e);
      if (limit > 0 && results.length >= limit) break;
    }
    return results;
  }

  getSummary({ activeSessions = [] } = {}) {
    let totalSiteVisits = 0;
    let totalCommands = 0;
    const domainMap = new Map();
    const sessionMap = new Map();

    // Seed with currently active sessions from the live Relay
    for (const active of activeSessions) {
      const key = active.sessionId || active.id;
      if (!key) continue;
      sessionMap.set(key, {
        sessionId: key,
        model: active.model || 'agent',
        groupTitle: active.groupTitle || `${active.model || 'agent'}-${String(key).slice(0, 8)}`,
        active: true,
        tabIds: active.tabIds || [],
        activeTabId: active.activeTabId ?? null,
        groupId: active.groupId ?? null,
        tabUrls: active.tabUrls || {},
        visitCount: 0,
        commandCount: 0,
        domains: new Set(),
        firstSeenAt: null,
        lastSeenAt: null,
      });
    }

    for (const e of this.entries) {
      if (e.type === 'site_visit') {
        totalSiteVisits++;
      } else if (e.type === 'command') {
        totalCommands++;
      }

      if (e.domain && e.domain !== 'data:') {
        let d = domainMap.get(e.domain);
        if (!d) {
          d = {
            domain: e.domain,
            visits: 0,
            commands: 0,
            total: 0,
            lastVisitedAt: e.ts,
            lastUrl: e.url,
            lastTitle: e.title || null,
            sessions: new Set(),
          };
          domainMap.set(e.domain, d);
        }
        if (e.type === 'site_visit') {
          d.visits++;
        } else if (e.type === 'command') {
          d.commands++;
        }
        d.total++;
        if (e.ts >= d.lastVisitedAt) {
          d.lastVisitedAt = e.ts;
          if (e.url) d.lastUrl = e.url;
          if (e.title) d.lastTitle = e.title;
        }
        if (e.groupTitle || e.sessionId) {
          d.sessions.add(e.groupTitle || e.sessionId);
        }
      }

      const sKey = e.sessionId || e.groupTitle;
      if (sKey) {
        let s = sessionMap.get(sKey);
        if (!s) {
          s = {
            sessionId: sKey,
            model: e.model || 'agent',
            groupTitle: e.groupTitle || `${e.model || 'agent'}-${String(sKey).slice(0, 8)}`,
            active: false,
            tabIds: [],
            activeTabId: null,
            groupId: e.groupId ?? null,
            tabUrls: {},
            visitCount: 0,
            commandCount: 0,
            domains: new Set(),
            firstSeenAt: e.ts,
            lastSeenAt: e.ts,
          };
          sessionMap.set(sKey, s);
        }
        if (e.model && (!s.model || s.model === 'agent')) s.model = e.model;
        if (e.groupTitle) s.groupTitle = e.groupTitle;
        if (e.type === 'site_visit') s.visitCount++;
        if (e.type === 'command') s.commandCount++;
        if (e.domain && e.domain !== 'data:') s.domains.add(e.domain);
        if (s.firstSeenAt == null || e.ts < s.firstSeenAt) s.firstSeenAt = e.ts;
        if (s.lastSeenAt == null || e.ts > s.lastSeenAt) s.lastSeenAt = e.ts;
      }
    }

    const topDomains = [...domainMap.values()]
      .map((d) => ({
        domain: d.domain,
        visits: d.visits,
        commands: d.commands,
        total: d.total,
        lastVisitedAt: d.lastVisitedAt,
        lastUrl: d.lastUrl,
        lastTitle: d.lastTitle,
        sessions: [...d.sessions],
      }))
      .sort((a, b) => (b.visits - a.visits) || (b.total - a.total) || (b.lastVisitedAt - a.lastVisitedAt));

    const sessions = [...sessionMap.values()]
      .map((s) => ({
        ...s,
        domains: [...s.domains],
      }))
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
      });

    return {
      totalEntries: this.entries.length,
      totalSiteVisits,
      totalCommands,
      uniqueDomainsCount: topDomains.length,
      totalSessionsCount: sessions.length,
      topDomains,
      sessions,
    };
  }

  clear() {
    this.entries = [];
    try {
      fs.writeFileSync(this.logPath, '', { mode: 0o600 });
      const rotatedPath = `${this.logPath}.1`;
      if (fs.existsSync(rotatedPath)) {
        fs.unlinkSync(rotatedPath);
      }
    } catch {}
  }
}

module.exports = {
  ActivityLog,
  sanitizeUrl,
  sanitizeCommandMeta,
  sanitizeExpression,
  isSinglePrintableChar,
};
