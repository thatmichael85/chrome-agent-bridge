function encodeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

class MessageDecoder {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 4) return;
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) return;
      const json = this.buffer.subarray(4, 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);
      this.onMessage(JSON.parse(json));
    }
  }
}

module.exports = { encodeMessage, MessageDecoder };
