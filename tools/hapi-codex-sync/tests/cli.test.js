const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseArgs,
  runWatchIteration,
  runWatchAllIteration,
  DEFAULT_HAPI_DB,
  DEFAULT_CODEX_DB,
  DEFAULT_HAPI_SETTINGS,
  DEFAULT_STATE_FILE
} = require('../src/cli');

test('parses import-file args with defaults', () => {
  assert.deepEqual(parseArgs(['import-file', '--thread-id', 't1', '--file', '/tmp/a.jsonl']), {
    command: 'import-file',
    threadId: 't1',
    file: '/tmp/a.jsonl',
    hapiDb: DEFAULT_HAPI_DB,
    codexDb: DEFAULT_CODEX_DB,
    hapiSettings: DEFAULT_HAPI_SETTINGS,
    hubUrl: 'http://127.0.0.1:3006',
    stateFile: DEFAULT_STATE_FILE,
    namespace: 'default',
    delivery: 'db',
    mode: 'all',
    fromLine: 1,
    intervalMs: 1000,
    startAt: 'end',
    maxBackoffMs: 30000,
    minEventAgeMs: 0,
    watchAllMaxAgeMs: 30 * 60 * 1000
  });
});

test('parses import-thread and watch args', () => {
  assert.equal(parseArgs(['import-thread', '--thread-id', 't1', '--from-line', '9']).fromLine, 9);
  const watch = parseArgs(['watch', '--thread-id', 't1', '--interval-ms', '2500']);
  assert.equal(watch.command, 'watch');
  assert.equal(watch.intervalMs, 2500);
});

test('parses watch-all without a thread id and defaults to safe end baseline', () => {
  const opts = parseArgs(['watch-all', '--delivery', 'socket', '--mode', 'assistant-only']);
  assert.equal(opts.command, 'watch-all');
  assert.equal(opts.threadId, undefined);
  assert.equal(opts.delivery, 'socket');
  assert.equal(opts.mode, 'assistant-only');
  assert.equal(opts.startAt, 'end');
  assert.equal(opts.watchAllMaxAgeMs, 30 * 60 * 1000);
});

test('parses watch-all max age override', () => {
  const opts = parseArgs(['watch-all', '--watch-all-max-age-ms', '0']);
  assert.equal(opts.watchAllMaxAgeMs, 0);
  assert.throws(() => parseArgs(['watch-all', '--watch-all-max-age-ms', '-1']), /--watch-all-max-age-ms/);
});

test('throws for missing required args', () => {
  assert.throws(() => parseArgs(['import-file', '--thread-id', 't1']), /--file is required/);
  assert.throws(() => parseArgs(['import-thread']), /--thread-id is required/);
  assert.doesNotThrow(() => parseArgs(['watch-all']));
});

test('parses live socket delivery options', () => {
  const opts = parseArgs(['watch', '--thread-id', 'abc', '--delivery', 'socket', '--hub-url', 'http://127.0.0.1:3006', '--namespace', 'default', '--mode', 'user-only']);
  assert.equal(opts.delivery, 'socket');
  assert.equal(opts.hubUrl, 'http://127.0.0.1:3006');
  assert.equal(opts.namespace, 'default');
  assert.equal(opts.mode, 'user-only');
});

test('throws for invalid mode', () => {
  assert.throws(() => parseArgs(['watch', '--thread-id', 'abc', '--mode', 'tools-only']), /--mode must be all, user-only, or assistant-only/);
});

test('watch-all runs each discovered HAPI Codex session with independent cursors', async () => {
  const opened = [];
  const imports = [];
  const opts = {
    command: 'watch-all',
    codexDb: '/tmp/codex.db',
    hapiDb: '/tmp/hapi.db',
    hapiSettings: '/tmp/settings.json',
    hubUrl: 'http://127.0.0.1:3006',
    namespace: 'default',
    delivery: 'socket',
    mode: 'assistant-only',
    fromLine: 1,
    startAt: 'from-line',
    intervalMs: 1000
  };

  const result = await runWatchAllIteration(opts, {
    threads: {
      'thread-2': { fromLine: 7 }
    }
  }, {
    listSessions() {
      return [
        { id: 'session-1', codexSessionId: 'thread-1', metadata: { executionControl: { generation: 1 } } },
        { id: 'session-2', codexSessionId: 'thread-2', metadata: { executionControl: { generation: 2 } } }
      ];
    },
    getThread(_dbPath, threadId) {
      return {
        id: threadId,
        rolloutPath: `/tmp/${threadId}.jsonl`,
        title: `${threadId} title`,
        updatedAtMs: 1000
      };
    },
    findSession(_dbPath, threadId) {
      return {
        id: threadId === 'thread-1' ? 'session-1' : 'session-2',
        metadata_version: 1,
        metadata: { executionControl: { generation: threadId === 'thread-1' ? 1 : 2 } }
      };
    },
    readToken() {
      return 'secret:default';
    },
    createSink({ sessionId, generation }) {
      return {
        async open() {
          opened.push({ sessionId, generation });
        },
        async close() {},
        async updateMetadata() {
          return { result: 'success' };
        }
      };
    },
    async importWithSink(args) {
      imports.push({ threadId: args.threadId, fromLine: args.fromLine, mode: args.mode });
      return {
        read: 2,
        converted: 1,
        inserted: 1,
        skipped: 1,
        missingSession: false
      };
    }
  });

  assert.deepEqual(opened, [
    { sessionId: 'session-1', generation: 1 },
    { sessionId: 'session-2', generation: 2 }
  ]);
  assert.deepEqual(imports, [
    { threadId: 'thread-1', fromLine: 1, mode: 'assistant-only' },
    { threadId: 'thread-2', fromLine: 7, mode: 'assistant-only' }
  ]);
  assert.equal(result.threads['thread-1'].fromLine, 3);
  assert.equal(result.threads['thread-2'].fromLine, 9);
  assert.equal(result.reports.length, 2);
});

test('watch-all skips stale sessions while keeping recent, live, and recently-written rollout threads', async () => {
  const imports = [];
  const opts = {
    command: 'watch-all',
    codexDb: '/tmp/codex.db',
    hapiDb: '/tmp/hapi.db',
    delivery: 'db',
    mode: 'assistant-only',
    fromLine: 1,
    startAt: 'from-line',
    intervalMs: 1000,
    minEventAgeMs: 0,
    watchAllMaxAgeMs: 1000
  };
  const sessions = [
    { id: 'recent-session', codexSessionId: 'recent-thread', updated_at: 9500, metadata: { codexSessionId: 'recent-thread' } },
    { id: 'stale-session', codexSessionId: 'stale-thread', updated_at: 100, metadata: { codexSessionId: 'stale-thread' } },
    { id: 'rollout-session', codexSessionId: 'rollout-thread', updated_at: 100, metadata: { codexSessionId: 'rollout-thread' } },
    { id: 'live-session', codexSessionId: 'live-thread', updated_at: 100, metadata: { codexSessionId: 'live-thread' } }
  ];

  const result = await runWatchAllIteration(opts, {
    threads: {
      'rollout-thread': { rolloutPath: '/tmp/rollout-thread.jsonl' }
    }
  }, {
    now: () => 10000,
    listSessions() {
      return sessions;
    },
    getThread(_dbPath, threadId) {
      return {
        id: threadId,
        rolloutPath: `/tmp/${threadId}.jsonl`,
        title: null,
        updatedAtMs: 0
      };
    },
    getFileMtimeMs(filePath) {
      return filePath.includes('rollout-thread') ? 9500 : 100;
    },
    getLiveThreadIds() {
      return new Set(['live-thread']);
    },
    getByteOffsetForLine() {
      return 0;
    },
    findSession(_dbPath, threadId) {
      const session = sessions.find((item) => item.codexSessionId === threadId);
      return {
        id: session.id,
        metadata_version: 1,
        metadata: { codexSessionId: threadId }
      };
    },
    importDirect(args) {
      imports.push(args.threadId);
      return {
        read: 1,
        converted: 1,
        inserted: 0,
        skipped: 1,
        missingSession: false,
        nextFromLine: args.fromLine + 1,
        nextByteOffset: 0
      };
    }
  });

  assert.deepEqual(imports, ['recent-thread', 'rollout-thread', 'live-thread']);
  assert.equal(result.threads['stale-thread'], undefined);
  assert.equal(result.reports.length, 3);
});

test('watch iteration rotates the socket sink on generation changes and respects nextFromLine retries', async () => {
  const opened = [];
  const closed = [];
  const sinks = [];
  let generation = 1;
  const opts = {
    threadId: 'abc',
    hapiDb: '/tmp/hapi.db',
    hapiSettings: '/tmp/settings.json',
    hubUrl: 'http://127.0.0.1:3006',
    namespace: 'default',
    delivery: 'socket',
    mode: 'all',
    fromLine: 1
  };

  const deps = {
    findSession() {
      return {
        id: 'session-1',
        metadata: { executionControl: { generation } }
      };
    },
    readToken() {
      return 'secret:default';
    },
    createSink({ sessionId, generation: sinkGeneration }) {
      const sink = {
        async open() {
          opened.push({ sessionId, generation: sinkGeneration });
        },
        async close() {
          closed.push({ sessionId, generation: sinkGeneration });
        }
      };
      sinks.push(sink);
      return sink;
    },
    async importWithSink() {
      return {
        read: 3,
        converted: 2,
        inserted: 1,
        skipped: 1,
        missingSession: false,
        nextFromLine: 3
      };
    }
  };

  const first = await runWatchIteration(
    { ...opts },
    { rolloutPath: '/tmp/rollout.jsonl', currentBinding: null, currentSink: null },
    deps
  );

  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0], { sessionId: 'session-1', generation: 1 });
  assert.equal(first.nextFromLine, 3);
  assert.deepEqual(first.report?.binding, { sessionId: 'session-1', generation: 1 });

  generation = 2;
  const second = await runWatchIteration(
    { ...opts, fromLine: first.nextFromLine },
    { rolloutPath: '/tmp/rollout.jsonl', currentBinding: first.currentBinding, currentSink: first.currentSink },
    deps
  );

  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0], { sessionId: 'session-1', generation: 1 });
  assert.equal(opened.length, 2);
  assert.deepEqual(opened[1], { sessionId: 'session-1', generation: 2 });
  assert.equal(second.nextFromLine, 3);
  assert.deepEqual(second.report?.binding, { sessionId: 'session-1', generation: 2 });
});

test('watch iteration pushes Codex thread title into HAPI metadata over the live socket', async () => {
  const metadataUpdates = [];
  const opts = {
    threadId: 'abc',
    codexDb: '/tmp/codex.db',
    hapiDb: '/tmp/hapi.db',
    hapiSettings: '/tmp/settings.json',
    hubUrl: 'http://127.0.0.1:3006',
    namespace: 'default',
    delivery: 'socket',
    mode: 'all',
    fromLine: 1
  };

  const deps = {
    getThread() {
      return {
        id: 'abc',
        rolloutPath: '/tmp/rollout.jsonl',
        title: 'Codex Desktop Thread Title',
        cwd: '/tmp/project',
        updatedAtMs: 1234
      };
    },
    findSession() {
      return {
        id: 'session-1',
        metadata_version: 4,
        metadata: {
          path: '/tmp/project',
          host: 'mac',
          name: 'Manual HAPI Name',
          mirrorSource: 'codex-desktop-sync',
          summary: { text: 'Changing summary', updatedAt: 99 },
          executionControl: { generation: 3 }
        }
      };
    },
    readToken() {
      return 'secret:default';
    },
    createSink() {
      return {
        async open() {},
        async close() {},
        async updateMetadata(payload) {
          metadataUpdates.push(payload);
          return { result: 'success', version: 5, metadata: payload.metadata };
        }
      };
    },
    async importWithSink() {
      return {
        read: 0,
        converted: 0,
        inserted: 0,
        skipped: 0,
        missingSession: false,
        nextFromLine: 1
      };
    }
  };

  await runWatchIteration({ ...opts }, { currentBinding: null, currentSink: null }, deps);

  assert.equal(metadataUpdates.length, 1);
  assert.equal(metadataUpdates[0].sid, 'session-1');
  assert.equal(metadataUpdates[0].expectedVersion, 4);
  assert.equal(metadataUpdates[0].metadata.title, 'Codex Desktop Thread Title');
  assert.equal(metadataUpdates[0].metadata.name, undefined);
  assert.equal(metadataUpdates[0].metadata.titleUpdatedAt, 1234);
  assert.deepEqual(metadataUpdates[0].metadata.summary, { text: 'Changing summary', updatedAt: 99 });
});

test('watch iteration writes a newer HAPI title back to the Codex thread instead of overwriting it', async () => {
  const metadataUpdates = [];
  const codexTitleWrites = [];
  const opts = {
    threadId: 'abc',
    codexDb: '/tmp/codex.db',
    hapiDb: '/tmp/hapi.db',
    hapiSettings: '/tmp/settings.json',
    hubUrl: 'http://127.0.0.1:3006',
    namespace: 'default',
    delivery: 'socket',
    mode: 'all',
    fromLine: 1
  };

  const deps = {
    getThread() {
      return {
        id: 'abc',
        rolloutPath: '/tmp/rollout.jsonl',
        title: 'Old Codex Title',
        cwd: '/tmp/project',
        updatedAtMs: 100
      };
    },
    findSession() {
      return {
        id: 'session-1',
        metadata_version: 4,
        metadata: {
          path: '/tmp/project',
          host: 'mac',
          title: 'New HAPI Title',
          titleUpdatedAt: 200,
          mirrorSource: 'codex-desktop-sync',
          executionControl: { generation: 3 }
        }
      };
    },
    readToken() {
      return 'secret:default';
    },
    createSink() {
      return {
        async open() {},
        async close() {},
        async updateMetadata(payload) {
          metadataUpdates.push(payload);
          return { result: 'success', version: 5, metadata: payload.metadata };
        }
      };
    },
    writeThreadTitle(dbPath, threadId, title) {
      codexTitleWrites.push({ dbPath, threadId, title });
      return { changed: true };
    },
    async importWithSink() {
      return {
        read: 0,
        converted: 0,
        inserted: 0,
        skipped: 0,
        missingSession: false,
        nextFromLine: 1
      };
    }
  };

  const iteration = await runWatchIteration({ ...opts }, { currentBinding: null, currentSink: null }, deps);

  assert.deepEqual(codexTitleWrites, [
    { dbPath: '/tmp/codex.db', threadId: 'abc', title: 'New HAPI Title' }
  ]);
  assert.deepEqual(metadataUpdates, []);
  assert.equal(iteration.titleSync.direction, 'hapi-to-codex');
  assert.equal(iteration.titleSync.changed, true);
});
