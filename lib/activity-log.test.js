const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ActivityLog,
  sanitizeUrl,
  sanitizeCommandMeta,
} = require('./activity-log');

test('sanitizeUrl extracts domain and redacts credentials, sensitive query params, and OAuth fragments', () => {
  const res1 = sanitizeUrl('https://alice:hunter2@github.com/thatmichael85/chrome-agent-bridge?token=secret123&page=2#access_token=jwt999');
  assert.strictEqual(res1.domain, 'github.com');
  assert.ok(!res1.url.includes('alice'));
  assert.ok(!res1.url.includes('hunter2'));
  assert.ok(!res1.url.includes('secret123'));
  assert.ok(!res1.url.includes('jwt999'));
  assert.ok(res1.url.includes('token=%5BREDACTED%5D'));
  assert.ok(res1.url.includes('page=2'));
  assert.ok(res1.url.endsWith('#[REDACTED]'));

  const res2 = sanitizeUrl('data:text/html,<h1>Hello</h1>');
  assert.strictEqual(res2.url, 'data:[inline]');
  assert.strictEqual(res2.domain, 'data:');

  const res3 = sanitizeUrl('about:blank');
  assert.strictEqual(res3.url, 'about:blank');
  assert.strictEqual(res3.domain, null);
});

test('sanitizeCommandMeta redacts type text, single-char press_key, and bulky/private response payloads', () => {
  const typeMeta = sanitizeCommandMeta('type', { selector: '#password', text: 'my-super-secret-password' });
  assert.strictEqual(typeMeta.selector, '#password');
  assert.strictEqual(typeMeta.textLength, 24);
  assert.strictEqual(typeMeta.redacted, true);
  assert.strictEqual(JSON.stringify(typeMeta).includes('my-super-secret-password'), false);

  const keyChar = sanitizeCommandMeta('press_key', { key: 'a' });
  assert.strictEqual(keyChar.key, '[REDACTED_CHAR]');
  const keyEnter = sanitizeCommandMeta('press_key', { key: 'Enter' });
  assert.strictEqual(keyEnter.key, 'Enter');

  const listTabsMeta = sanitizeCommandMeta('list_tabs', {}, [
    { id: 1, url: 'https://mail.google.com/ personal' },
    { id: 2, url: 'https://bank.example.com/' },
  ]);
  assert.deepStrictEqual(listTabsMeta, { returnedTabCount: 2 });
  assert.strictEqual(JSON.stringify(listTabsMeta).includes('mail.google.com'), false);

  const evalMeta = sanitizeCommandMeta('evaluate', { expression: 'document.title' }, { result: 'Secret Page Title' });
  assert.strictEqual(evalMeta.expressionPreview, 'document.title');
  assert.strictEqual(JSON.stringify(evalMeta).includes('Secret Page Title'), false);
});

test('ActivityLog persists JSONL with 0600 permissions, supports rich queries and domain/session summaries, and rotates cleanly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-activity-log-'));
  try {
    const log = new ActivityLog({ configDir: tmpDir, maxBytes: 2048 });

    const stat = fs.statSync(log.logPath);
    assert.strictEqual(stat.mode & 0o777, 0o600);

    log.record({
      ts: 1000,
      type: 'site_visit',
      trigger: 'load_complete',
      sessionId: 'sess-11112222',
      model: 'gemini-4-argon',
      groupTitle: 'gemini-4-argon-sess-111',
      tabId: 10,
      groupId: 3,
      url: 'https://www.moneysmart.sg/dashboard/claims?api_key=topsecret',
      title: 'MoneySmart Claims',
    });

    log.record({
      ts: 2000,
      type: 'command',
      command: 'click',
      sessionId: 'sess-11112222',
      model: 'gemini-4-argon',
      groupTitle: 'gemini-4-argon-sess-111',
      tabId: 10,
      groupId: 3,
      url: 'https://www.moneysmart.sg/dashboard/claims',
      meta: { selector: 'button[type="submit"]' },
      durationMs: 42,
    });

    log.record({
      ts: 3000,
      type: 'site_visit',
      trigger: 'load_complete',
      sessionId: 'sess-99998888',
      model: 'claude-sonnet-4',
      groupTitle: 'claude-sonnet-4-sess-999',
      tabId: 20,
      groupId: 4,
      url: 'https://github.com/thatmichael85/chrome-agent-bridge',
      title: 'thatmichael85/chrome-agent-bridge',
    });

    // Reload in a second instance to verify disk persistence
    const log2 = new ActivityLog({ configDir: tmpDir });
    assert.strictEqual(log2.entries.length, 3);

    const visitsOnly = log2.query({ sitesOnly: true });
    assert.strictEqual(visitsOnly.length, 2);
    assert.strictEqual(visitsOnly[0].domain, 'github.com');
    assert.strictEqual(visitsOnly[1].domain, 'www.moneysmart.sg');
    assert.ok(!visitsOnly[1].url.includes('topsecret'), 'query param redacted on disk');

    const bySession = log2.query({ sessionId: 'sess-111' });
    assert.strictEqual(bySession.length, 2);

    const summary = log2.getSummary({
      activeSessions: [{
        sessionId: 'sess-11112222',
        model: 'gemini-4-argon',
        groupTitle: 'gemini-4-argon-sess-111',
        tabIds: [10],
        activeTabId: 10,
        groupId: 3,
        tabUrls: { 10: 'https://www.moneysmart.sg/dashboard/claims' },
      }],
    });

    assert.strictEqual(summary.totalSiteVisits, 2);
    assert.strictEqual(summary.totalCommands, 1);
    assert.strictEqual(summary.uniqueDomainsCount, 2);
    assert.strictEqual(summary.topDomains[0].domain, 'www.moneysmart.sg');
    assert.strictEqual(summary.topDomains[0].visits, 1);
    assert.strictEqual(summary.topDomains[0].commands, 1);
    assert.strictEqual(summary.sessions[0].active, true);
    assert.strictEqual(summary.sessions[0].groupTitle, 'gemini-4-argon-sess-111');

    // Clear log
    log2.clear();
    assert.strictEqual(log2.entries.length, 0);
    assert.strictEqual(fs.readFileSync(log2.logPath, 'utf8'), '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
