#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildNativeMessagingManifest, ensureManifestKey } = require('./install-helpers');

const REPO_ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'extension', 'manifest.json');
const HOST_SCRIPT_PATH = path.join(REPO_ROOT, 'host', 'native-host.js');
const HOST_WRAPPER_PATH = path.join(REPO_ROOT, 'host', 'run-host.sh');
const ADAPTER_PATH = path.join(REPO_ROOT, 'mcp-adapter', 'index.js');
const NATIVE_HOSTS_DIR = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'
);
const AGY_MCP_CONFIG_PATH = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
const SKILL_SOURCE_PATH = path.join(REPO_ROOT, '.agents', 'skills', 'chrome-agent-bridge', 'SKILL.md');
const SKILL_TARGETS = [
  path.join(os.homedir(), '.claude', 'skills', 'chrome-agent-bridge', 'SKILL.md'),
  path.join(os.homedir(), '.codex', 'skills', 'chrome-agent-bridge', 'SKILL.md'),
  path.join(os.homedir(), '.gemini', 'config', 'skills', 'chrome-agent-bridge', 'SKILL.md'),
];

function step(label, fn) {
  process.stdout.write(`- ${label}... `);
  try {
    fn();
    process.stdout.write('done\n');
  } catch (err) {
    process.stdout.write(`FAILED: ${err.message}\n`);
  }
}

function main() {
  const rawManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const { manifestObj, extensionId, changed } = ensureManifestKey(rawManifest);
  if (changed) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifestObj, null, 2) + '\n');
  }
  console.log(`Extension id: ${extensionId}${changed ? ' (newly generated)' : ' (reused existing key)'}`);

  fs.chmodSync(HOST_SCRIPT_PATH, 0o755);
  fs.chmodSync(ADAPTER_PATH, 0o755);

  step('write host wrapper script', () => {
    // Chrome spawns native-messaging hosts with a minimal PATH that may not
    // include this node's directory, so the wrapper pins the absolute path.
    fs.writeFileSync(
      HOST_WRAPPER_PATH,
      `#!/bin/bash\nexec "${process.execPath}" "${HOST_SCRIPT_PATH}"\n`
    );
    fs.chmodSync(HOST_WRAPPER_PATH, 0o755);
  });

  step('write native messaging host manifest', () => {
    fs.mkdirSync(NATIVE_HOSTS_DIR, { recursive: true });
    const hostManifest = buildNativeMessagingManifest({ extensionId, hostScriptPath: HOST_WRAPPER_PATH });
    fs.writeFileSync(
      path.join(NATIVE_HOSTS_DIR, `${hostManifest.name}.json`),
      JSON.stringify(hostManifest, null, 2) + '\n'
    );
  });

  step('register MCP server with Claude Code (user scope)', () => {
    execFileSync('claude', ['mcp', 'remove', 'chrome-agent-bridge', '-s', 'user'], { stdio: 'ignore' });
  });
  step('add MCP server to Claude Code', () => {
    execFileSync('claude', ['mcp', 'add', 'chrome-agent-bridge', '-s', 'user', '--', 'node', ADAPTER_PATH], { stdio: 'inherit' });
  });

  step('remove any existing Codex MCP registration', () => {
    execFileSync('codex', ['mcp', 'remove', 'chrome-agent-bridge'], { stdio: 'ignore' });
  });
  step('add MCP server to Codex', () => {
    execFileSync('codex', ['mcp', 'add', 'chrome-agent-bridge', '--', 'node', ADAPTER_PATH], { stdio: 'inherit' });
  });

  step('register MCP server with Antigravity (~/.gemini/config/mcp_config.json)', () => {
    fs.mkdirSync(path.dirname(AGY_MCP_CONFIG_PATH), { recursive: true });
    let cfg = {};
    if (fs.existsSync(AGY_MCP_CONFIG_PATH)) {
      const raw = fs.readFileSync(AGY_MCP_CONFIG_PATH, 'utf8').trim();
      if (raw) cfg = JSON.parse(raw);
    }
    if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') {
      cfg.mcpServers = {};
    }
    cfg.mcpServers['chrome-agent-bridge'] = {
      command: process.execPath,
      args: [ADAPTER_PATH],
    };
    fs.writeFileSync(AGY_MCP_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  });

  if (fs.existsSync(SKILL_SOURCE_PATH)) {
    step('install chrome-agent-bridge skill for Claude Code, Codex, and Antigravity', () => {
      const skillContent = fs.readFileSync(SKILL_SOURCE_PATH, 'utf8');
      for (const target of SKILL_TARGETS) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, skillContent);
      }
    });
  }

  console.log('\nNext step: load the extension unpacked.');
  console.log('  1. Open chrome://extensions');
  console.log('  2. Enable Developer mode (top right)');
  console.log(`  3. Click "Load unpacked" and select: ${path.join(REPO_ROOT, 'extension')}`);
  console.log(`  4. Confirm its ID matches: ${extensionId}`);
}

main();
