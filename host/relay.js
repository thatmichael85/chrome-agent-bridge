const crypto = require('crypto');

class Relay {
  constructor({ token, sendToExtension }) {
    this.token = token;
    this.sendToExtension = sendToExtension;
    this.pending = new Map();
  }

  handleClientConnected() {
    return { authenticated: false };
  }

  handleClientMessage(clientState, message, clientSend) {
    if (!clientState.authenticated) {
      if (message.type !== 'auth') return;
      if (message.token === this.token) {
        clientState.authenticated = true;
        clientSend({ type: 'auth_ok' });
      } else {
        clientSend({ type: 'auth_error' });
      }
      return;
    }
    if (message.type === 'command') {
      const internalId = crypto.randomUUID();
      this.pending.set(internalId, { clientSend, originalId: message.id });
      this.sendToExtension({ id: internalId, command: message.command, params: message.params });
    }
  }

  handleExtensionMessage(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.clientSend({
      type: 'response',
      id: pending.originalId,
      result: message.result,
      error: message.error,
    });
  }
}

module.exports = { Relay };
