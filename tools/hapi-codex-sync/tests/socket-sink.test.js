const test = require('node:test');
const assert = require('node:assert/strict');
const { createCliMessageSink } = require('../src/socket-sink');

test('socket sink marks mirrored session alive around passive sync messages', async () => {
  const emitted = [];
  const fakeSocket = {
    connected: false,
    on(event, handler) {
      if (event === 'connect') this._connect = handler;
      if (event === 'connect_error') this._connectError = handler;
      return this;
    },
    emit(event, payload, cb) {
      emitted.push({ event, payload });
      cb?.(event === 'sync-message' ? { inserted: true } : { ok: true });
    },
    disconnect() {
      this.disconnected = true;
    }
  };
  const calls = [];
  const sink = createCliMessageSink({
    hubUrl: 'http://127.0.0.1:3006',
    token: 'secret:default',
    sessionId: 'session-1',
    generation: 7,
    ioFactory(url, opts) {
      calls.push({ url, opts });
      queueMicrotask(() => fakeSocket._connect());
      return fakeSocket;
    }
  });

  await sink.open();
  await sink.write({
    sessionId: 'session-1',
    localId: 'codex:t:1:abc',
    message: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'hi' } } }
  });
  await sink.close();

  assert.equal(calls[0].url, 'http://127.0.0.1:3006/cli');
  assert.deepEqual(calls[0].opts.auth, { token: 'secret:default', sessionId: 'session-1' });
  assert.equal(emitted.length, 4);
  assert.equal(emitted[0].event, 'session-alive');
  assert.equal(emitted[0].payload.sid, 'session-1');
  assert.equal(typeof emitted[0].payload.time, 'number');
  assert.equal(emitted[1].event, 'session-alive');
  assert.equal(emitted[1].payload.sid, 'session-1');
  assert.equal(typeof emitted[1].payload.time, 'number');
  assert.equal(emitted[2].event, 'sync-message');
  assert.deepEqual(emitted[0].payload, {
    sid: 'session-1',
    time: emitted[0].payload.time,
    source: 'codex-desktop-sync',
    generation: 7
  });
  assert.deepEqual(emitted[2].payload, {
    sid: 'session-1',
    localId: 'codex:t:1:abc',
    source: 'codex-desktop-sync',
    generation: 7,
    message: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'hi' } } }
  });
  assert.equal(emitted[3].event, 'session-end');
  assert.deepEqual(emitted[3].payload, {
    sid: 'session-1',
    time: emitted[3].payload.time,
    source: 'codex-desktop-sync',
    generation: 7
  });
  assert.equal(typeof emitted[3].payload.time, 'number');
  assert.equal(fakeSocket.disconnected, true);
});

test('socket sink returns hub rejection acks to the watcher', async () => {
  const fakeSocket = {
    connected: false,
    on(event, handler) {
      if (event === 'connect') this._connect = handler;
      return this;
    },
    emit(event, payload, cb) {
      if (event === 'sync-message') {
        cb?.({ inserted: false, reason: 'stale-generation' });
      } else {
        cb?.({ ok: true });
      }
    },
    disconnect() {}
  };

  const sink = createCliMessageSink({
    hubUrl: 'http://127.0.0.1:3006',
    token: 'secret:default',
    sessionId: 'session-1',
    generation: 7,
    ioFactory() {
      queueMicrotask(() => fakeSocket._connect());
      return fakeSocket;
    }
  });

  await sink.open();
  const result = await sink.write({
    sessionId: 'session-1',
    localId: 'codex:t:9:def',
    message: { role: 'user', content: { type: 'text', text: 'retry me' } }
  });
  await sink.close();

  assert.deepEqual(result, { inserted: false, reason: 'stale-generation' });
});

test('socket sink sends metadata updates through the live HAPI socket', async () => {
  const emitted = [];
  const fakeSocket = {
    connected: false,
    on(event, handler) {
      if (event === 'connect') this._connect = handler;
      return this;
    },
    emit(event, payload, cb) {
      emitted.push({ event, payload });
      if (event === 'update-metadata') {
        cb?.({ result: 'success', version: 3, metadata: payload.metadata });
      } else {
        cb?.({ ok: true });
      }
    },
    disconnect() {}
  };

  const sink = createCliMessageSink({
    hubUrl: 'http://127.0.0.1:3006',
    token: 'secret:default',
    sessionId: 'session-1',
    generation: 7,
    ioFactory() {
      queueMicrotask(() => fakeSocket._connect());
      return fakeSocket;
    }
  });

  await sink.open();
  const result = await sink.updateMetadata({
    sid: 'session-1',
    expectedVersion: 2,
    metadata: { path: '/tmp/project', host: 'mac', title: 'Codex Desktop Thread Title' }
  });
  await sink.close();

  const update = emitted.find((entry) => entry.event === 'update-metadata');
  assert.deepEqual(update.payload, {
    sid: 'session-1',
    expectedVersion: 2,
    metadata: { path: '/tmp/project', host: 'mac', title: 'Codex Desktop Thread Title' }
  });
  assert.deepEqual(result, {
    result: 'success',
    version: 3,
    metadata: { path: '/tmp/project', host: 'mac', title: 'Codex Desktop Thread Title' }
  });
});
