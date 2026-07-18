const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { importRolloutFile } = require('./importer');
const { getCodexThread, updateCodexThreadTitle } = require('./codex-db');
const { findHapiSessionByCodexId, listHapiSessionsWithCodexIds, updateSessionMetadata } = require('./hapi-db');
const { createCliMessageSink } = require('./socket-sink');
const { DEFAULT_HAPI_HOME, readCliApiToken } = require('./hapi-settings');
const { resolveBindingChange } = require('./session-binding');

const DEFAULT_CODEX_HOME = process.env.CODEX_HOME
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(os.homedir(), '.codex');
const DEFAULT_HAPI_DB = path.join(DEFAULT_HAPI_HOME, 'hapi.db');
const DEFAULT_CODEX_DB = path.join(DEFAULT_CODEX_HOME, 'state_5.sqlite');
const DEFAULT_HAPI_SETTINGS = path.join(DEFAULT_HAPI_HOME, 'settings.json');
const DEFAULT_HUB_URL = 'http://127.0.0.1:3006';
const DEFAULT_STATE_FILE = path.join(DEFAULT_HAPI_HOME, 'hapi-codex-sync-state.json');
const DEFAULT_WATCH_ALL_MAX_AGE_MS = 30 * 60 * 1000;
const COMMANDS = ['import-file', 'import-thread', 'watch', 'watch-all', 'status'];
const MODES = ['all', 'user-only', 'assistant-only'];

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.includes(command)) {
    throw new Error('Usage: hapi-codex-sync <import-file|import-thread|watch|watch-all|status> [--thread-id <id>] [--file <rollout.jsonl>] [--from-line <n>] [--delivery db|socket]');
  }
  const opts = {
    command,
    hapiDb: DEFAULT_HAPI_DB,
    codexDb: DEFAULT_CODEX_DB,
    hapiSettings: DEFAULT_HAPI_SETTINGS,
    hubUrl: DEFAULT_HUB_URL,
    stateFile: DEFAULT_STATE_FILE,
    namespace: 'default',
    delivery: 'db',
    mode: 'all',
    fromLine: 1,
    intervalMs: 1000,
    startAt: 'end',
    maxBackoffMs: 30000,
    minEventAgeMs: 0,
    watchAllMaxAgeMs: DEFAULT_WATCH_ALL_MAX_AGE_MS
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = () => {
      const value = rest[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === '--thread-id') opts.threadId = next();
    else if (arg === '--file') opts.file = next();
    else if (arg === '--hapi-db') opts.hapiDb = next();
    else if (arg === '--codex-db') opts.codexDb = next();
    else if (arg === '--hapi-settings') opts.hapiSettings = next();
    else if (arg === '--hub-url') opts.hubUrl = next();
    else if (arg === '--state-file') opts.stateFile = next();
    else if (arg === '--namespace') opts.namespace = next();
    else if (arg === '--delivery') opts.delivery = next();
    else if (arg === '--mode') opts.mode = next();
    else if (arg === '--from-line') opts.fromLine = Number(next());
    else if (arg === '--interval-ms') opts.intervalMs = Number(next());
    else if (arg === '--start-at') opts.startAt = next();
    else if (arg === '--max-backoff-ms') opts.maxBackoffMs = Number(next());
    else if (arg === '--min-event-age-ms') opts.minEventAgeMs = Number(next());
    else if (arg === '--watch-all-max-age-ms') opts.watchAllMaxAgeMs = Number(next());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (['import-file', 'import-thread', 'watch'].includes(command) && !opts.threadId) throw new Error('--thread-id is required');
  if (command === 'import-file' && !opts.file) throw new Error('--file is required for import-file');
  if (!['db', 'socket'].includes(opts.delivery)) throw new Error('--delivery must be db or socket');
  if (!MODES.includes(opts.mode)) throw new Error('--mode must be all, user-only, or assistant-only');
  if (!['end', 'from-line'].includes(opts.startAt)) throw new Error('--start-at must be end or from-line');
  if (!Number.isInteger(opts.fromLine) || opts.fromLine < 1) throw new Error('--from-line must be a positive integer');
  if (!Number.isInteger(opts.intervalMs) || opts.intervalMs < 100) throw new Error('--interval-ms must be an integer >= 100');
  if (!Number.isInteger(opts.maxBackoffMs) || opts.maxBackoffMs < 100) throw new Error('--max-backoff-ms must be an integer >= 100');
  if (!Number.isInteger(opts.minEventAgeMs) || opts.minEventAgeMs < 0) throw new Error('--min-event-age-ms must be an integer >= 0');
  if (!Number.isInteger(opts.watchAllMaxAgeMs) || opts.watchAllMaxAgeMs < 0) throw new Error('--watch-all-max-age-ms must be an integer >= 0');
  return opts;
}

function getRolloutPathForThread(opts) {
  const thread = getCodexThread(opts.codexDb, opts.threadId);
  if (!thread) throw new Error(`Codex thread not found: ${opts.threadId}`);
  return thread.rolloutPath;
}

function normalizeCodexThreadTitle(title) {
  const text = typeof title === 'string' ? title.trim() : '';
  return text.length > 0 ? text : null;
}

function applyCodexThreadTitle(metadata, title) {
  return applyCodexThreadTitleWithTimestamp(metadata, title, undefined);
}

function applyCodexThreadTitleWithTimestamp(metadata, title, titleUpdatedAt) {
  const normalized = normalizeCodexThreadTitle(title);
  if (!normalized) return { changed: false, metadata };
  const current = metadata && typeof metadata === 'object' ? metadata : {};
  const nextTitleUpdatedAt = Number.isFinite(Number(titleUpdatedAt)) ? Number(titleUpdatedAt) : current.titleUpdatedAt;
  const shouldClearName = current.name !== undefined;
  if (
    current.title === normalized
    && !shouldClearName
    && current.titleUpdatedAt === nextTitleUpdatedAt
  ) {
    return { changed: false, metadata: current };
  }
  return {
    changed: true,
    metadata: {
      ...current,
      name: undefined,
      title: normalized,
      ...(Number.isFinite(Number(titleUpdatedAt)) ? { titleUpdatedAt: Number(titleUpdatedAt) } : {})
    }
  };
}

function getHapiMetadataTitle(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  return normalizeCodexThreadTitle(metadata.title ?? metadata.name);
}

function getMetadataTitleUpdatedAt(metadata) {
  const value = Number(metadata?.titleUpdatedAt);
  return Number.isFinite(value) ? value : 0;
}

async function syncCodexThreadTitle({
  hapiDb,
  codexDb,
  session,
  thread,
  sink,
  updateMetadataFn = updateSessionMetadata,
  writeThreadTitleFn = updateCodexThreadTitle
}) {
  const codexTitle = normalizeCodexThreadTitle(thread?.title);
  const hapiTitle = getHapiMetadataTitle(session?.metadata);
  const codexUpdatedAt = Number(thread?.updatedAtMs || 0);
  const hapiUpdatedAt = getMetadataTitleUpdatedAt(session?.metadata);

  if (codexTitle && hapiTitle && codexTitle !== hapiTitle && hapiUpdatedAt > codexUpdatedAt) {
    const result = writeThreadTitleFn(codexDb, thread.id, hapiTitle);
    return {
      changed: Boolean(result?.changed),
      direction: 'hapi-to-codex',
      result
    };
  }

  const titleUpdate = applyCodexThreadTitleWithTimestamp(session?.metadata, thread?.title, thread?.updatedAtMs);
  if (!titleUpdate.changed) return { changed: false };

  const expectedVersion = Number(session?.metadata_version || session?.metadataVersion || 0);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { changed: false, reason: 'missing-metadata-version' };
  }

  if (sink && typeof sink.updateMetadata === 'function') {
    const ack = await sink.updateMetadata({
      sid: session.id,
      metadata: titleUpdate.metadata,
      expectedVersion
    });
    return {
      changed: ack?.result === 'success',
      direction: 'codex-to-hapi',
      result: ack?.result,
      version: ack?.version,
      metadata: ack?.metadata
    };
  }

  const result = updateMetadataFn(hapiDb, session.id, titleUpdate.metadata, expectedVersion);
  return {
    changed: result?.result === 'success',
    direction: 'codex-to-hapi',
    result: result?.result,
    version: result?.version,
    metadata: result?.metadata
  };
}

async function withOptionalSocketSink(opts, fn) {
  if (opts.delivery !== 'socket') return fn(null);
  const session = findHapiSessionByCodexId(opts.hapiDb, opts.threadId);
  if (!session) throw new Error(`HAPI session not found for Codex thread: ${opts.threadId}`);
  const token = readCliApiToken(opts.hapiSettings, opts.namespace);
  const sink = createCliMessageSink({
    hubUrl: opts.hubUrl,
    token,
    sessionId: session.id,
    generation: Number(session.metadata?.executionControl?.generation || 1)
  });
  await sink.open();
  try {
    return await fn(sink);
  } finally {
    await sink.close();
  }
}

async function importThread(opts) {
  const rolloutPath = getRolloutPathForThread(opts);
  return withOptionalSocketSink(opts, (sink) => {
    const args = { hapiDbPath: opts.hapiDb, threadId: opts.threadId, rolloutPath, fromLine: opts.fromLine, mode: opts.mode };
    return sink ? importRolloutFile.withSink({ ...args, sink }) : importRolloutFile(args);
  });
}

async function importFile(opts) {
  const rolloutPath = path.resolve(opts.file);
  return withOptionalSocketSink(opts, (sink) => {
    const args = { hapiDbPath: opts.hapiDb, threadId: opts.threadId, rolloutPath, fromLine: opts.fromLine, mode: opts.mode };
    return sink ? importRolloutFile.withSink({ ...args, sink }) : importRolloutFile(args);
  });
}

async function runWatchIteration(opts, state = {}, deps = {}) {
  const getThread = deps.getThread ?? getCodexThread;
  const shouldReadThread = Boolean(deps.getThread || opts.codexDb);
  const thread = shouldReadThread ? getThread(opts.codexDb, opts.threadId) : null;
  if (shouldReadThread && !thread) throw new Error(`Codex thread not found: ${opts.threadId}`);
  const rolloutPath = state.rolloutPath ?? thread?.rolloutPath ?? getRolloutPathForThread(opts);
  const findSession = deps.findSession ?? findHapiSessionByCodexId;
  const readToken = deps.readToken ?? readCliApiToken;
  const createSink = deps.createSink ?? createCliMessageSink;
  const importWithSink = deps.importWithSink ?? importRolloutFile.withSink;
  const importDirect = deps.importDirect ?? importRolloutFile;
  const updateMetadataFn = deps.updateMetadata ?? updateSessionMetadata;
  const writeThreadTitleFn = deps.writeThreadTitle ?? updateCodexThreadTitle;

  let currentBinding = state.currentBinding ?? null;
  let currentSink = state.currentSink ?? null;

  try {
    const session = findSession(opts.hapiDb, opts.threadId);
    if (!session) throw new Error(`HAPI session not found for Codex thread: ${opts.threadId}`);

    const nextBinding = {
      sessionId: session.id,
      generation: Number(session.metadata?.executionControl?.generation || 1)
    };
    const binding = resolveBindingChange(currentBinding, nextBinding);

    if (binding.changed) {
      await currentSink?.close();
      currentSink = opts.delivery === 'socket'
        ? createSink({
            hubUrl: opts.hubUrl,
            token: readToken(opts.hapiSettings, opts.namespace),
            sessionId: binding.next.sessionId,
            generation: binding.next.generation
          })
        : null;
      await currentSink?.open();
      currentBinding = binding.next;
    }

    const titleSync = thread
      ? await syncCodexThreadTitle({
          hapiDb: opts.hapiDb,
          codexDb: opts.codexDb,
          session,
          thread,
          sink: currentSink,
          updateMetadataFn,
          writeThreadTitleFn
        })
      : { changed: false };

    const args = {
      hapiDbPath: opts.hapiDb,
      threadId: opts.threadId,
      rolloutPath,
      fromLine: opts.fromLine,
      mode: opts.mode,
      maxCreatedAt: opts.minEventAgeMs > 0 ? Date.now() - opts.minEventAgeMs : Infinity,
      fromByteOffset: Number.isInteger(opts.fromByteOffset) && opts.fromByteOffset >= 0 ? opts.fromByteOffset : null
    };
    const stats = currentSink ? await importWithSink({ ...args, sink: currentSink }) : importDirect(args);
    const nextFromLine = Number.isInteger(stats?.nextFromLine) ? stats.nextFromLine : opts.fromLine + stats.read;
    const nextByteOffset = Number.isInteger(stats?.nextByteOffset) ? stats.nextByteOffset : opts.fromByteOffset;
    const report = stats.read > 0
      ? { ...stats, nextFromLine, delivery: opts.delivery, mode: opts.mode, binding: currentBinding, titleSync }
      : null;

    return {
      rolloutPath,
      thread,
      currentBinding,
      currentSink,
      nextFromLine,
      nextByteOffset,
      stats,
      report,
      titleSync
    };
  } catch (error) {
    if (error && typeof error === 'object') {
      error.currentBinding = currentBinding;
      error.currentSink = currentSink;
    }
    throw error;
  }
}

function nextLineAfterFileEnd(filePath, fsImpl = fs) {
  if (!filePath || !fsImpl.existsSync(filePath)) return 1;
  const text = fsImpl.readFileSync(filePath, 'utf8');
  if (!text) return 1;
  const lines = text.split(/\r?\n/);
  return lines.length + (lines[lines.length - 1] === '' ? 0 : 1);
}

function byteOffsetForLine(filePath, targetLine) {
  const line = Number(targetLine || 1);
  if (!filePath || !fs.existsSync(filePath) || line <= 1) return 0;
  const { forEachJsonlLine } = require('./importer');
  let byteOffset = fs.statSync(filePath).size;
  forEachJsonlLine(filePath, (_text, lineNumber, nextByteOffset) => {
    if (lineNumber + 1 >= line) {
      byteOffset = nextByteOffset;
      return false;
    }
    return undefined;
  });
  return byteOffset;
}

function endCursorForFile(filePath) {
  return {
    fromLine: nextLineAfterFileEnd(filePath),
    byteOffset: filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
  };
}

function loadWatchAllState(stateFile) {
  if (!stateFile || !fs.existsSync(stateFile)) return { version: 1, threads: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return {
      version: 1,
      ...parsed,
      threads: parsed && typeof parsed.threads === 'object' && parsed.threads ? parsed.threads : {}
    };
  } catch {
    return { version: 1, threads: {} };
  }
}

function serializableWatchAllState(state) {
  const threads = {};
  for (const [threadId, threadState] of Object.entries(state?.threads || {})) {
    const { currentSink, ...rest } = threadState || {};
    threads[threadId] = {
      ...rest,
      currentSink: undefined
    };
  }
  return {
    version: 1,
    updatedAt: state?.updatedAt,
    threads
  };
}

function saveWatchAllState(stateFile, state) {
  if (!stateFile) return;
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(serializableWatchAllState(state), null, 2)}\n`);
  fs.renameSync(tmp, stateFile);
}

async function closeWatchAllSinks(state) {
  const threads = Object.values(state?.threads || {});
  await Promise.all(threads.map(async (threadState) => {
    try {
      await threadState?.currentSink?.close?.();
    } catch {
      // Best-effort shutdown only.
    }
  }));
}

function backoffDelayMs(opts, failureCount) {
  const exponent = Math.min(Math.max(Number(failureCount || 1), 1) - 1, 5);
  return Math.min(Number(opts.maxBackoffMs || 30000), Number(opts.intervalMs || 1000) * (2 ** exponent));
}

function isRecentMs(value, now, maxAgeMs) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  return timestamp >= now || now - timestamp <= maxAgeMs;
}

function fileMtimeMs(filePath) {
  if (!filePath) return 0;
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function listLiveCodexThreadIdsFromProcessTable() {
  try {
    const output = execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' });
    const ids = new Set();
    for (const line of output.split('\n')) {
      if (!line.includes('hapi-source/cli/src/index.ts codex resume ')) continue;
      const match = line.match(/hapi-source\/cli\/src\/index\.ts codex resume\s+(\S+)/);
      if (match?.[1]) ids.add(match[1]);
    }
    return ids;
  } catch {
    return new Set();
  }
}

function shouldWatchAllSession({ session, thread, now, maxAgeMs, liveThreadIds, getFileMtimeMs }) {
  if (maxAgeMs === undefined || maxAgeMs === null) return true;
  const ageMs = Number(maxAgeMs);
  if (!Number.isFinite(ageMs) || ageMs <= 0) return true;

  if (Number(session?.active || 0) === 1) return true;
  if (isRecentMs(session?.updated_at, now, ageMs)) return true;
  if (isRecentMs(session?.active_at, now, ageMs)) return true;

  const threadId = session?.codexSessionId || session?.metadata?.codexSessionId || thread?.id;
  if (threadId && liveThreadIds?.has?.(threadId)) return true;

  const rolloutPath = thread?.rolloutPath;
  if (rolloutPath && isRecentMs(getFileMtimeMs(rolloutPath), now, ageMs)) return true;

  return false;
}

function shouldConsiderWatchAllSessionBeforeThread({ session, threadState, now, maxAgeMs, liveThreadIds, getFileMtimeMs }) {
  if (maxAgeMs === undefined || maxAgeMs === null) return true;
  const ageMs = Number(maxAgeMs);
  if (!Number.isFinite(ageMs) || ageMs <= 0) return true;

  if (Number(session?.active || 0) === 1) return true;
  if (isRecentMs(session?.updated_at, now, ageMs)) return true;
  if (isRecentMs(session?.active_at, now, ageMs)) return true;

  const threadId = session?.codexSessionId || session?.metadata?.codexSessionId;
  if (threadId && liveThreadIds?.has?.(threadId)) return true;

  if (threadState?.rolloutPath && isRecentMs(getFileMtimeMs(threadState.rolloutPath), now, ageMs)) return true;

  return false;
}

async function runWatchAllIteration(opts, state = {}, deps = {}) {
  const listSessions = deps.listSessions ?? listHapiSessionsWithCodexIds;
  const getThread = deps.getThread ?? getCodexThread;
  const getEndCursor = deps.getEndCursor ?? endCursorForFile;
  const getByteOffsetForLine = deps.getByteOffsetForLine ?? byteOffsetForLine;
  const getFileMtimeMs = deps.getFileMtimeMs ?? fileMtimeMs;
  const getLiveThreadIds = deps.getLiveThreadIds ?? listLiveCodexThreadIdsFromProcessTable;
  const nowFn = deps.now ?? Date.now;
  const now = nowFn();
  const sessions = listSessions(opts.hapiDb);
  const ageFilterEnabled = Number.isFinite(Number(opts.watchAllMaxAgeMs)) && Number(opts.watchAllMaxAgeMs) > 0;
  const liveThreadIds = ageFilterEnabled ? getLiveThreadIds() : new Set();
  const nextState = {
    version: 1,
    ...state,
    updatedAt: now,
    threads: { ...(state.threads || {}) }
  };
  const reports = [];
  const discovered = new Set();

  for (const session of sessions) {
    const threadId = session.codexSessionId || session.metadata?.codexSessionId;
    if (!threadId) continue;
    const existingThreadState = nextState.threads[threadId] || {};
    if (!shouldConsiderWatchAllSessionBeforeThread({
      session,
      threadState: existingThreadState,
      now,
      maxAgeMs: opts.watchAllMaxAgeMs,
      liveThreadIds,
      getFileMtimeMs
    })) {
      continue;
    }

    try {
      const thread = getThread(opts.codexDb, threadId);
      if (!thread) throw new Error(`Codex thread not found: ${threadId}`);
      if (!shouldWatchAllSession({
        session,
        thread,
        now,
        maxAgeMs: opts.watchAllMaxAgeMs,
        liveThreadIds,
        getFileMtimeMs
      })) {
        continue;
      }
      discovered.add(threadId);
      if (Number(existingThreadState.nextAttemptAt || 0) > now) {
        reports.push({
          threadId,
          skipped: true,
          reason: 'backoff',
          nextAttemptAt: existingThreadState.nextAttemptAt
        });
        continue;
      }
      const hasStoredCursor = Number.isInteger(existingThreadState.fromLine) && existingThreadState.fromLine >= 1;
      const endCursor = !hasStoredCursor && opts.startAt === 'end'
        ? getEndCursor(thread.rolloutPath)
        : null;
      const fromLine = hasStoredCursor
        ? existingThreadState.fromLine
        : (endCursor ? endCursor.fromLine : opts.fromLine);
      const hasStoredByteOffset = Number.isInteger(existingThreadState.byteOffset) && existingThreadState.byteOffset >= 0;
      const fromByteOffset = hasStoredByteOffset
        ? existingThreadState.byteOffset
        : (endCursor ? endCursor.byteOffset : getByteOffsetForLine(thread.rolloutPath, fromLine));

      const iteration = await runWatchIteration(
        { ...opts, command: 'watch', threadId, fromLine, fromByteOffset },
        {
          rolloutPath: existingThreadState.rolloutPath ?? thread.rolloutPath,
          currentBinding: existingThreadState.currentBinding ?? null,
          currentSink: existingThreadState.currentSink ?? null
        },
        {
          ...deps,
          getThread: () => thread
        }
      );

      nextState.threads[threadId] = {
        ...existingThreadState,
        rolloutPath: iteration.rolloutPath,
        fromLine: iteration.nextFromLine,
        byteOffset: Number.isInteger(iteration.nextByteOffset) ? iteration.nextByteOffset : fromByteOffset,
        currentBinding: iteration.currentBinding,
        currentSink: iteration.currentSink,
        sessionId: iteration.currentBinding?.sessionId,
        generation: iteration.currentBinding?.generation,
        lastSuccessAt: now,
        lastError: null,
        failureCount: 0,
        nextAttemptAt: 0
      };

      if (iteration.report) {
        reports.push({
          threadId,
          sessionId: iteration.currentBinding?.sessionId,
          ...iteration.report
        });
      }
    } catch (error) {
      const currentSink = error && typeof error === 'object' && error.currentSink
        ? error.currentSink
        : existingThreadState.currentSink;
      try {
        await currentSink?.close?.();
      } catch {
        // Reconnect on the next eligible iteration.
      }
      const failureCount = Number(existingThreadState.failureCount || 0) + 1;
      const nextAttemptAt = now + backoffDelayMs(opts, failureCount);
      nextState.threads[threadId] = {
        ...existingThreadState,
        currentBinding: null,
        currentSink: null,
        lastError: error instanceof Error ? error.message : String(error),
        failureCount,
        nextAttemptAt
      };
      reports.push({
        threadId,
        error: nextState.threads[threadId].lastError,
        failureCount,
        nextAttemptAt
      });
    }
  }

  for (const [threadId, threadState] of Object.entries(nextState.threads)) {
    if (discovered.has(threadId)) continue;
    await threadState?.currentSink?.close?.();
    nextState.threads[threadId] = {
      ...threadState,
      currentSink: null,
      inactiveAt: now
    };
  }

  return { ...nextState, reports };
}

async function watchThread(opts, onStats = (stats) => console.log(JSON.stringify(stats))) {
  let state = {
    rolloutPath: getRolloutPathForThread(opts),
    currentBinding: null,
    currentSink: null
  };

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const iteration = await runWatchIteration(opts, state);
      state = {
        rolloutPath: iteration.rolloutPath,
        currentBinding: iteration.currentBinding,
        currentSink: iteration.currentSink
      };
      if (iteration.report) {
        opts.fromLine = iteration.nextFromLine;
        onStats(iteration.report);
      }
      await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
    }
  } finally {
    await state.currentSink?.close();
  }
}

async function watchAll(opts, onStats = (stats) => console.log(JSON.stringify(stats))) {
  let state = loadWatchAllState(opts.stateFile);
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const iteration = await runWatchAllIteration(opts, state);
      state = iteration;
      saveWatchAllState(opts.stateFile, state);
      const reports = iteration.reports || [];
      if (reports.length > 0) {
        onStats({
          command: 'watch-all',
          delivery: opts.delivery,
          mode: opts.mode,
          reports
        });
      }
      await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
    }
  } finally {
    await closeWatchAllSinks(state);
  }
}

function status(opts) {
  return serializableWatchAllState(loadWatchAllState(opts.stateFile));
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.command === 'import-file') return importFile(opts);
  if (opts.command === 'import-thread') return importThread(opts);
  if (opts.command === 'watch') return watchThread(opts);
  if (opts.command === 'watch-all') return watchAll(opts);
  if (opts.command === 'status') {
    const result = status(opts);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  throw new Error(`Unsupported command: ${opts.command}`);
}

module.exports = {
  parseArgs,
  main,
  importThread,
  importFile,
  runWatchIteration,
  runWatchAllIteration,
  watchThread,
  watchAll,
  status,
  DEFAULT_HAPI_DB,
  DEFAULT_CODEX_DB,
  DEFAULT_HAPI_SETTINGS,
  DEFAULT_HUB_URL,
  DEFAULT_STATE_FILE,
  nextLineAfterFileEnd,
  byteOffsetForLine,
  endCursorForFile,
  loadWatchAllState,
  saveWatchAllState,
  serializableWatchAllState,
  normalizeCodexThreadTitle,
  applyCodexThreadTitle,
  syncCodexThreadTitle
};
