#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { encodeMessage, MessageDecoder } = require('../lib/framing');
const { loadOrCreateConfig, resolveConfigDir } = require('../lib/config');
const { ActivityLog } = require('../lib/activity-log');
const { Relay } = require('./relay');

function main() {
  const configDir = resolveConfigDir();
  const config = loadOrCreateConfig(configDir);
  const activityLog = new ActivityLog({ configDir });
  const pidFile = path.join(os.tmpdir(), `chrome-agent-bridge-${config.port}.pid`);

  const relay = new Relay({
    token: config.token,
    activityLog,
    sendToExtension: (msg) => {
      process.stdout.write(encodeMessage(msg));
    },
  });

  const decoder = new MessageDecoder((msg) => relay.handleExtensionMessage(msg));
  process.stdin.on('data', (chunk) => decoder.push(chunk));
  process.stdin.on('end', () => process.exit(0));

  let activeWss = null;
  process.on('SIGUSR1', () => {
    // Another native-host instance was spawned by the extension and now owns
    // the extension's `port` reference. Release the WebSocket port for it, but
    // keep stdin open so our own port.onDisconnect doesn't fire and start a
    // competing reconnect loop.
    if (activeWss) {
      try { activeWss.close(); } catch {}
      activeWss = null;
    }
  });

  function startServer(retries = 5) {
    const wss = new WebSocket.Server({ host: '127.0.0.1', port: config.port });
    activeWss = wss;

    wss.on('listening', () => {
      try { fs.writeFileSync(pidFile, String(process.pid)); } catch {}
    });

    wss.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && retries > 0) {
        try {
          const oldPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
          if (oldPid && oldPid !== process.pid) process.kill(oldPid, 'SIGUSR1');
        } catch {}
        setTimeout(() => startServer(retries - 1), 150);
        return;
      }
      throw err;
    });

    wss.on('connection', (ws) => {
      const state = relay.handleClientConnected();
      ws.on('message', (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        relay.handleClientMessage(state, message, (reply) => {
          ws.send(JSON.stringify(reply));
        });
      });
      ws.on('close', () => relay.handleClientDisconnected(state));
    });

    return wss;
  }

  const wss = startServer();
  return { wss, config, activityLog, relay };
}

if (require.main === module) {
  main();
}

module.exports = { main };
