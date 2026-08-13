const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.chrome-agent-bridge');

function resolveConfigDir(explicitDir) {
  return explicitDir || process.env.CHROME_AGENT_BRIDGE_HOME || DEFAULT_CONFIG_DIR;
}

function loadOrCreateConfig(explicitDir) {
  const configDir = resolveConfigDir(explicitDir);
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  const config = {
    token: crypto.randomBytes(24).toString('hex'),
    port: 8787,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return config;
}

module.exports = { DEFAULT_CONFIG_DIR, resolveConfigDir, loadOrCreateConfig };
