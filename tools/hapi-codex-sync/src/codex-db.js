const fs = require('node:fs');
const path = require('node:path');
const { sqliteJson, sqlString } = require('./hapi-db');

function normalizeTitle(title) {
  const normalized = typeof title === 'string' ? title.trim() : '';
  return normalized || null;
}

function getSessionIndexPath(dbPath) {
  return path.join(path.dirname(dbPath), 'session_index.jsonl');
}

function parseSessionIndexUpdatedAtMs(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\.(\d{3})\d+Z$/, '.$1Z');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function readSessionIndexThreadName(dbPath, threadId) {
  const sessionIndexPath = getSessionIndexPath(dbPath);
  if (!threadId || !fs.existsSync(sessionIndexPath)) return null;
  try {
    const lines = fs.readFileSync(sessionIndexPath, 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]?.trim();
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.id !== threadId) continue;
      const title = normalizeTitle(parsed.thread_name);
      if (!title) continue;
      return {
        title,
        updatedAtMs: parseSessionIndexUpdatedAtMs(parsed.updated_at) || 0
      };
    }
  } catch {
    return null;
  }
  return null;
}

function getCodexThread(dbPath, threadId) {
  const rows = sqliteJson(dbPath, `
    select id, rollout_path, title, cwd, updated_at_ms
    from threads
    where id = ${sqlString(threadId)}
    limit 1
  `);
  if (rows.length === 0) return null;
  const row = rows[0];
  const sessionIndexTitle = readSessionIndexThreadName(dbPath, threadId);
  return {
    id: row.id,
    rolloutPath: row.rollout_path,
    title: sessionIndexTitle?.title ?? row.title,
    cwd: row.cwd,
    updatedAtMs: sessionIndexTitle?.updatedAtMs ?? row.updated_at_ms
  };
}

function updateCodexThreadTitle(dbPath, threadId, title, nowMs = Date.now()) {
  const normalized = normalizeTitle(title);
  if (!dbPath || !threadId || !normalized) return { changed: false };
  const nowSeconds = Math.floor(nowMs / 1000);
  const rows = sqliteJson(dbPath, `
    update threads
    set title = ${sqlString(normalized)},
        updated_at = ${nowSeconds},
        updated_at_ms = ${nowMs}
    where id = ${sqlString(threadId)}
      and (title is null or title != ${sqlString(normalized)});
    select changes() as changes;
  `);
  const sqliteChanged = Number(rows[0]?.changes || 0) > 0;
  const sessionIndexPath = getSessionIndexPath(dbPath);
  const latestIndexTitle = readSessionIndexThreadName(dbPath, threadId);
  const indexChanged = latestIndexTitle?.title !== normalized;
  if (indexChanged) {
    fs.mkdirSync(path.dirname(sessionIndexPath), { recursive: true });
    fs.appendFileSync(sessionIndexPath, `${JSON.stringify({
      id: threadId,
      thread_name: normalized,
      updated_at: new Date(nowMs).toISOString()
    })}\n`);
  }
  return { changed: sqliteChanged || indexChanged };
}

module.exports = { getCodexThread, updateCodexThreadTitle };
