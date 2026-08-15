#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildNativeMessagingManifest, ensureManifestKey } = require('./install-helpers');

const REPO_ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'extension', 'manifest.json');
const HOST_SCRIPT_PATH = path.join(REPO_ROOT, 'host', 'native-host.js');
const ADAPTER_PATH = path.join(REPO_ROOT, 'mcp-adapter', 'index.js');
const NATIVE_HOSTS_DIR = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'
);

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

  step('write native messaging host manifest', () => {
    fs.mkdirSync(NATIVE_HOSTS_DIR, { recursive: true });
    const hostManifest = buildNativeMessagingManifest({ extensionId, hostScriptPath: HOST_SCRIPT_PATH });
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

  console.log('\nNext step: load the extension unpacked.');
  console.log('  1. Open chrome://extensions');
  console.log('  2. Enable Developer mode (top right)');
  console.log(`  3. Click "Load unpacked" and select: ${path.join(REPO_ROOT, 'extension')}`);
  console.log(`  4. Confirm its ID matches: ${extensionId}`);
}

main();
