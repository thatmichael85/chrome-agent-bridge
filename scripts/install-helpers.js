const { generateKeyPair, idFromPublicKeyDer } = require('../lib/extension-id');

function buildNativeMessagingManifest({ extensionId, hostScriptPath }) {
  return {
    name: 'com.chromeagentbridge.host',
    description: 'Chrome Agent Bridge native messaging host',
    path: hostScriptPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

function ensureManifestKey(manifestObj) {
  if (manifestObj.key) {
    const der = Buffer.from(manifestObj.key, 'base64');
    return { manifestObj, extensionId: idFromPublicKeyDer(der), changed: false };
  }
  const { publicKeyDer, publicKeyBase64 } = generateKeyPair();
  const updated = { ...manifestObj, key: publicKeyBase64 };
  return { manifestObj: updated, extensionId: idFromPublicKeyDer(publicKeyDer), changed: true };
}

module.exports = { buildNativeMessagingManifest, ensureManifestKey };
