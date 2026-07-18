function normalizeHubUrl(hubUrl) {
  return String(hubUrl || '').replace(/\/+$/, '');
}

function cliNamespaceUrl(hubUrl) {
  return `${normalizeHubUrl(hubUrl)}/cli`;
}

function defaultIoFactory(url, opts) {
  const { io } = require('socket.io-client');
  return io(url, opts);
}

function emitWithAck(socket, event, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timed out waiting for ${event} ack`));
    }, timeoutMs);

    const finish = (fn) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    try {
      socket.emit(event, payload, finish(resolve));
    } catch (error) {
      finish(reject)(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function createCliMessageSink({
  hubUrl,
  token,
  sessionId,
  generation,
  ioFactory = defaultIoFactory,
  connectTimeoutMs = 5000,
  ackTimeoutMs = connectTimeoutMs
}) {
  if (!hubUrl) throw new Error('hubUrl is required');
  if (!token) throw new Error('token is required');
  if (!sessionId) throw new Error('sessionId is required');
  if (!Number.isInteger(generation) || generation < 1) throw new Error('generation must be a positive integer');
  let socket = null;

  function emitSessionAlive() {
    if (!socket) throw new Error('socket sink is not open');
    socket.emit('session-alive', {
      sid: sessionId,
      time: Date.now(),
      source: 'codex-desktop-sync',
      generation
    });
  }

  return {
    async open() {
      if (socket?.connected) return;
      socket = ioFactory(cliNamespaceUrl(hubUrl), {
        auth: { token, sessionId },
        transports: ['websocket', 'polling'],
        reconnection: false,
        timeout: connectTimeoutMs
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out connecting to HAPI CLI socket at ${hubUrl}`)), connectTimeoutMs);
        socket.on('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.on('connect_error', (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
      emitSessionAlive();
    },

    async write({ sessionId: sid, localId, message }) {
      if (!socket) throw new Error('socket sink is not open');
      emitSessionAlive();
      const ack = await emitWithAck(socket, 'sync-message', {
        sid,
        localId,
        source: 'codex-desktop-sync',
        generation,
        message
      }, ackTimeoutMs);
      if (!ack || typeof ack !== 'object' || typeof ack.inserted !== 'boolean') {
        throw new Error('Invalid sync-message ack from HAPI hub');
      }
      return ack;
    },

    async updateMetadata({ sid, metadata, expectedVersion }) {
      if (!socket) throw new Error('socket sink is not open');
      emitSessionAlive();
      const ack = await emitWithAck(socket, 'update-metadata', {
        sid,
        metadata,
        expectedVersion
      }, ackTimeoutMs);
      if (!ack || typeof ack !== 'object' || typeof ack.result !== 'string') {
        throw new Error('Invalid update-metadata ack from HAPI hub');
      }
      return ack;
    },

    async close() {
      if (socket) {
        socket.emit('session-end', {
          sid: sessionId,
          time: Date.now(),
          source: 'codex-desktop-sync',
          generation
        });
        socket.disconnect();
        socket = null;
      }
    }
  };
}

module.exports = { createCliMessageSink, cliNamespaceUrl, emitWithAck };
