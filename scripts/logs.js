#!/usr/bin/env node
const fs = require('fs');
const { ActivityLog } = require('../lib/activity-log');
const { resolveConfigDir } = require('../lib/config');

function parseArgs(argv) {
  const opts = {
    sitesOnly: false,
    domainsOnly: false,
    domain: null,
    sessionId: null,
    search: null,
    limit: 25,
    json: false,
    follow: false,
    clear: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sites' || arg === '-s') {
      opts.sitesOnly = true;
    } else if (arg === '--domains' || arg === '-d') {
      opts.domainsOnly = true;
    } else if (arg === '--domain' && argv[i + 1]) {
      opts.domain = argv[++i];
    } else if (arg.startsWith('--domain=')) {
      opts.domain = arg.slice('--domain='.length);
    } else if (arg === '--session' && argv[i + 1]) {
      opts.sessionId = argv[++i];
    } else if (arg.startsWith('--session=')) {
      opts.sessionId = arg.slice('--session='.length);
    } else if (arg === '--search' && argv[i + 1]) {
      opts.search = argv[++i];
    } else if ((arg === '--limit' || arg === '-n') && argv[i + 1]) {
      opts.limit = Math.max(1, parseInt(argv[++i], 10) || 25);
    } else if (arg.startsWith('--limit=')) {
      opts.limit = Math.max(1, parseInt(arg.slice('--limit='.length), 10) || 25);
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--follow' || arg === '-f') {
      opts.follow = true;
    } else if (arg === '--clear') {
      opts.clear = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    }
  }
  return opts;
}

function formatEntryLine(e) {
  const time = e.iso ? e.iso.replace('T', ' ').slice(0, 19) : new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19);
  const sess = (e.groupTitle || e.sessionId || 'agent').padEnd(24).slice(0, 24);
  const kind = e.status && e.status !== 'ok'
    ? `ERR:${e.command || e.type}`
    : (e.type === 'site_visit' ? 'VISIT' : (e.command || 'CMD'));
  const badge = kind.padEnd(11).slice(0, 11);
  const target = e.url || e.domain || (e.meta && e.meta.selector ? `selector=${e.meta.selector}` : '') || '';
  const titleSuffix = e.title ? ` (${e.title})` : '';
  const tabTag = e.tabId != null ? ` [tab #${e.tabId}]` : '';
  return `${time}  ${sess}  ${badge}  ${target}${titleSuffix}${tabTag}`;
}

function runCli(argv = process.argv.slice(2), io = { stdout: process.stdout, configDir: undefined }) {
  const opts = parseArgs(argv);
  const out = (line = '') => io.stdout.write(`${line}\n`);

  if (opts.help) {
    out('Usage: npm run logs -- [options]');
    out('');
    out('Options:');
    out('  --sites, -s          Show only site visits and navigations');
    out('  --domains, -d        Show full breakdown of visited domains');
    out('  --domain <host>      Filter by domain hostname');
    out('  --session <id>       Filter by session ID or <model>-<sessionid>');
    out('  --search <text>      Search URL, title, domain, or CSS selector');
    out('  --limit, -n <count>  Number of recent entries to display (default: 25)');
    out('  --follow, -f         Live tail of new agent site visits & actions');
    out('  --json               Print raw JSON lines');
    out('  --clear              Clear the activity log');
    return { opts };
  }

  const configDir = resolveConfigDir(io.configDir);
  const log = new ActivityLog({ configDir });

  if (opts.clear) {
    log.clear();
    out(`Cleared activity log at ${log.logPath}`);
    return { opts };
  }

  const entries = log.query({
    limit: opts.limit,
    sitesOnly: opts.sitesOnly,
    domain: opts.domain,
    sessionId: opts.sessionId,
    search: opts.search,
  });

  if (opts.json && !opts.follow) {
    // Print chronological order for JSON output
    for (const e of [...entries].reverse()) {
      out(JSON.stringify(e));
    }
    return { opts, entries };
  }

  const summary = log.getSummary();

  if (opts.domainsOnly) {
    out(`=== Visited Domains (${summary.topDomains.length}) ===`);
    if (summary.topDomains.length === 0) {
      out('No domains visited yet.');
    } else {
      out(`${'DOMAIN'.padEnd(32)}  ${'VISITS'.padStart(6)}  ${'CMDS'.padStart(6)}  LAST URL`);
      out('-'.repeat(90));
      for (const d of summary.topDomains) {
        out(`${d.domain.padEnd(32).slice(0, 32)}  ${String(d.visits).padStart(6)}  ${String(d.commands).padStart(6)}  ${d.lastUrl || ''}`);
      }
    }
    return { opts, summary };
  }

  if (!opts.follow) {
    out(`Chrome Agent Bridge — Activity Monitor (${log.logPath})`);
    out(`Total Site Visits: ${summary.totalSiteVisits}  |  Unique Domains: ${summary.uniqueDomainsCount}  |  Commands: ${summary.totalCommands}  |  Sessions: ${summary.totalSessionsCount}`);
    out('');

    if (summary.topDomains.length > 0 && !opts.domain) {
      out('Top Visited Sites:');
      for (const d of summary.topDomains.slice(0, 10)) {
        out(`  • ${d.domain.padEnd(28)} ${String(d.visits).padStart(3)} visit(s), ${String(d.commands).padStart(3)} action(s)  —  last: ${d.lastUrl || ''}`);
      }
      out('');
    }

    out(`Recent ${opts.sitesOnly ? 'Site Visits' : 'Activity'} (${entries.length} shown):`);
    if (entries.length === 0) {
      out('  (no matching entries recorded yet)');
    } else {
      // Display chronological (oldest to newest of the recent window)
      for (const e of [...entries].reverse()) {
        out(`  ${formatEntryLine(e)}`);
      }
    }
    return { opts, entries, summary };
  }

  // Follow mode (-f / --follow)
  for (const e of [...entries].reverse()) {
    out(opts.json ? JSON.stringify(e) : formatEntryLine(e));
  }

  let fileOffset = 0;
  try {
    fileOffset = fs.statSync(log.logPath).size;
  } catch {}

  let remainder = '';
  const poll = () => {
    try {
      if (!fs.existsSync(log.logPath)) return;
      const stat = fs.statSync(log.logPath);
      if (stat.size < fileOffset) {
        fileOffset = 0;
        remainder = '';
      }
      if (stat.size === fileOffset) return;
      const fd = fs.openSync(log.logPath, 'r');
      const len = stat.size - fileOffset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, fileOffset);
      fs.closeSync(fd);
      fileOffset = stat.size;

      const text = remainder + buf.toString('utf8');
      const lines = text.split('\n');
      remainder = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (opts.sitesOnly && e.type !== 'site_visit' && e.command !== 'navigate' && e.command !== 'new_tab') continue;
          if (opts.domain && (!e.domain || !e.domain.toLowerCase().includes(opts.domain.toLowerCase()))) continue;
          if (opts.sessionId) {
            const match = (e.sessionId && e.sessionId.toLowerCase().includes(opts.sessionId.toLowerCase()))
              || (e.groupTitle && e.groupTitle.toLowerCase().includes(opts.sessionId.toLowerCase()));
            if (!match) continue;
          }
          out(opts.json ? JSON.stringify(e) : formatEntryLine(e));
        } catch {}
      }
    } catch {}
  };

  const interval = setInterval(poll, 300);
  return { opts, stop: () => clearInterval(interval) };
}

if (require.main === module) {
  runCli();
}

module.exports = { parseArgs, formatEntryLine, runCli };
