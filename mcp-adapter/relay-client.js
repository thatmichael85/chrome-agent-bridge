const crypto = require('crypto');

function createRelayClient({ socket, token }) {
  const pending = new Map();
  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = () => { settled = true; resolve(); };
    rejectReady = (err) => { settled = true; reject(err); };
  });

  socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'auth', token }));
  });

  socket.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'auth_ok') {
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

  socket.on('error', (err) => {
    if (!settled) rejectReady(err);
  });

  socket.on('close', () => {
    if (!settled) rejectReady(new Error('relay connection closed before authenticating'));
    for (const [id, p] of pending) {
      pending.delete(id);
      p.reject(new Error('relay connection closed'));
    }
  });

  function sendCommand(command, params) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type: 'command', id, command, params }));
    });
  }

  return { ready, sendCommand };
}

module.exports = { createRelayClient };
