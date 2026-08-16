const test = require('node:test');
const assert = require('node:assert');
const { Relay } = require('./relay');

// Auth triggers an automatic new_tab provisioning round-trip (which also
// creates a tab group for the session) before auth_ok is sent. This helper
// authenticates a client and completes that handshake.
function authenticateAndProvision(relay, toExtension, token, tabId, groupId) {
  const state = relay.handleClientConnected();
  const authReplies = [];
  relay.handleClientMessage(state, { type: 'auth', token }, (m) => authReplies.push(m));
  const provisionCall = toExtension[toExtension.length - 1];
  relay.handleExtensionMessage({ id: provisionCall.id, result: { tabId, groupId } });
  return { state, authReplies, provisionCall };
}

test('rejects commands before auth', () => {
  const relay = new Relay({ token: 'secret', sendToExtension: () => { throw new Error('should not be called'); } });
  const state = relay.handleClientConnected();
  const sent = [];
  relay.handleClientMessage(state, { type: 'command', id: '1', command: 'navigate', params: {} }, (m) => sent.push(m));
  assert.strictEqual(sent.length, 0);
});

test('rejects the wrong token without provisioning a tab', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const state = relay.handleClientConnected();
  const sent = [];
  relay.handleClientMessage(state, { type: 'auth', token: 'wrong' }, (m) => sent.push(m));
  assert.deepStrictEqual(sent, [{ type: 'auth_error' }]);
  assert.strictEqual(state.authenticated, false);
  assert.strictEqual(toExtension.length, 0);
});

test('auth provisions a tab (with a fresh tab group) and does not send auth_ok until the extension confirms it', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const state = relay.handleClientConnected();
  const authReplies = [];
  relay.handleClientMessage(state, { type: 'auth', token: 'secret' }, (m) => authReplies.push(m));

  assert.strictEqual(authReplies.length, 0, 'auth_ok must wait for tab provisioning');
  assert.strictEqual(toExtension.length, 1);
  assert.strictEqual(toExtension[0].command, 'new_tab');
  assert.strictEqual(toExtension[0].params.createGroup, true);
  assert.strictEqual(typeof toExtension[0].params.groupTitle, 'string');

  relay.handleExtensionMessage({ id: toExtension[0].id, result: { tabId: 555, groupId: 9 } });
  assert.deepStrictEqual(authReplies, [{ type: 'auth_ok' }]);
  assert.strictEqual(state.activeTabId, 555);
  assert.deepStrictEqual([...state.tabs], [555]);
  assert.strictEqual(state.groupId, 9);
});

test('commands without an explicit tabId get the session active tabId injected', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state } = authenticateAndProvision(relay, toExtension, 'secret', 42, 1);

  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'get_text', params: {} }, () => {});
  const forwarded = toExtension[toExtension.length - 1];
  assert.strictEqual(forwarded.command, 'get_text');
  assert.deepStrictEqual(forwarded.params, { tabId: 42 });
});

test('commands with an explicit tabId are not overridden by the session default', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state } = authenticateAndProvision(relay, toExtension, 'secret', 42, 1);

  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'navigate', params: { url: 'https://x.com', tabId: 999 } }, () => {});
  const forwarded = toExtension[toExtension.length - 1];
  assert.deepStrictEqual(forwarded.params, { url: 'https://x.com', tabId: 999 });
});

test('a second new_tab call joins the existing session group instead of creating a new one', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state } = authenticateAndProvision(relay, toExtension, 'secret', 1, 7);

  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'new_tab', params: { url: 'https://y.com' } }, () => {});
  const forwarded = toExtension[toExtension.length - 1];
  assert.strictEqual(forwarded.command, 'new_tab');
  assert.strictEqual(forwarded.params.groupId, 7);
  assert.strictEqual(forwarded.params.createGroup, undefined);

  relay.handleExtensionMessage({ id: forwarded.id, result: { tabId: 2, groupId: 7 } });
  assert.deepStrictEqual([...state.tabs].sort(), [1, 2]);
  assert.strictEqual(state.activeTabId, 2, 'newly opened tab becomes the active default');
});

test('use_tab switches the active default among owned tabs without contacting the extension', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state } = authenticateAndProvision(relay, toExtension, 'secret', 1, 7);
  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'new_tab', params: {} }, () => {});
  relay.handleExtensionMessage({ id: toExtension[toExtension.length - 1].id, result: { tabId: 2, groupId: 7 } });

  const callsBefore = toExtension.length;
  const sent = [];
  relay.handleClientMessage(state, { type: 'command', id: 'c2', command: 'use_tab', params: { tabId: 1 } }, (m) => sent.push(m));

  assert.strictEqual(toExtension.length, callsBefore, 'use_tab must not call the extension');
  assert.strictEqual(state.activeTabId, 1);
  assert.deepStrictEqual(sent, [{ type: 'response', id: 'c2', result: { ok: true }, error: undefined }]);
});

test('use_tab rejects a tabId the session does not own', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state } = authenticateAndProvision(relay, toExtension, 'secret', 1, 7);

  const sent = [];
  relay.handleClientMessage(state, { type: 'command', id: 'c2', command: 'use_tab', params: { tabId: 999 } }, (m) => sent.push(m));

  assert.strictEqual(state.activeTabId, 1, 'active tab is unchanged');
  assert.strictEqual(sent[0].error, 'not your tab: 999');
});

test('list_my_tabs returns owned tabIds without contacting the extension', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state } = authenticateAndProvision(relay, toExtension, 'secret', 1, 7);
  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'new_tab', params: {} }, () => {});
  relay.handleExtensionMessage({ id: toExtension[toExtension.length - 1].id, result: { tabId: 2, groupId: 7 } });

  const callsBefore = toExtension.length;
  const sent = [];
  relay.handleClientMessage(state, { type: 'command', id: 'c2', command: 'list_my_tabs', params: {} }, (m) => sent.push(m));

  assert.strictEqual(toExtension.length, callsBefore);
  assert.deepStrictEqual(sent[0].result.tabIds.sort(), [1, 2]);
  assert.strictEqual(sent[0].result.activeTabId, 2, 'the second new_tab call made tab 2 the active default');
});

test('close_tab removes the tab from ownership and clears activeTabId if it was active', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state } = authenticateAndProvision(relay, toExtension, 'secret', 1, 7);
  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'new_tab', params: {} }, () => {});
  relay.handleExtensionMessage({ id: toExtension[toExtension.length - 1].id, result: { tabId: 2, groupId: 7 } });
  relay.handleClientMessage(state, { type: 'command', id: 'c2', command: 'use_tab', params: { tabId: 2 } }, () => {});

  const sent = [];
  relay.handleClientMessage(state, { type: 'command', id: 'c3', command: 'close_tab', params: { tabId: 2 } }, (m) => sent.push(m));
  const closeCall = toExtension[toExtension.length - 1];
  relay.handleExtensionMessage({ id: closeCall.id, result: { ok: true } });

  assert.deepStrictEqual([...state.tabs], [1]);
  assert.strictEqual(state.activeTabId, 1, 'falls back to a remaining owned tab');
  // Regression: the response must carry the ORIGINAL client-issued id ('c3'),
  // not the relay's internal request id -- otherwise the client's pending
  // promise for this call never resolves and the caller hangs until timeout.
  assert.deepStrictEqual(sent, [{ type: 'response', id: 'c3', result: { ok: true }, error: undefined }]);
});

test('closing the last owned tab clears the stale groupId so a later new_tab creates a fresh group', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state } = authenticateAndProvision(relay, toExtension, 'secret', 1, 7);

  // Session's only tab gets closed -- Chrome auto-deletes the now-empty
  // group 7 as a side effect, so the relay must not keep referencing it.
  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'close_tab', params: { tabId: 1 } }, () => {});
  relay.handleExtensionMessage({ id: toExtension[toExtension.length - 1].id, result: { ok: true } });

  assert.strictEqual(state.tabs.size, 0);
  assert.strictEqual(state.groupId, null, 'a deleted group must not be remembered as still valid');

  relay.handleClientMessage(state, { type: 'command', id: 'c2', command: 'new_tab', params: { url: 'https://x.com' } }, () => {});
  const newTabCall = toExtension[toExtension.length - 1];
  assert.strictEqual(newTabCall.params.groupId, undefined, 'must not reference the deleted group');
  assert.strictEqual(newTabCall.params.createGroup, true, 'must create a fresh group instead');
});

test('two clients get their own auto-provisioned tabs/groups and their own responses routed correctly', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state: stateA } = authenticateAndProvision(relay, toExtension, 'secret', 100, 11);
  const { state: stateB } = authenticateAndProvision(relay, toExtension, 'secret', 200, 22);

  assert.strictEqual(stateA.activeTabId, 100);
  assert.strictEqual(stateB.activeTabId, 200);
  assert.notStrictEqual(stateA.groupId, stateB.groupId);

  const sentA = [];
  const sentB = [];
  relay.handleClientMessage(stateA, { type: 'command', id: 'a1', command: 'get_text', params: {} }, (m) => sentA.push(m));
  relay.handleClientMessage(stateB, { type: 'command', id: 'b1', command: 'get_text', params: {} }, (m) => sentB.push(m));

  const callA = toExtension.find((c) => c.params && c.params.tabId === 100);
  const callB = toExtension.find((c) => c.params && c.params.tabId === 200);
  relay.handleExtensionMessage({ id: callA.id, result: 'fromA' });
  relay.handleExtensionMessage({ id: callB.id, result: 'fromB' });
  assert.strictEqual(sentA[0].result, 'fromA');
  assert.strictEqual(sentB[0].result, 'fromB');
});

test('disconnecting a client cleans up only its own pending entries', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state: stateA } = authenticateAndProvision(relay, toExtension, 'secret', 1, 7);
  const { state: stateB } = authenticateAndProvision(relay, toExtension, 'secret', 2, 8);

  const sentA = [];
  const sentB = [];
  relay.handleClientMessage(stateA, { type: 'command', id: 'a1', command: 'get_text', params: {} }, (m) => sentA.push(m));
  relay.handleClientMessage(stateB, { type: 'command', id: 'b1', command: 'get_text', params: {} }, (m) => sentB.push(m));

  assert.strictEqual(relay.pending.size, 2);
  relay.handleClientDisconnected(stateA);
  assert.strictEqual(relay.pending.size, 1);

  const callB = toExtension.find((c) => c.params && c.params.tabId === 2);
  relay.handleExtensionMessage({ id: callB.id, result: 'fromB' });
  assert.deepStrictEqual(sentB, [{ type: 'response', id: 'b1', result: 'fromB', error: undefined }]);
});
