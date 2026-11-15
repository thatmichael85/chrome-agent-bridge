const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ActivityLog } = require('../lib/activity-log');
const { runCli, parseArgs } = require('./logs');

test('parseArgs parses CLI flags for logs viewer', () => {
  const opts = parseArgs(['--sites', '--domain', 'github.com', '--session=c8a50c80', '-n', '10', '--json']);
  assert.strictEqual(opts.sitesOnly, true);
  assert.strictEqual(opts.domain, 'github.com');
  assert.strictEqual(opts.sessionId, 'c8a50c80');
  assert.strictEqual(opts.limit, 10);
  assert.strictEqual(opts.json, true);
});

test('runCli prints summary, domains breakdown, sites filter, json output, and clear', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-logs-cli-'));
  try {
    const log = new ActivityLog({ configDir: tmpDir });
    log.record({
      ts: 1700000000000,
      type: 'site_visit',
      sessionId: 'c8a50c80',
      model: 'gemini-4-argon',
      groupTitle: 'gemini-4-argon-c8a50c80',
      tabId: 12,
      url: 'https://www.moneysmart.sg/dashboard/claims',
      title: 'MoneySmart Claims',
    });
    log.record({
      ts: 1700000005000,
      type: 'command',
      command: 'click',
      sessionId: 'c8a50c80',
      model: 'gemini-4-argon',
      groupTitle: 'gemini-4-argon-c8a50c80',
      tabId: 12,
      url: 'https://www.moneysmart.sg/dashboard/claims',
      meta: { selector: 'button.submit' },
    });

    const capture = (args) => {
      let buf = '';
      runCli(args, {
        configDir: tmpDir,
        stdout: { write: (s) => { buf += s; } },
      });
      return buf;
    };

    const summaryOut = capture([]);
    assert.match(summaryOut, /Total Site Visits: 1/);
    assert.match(summaryOut, /www\.moneysmart\.sg/);
    assert.match(summaryOut, /gemini-4-argon-c8a50c80/);

    const domainsOut = capture(['--domains']);
    assert.match(domainsOut, /=== Visited Domains \(1\) ===/);
    assert.match(domainsOut, /www\.moneysmart\.sg/);

    const sitesJsonOut = capture(['--sites', '--json']).trim().split('\n');
    assert.strictEqual(sitesJsonOut.length, 1);
    const parsed = JSON.parse(sitesJsonOut[0]);
    assert.strictEqual(parsed.type, 'site_visit');
    assert.strictEqual(parsed.domain, 'www.moneysmart.sg');

    const clearOut = capture(['--clear']);
    assert.match(clearOut, /Cleared activity log/);
    const afterClear = new ActivityLog({ configDir: tmpDir });
    assert.strictEqual(afterClear.entries.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
