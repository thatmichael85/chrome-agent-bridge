let sitesOnly = true;
let filterDomain = null;

function formatRelativeTime(ts) {
  if (!ts) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return new Date(ts).toLocaleDateString();
}

function renderSummary(summary) {
  if (!summary) return;
  document.getElementById('kpiVisits').textContent = String(summary.totalSiteVisits || 0);
  document.getElementById('kpiDomains').textContent = String(summary.uniqueDomainsCount || 0);
  document.getElementById('kpiCommands').textContent = String(summary.totalCommands || 0);
  const activeCount = Array.isArray(summary.sessions)
    ? summary.sessions.filter((s) => s.active).length
    : 0;
  document.getElementById('kpiSessions').textContent = activeCount > 0
    ? `${activeCount} live`
    : String(summary.totalSessionsCount || 0);

  const domainsBox = document.getElementById('topDomainsBox');
  domainsBox.replaceChildren();
  const topDomains = (summary.topDomains || []).slice(0, 6);
  if (topDomains.length === 0) {
    const empty = document.createElement('span');
    empty.style.color = '#94a3b8';
    empty.style.fontSize = '11px';
    empty.textContent = 'No agent site visits recorded yet.';
    domainsBox.appendChild(empty);
    return;
  }

  for (const d of topDomains) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    if (filterDomain === d.domain) {
      chip.style.borderColor = '#38bdf8';
      chip.style.background = 'rgba(56, 189, 248, 0.16)';
    }
    const nameSpan = document.createElement('span');
    nameSpan.textContent = d.domain;
    const countSpan = document.createElement('span');
    countSpan.className = 'chip-count';
    countSpan.textContent = String(d.visits || d.total || 0);
    chip.append(nameSpan, countSpan);
    chip.addEventListener('click', () => {
      filterDomain = filterDomain === d.domain ? null : d.domain;
      loadActivity();
    });
    domainsBox.appendChild(chip);
  }
}

function renderFeed(entries) {
  const feedBox = document.getElementById('feedBox');
  feedBox.replaceChildren();

  if (!Array.isArray(entries) || entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = filterDomain
      ? `No matching activity for ${filterDomain}.`
      : 'No agent activity recorded yet.';
    feedBox.appendChild(empty);
    return;
  }

  for (const e of entries) {
    const item = document.createElement('div');
    item.className = 'item';

    const top = document.createElement('div');
    top.className = 'item-top';

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.alignItems = 'center';
    left.style.gap = '6px';
    left.style.minWidth = '0';

    const badge = document.createElement('span');
    if (e.status && e.status !== 'ok') {
      badge.className = 'badge badge-err';
      badge.textContent = e.status === 'rejected' ? 'BLOCKED' : 'ERROR';
    } else if (e.type === 'site_visit') {
      badge.className = 'badge badge-visit';
      badge.textContent = 'VISIT';
    } else {
      badge.className = 'badge badge-cmd';
      badge.textContent = e.command || 'CMD';
    }

    const domainEl = document.createElement('span');
    domainEl.className = 'domain-name';
    domainEl.textContent = e.domain || e.title || e.command || 'Browser';

    left.append(badge, domainEl);

    const timeEl = document.createElement('span');
    timeEl.className = 'time';
    timeEl.textContent = formatRelativeTime(e.ts);

    top.append(left, timeEl);
    item.appendChild(top);

    if (e.title) {
      const titleLine = document.createElement('div');
      titleLine.style.fontSize = '11.5px';
      titleLine.style.color = '#e2e8f0';
      titleLine.style.overflow = 'hidden';
      titleLine.style.textOverflow = 'ellipsis';
      titleLine.style.whiteSpace = 'nowrap';
      titleLine.textContent = e.title;
      item.appendChild(titleLine);
    }

    if (e.url) {
      const urlLine = document.createElement('div');
      urlLine.className = 'url-line';
      urlLine.title = e.url;
      urlLine.textContent = e.url;
      item.appendChild(urlLine);
    } else if (e.meta && e.meta.selector) {
      const selLine = document.createElement('div');
      selLine.className = 'url-line';
      selLine.textContent = `selector: ${e.meta.selector}`;
      item.appendChild(selLine);
    }

    const meta = document.createElement('div');
    meta.className = 'meta-line';

    const sessTag = document.createElement('span');
    sessTag.className = 'session-tag';
    sessTag.textContent = e.groupTitle || (e.sessionId ? e.sessionId.slice(0, 8) : 'agent');
    meta.appendChild(sessTag);

    if (e.tabId != null) {
      const focusBtn = document.createElement('button');
      focusBtn.className = 'focus-link';
      focusBtn.textContent = `Tab #${e.tabId} →`;
      focusBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'focus_tab', tabId: e.tabId });
      });
      meta.appendChild(focusBtn);
    }

    item.appendChild(meta);
    feedBox.appendChild(item);
  }
}

function loadActivity() {
  chrome.runtime.sendMessage(
    {
      type: 'get_activity',
      params: {
        limit: 40,
        sitesOnly,
        domain: filterDomain,
      },
    },
    (resp) => {
      const dot = document.getElementById('statusDot');
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        dot.classList.add('offline');
        const feedBox = document.getElementById('feedBox');
        feedBox.replaceChildren();
        const errEl = document.createElement('div');
        errEl.className = 'empty';
        errEl.textContent = (resp && resp.error) || 'Waiting for Native Relay connection...';
        feedBox.appendChild(errEl);
        return;
      }
      dot.classList.remove('offline');
      renderSummary(resp.summary);
      renderFeed(resp.entries);
    }
  );
}

document.getElementById('openDashboardBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

document.getElementById('modeSitesBtn').addEventListener('click', () => {
  sitesOnly = true;
  document.getElementById('modeSitesBtn').classList.add('active');
  document.getElementById('modeAllBtn').classList.remove('active');
  loadActivity();
});

document.getElementById('modeAllBtn').addEventListener('click', () => {
  sitesOnly = false;
  document.getElementById('modeAllBtn').classList.add('active');
  document.getElementById('modeSitesBtn').classList.remove('active');
  loadActivity();
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  loadActivity();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'activity_entry') {
    loadActivity();
  }
});

loadActivity();
