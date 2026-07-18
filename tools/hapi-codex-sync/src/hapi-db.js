const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

function sqliteJson(dbPath, sql) {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  if (!out) return [];
  return JSON.parse(out);
}

function sqliteExec(dbPath, sql) {
  execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function findHapiSessionByCodexId(dbPath, codexSessionId) {
  const rows = sqliteJson(dbPath, `
    select * from sessions
    where json_extract(metadata, '$.codexSessionId') = ${sqlString(codexSessionId)}
    order by coalesce(active, 0) desc, coalesce(active_at, 0) desc, updated_at desc, created_at desc
    limit 1
  `);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null
  };
}

function listHapiSessionsWithCodexIds(dbPath) {
  const rows = sqliteJson(dbPath, `
    select *
    from sessions
    where json_extract(metadata, '$.codexSessionId') is not null
      and trim(json_extract(metadata, '$.codexSessionId')) != ''
    order by coalesce(active, 0) desc, coalesce(active_at, 0) desc, updated_at desc, created_at desc
  `);
  const seen = new Set();
  const sessions = [];
  for (const row of rows) {
    let metadata = null;
    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : null;
    } catch {
      continue;
    }
    const codexSessionId = typeof metadata?.codexSessionId === 'string' ? metadata.codexSessionId.trim() : '';
    if (!codexSessionId || seen.has(codexSessionId)) continue;
    seen.add(codexSessionId);
    sessions.push({
      ...row,
      metadata,
      codexSessionId
    });
  }
  return sessions;
}

function updateSessionMetadata(dbPath, sessionId, metadata, expectedVersion) {
  const version = Number(expectedVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('expectedVersion must be a positive integer');
  }

  const metadataJson = JSON.stringify(metadata);
  sqliteExec(dbPath, `
    update sessions
    set metadata = ${sqlString(metadataJson)}, metadata_version = metadata_version + 1
    where id = ${sqlString(sessionId)} and metadata_version = ${version};
  `);

  const rows = sqliteJson(dbPath, `
    select metadata, metadata_version
    from sessions
    where id = ${sqlString(sessionId)}
    limit 1
  `);
  if (rows.length === 0) return { result: 'error' };

  const value = rows[0].metadata ? JSON.parse(rows[0].metadata) : null;
  const currentVersion = Number(rows[0].metadata_version || 0);
  if (currentVersion !== version + 1 || JSON.stringify(value) !== metadataJson) {
    return { result: 'version-mismatch', version: currentVersion, metadata: value };
  }

  return { result: 'success', version: currentVersion, metadata: value };
}

function comparableMessage(message) {
  return JSON.stringify({ role: message.role, content: message.content });
}

function findSemanticDuplicate(dbPath, sessionId, createdAt, message) {
  const rows = sqliteJson(dbPath, `
    select seq, content from messages
    where session_id = ${sqlString(sessionId)} and created_at = ${Number(createdAt || 0)}
    order by seq asc
  `);
  const target = comparableMessage(message);
  for (const row of rows) {
    try {
      const existing = JSON.parse(row.content);
      if (comparableMessage(existing) === target) return row.seq;
    } catch {
      // ignore malformed existing messages
    }
  }
  return null;
}

function findUserTextDuplicate(dbPath, sessionId, text, createdAt, windowMs = 120000) {
  if (typeof text !== 'string') return null;
  const created = Number(createdAt || 0);
  const rows = sqliteJson(dbPath, `
    select seq from messages
    where session_id = ${sqlString(sessionId)}
      and json_extract(content, '$.role') = 'user'
      and json_extract(content, '$.content.text') = ${sqlString(text)}
      and abs(created_at - ${created}) <= ${Number(windowMs)}
    order by seq asc
    limit 1
  `);
  return rows.length > 0 ? rows[0].seq : null;
}

function findRecentNonDesktopUserTextDuplicate(dbPath, sessionId, text, createdAt, windowMs = 30000) {
  if (typeof text !== 'string') return null;
  const created = Number(createdAt || 0);
  const rows = sqliteJson(dbPath, `
    select seq from messages
    where session_id = ${sqlString(sessionId)}
      and json_extract(content, '$.role') = 'user'
      and json_extract(content, '$.content.text') = ${sqlString(text)}
      and abs(created_at - ${created}) <= ${Number(windowMs)}
      and (local_id is null or local_id not like 'codex:%')
      and coalesce(json_extract(content, '$.meta.sentFrom'), '') != 'codex-desktop-sync'
    order by seq asc
    limit 1
  `);
  return rows.length > 0 ? rows[0].seq : null;
}

function normalizeAgentTextForDuplicateCheck(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n*<oai-mem-citation>[\s\S]*<\/oai-mem-citation>\s*$/, '')
    .trimEnd();
}

function agentMessageSignature(message) {
  if (!message || message.role !== 'agent') return null;
  const content = message.content;
  if (!content || content.type !== 'codex') return null;
  const data = content.data;
  if (!data || data.type !== 'message' || typeof data.message !== 'string') return null;
  return JSON.stringify({
    message: normalizeAgentTextForDuplicateCheck(data.message),
    phase: typeof data.phase === 'string' ? data.phase : null
  });
}

function parsedAgentMessage(message) {
  if (!message || message.role !== 'agent') return null;
  const content = message.content;
  if (!content || content.type !== 'codex') return null;
  const data = content.data;
  if (!data || data.type !== 'message' || typeof data.message !== 'string') return null;
  return {
    message: normalizeAgentTextForDuplicateCheck(data.message),
    phase: typeof data.phase === 'string' ? data.phase : null
  };
}

function agentMessagesEquivalent(existing, incoming) {
  const left = parsedAgentMessage(existing);
  const right = parsedAgentMessage(incoming);
  if (!left || !right) return false;
  if (left.message !== right.message) return false;
  if (left.phase === right.phase) return true;
  return left.phase === null || right.phase === null;
}

function agentToolSignature(message) {
  if (!message || message.role !== 'agent') return null;
  const content = message.content;
  if (!content || content.type !== 'codex') return null;
  const data = content.data;
  if (!data || !['tool-call', 'tool-call-result'].includes(data.type)) return null;
  if (typeof data.callId !== 'string' || data.callId.length === 0) return null;
  return JSON.stringify({
    type: data.type,
    callId: data.callId
  });
}

function parsedReadyEvent(message) {
  if (!message || message.role !== 'agent') return null;
  const content = message.content;
  if (!content || content.type !== 'event') return null;
  const data = content.data;
  if (!data || data.type !== 'ready') return null;
  return { type: 'ready' };
}

function findAgentTextDuplicate(dbPath, sessionId, message, createdAt, windowMs = 2000) {
  if (!parsedAgentMessage(message)) return null;
  const created = Number(createdAt || 0);
  const rows = sqliteJson(dbPath, `
    select seq, content from messages
    where session_id = ${sqlString(sessionId)}
      and abs(created_at - ${created}) <= ${Number(windowMs)}
    order by seq asc
  `);
  for (const row of rows) {
    try {
      const existing = JSON.parse(row.content);
      if (agentMessagesEquivalent(existing, message)) return row.seq;
    } catch {
      // ignore malformed existing messages
    }
  }
  return null;
}

function findRecentNonDesktopToolDuplicate(dbPath, sessionId, message, createdAt, windowMs = 30000) {
  const signature = agentToolSignature(message);
  if (!signature) return null;
  const created = Number(createdAt || 0);
  const rows = sqliteJson(dbPath, `
    select seq, content from messages
    where session_id = ${sqlString(sessionId)}
      and json_extract(content, '$.role') = 'agent'
      and json_extract(content, '$.content.type') = 'codex'
      and abs(created_at - ${created}) <= ${Number(windowMs)}
      and (local_id is null or local_id not like 'codex:%')
      and coalesce(json_extract(content, '$.meta.sentFrom'), '') != 'codex-desktop-sync'
    order by seq asc
  `);
  for (const row of rows) {
    try {
      const existing = JSON.parse(row.content);
      if (agentToolSignature(existing) === signature) return row.seq;
    } catch {
      // ignore malformed existing messages
    }
  }
  return null;
}

function findRecentNonDesktopAgentTextDuplicate(dbPath, sessionId, message, createdAt, windowMs = 30000) {
  if (!parsedAgentMessage(message)) return null;
  const created = Number(createdAt || 0);
  const rows = sqliteJson(dbPath, `
    select seq, content from messages
    where session_id = ${sqlString(sessionId)}
      and json_extract(content, '$.role') = 'agent'
      and json_extract(content, '$.content.type') = 'codex'
      and json_extract(content, '$.content.data.type') = 'message'
      and abs(created_at - ${created}) <= ${Number(windowMs)}
      and (local_id is null or local_id not like 'codex:%')
      and coalesce(json_extract(content, '$.meta.sentFrom'), '') != 'codex-desktop-sync'
    order by seq asc
  `);
  for (const row of rows) {
    try {
      const existing = JSON.parse(row.content);
      if (agentMessagesEquivalent(existing, message)) return row.seq;
    } catch {
      // ignore malformed existing messages
    }
  }
  return null;
}

function findAgentReadyDuplicate(dbPath, sessionId, message, createdAt, windowMs = 5000) {
  if (!parsedReadyEvent(message)) return null;
  const created = Number(createdAt || 0);
  const rows = sqliteJson(dbPath, `
    select seq, content from messages
    where session_id = ${sqlString(sessionId)}
      and json_extract(content, '$.role') = 'agent'
      and json_extract(content, '$.content.type') = 'event'
      and json_extract(content, '$.content.data.type') = 'ready'
      and abs(created_at - ${created}) <= ${Number(windowMs)}
    order by seq asc
    limit 1
  `);
  return rows.length > 0 ? rows[0].seq : null;
}

function messageAlreadyStored(dbPath, sessionId, localId, createdAt, message, options = {}) {
  const semanticSeq = findSemanticDuplicate(dbPath, sessionId, createdAt, message);
  if (semanticSeq !== null) return true;
  if (options.userTextDuplicate && message?.role === 'user') {
    const textSeq = findUserTextDuplicate(dbPath, sessionId, message?.content?.text, createdAt, options.userTextDuplicateWindowMs);
    if (textSeq !== null) return true;
  }
  if (options.nonDesktopUserTextDuplicateWindowMs && message?.role === 'user') {
    const textSeq = findRecentNonDesktopUserTextDuplicate(
      dbPath,
      sessionId,
      message?.content?.text,
      createdAt,
      options.nonDesktopUserTextDuplicateWindowMs
    );
    if (textSeq !== null) return true;
  }
  if (options.nonDesktopToolDuplicateWindowMs && message?.role === 'agent') {
    const toolSeq = findRecentNonDesktopToolDuplicate(
      dbPath,
      sessionId,
      message,
      createdAt,
      options.nonDesktopToolDuplicateWindowMs
    );
    if (toolSeq !== null) return true;
  }
  if (options.nonDesktopAgentTextDuplicateWindowMs && message?.role === 'agent') {
    const agentTextSeq = findRecentNonDesktopAgentTextDuplicate(
      dbPath,
      sessionId,
      message,
      createdAt,
      options.nonDesktopAgentTextDuplicateWindowMs
    );
    if (agentTextSeq !== null) return true;
  }
  if (options.agentTextDuplicate) {
    const agentSeq = findAgentTextDuplicate(dbPath, sessionId, message, createdAt, options.agentTextDuplicateWindowMs);
    if (agentSeq !== null) return true;
  }
  if (options.agentReadyDuplicate) {
    const readySeq = findAgentReadyDuplicate(dbPath, sessionId, message, createdAt, options.agentReadyDuplicateWindowMs);
    if (readySeq !== null) return true;
  }
  if (!localId) return false;
  const existing = sqliteJson(dbPath, `
    select seq from messages
    where session_id = ${sqlString(sessionId)} and local_id = ${sqlString(localId)}
    limit 1
  `);
  return existing.length > 0;
}

function insertMessageIfMissing(dbPath, { sessionId, localId, createdAt, message }, options = {}) {
  const semanticSeq = findSemanticDuplicate(dbPath, sessionId, createdAt, message);
  if (semanticSeq !== null) {
    return { inserted: false, seq: semanticSeq };
  }
  if (options.userTextDuplicate && message?.role === 'user') {
    const textSeq = findUserTextDuplicate(dbPath, sessionId, message?.content?.text, createdAt, options.userTextDuplicateWindowMs);
    if (textSeq !== null) {
      return { inserted: false, seq: textSeq };
    }
  }
  if (options.nonDesktopUserTextDuplicateWindowMs && message?.role === 'user') {
    const textSeq = findRecentNonDesktopUserTextDuplicate(
      dbPath,
      sessionId,
      message?.content?.text,
      createdAt,
      options.nonDesktopUserTextDuplicateWindowMs
    );
    if (textSeq !== null) {
      return { inserted: false, seq: textSeq };
    }
  }
  if (options.nonDesktopToolDuplicateWindowMs && message?.role === 'agent') {
    const toolSeq = findRecentNonDesktopToolDuplicate(
      dbPath,
      sessionId,
      message,
      createdAt,
      options.nonDesktopToolDuplicateWindowMs
    );
    if (toolSeq !== null) {
      return { inserted: false, seq: toolSeq };
    }
  }
  if (options.nonDesktopAgentTextDuplicateWindowMs && message?.role === 'agent') {
    const agentTextSeq = findRecentNonDesktopAgentTextDuplicate(
      dbPath,
      sessionId,
      message,
      createdAt,
      options.nonDesktopAgentTextDuplicateWindowMs
    );
    if (agentTextSeq !== null) {
      return { inserted: false, seq: agentTextSeq };
    }
  }
  if (options.agentTextDuplicate) {
    const agentSeq = findAgentTextDuplicate(dbPath, sessionId, message, createdAt, options.agentTextDuplicateWindowMs);
    if (agentSeq !== null) {
      return { inserted: false, seq: agentSeq };
    }
  }
  if (options.agentReadyDuplicate) {
    const readySeq = findAgentReadyDuplicate(dbPath, sessionId, message, createdAt, options.agentReadyDuplicateWindowMs);
    if (readySeq !== null) {
      return { inserted: false, seq: readySeq };
    }
  }

  const existing = localId ? sqliteJson(dbPath, `
    select seq from messages
    where session_id = ${sqlString(sessionId)} and local_id = ${sqlString(localId)}
    limit 1
  `) : [];
  if (localId && existing.length > 0) {
    return { inserted: false, seq: existing[0].seq };
  }

  const sessionRows = sqliteJson(dbPath, `select coalesce(seq, 0) as seq from sessions where id = ${sqlString(sessionId)} limit 1`);
  if (sessionRows.length === 0) throw new Error(`HAPI session not found: ${sessionId}`);
  const seq = Number(sessionRows[0].seq || 0) + 1;
  const id = randomUUID();
  const content = JSON.stringify({ ...message, meta: { ...(message.meta || {}), sentFrom: 'codex-desktop-sync' } });
  const now = Number(createdAt || Date.now());

  sqliteExec(dbPath, `
    begin immediate;
    insert into messages (id, session_id, content, created_at, seq, local_id)
    values (${sqlString(id)}, ${sqlString(sessionId)}, ${sqlString(content)}, ${now}, ${seq}, ${sqlString(localId)});
    update sessions
    set seq = max(coalesce(seq, 0), ${seq}), updated_at = max(coalesce(updated_at, 0), ${now})
    where id = ${sqlString(sessionId)};
    commit;
  `);
  return { inserted: true, seq };
}

module.exports = {
  findHapiSessionByCodexId,
  listHapiSessionsWithCodexIds,
  updateSessionMetadata,
  insertMessageIfMissing,
  sqliteJson,
  sqliteExec,
  sqlString,
  comparableMessage,
  findSemanticDuplicate,
  findUserTextDuplicate,
  findRecentNonDesktopUserTextDuplicate,
  findAgentTextDuplicate,
  findRecentNonDesktopAgentTextDuplicate,
  findRecentNonDesktopToolDuplicate,
  findAgentReadyDuplicate,
  messageAlreadyStored
};
