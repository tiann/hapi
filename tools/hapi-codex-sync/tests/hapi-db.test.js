const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findHapiSessionByCodexId, updateSessionMetadata, insertMessageIfMissing, sqlString } = require('../src/hapi-db');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hapi-db-test-'));
  const dbPath = path.join(dir, 'hapi.db');
  execFileSync('sqlite3', [dbPath, `
    create table sessions (
      id text primary key,
      tag text,
      namespace text not null default 'default',
      machine_id text,
      created_at integer not null,
      updated_at integer not null,
      metadata text,
      metadata_version integer default 1,
      agent_state text,
      agent_state_version integer default 1,
      model text,
      model_reasoning_effort text,
      effort text,
      todos text,
      todos_updated_at integer,
      team_state text,
      team_state_updated_at integer,
      active integer default 0,
      active_at integer,
      seq integer default 0
    );
    create table messages (
      id text primary key,
      session_id text not null,
      content text not null,
      created_at integer not null,
      seq integer not null,
      local_id text,
      foreign key (session_id) references sessions(id) on delete cascade
    );
    create unique index idx_messages_local_id on messages(session_id, local_id) where local_id is not null;
    insert into sessions (id,tag,namespace,created_at,updated_at,metadata,seq)
    values ('hapi-1','tag-1','default',1000,1000,'{"codexSessionId":"codex-1","path":"/tmp/project","flavor":"codex"}',0);
  `]);
  return dbPath;
}

test('finds HAPI session by metadata.codexSessionId', () => {
  const dbPath = tempDb();
  const session = findHapiSessionByCodexId(dbPath, 'codex-1');
  assert.equal(session.id, 'hapi-1');
  assert.equal(session.seq, 0);
  assert.equal(session.metadata.path, '/tmp/project');
});

test('findHapiSessionByCodexId returns the newest canonical session with generation metadata', () => {
  const dbPath = tempDb();
  execFileSync('sqlite3', [dbPath, `
    insert into sessions (id,tag,namespace,created_at,updated_at,metadata,seq,active,active_at)
    values ('hapi-2','tag-2','default',1100,2100,'{"codexSessionId":"codex-1","path":"/tmp/project","flavor":"codex","executionControl":{"owner":"hapi-runner","generation":3,"leaseExpiresAt":9999,"runnerSessionId":"hapi-2","updatedAt":2100}}',5,1,2100);
  `]);

  const session = findHapiSessionByCodexId(dbPath, 'codex-1');
  assert.equal(session.id, 'hapi-2');
  assert.equal(session.metadata.executionControl.generation, 3);
  assert.equal(session.metadata.executionControl.owner, 'hapi-runner');
});

test('updates session metadata with optimistic version check', () => {
  const dbPath = tempDb();
  const result = updateSessionMetadata(dbPath, 'hapi-1', {
    codexSessionId: 'codex-1',
    path: '/tmp/project',
    flavor: 'codex',
    title: 'Codex Desktop Thread Title'
  }, 1);

  assert.equal(result.result, 'success');
  assert.equal(result.version, 2);
  assert.equal(result.metadata.title, 'Codex Desktop Thread Title');

  const stale = updateSessionMetadata(dbPath, 'hapi-1', {
    codexSessionId: 'codex-1',
    path: '/tmp/project',
    flavor: 'codex',
    title: 'Stale Title'
  }, 1);

  assert.equal(stale.result, 'version-mismatch');
  assert.equal(stale.version, 2);
  assert.equal(stale.metadata.title, 'Codex Desktop Thread Title');
});

test('inserts message idempotently and updates session seq and updated_at', () => {
  const dbPath = tempDb();
  const first = insertMessageIfMissing(dbPath, {
    sessionId: 'hapi-1',
    localId: 'codex:codex-1:2:abc',
    createdAt: 2000,
    message: { role: 'user', content: { type: 'text', text: 'hello' } }
  });
  const second = insertMessageIfMissing(dbPath, {
    sessionId: 'hapi-1',
    localId: 'codex:codex-1:2:abc',
    createdAt: 2000,
    message: { role: 'user', content: { type: 'text', text: 'hello' } }
  });

  assert.deepEqual(first, { inserted: true, seq: 1 });
  assert.deepEqual(second, { inserted: false, seq: 1 });

  const rows = JSON.parse(execFileSync('sqlite3', ['-json', dbPath, "select session_id,seq,local_id,content from messages"]).toString());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, 'hapi-1');
  assert.equal(rows[0].seq, 1);

  const session = JSON.parse(execFileSync('sqlite3', ['-json', dbPath, "select seq,updated_at from sessions where id='hapi-1'"]).toString())[0];
  assert.equal(session.seq, 1);
  assert.equal(session.updated_at, 2000);
});


test('skips semantic duplicate message even when local_id differs', () => {
  const dbPath = tempDb();
  const first = insertMessageIfMissing(dbPath, {
    sessionId: 'hapi-1',
    localId: null,
    createdAt: 3000,
    message: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'same' } }, meta: { sentFrom: 'webapp' } }
  });
  const second = insertMessageIfMissing(dbPath, {
    sessionId: 'hapi-1',
    localId: 'codex:codex-1:99:def',
    createdAt: 3000,
    message: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'same' } } }
  });

  assert.equal(first.inserted, true);
  assert.deepEqual(second, { inserted: false, seq: 1 });
  const rows = JSON.parse(execFileSync('sqlite3', ['-json', dbPath, 'select count(*) as n from messages']).toString());
  assert.equal(rows[0].n, 1);
});

test('dedupes nearby assistant final answer replay when live copy omitted phase', () => {
  const dbPath = tempDb();
  const first = insertMessageIfMissing(dbPath, {
    sessionId: 'hapi-1',
    localId: null,
    createdAt: 4000,
    message: {
      role: 'agent',
      content: { type: 'codex', data: { type: 'message', message: 'same final answer' } },
      meta: { sentFrom: 'cli' }
    }
  }, {
    agentTextDuplicate: true,
    agentTextDuplicateWindowMs: 2000
  });
  const second = insertMessageIfMissing(dbPath, {
    sessionId: 'hapi-1',
    localId: 'codex:codex-1:99:def',
    createdAt: 5000,
    message: {
      role: 'agent',
      content: { type: 'codex', data: { type: 'message', message: 'same final answer', phase: 'final_answer' } }
    }
  }, {
    agentTextDuplicate: true,
    agentTextDuplicateWindowMs: 2000
  });

  assert.equal(first.inserted, true);
  assert.deepEqual(second, { inserted: false, seq: 1 });
  const rows = JSON.parse(execFileSync('sqlite3', ['-json', dbPath, 'select count(*) as n from messages']).toString());
  assert.equal(rows[0].n, 1);
});

test('dedupes nearby assistant commentary replay when live copy omitted phase', () => {
  const dbPath = tempDb();
  const first = insertMessageIfMissing(dbPath, {
    sessionId: 'hapi-1',
    localId: null,
    createdAt: 4000,
    message: {
      role: 'agent',
      content: { type: 'codex', data: { type: 'message', message: 'same commentary line' } },
      meta: { sentFrom: 'cli' }
    }
  }, {
    agentTextDuplicate: true,
    agentTextDuplicateWindowMs: 2000
  });
  const second = insertMessageIfMissing(dbPath, {
    sessionId: 'hapi-1',
    localId: 'codex:codex-1:100:ghi',
    createdAt: 5000,
    message: {
      role: 'agent',
      content: { type: 'codex', data: { type: 'message', message: 'same commentary line', phase: 'commentary' } }
    }
  }, {
    agentTextDuplicate: true,
    agentTextDuplicateWindowMs: 2000
  });

  assert.equal(first.inserted, true);
  assert.deepEqual(second, { inserted: false, seq: 1 });
  const rows = JSON.parse(execFileSync('sqlite3', ['-json', dbPath, 'select count(*) as n from messages']).toString());
  assert.equal(rows[0].n, 1);
});

test('dedupes delayed assistant replay against recent non-desktop HAPI runner copy', () => {
  const dbPath = tempDb();
  execFileSync('sqlite3', [dbPath, `
    insert into messages (id, session_id, content, created_at, seq, local_id)
    values (
      'runner-copy',
      'hapi-1',
      '{"role":"agent","content":{"type":"codex","data":{"type":"message","message":"delayed same answer"}},"meta":{"sentFrom":"cli"}}',
      4000,
      1,
      null
    );
    update sessions set seq = 1 where id = 'hapi-1';
  `]);
  const second = insertMessageIfMissing(dbPath, {
    sessionId: 'hapi-1',
    localId: 'codex:codex-1:120:delayed',
    createdAt: 25000,
    message: {
      role: 'agent',
      content: { type: 'codex', data: { type: 'message', message: 'delayed same answer', phase: 'final_answer' } }
    }
  }, {
    nonDesktopAgentTextDuplicateWindowMs: 30000,
    agentTextDuplicate: true,
    agentTextDuplicateWindowMs: 2000
  });

  assert.deepEqual(second, { inserted: false, seq: 1 });
  const rows = JSON.parse(execFileSync('sqlite3', ['-json', dbPath, 'select count(*) as n from messages']).toString());
  assert.equal(rows[0].n, 1);
});

test('dedupes assistant replay that only appends a memory citation block', () => {
  const dbPath = tempDb();
  const hapiRunnerText = [
    '已开始按 `superpowers:brainstorming` 做设计，不写代码、不改 live 配置。',
    '',
    '推荐选：**是**。这样最利于版本隔离、回滚和未来 OpenClaw 升级稳定。'
  ].join('\n');
  const desktopReplayText = `${hapiRunnerText}\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:937-943|note=[OpenClaw voice provider history]\n</citation_entries>\n<rollout_ids>\n019d9fe2-c00a-7dd0-8681-8dd3583d2071\n</rollout_ids>\n</oai-mem-citation>`;
  execFileSync('sqlite3', [dbPath, `
    insert into messages (id, session_id, content, created_at, seq, local_id)
    values (
      'runner-memory-citation-copy',
      'hapi-1',
      ${sqlString(JSON.stringify({
        role: 'agent',
        content: { type: 'codex', data: { type: 'message', message: hapiRunnerText } },
        meta: { sentFrom: 'cli' }
      }))},
      4000,
      1,
      null
    );
    update sessions set seq = 1 where id = 'hapi-1';
  `]);
  const result = insertMessageIfMissing(dbPath, {
    sessionId: 'hapi-1',
    localId: 'codex:codex-1:121:memory-citation',
    createdAt: 5000,
    message: {
      role: 'agent',
      content: { type: 'codex', data: { type: 'message', message: desktopReplayText, phase: 'final_answer' } }
    }
  }, {
    nonDesktopAgentTextDuplicateWindowMs: 30000,
    agentTextDuplicate: true,
    agentTextDuplicateWindowMs: 2000
  });

  assert.deepEqual(result, { inserted: false, seq: 1 });
  const rows = JSON.parse(execFileSync('sqlite3', ['-json', dbPath, 'select count(*) as n from messages']).toString());
  assert.equal(rows[0].n, 1);
});
