const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBindingChange } = require('../src/session-binding');

test('rotates the watcher sink when there is no current binding yet', () => {
  assert.deepEqual(
    resolveBindingChange(
      null,
      { sessionId: 'session-1', generation: 1 }
    ),
    { changed: true, next: { sessionId: 'session-1', generation: 1 } }
  );
});

test('reports changed when no current binding exists', () => {
  assert.deepEqual(
    resolveBindingChange(
      null,
      { sessionId: 'session-runner', generation: 2 }
    ),
    { changed: true, next: { sessionId: 'session-runner', generation: 2 } }
  );
});

test('rotates the watcher sink when the canonical session id changes', () => {
  assert.deepEqual(
    resolveBindingChange(
      { sessionId: 'session-1', generation: 1 },
      { sessionId: 'session-runner', generation: 2 }
    ),
    { changed: true, next: { sessionId: 'session-runner', generation: 2 } }
  );
});

test('reports changed when generation differs', () => {
  assert.deepEqual(
    resolveBindingChange(
      { sessionId: 'session-runner', generation: 2 },
      { sessionId: 'session-runner', generation: 3 }
    ),
    { changed: true, next: { sessionId: 'session-runner', generation: 3 } }
  );
});

test('rotates the watcher sink when the canonical generation changes', () => {
  assert.deepEqual(
    resolveBindingChange(
      { sessionId: 'session-runner', generation: 2 },
      { sessionId: 'session-runner', generation: 3 }
    ),
    { changed: true, next: { sessionId: 'session-runner', generation: 3 } }
  );
});

test('keeps the current sink when the canonical binding is unchanged', () => {
  assert.deepEqual(
    resolveBindingChange(
      { sessionId: 'session-runner', generation: 2 },
      { sessionId: 'session-runner', generation: 2 }
    ),
    { changed: false, next: { sessionId: 'session-runner', generation: 2 } }
  );
});
