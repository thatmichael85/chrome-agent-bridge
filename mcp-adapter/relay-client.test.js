// mcp-adapter/relay-client.test.js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createRelayClient } = require('./relay-client');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

test('sendCommand resolves with the result once a matching response arrives', async () => {
  const socket = new FakeSocket();
  const client = createRelayClient({ socket, token: 'secret' });
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth_ok' })));
  await client.ready;

  const promise = client.sendCommand('navigate', { url: 'https://x.com' });
  const sentCommand = socket.sent.find((m) => m.type === 'command');
  assert.strictEqual(sentCommand.command, 'navigate');

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response', id: sentCommand.id, result: { ok: true } })));
  const result = await promise;
  assert.deepStrictEqual(result, { ok: true });
});

test('sendCommand rejects when the response carries an error', async () => {
  const socket = new FakeSocket();
  const client = createRelayClient({ socket, token: 'secret' });
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth_ok' })));
  await client.ready;

  const promise = client.sendCommand('click', { selector: '#missing' });
  const sentCommand = socket.sent.find((m) => m.type === 'command');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response', id: sentCommand.id, error: 'no element matching selector: #missing' })));

  await assert.rejects(promise, /no element matching selector/);
});

test('ready rejects when the relay sends auth_error', async () => {
  const socket = new FakeSocket();
  const client = createRelayClient({ socket, token: 'wrong' });
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth_error' })));
  await assert.rejects(client.ready, /auth/);
});

test('ready rejects when the socket errors before auth completes (e.g. relay not running)', async () => {
  const socket = new FakeSocket();
  const client = createRelayClient({ socket, token: 'secret' });
  socket.emit('error', new Error('ECONNREFUSED'));
  await assert.rejects(client.ready, /ECONNREFUSED/);
});

test('sendCommand rejects if the socket closes while a command is still pending', async () => {
  const socket = new FakeSocket();
  const client = createRelayClient({ socket, token: 'secret' });
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth_ok' })));
  await client.ready;

  const promise = client.sendCommand('navigate', { url: 'https://x.com' });
  socket.emit('close');
  await assert.rejects(promise, /connection closed/);
});
