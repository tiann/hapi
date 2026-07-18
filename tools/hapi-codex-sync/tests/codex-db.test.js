const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getCodexThread, updateCodexThreadTitle } = require('../src/codex-db');

test('reads Codex thread rollout path from state sqlite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-db-test-'));
  const dbPath = path.join(dir, 'state_5.sqlite');
  execFileSync('sqlite3', [dbPath, `
    create table threads (id text primary key, rollout_path text not null, title text not null, cwd text not null, updated_at_ms integer not null);
    insert into threads (id, rollout_path, title, cwd, updated_at_ms) values ('thread-1','/tmp/rollout.jsonl','Title','/tmp/project',1234);
  `]);
  assert.deepEqual(getCodexThread(dbPath, 'thread-1'), {
    id: 'thread-1',
    rolloutPath: '/tmp/rollout.jsonl',
    title: 'Title',
    cwd: '/tmp/project',
    updatedAtMs: 1234
  });
  assert.equal(getCodexThread(dbPath, 'missing'), null);
});

test('prefers the latest Codex desktop thread name from session_index.jsonl', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-db-test-'));
  const dbPath = path.join(dir, 'state_5.sqlite');
  const sessionIndexPath = path.join(dir, 'session_index.jsonl');
  execFileSync('sqlite3', [dbPath, `
    create table threads (id text primary key, rollout_path text not null, title text not null, cwd text not null, updated_at_ms integer not null);
    insert into threads (id, rollout_path, title, cwd, updated_at_ms) values ('thread-1','/tmp/rollout.jsonl','SQLite Title','/tmp/project',1000);
  `]);
  fs.writeFileSync(sessionIndexPath, [
    JSON.stringify({ id: 'thread-1', thread_name: 'Desktop App Title', updated_at: '2026-04-19T10:16:17.131288Z' }),
    ''
  ].join('\n'));

  assert.deepEqual(getCodexThread(dbPath, 'thread-1'), {
    id: 'thread-1',
    rolloutPath: '/tmp/rollout.jsonl',
    title: 'Desktop App Title',
    cwd: '/tmp/project',
    updatedAtMs: 1776593777131
  });
});

test('writes a Codex thread title when the existing title is null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-db-test-'));
  const dbPath = path.join(dir, 'state_5.sqlite');
  execFileSync('sqlite3', [dbPath, `
    create table threads (
      id text primary key,
      rollout_path text,
      title text,
      cwd text,
      updated_at integer,
      updated_at_ms integer
    );
    insert into threads (id, rollout_path, title, cwd, updated_at, updated_at_ms)
    values ('thread-1','/tmp/rollout.jsonl',null,'/tmp/project',0,0);
  `]);

  assert.deepEqual(updateCodexThreadTitle(dbPath, 'thread-1', 'First Shared Title', 12345), {
    changed: true
  });

  const rows = JSON.parse(execFileSync('sqlite3', ['-json', dbPath, `
    select title, updated_at, updated_at_ms from threads where id = 'thread-1';
  `], { encoding: 'utf8' }));
  assert.deepEqual(rows, [{
    title: 'First Shared Title',
    updated_at: 12,
    updated_at_ms: 12345
  }]);

  const sessionIndexLines = fs.readFileSync(path.join(dir, 'session_index.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(sessionIndexLines, [{
    id: 'thread-1',
    thread_name: 'First Shared Title',
    updated_at: '1970-01-01T00:00:12.345Z'
  }]);
});
