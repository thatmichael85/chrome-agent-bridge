#!/usr/bin/env node
const WebSocket = require('ws');
const { encodeMessage, MessageDecoder } = require('../lib/framing');
const { loadOrCreateConfig } = require('../lib/config');
const { Relay } = require('./relay');

function main() {
  const config = loadOrCreateConfig();

  const relay = new Relay({
    token: config.token,
    sendToExtension: (msg) => {
      process.stdout.write(encodeMessage(msg));
    },
  });

  const decoder = new MessageDecoder((msg) => relay.handleExtensionMessage(msg));
  process.stdin.on('data', (chunk) => decoder.push(chunk));
  process.stdin.on('end', () => process.exit(0));

  const wss = new WebSocket.Server({ host: '127.0.0.1', port: config.port });
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

  return { wss, config };
}

if (require.main === module) {
  main();
}

module.exports = { main };
