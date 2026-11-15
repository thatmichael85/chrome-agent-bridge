const test = require('node:test');
const assert = require('node:assert');
const { Relay } = require('./relay');

// Auth no longer provisions a tab -- that happens on first use. This helper
// authenticates a client and then drives one new_tab round-trip so the session
// owns a tab, which is the starting point most tests below assume.
function authenticateAndProvision(relay, toExtension, token, tabId, groupId, sessionId) {
  const state = relay.handleClientConnected();
  const authReplies = [];
  relay.handleClientMessage(state, { type: 'auth', token, sessionId }, (m) => authReplies.push(m));
  relay.handleClientMessage(state, { type: 'command', id: `prov-${tabId}`, command: 'new_tab', params: { url: 'about:blank' } }, () => {});
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

test('auth opens no tab and acknowledges immediately', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const state = relay.handleClientConnected();
  const authReplies = [];
  relay.handleClientMessage(state, { type: 'auth', token: 'secret' }, (m) => authReplies.push(m));

  // Sessions that never browse must not cost the user a tab or a tab group.
  assert.strictEqual(toExtension.length, 0, 'connecting must not touch the browser');
  assert.deepStrictEqual(authReplies, [{ type: 'auth_ok' }]);
  assert.strictEqual(state.activeTabId, null);
  assert.strictEqual(state.tabs.size, 0);
});

test('the first tab-targeting command provisions a tab, then runs against it', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const state = relay.handleClientConnected();
  relay.handleClientMessage(state, { type: 'auth', token: 'secret' }, () => {});

  const sent = [];
  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'navigate', params: { url: 'https://x.com' } }, (m) => sent.push(m));

  assert.strictEqual(toExtension.length, 1);
  assert.strictEqual(toExtension[0].command, 'new_tab', 'provisions before running the command');
  assert.strictEqual(toExtension[0].params.createGroup, true);
  assert.strictEqual(sent.length, 0, 'the caller waits for its own command, not the provisioning');

  relay.handleExtensionMessage({ id: toExtension[0].id, result: { tabId: 555, groupId: 9 } });
  assert.strictEqual(state.activeTabId, 555);
  assert.strictEqual(state.groupId, 9);

  assert.strictEqual(toExtension.length, 2, 'the original command follows');
  assert.strictEqual(toExtension[1].command, 'navigate');
  assert.strictEqual(toExtension[1].params.tabId, 555, 'aimed at the tab just created');

  relay.handleExtensionMessage({ id: toExtension[1].id, result: { ok: true } });
  assert.deepStrictEqual(sent, [{ type: 'response', id: 'c1', result: { ok: true }, error: undefined }]);
});

test('list_tabs does not provision a tab', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const state = relay.handleClientConnected();
  relay.handleClientMessage(state, { type: 'auth', token: 'secret' }, () => {});

  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'list_tabs', params: {} }, () => {});

  assert.strictEqual(toExtension.length, 1);
  assert.strictEqual(toExtension[0].command, 'list_tabs', 'forwarded directly, no new_tab first');
  assert.strictEqual(state.tabs.size, 0);
});

test('reconnecting with the same sessionId resumes the tabs instead of opening more', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state: first } = authenticateAndProvision(relay, toExtension, 'secret', 42, 1, 'sess-a');
  relay.handleClientDisconnected(first);

  // The adapter's socket dropped and came back with the same session identity.
  const resumed = relay.handleClientConnected();
  const callsBefore = toExtension.length;
  relay.handleClientMessage(resumed, { type: 'auth', token: 'secret', sessionId: 'sess-a' }, () => {});

  assert.strictEqual(toExtension.length, callsBefore, 'resuming must not open a tab');
  assert.deepStrictEqual([...resumed.tabs], [42], 'the original tab is still owned');
  assert.strictEqual(resumed.activeTabId, 42);
  assert.strictEqual(resumed.groupId, 1, 'and still lands in the same tab group');

  // Its first command therefore reuses tab 42 rather than provisioning again.
  relay.handleClientMessage(resumed, { type: 'command', id: 'c1', command: 'navigate', params: { url: 'https://y.com' } }, () => {});
  const forwarded = toExtension[toExtension.length - 1];
  assert.strictEqual(forwarded.command, 'navigate');
  assert.strictEqual(forwarded.params.tabId, 42);
});

test('a session that owns no tabs is not retained for resumption', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const state = relay.handleClientConnected();
  relay.handleClientMessage(state, { type: 'auth', token: 'secret', sessionId: 'sess-empty' }, () => {});

  assert.strictEqual(relay.sessions.size, 1);
  relay.handleClientDisconnected(state);
  assert.strictEqual(relay.sessions.size, 0, 'nothing to resume, so nothing kept');
});

test('a different sessionId gets its own tabs, not the previous session\'s', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state: first } = authenticateAndProvision(relay, toExtension, 'secret', 42, 1, 'sess-a');
  relay.handleClientDisconnected(first);

  const other = relay.handleClientConnected();
  relay.handleClientMessage(other, { type: 'auth', token: 'secret', sessionId: 'sess-b' }, () => {});

  assert.strictEqual(other.tabs.size, 0);
  assert.strictEqual(other.activeTabId, null);
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
  // Take a second tab so the explicit id can differ from the session default.
  // (This used to pass tabId 999 -- a tab the session never owned -- which the
  // ownership guard now correctly rejects. The point of the test is that an
  // explicit id beats the injected default, so use one the session owns.)
  relay.handleClientMessage(state, { type: 'command', id: 'c0', command: 'new_tab', params: { url: 'https://y.com' } }, () => {});
  const ntCall = toExtension[toExtension.length - 1];
  relay.handleExtensionMessage({ id: ntCall.id, result: { tabId: 77, groupId: 1 } });
  assert.strictEqual(state.activeTabId, 77, 'the newly opened tab is the session default');

  const sent = [];
  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'navigate', params: { url: 'https://x.com', tabId: 42 } }, (m) => sent.push(m));
  assert.strictEqual(sent.length, 0, 'an owned tabId must not be rejected');
  const forwarded = toExtension[toExtension.length - 1];
  assert.deepStrictEqual(forwarded.params, { url: 'https://x.com', tabId: 42 });
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

// Ownership used to be checked only in the use_tab branch, so an explicit
// tabId on any other command was forwarded unchecked -- and list_tabs hands
// out every tabId in the browser. These guard that hole staying shut.

test('an explicit tabId belonging to another session is rejected, not forwarded', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state: stateA } = authenticateAndProvision(relay, toExtension, 'secret', 1, 7);
  authenticateAndProvision(relay, toExtension, 'secret', 2, 8);

  const before = toExtension.length;
  const sent = [];
  relay.handleClientMessage(stateA, { type: 'command', id: 'a1', command: 'navigate', params: { tabId: 2, url: 'https://evil.example' } }, (m) => sent.push(m));

  assert.deepStrictEqual(sent, [{ type: 'response', id: 'a1', result: undefined, error: 'not your tab: 2' }]);
  assert.strictEqual(toExtension.length, before, 'nothing may reach the extension');
});

test('an explicit tabId the user owns (never provisioned to any session) is rejected', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state } = authenticateAndProvision(relay, toExtension, 'secret', 1, 7);

  const before = toExtension.length;
  const sent = [];
  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'evaluate', params: { tabId: 999, expression: 'document.cookie' } }, (m) => sent.push(m));

  assert.deepStrictEqual(sent, [{ type: 'response', id: 'c1', result: undefined, error: 'not your tab: 999' }]);
  assert.strictEqual(toExtension.length, before);
});

test('close_tab cannot close a tab the session does not own', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state: stateA } = authenticateAndProvision(relay, toExtension, 'secret', 1, 7);
  const { state: stateB } = authenticateAndProvision(relay, toExtension, 'secret', 2, 8);

  const before = toExtension.length;
  const sent = [];
  relay.handleClientMessage(stateA, { type: 'command', id: 'a1', command: 'close_tab', params: { tabId: 2 } }, (m) => sent.push(m));

  assert.deepStrictEqual(sent, [{ type: 'response', id: 'a1', result: undefined, error: 'not your tab: 2' }]);
  assert.strictEqual(toExtension.length, before);
  assert.ok(stateB.tabs.has(2), 'the other session keeps its tab');
});

test('switch_tab cannot signal on a tab the session does not own', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state: stateA } = authenticateAndProvision(relay, toExtension, 'secret', 1, 7);
  authenticateAndProvision(relay, toExtension, 'secret', 2, 8);

  const before = toExtension.length;
  const sent = [];
  relay.handleClientMessage(stateA, { type: 'command', id: 'a1', command: 'switch_tab', params: { tabId: 2 } }, (m) => sent.push(m));

  assert.deepStrictEqual(sent, [{ type: 'response', id: 'a1', result: undefined, error: 'not your tab: 2' }]);
  assert.strictEqual(toExtension.length, before);
});

test('groupTitle uses <model>-<sessionid> when model is supplied on auth', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const state = relay.handleClientConnected();
  relay.handleClientMessage(state, { type: 'auth', token: 'secret', sessionId: 'c8a50c80-9e86-4407', model: 'gemini-4-argon' }, () => {});

  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'new_tab', params: { url: 'https://example.com' } }, () => {});
  assert.strictEqual(toExtension.length, 1);
  assert.strictEqual(toExtension[0].params.createGroup, true);
  assert.strictEqual(toExtension[0].params.groupTitle, 'gemini-4-argon-c8a50c80');
});

test('groupTitle uses <model>-<sessionid> when model is supplied on the command and strips model from forwarded params', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const state = relay.handleClientConnected();
  relay.handleClientMessage(state, { type: 'auth', token: 'secret', sessionId: 'deadbeef-1234-5678' }, () => {});

  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'navigate', params: { url: 'https://example.com', model: 'claude-sonnet-4' } }, () => {});
  assert.strictEqual(toExtension[0].command, 'new_tab');
  assert.strictEqual(toExtension[0].params.groupTitle, 'claude-sonnet-4-deadbeef');

  relay.handleExtensionMessage({ id: toExtension[0].id, result: { tabId: 10, groupId: 3 } });
  assert.strictEqual(toExtension[1].command, 'navigate');
  assert.deepStrictEqual(toExtension[1].params, { url: 'https://example.com', tabId: 10 });
});

test('groupTitle falls back to agent-<sessionid> when no model is supplied', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const state = relay.handleClientConnected();
  relay.handleClientMessage(state, { type: 'auth', token: 'secret', sessionId: '12345678-abcd' }, () => {});

  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'new_tab', params: { url: 'https://example.com' } }, () => {});
  assert.strictEqual(toExtension[0].params.groupTitle, 'agent-12345678');
});

test('when the user removes the tab group in Chrome, the next command informs the LLM and the following command respawns a fresh group', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state } = authenticateAndProvision(relay, toExtension, 'secret', 10, 77, 'sess-rm');

  // Extension notifies the relay that Chrome tab group 77 was deleted by the user.
  relay.handleExtensionMessage({ event: 'group_removed', groupId: 77 });
  assert.strictEqual(state.tabs.size, 0);
  assert.strictEqual(state.activeTabId, null);
  assert.strictEqual(state.groupId, null);

  // 1st command after group removal: tells the LLM that its group was removed and to respawn.
  const sent1 = [];
  const before = toExtension.length;
  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'get_text', params: {} }, (m) => sent1.push(m));
  assert.strictEqual(toExtension.length, before, 'does not silently open a tab before notifying the LLM');
  assert.strictEqual(sent1.length, 1);
  assert.match(sent1[0].error, /tab group was removed by the user.*respawn/i);

  // 2nd command (respawn): automatically creates a brand-new tab group and executes.
  const sent2 = [];
  relay.handleClientMessage(state, { type: 'command', id: 'c2', command: 'navigate', params: { url: 'https://respawned.example' } }, (m) => sent2.push(m));
  const prov = toExtension[toExtension.length - 1];
  assert.strictEqual(prov.command, 'new_tab');
  assert.strictEqual(prov.params.createGroup, true);
  assert.strictEqual(prov.params.groupId, undefined);

  relay.handleExtensionMessage({ id: prov.id, result: { tabId: 20, groupId: 88 } });
  const nav = toExtension[toExtension.length - 1];
  assert.strictEqual(nav.command, 'navigate');
  assert.strictEqual(nav.params.tabId, 20);
  relay.handleExtensionMessage({ id: nav.id, result: { tabId: 20, url: 'https://respawned.example' } });
  assert.strictEqual(sent2[0].error, undefined);
});

test('when the user closes the last tab in the group (tab_removed), the LLM is notified and can respawn even if it passed the old tabId', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state } = authenticateAndProvision(relay, toExtension, 'secret', 10, 77, 'sess-tab-rm');

  // Extension fires tab_removed when the user closes tab 10 in Chrome.
  relay.handleExtensionMessage({ event: 'tab_removed', tabId: 10 });
  assert.strictEqual(state.tabs.size, 0);
  assert.strictEqual(state.groupId, null);

  // Even if the LLM explicitly passes the old tabId: 10, it gets the group-removed notice (not a generic "not your tab").
  const sent1 = [];
  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'click', params: { tabId: 10, selector: 'button' } }, (m) => sent1.push(m));
  assert.match(sent1[0].error, /tab group was removed by the user.*respawn/i);

  // And when it respawns via new_tab, a new group is created.
  relay.handleClientMessage(state, { type: 'command', id: 'c2', command: 'new_tab', params: { url: 'https://fresh.example' } }, () => {});
  const nt = toExtension[toExtension.length - 1];
  assert.strictEqual(nt.command, 'new_tab');
  assert.strictEqual(nt.params.createGroup, true);
});

test('agent-initiated close_tab does NOT trigger the user-removed-group error on the next command', () => {
  const toExtension = [];
  const relay = new Relay({ token: 'secret', sendToExtension: (m) => toExtension.push(m) });
  const { state } = authenticateAndProvision(relay, toExtension, 'secret', 10, 77, 'sess-self-close');

  // Agent closes its own tab 10; Chrome subsequently fires tab_removed and group_removed.
  relay.handleClientMessage(state, { type: 'command', id: 'c1', command: 'close_tab', params: { tabId: 10 } }, () => {});
  relay.handleExtensionMessage({ event: 'tab_removed', tabId: 10 });
  relay.handleExtensionMessage({ event: 'group_removed', groupId: 77 });
  relay.handleExtensionMessage({ id: toExtension[toExtension.length - 1].id, result: { ok: true } });

  // Next command should lazily provision without complaining that the user removed the group.
  const sent = [];
  relay.handleClientMessage(state, { type: 'command', id: 'c2', command: 'navigate', params: { url: 'https://next.example' } }, (m) => sent.push(m));
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(toExtension[toExtension.length - 1].command, 'new_tab');
  assert.strictEqual(toExtension[toExtension.length - 1].params.createGroup, true);
});


