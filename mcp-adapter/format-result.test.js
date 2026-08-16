// mcp-adapter/format-result.test.js
const test = require('node:test');
const assert = require('node:assert');
const { formatResult } = require('./format-result');

test('small text results pass through as compact JSON', () => {
  const content = formatResult('evaluate', { result: { n: 20, has: true } });
  assert.deepStrictEqual(content, [{ type: 'text', text: '{"result":{"n":20,"has":true}}' }]);
});

test('oversized results are truncated with an explicit marker', () => {
  const content = formatResult('get_html', { html: 'x'.repeat(50000) }, 1000);
  assert.strictEqual(content.length, 1);
  assert.ok(content[0].text.length < 1200, 'stays near the cap');
  assert.match(content[0].text, /truncated \d+ of \d+ chars/);
});

test('results at exactly the cap are not truncated', () => {
  const payload = { html: 'y'.repeat(100) };
  const exact = JSON.stringify(payload).length;
  const content = formatResult('get_html', payload, exact);
  assert.strictEqual(content[0].text, JSON.stringify(payload));
});

test('screenshot data URLs become MCP image content, not text', () => {
  const content = formatResult('screenshot', { dataUrl: 'data:image/jpeg;base64,/9j/AAAA' });
  assert.deepStrictEqual(content, [{ type: 'image', data: '/9j/AAAA', mimeType: 'image/jpeg' }]);
});

test('a malformed screenshot result falls back to capped text', () => {
  const content = formatResult('screenshot', { dataUrl: 'not-a-data-url' }, 1000);
  assert.strictEqual(content[0].type, 'text');
});

test('non-screenshot commands never emit image content even if a dataUrl sneaks through', () => {
  const content = formatResult('evaluate', { dataUrl: 'data:image/png;base64,AAAA' });
  assert.strictEqual(content[0].type, 'text');
});
