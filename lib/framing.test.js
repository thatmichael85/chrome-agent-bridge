const test = require('node:test');
const assert = require('node:assert');
const { encodeMessage, MessageDecoder } = require('./framing');

test('round-trips a single message', () => {
  const received = [];
  const decoder = new MessageDecoder((msg) => received.push(msg));
  decoder.push(encodeMessage({ hello: 'world' }));
  assert.deepStrictEqual(received, [{ hello: 'world' }]);
});

test('handles a message split across multiple chunks', () => {
  const received = [];
  const decoder = new MessageDecoder((msg) => received.push(msg));
  const encoded = encodeMessage({ a: 1, b: 'x'.repeat(100) });
  decoder.push(encoded.subarray(0, 5));
  decoder.push(encoded.subarray(5));
  assert.deepStrictEqual(received, [{ a: 1, b: 'x'.repeat(100) }]);
});

test('handles multiple messages arriving in one chunk', () => {
  const received = [];
  const decoder = new MessageDecoder((msg) => received.push(msg));
  const combined = Buffer.concat([encodeMessage({ n: 1 }), encodeMessage({ n: 2 })]);
  decoder.push(combined);
  assert.deepStrictEqual(received, [{ n: 1 }, { n: 2 }]);
});
