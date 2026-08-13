const crypto = require('crypto');

function generateKeyPair() {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  return { publicKeyDer, publicKeyBase64: publicKeyDer.toString('base64') };
}

function idFromPublicKeyDer(der) {
  const hash = crypto.createHash('sha256').update(der).digest();
  const first16 = hash.subarray(0, 16);
  let id = '';
  for (const byte of first16) {
    const high = byte >> 4;
    const low = byte & 0x0f;
    id += String.fromCharCode(97 + high) + String.fromCharCode(97 + low);
  }
  return id;
}

module.exports = { generateKeyPair, idFromPublicKeyDer };
