const crypto = require('crypto');

function createRelayClient({ socket, createSocket, token, reconnectDelayMs = 1000, maxReconnectDelayMs = 15000 }) {
  const pending = new Map();
  let currentSocket;
  let settled = false;
  let resolveReady;
  let rejectReady;
  let ready;
  let nextDelay = reconnectDelayMs;
  let reconnectTimer = null;

  function newReadyPromise() {
    settled = false;
    ready = new Promise((resolve, reject) => {
      resolveReady = () => { settled = true; resolve(); };
      rejectReady = (err) => { settled = true; reject(err); };
    });
  }

  function attach(sock) {
    currentSocket = sock;

    sock.on('open', () => {
      sock.send(JSON.stringify({ type: 'auth', token }));
    });

    sock.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth_ok') {
        nextDelay = reconnectDelayMs;
        resolveReady();
      } else if (msg.type === 'auth_error') {
        rejectReady(new Error('relay rejected auth token'));
      } else if (msg.type === 'response') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
    });

    sock.on('error', (err) => {
      if (!settled) rejectReady(err);
    });

    sock.on('close', () => {
      if (!settled) rejectReady(new Error('relay connection closed before authenticating'));
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error('relay connection closed'));
      }
      // Only auto-reconnect in production use (index.js passes createSocket).
      // Tests that hand in a single fixed `socket` get the original,
      // no-reconnect behavior so existing assertions keep holding.
      if (createSocket) scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      nextDelay = Math.min(nextDelay * 2, maxReconnectDelayMs);
      newReadyPromise();
      attach(createSocket());
    }, nextDelay);
    // Don't let a pending reconnect attempt keep the process alive on its own.
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  newReadyPromise();
  attach(socket || createSocket());

  function sendCommand(command, params) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.set(id, { resolve, reject });
      try {
        currentSocket.send(JSON.stringify({ type: 'command', id, command, params }));
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  return {
    get ready() { return ready; },
    sendCommand,
  };
}

module.exports = { createRelayClient };
