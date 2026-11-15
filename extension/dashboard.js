let currentFilterMode = 'sites'; // 'all' | 'sites' | 'commands' | 'errors'
let selectedDomain = null;
let selectedSession = null;
let searchQuery = '';
let latestData = { entries: [], summary: null };

function formatTimestamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${time} · ${date}`;
}

function formatRelative(ts) {
  if (!ts) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function updateActiveFiltersBar() {
  const bar = document.getElementById('activeFiltersBar');
  bar.replaceChildren();
  if (!selectedDomain && !selectedSession && !searchQuery) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  const label = document.createElement('span');
  label.style.color = '#94a3b8';
  label.textContent = 'Filtered by:';
  bar.appendChild(label);

  if (selectedDomain) {
    const tag = document.createElement('span');
    tag.className = 'filter-tag';
    tag.textContent = `Domain: ${selectedDomain} ×`;
    tag.style.cursor = 'pointer';
    tag.addEventListener('click', () => {
      selectedDomain = null;
      fetchActivity();
    });
    bar.appendChild(tag);
  }

  if (selectedSession) {
    const tag = document.createElement('span');
    tag.className = 'filter-tag';
    tag.textContent = `Session: ${selectedSession} ×`;
    tag.style.cursor = 'pointer';
    tag.addEventListener('click', () => {
      selectedSession = null;
      fetchActivity();
    });
    bar.appendChild(tag);
  }

  if (searchQuery) {
    const tag = document.createElement('span');
    tag.className = 'filter-tag';
    tag.textContent = `Search: "${searchQuery}" ×`;
    tag.style.cursor = 'pointer';
    tag.addEventListener('click', () => {
      searchQuery = '';
      document.getElementById('searchInput').value = '';
      fetchActivity();
    });
    bar.appendChild(tag);
  }

  const clearAll = document.createElement('button');
  clearAll.className = 'focus-btn';
  clearAll.textContent = 'Reset all filters';
  clearAll.addEventListener('click', () => {
    selectedDomain = null;
    selectedSession = null;
    searchQuery = '';
    document.getElementById('searchInput').value = '';
    fetchActivity();
  });
  bar.appendChild(clearAll);
}

function renderKpisAndSidebars(summary) {
  if (!summary) return;
  document.getElementById('kpiVisits').textContent = String(summary.totalSiteVisits || 0);
  document.getElementById('kpiDomains').textContent = String(summary.uniqueDomainsCount || 0);
  document.getElementById('kpiCommands').textContent = String(summary.totalCommands || 0);

  const sessions = summary.sessions || [];
  const activeCount = sessions.filter((s) => s.active).length;
  document.getElementById('kpiSessions').textContent = String(summary.totalSessionsCount || 0);
  document.getElementById('kpiSessionsSub').textContent = `${activeCount} currently active in Chrome · ${sessions.length} total`;

  // Render Top Domains
  const topDomains = summary.topDomains || [];
  document.getElementById('domainCountBadge').textContent = `${topDomains.length} domain${topDomains.length === 1 ? '' : 's'}`;
  const domainsList = document.getElementById('domainsList');
  domainsList.replaceChildren();

  if (topDomains.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.padding = '20px 10px';
    empty.textContent = 'No domains visited yet.';
    domainsList.appendChild(empty);
  } else {
    for (const d of topDomains) {
      const row = document.createElement('div');
      row.className = `domain-row${selectedDomain === d.domain ? ' selected' : ''}`;

      const top = document.createElement('div');
      top.className = 'row-top';
      const hostEl = document.createElement('span');
      hostEl.textContent = d.domain;
      const countEl = document.createElement('span');
      countEl.className = 'pill-count';
      countEl.textContent = `${d.visits} visit${d.visits === 1 ? '' : 's'} · ${d.commands} cmd${d.commands === 1 ? '' : 's'}`;
      top.append(hostEl, countEl);

      const sub = document.createElement('div');
      sub.className = 'row-sub';
      const titleEl = document.createElement('span');
      titleEl.style.overflow = 'hidden';
      titleEl.style.textOverflow = 'ellipsis';
      titleEl.style.whiteSpace = 'nowrap';
      titleEl.textContent = d.lastTitle || d.lastUrl || '';
      const timeEl = document.createElement('span');
      timeEl.style.whiteSpace = 'nowrap';
      timeEl.textContent = formatRelative(d.lastVisitedAt);
      sub.append(titleEl, timeEl);

      row.append(top, sub);
      row.addEventListener('click', () => {
        selectedDomain = selectedDomain === d.domain ? null : d.domain;
        fetchActivity();
      });
      domainsList.appendChild(row);
    }
  }

  // Render Sessions
  document.getElementById('sessionCountBadge').textContent = `${sessions.length} session${sessions.length === 1 ? '' : 's'}`;
  const sessionsList = document.getElementById('sessionsList');
  sessionsList.replaceChildren();

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.padding = '20px 10px';
    empty.textContent = 'No agent sessions recorded yet.';
    sessionsList.appendChild(empty);
  } else {
    for (const s of sessions) {
      const isSelected = selectedSession && (selectedSession === s.sessionId || selectedSession === s.groupTitle);
      const row = document.createElement('div');
      row.className = `session-row${isSelected ? ' selected' : ''}`;

      const top = document.createElement('div');
      top.className = 'row-top';

      const titleWrap = document.createElement('div');
      titleWrap.style.display = 'flex';
      titleWrap.style.alignItems = 'center';
      titleWrap.style.gap = '6px';

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = s.active ? '#22c55e' : '#64748b';

      const nameEl = document.createElement('span');
      nameEl.className = 'mono';
      nameEl.textContent = s.groupTitle || s.sessionId;
      titleWrap.append(dot, nameEl);

      const badge = document.createElement('span');
      badge.className = 'pill-count';
      badge.textContent = `${s.visitCount || 0} visits · ${s.commandCount || 0} cmds`;
      top.append(titleWrap, badge);

      const sub = document.createElement('div');
      sub.className = 'row-sub';
      const domsText = document.createElement('span');
      domsText.textContent = s.domains && s.domains.length
        ? `Sites: ${s.domains.slice(0, 3).join(', ')}${s.domains.length > 3 ? ` +${s.domains.length - 3}` : ''}`
        : 'No sites visited';
      const timeEl = document.createElement('span');
      timeEl.textContent = s.active ? 'Active' : formatRelative(s.lastSeenAt);
      sub.append(domsText, timeEl);

      row.append(top, sub);

      if (s.active && Array.isArray(s.tabIds) && s.tabIds.length > 0) {
        const tabsBar = document.createElement('div');
        tabsBar.style.marginTop = '6px';
        tabsBar.style.display = 'flex';
        tabsBar.style.flexWrap = 'wrap';
        tabsBar.style.gap = '5px';
        for (const tId of s.tabIds) {
          const btn = document.createElement('button');
          btn.className = 'focus-btn';
          btn.textContent = `Focus Tab #${tId} ↗`;
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            chrome.runtime.sendMessage({ type: 'focus_tab', tabId: tId });
          });
          tabsBar.appendChild(btn);
        }
        row.appendChild(tabsBar);
      }

      row.addEventListener('click', () => {
        const key = s.groupTitle || s.sessionId;
        selectedSession = selectedSession === key ? null : key;
        fetchActivity();
      });
      sessionsList.appendChild(row);
    }
  }
}

function formatMetaSummary(e) {
  const parts = [];
  if (e.meta && typeof e.meta === 'object') {
    if (e.meta.selector) parts.push(`selector: ${e.meta.selector}`);
    if (e.meta.redacted) parts.push(`input: [REDACTED ${e.meta.textLength || 0} chars]`);
    if (e.meta.key) parts.push(`key: ${e.meta.key}`);
    if (e.meta.expressionPreview) parts.push(`eval: ${e.meta.expressionPreview}`);
    if (typeof e.meta.returnedChars === 'number') parts.push(`${e.meta.returnedChars} chars read`);
    if (typeof e.meta.returnedBytes === 'number') parts.push(`${e.meta.returnedBytes} bytes HTML`);
    if (typeof e.meta.returnedTabCount === 'number') parts.push(`${e.meta.returnedTabCount} browser tabs listed`);
    if (typeof e.meta.tabCount === 'number') parts.push(`${e.meta.tabCount} session tabs`);
  }
  if (typeof e.durationMs === 'number' && e.type === 'command') {
    parts.push(`${e.durationMs}ms`);
  }
  if (e.error) {
    parts.push(`error: ${e.error}`);
  }
  return parts.join('  ·  ');
}

function renderActivityTable(entries) {
  const tbody = document.getElementById('activityTableBody');
  tbody.replaceChildren();

  if (!Array.isArray(entries) || entries.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'empty-state';
    td.textContent = 'No matching agent activity found for the current filters.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const e of entries) {
    const tr = document.createElement('tr');

    // 1. Time
    const tdTime = document.createElement('td');
    tdTime.className = 'mono';
    tdTime.style.color = '#94a3b8';
    tdTime.textContent = formatTimestamp(e.ts);
    tr.appendChild(tdTime);

    // 2. Session
    const tdSession = document.createElement('td');
    const sessChip = document.createElement('span');
    sessChip.className = 'session-chip';
    const sessLabel = e.groupTitle || (e.sessionId ? e.sessionId.slice(0, 8) : 'agent');
    sessChip.textContent = sessLabel;
    sessChip.addEventListener('click', () => {
      selectedSession = selectedSession === sessLabel ? null : sessLabel;
      fetchActivity();
    });
    tdSession.appendChild(sessChip);
    tr.appendChild(tdSession);

    // 3. Event Badge
    const tdEvent = document.createElement('td');
    const badge = document.createElement('span');
    if (e.status && e.status !== 'ok') {
      badge.className = 'badge badge-err';
      badge.textContent = e.status === 'rejected' ? `BLOCKED: ${e.command || ''}` : `ERR: ${e.command || ''}`;
    } else if (e.type === 'site_visit') {
      badge.className = 'badge badge-visit';
      badge.textContent = 'SITE VISIT';
    } else {
      badge.className = 'badge badge-cmd';
      badge.textContent = e.command || 'COMMAND';
    }
    tdEvent.appendChild(badge);
    tr.appendChild(tdEvent);

    // 4. Site / URL / Details
    const tdDetails = document.createElement('td');
    if (e.domain || e.title) {
      const topRow = document.createElement('div');
      topRow.style.display = 'flex';
      topRow.style.alignItems = 'center';
      topRow.style.gap = '8px';
      topRow.style.marginBottom = '2px';

      if (e.domain) {
        const domBadge = document.createElement('span');
        domBadge.style.fontWeight = '700';
        domBadge.style.color = '#f8fafc';
        domBadge.style.cursor = 'pointer';
        domBadge.textContent = e.domain;
        domBadge.addEventListener('click', () => {
          selectedDomain = selectedDomain === e.domain ? null : e.domain;
          fetchActivity();
        });
        topRow.appendChild(domBadge);
      }

      if (e.title) {
        const titleSpan = document.createElement('span');
        titleSpan.style.color = '#cbd5e1';
        titleSpan.textContent = e.domain ? `— ${e.title}` : e.title;
        topRow.appendChild(titleSpan);
      }
      tdDetails.appendChild(topRow);
    }

    if (e.url) {
      const urlWrap = document.createElement('div');
      urlWrap.className = 'mono';
      if (/^https?:/i.test(e.url)) {
        const a = document.createElement('a');
        a.className = 'url-link';
        a.href = e.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = e.url;
        urlWrap.appendChild(a);
      } else {
        urlWrap.style.color = '#94a3b8';
        urlWrap.textContent = e.url;
      }
      tdDetails.appendChild(urlWrap);
    }

    const metaSummary = formatMetaSummary(e);
    if (metaSummary) {
      const metaDiv = document.createElement('div');
      metaDiv.className = 'mono';
      metaDiv.style.color = e.error ? '#f87171' : '#94a3b8';
      metaDiv.style.marginTop = '3px';
      metaDiv.textContent = metaSummary;
      tdDetails.appendChild(metaDiv);
    }
    tr.appendChild(tdDetails);

    // 5. Tab
    const tdTab = document.createElement('td');
    if (e.tabId != null) {
      const btn = document.createElement('button');
      btn.className = 'focus-btn';
      btn.textContent = `#${e.tabId} ↗`;
      btn.title = `Focus Chrome tab #${e.tabId}`;
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'focus_tab', tabId: e.tabId });
      });
      tdTab.appendChild(btn);
    } else {
      tdTab.style.color = '#64748b';
      tdTab.textContent = '—';
    }
    tr.appendChild(tdTab);

    tbody.appendChild(tr);
  }
}

function setFilterMode(mode) {
  currentFilterMode = mode;
  document.getElementById('filterAllBtn').classList.toggle('active', mode === 'all');
  document.getElementById('filterSitesBtn').classList.toggle('active', mode === 'sites');
  document.getElementById('filterCommandsBtn').classList.toggle('active', mode === 'commands');
  document.getElementById('filterErrorsBtn').classList.toggle('active', mode === 'errors');
  fetchActivity();
}

function fetchActivity() {
  updateActiveFiltersBar();

  const params = {
    limit: 300,
    domain: selectedDomain,
    sessionId: selectedSession,
    search: searchQuery || null,
    sitesOnly: currentFilterMode === 'sites',
    type: currentFilterMode === 'commands' ? 'command' : null,
  };

  chrome.runtime.sendMessage({ type: 'get_activity', params }, (resp) => {
    const pill = document.getElementById('liveStatusPill');
    const text = document.getElementById('liveStatusText');
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      pill.classList.add('offline');
      text.textContent = (resp && resp.error) || 'Relay Offline';
      return;
    }
    pill.classList.remove('offline');
    text.textContent = 'Live Connected';

    let entries = resp.entries || [];
    if (currentFilterMode === 'errors') {
      entries = entries.filter((e) => e.status && e.status !== 'ok');
    }

    latestData = { entries, summary: resp.summary };
    renderKpisAndSidebars(resp.summary);
    renderActivityTable(entries);
  });
}

document.getElementById('filterAllBtn').addEventListener('click', () => setFilterMode('all'));
document.getElementById('filterSitesBtn').addEventListener('click', () => setFilterMode('sites'));
document.getElementById('filterCommandsBtn').addEventListener('click', () => setFilterMode('commands'));
document.getElementById('filterErrorsBtn').addEventListener('click', () => setFilterMode('errors'));

let searchDebounce = null;
document.getElementById('searchInput').addEventListener('input', (ev) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchQuery = ev.target.value.trim();
    fetchActivity();
  }, 150);
});

document.getElementById('refreshBtn').addEventListener('click', () => fetchActivity());

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(latestData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chrome-agent-bridge-activity-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.getElementById('clearBtn').addEventListener('click', () => {
  if (!confirm('Clear all recorded agent activity logs?')) return;
  chrome.runtime.sendMessage({ type: 'clear_activity' }, () => {
    selectedDomain = null;
    selectedSession = null;
    fetchActivity();
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'activity_entry') {
    fetchActivity();
  }
});

fetchActivity();
