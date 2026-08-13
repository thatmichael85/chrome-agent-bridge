const test = require('node:test');
const assert = require('node:assert');
const { Relay } = require('./relay');

test('rejects commands before auth', () => {
  const relay = new Relay({ token: 'secret', sendToExtension: () => { throw new Error('should not be called'); } });
  const state = relay.handleClientConnected();
  const sent = [];
  relay.handleClientMessage(state, { type: 'command', id: '1', command: 'navigate', params: {} }, (m) => sent.push(m));
  assert.strictEqual(sent.length, 0);
});

test('authenticates with the correct token', () => {
  const relay = new Relay({ token: 'secret', sendToExtension: () => {} });
  const state = relay.handleClientConnected();
  const sent = [];
  relay.handleClientMessage(state, { type: 'auth', token: 'secret' }, (m) => sent.push(m));
  assert.deepStrictEqual(sent, [{ type: 'auth_ok' }]);
  assert.strictEqual(state.authenticated, true);
});

test('rejects the wrong token', () => {
  const relay = new Relay({ token: 'secret', sendToExtension: () => {} });
  const state = relay.handleClientConnected();
  const sent = [];
  relay.handleClientMessage(state, { type: 'auth', token: 'wrong' }, (m) => sent.push(m));
  assert.deepStrictEqual(sent, [{ type: 'auth_error' }]);
  assert.strictEqual(state.authenticated, false);
});

test('forwards an authenticated command to the extension and routes the response back to the right client', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const state = relay.handleClientConnected();
  relay.handleClientMessage(state, { type: 'auth', token: 'secret' }, () => {});
  const sent = [];
  relay.handleClientMessage(state, { type: 'command', id: 'abc', command: 'navigate', params: { url: 'https://x.com' } }, (m) => sent.push(m));
  assert.strictEqual(toExtension.length, 1);
  assert.strictEqual(toExtension[0].command, 'navigate');
  assert.deepStrictEqual(toExtension[0].params, { url: 'https://x.com' });
  const internalId = toExtension[0].id;
  relay.handleExtensionMessage({ id: internalId, result: { ok: true } });
  assert.deepStrictEqual(sent, [{ type: 'response', id: 'abc', result: { ok: true }, error: undefined }]);
});

test('two clients get their own responses routed correctly', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const stateA = relay.handleClientConnected();
  const stateB = relay.handleClientConnected();
  relay.handleClientMessage(stateA, { type: 'auth', token: 'secret' }, () => {});
  relay.handleClientMessage(stateB, { type: 'auth', token: 'secret' }, () => {});
  const sentA = [];
  const sentB = [];
  relay.handleClientMessage(stateA, { type: 'command', id: 'a1', command: 'list_tabs', params: {} }, (m) => sentA.push(m));
  relay.handleClientMessage(stateB, { type: 'command', id: 'b1', command: 'list_tabs', params: {} }, (m) => sentB.push(m));
  relay.handleExtensionMessage({ id: toExtension[0].id, result: 'fromA' });
  relay.handleExtensionMessage({ id: toExtension[1].id, result: 'fromB' });
  assert.strictEqual(sentA[0].result, 'fromA');
  assert.strictEqual(sentB[0].result, 'fromB');
});
