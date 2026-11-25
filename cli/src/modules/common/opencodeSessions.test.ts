import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// bun:sqlite is only resolvable under the Bun runtime, while the unit suite
// runs on node (vitest). Mirror the agy modules' approach: the production
// module lazy-imports bun:sqlite, and these tests drive the real module +
// a real sqlite db inside a `bun` subprocess, asserting on its JSON output.

const RUNNER = /* ts */ `
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import {
    getOpencodeDbPath,
    listLocalOpencodeSessionSummaries,
    listLocalOpencodeSessionsWithMessagesByIds
} from './opencodeSessions'

function createDb(root) {
    const db = new Database(join(root, 'opencode.db'))
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated REAL, time_archived REAL); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created REAL); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT, time_created REAL);')
    return db
}

function insertMessages(dbPath, messages, parts) {
    const db = new Database(dbPath)
    try {
        for (const m of messages) {
            db.query('INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)')
                .run(m.id, m.sessionId, JSON.stringify({ role: m.role }), m.timeCreated)
        }
        let i = 0
        for (const p of parts) {
            i += 1
            const data = Object.assign(
                { type: p.type },
                p.text === undefined ? {} : { text: p.text },
                p.extra ?? {}
            )
            db.query('INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)')
                .run('part-' + i, p.messageId, JSON.stringify(data), i)
        }
    } finally {
        db.close()
    }
}

// OpenCode v2 storage: session_v2 is a superset of the v1 session table and
// session_message replaces message/part with one row per message. Like the v1
// table, session_v2 tracks archived sessions in time_archived.
function createV2Tables(db) {
    db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, fork_session_id TEXT, fork_boundary INTEGER, slug TEXT, directory TEXT, path TEXT, title TEXT, version TEXT, model TEXT, time_created REAL, time_updated REAL, time_archived REAL); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT, data TEXT, time_created REAL);')
    return db
}

function insertV2Sessions(db, sessions) {
    for (const s of sessions) {
        db.query('INSERT INTO session_v2 (id, project_id, workspace_id, parent_id, fork_session_id, fork_boundary, slug, directory, path, title, version, model, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                s.id,
                s.projectId ?? 'project-1',
                s.workspaceId ?? 'workspace-1',
                s.parentId ?? null,
                s.forkSessionId ?? null,
                s.forkBoundary ?? null,
                s.slug ?? 'slug-' + s.id,
                s.directory ?? null,
                s.path ?? '/tmp/' + s.id,
                s.title ?? null,
                s.version ?? '2.2.7',
                s.model ?? null,
                s.timeCreated ?? 0,
                s.timeUpdated ?? 0,
                s.timeArchived ?? null
            )
    }
}

function insertV2Messages(dbPath, messages) {
    const db = new Database(dbPath)
    try {
        for (const m of messages) {
            db.query('INSERT INTO session_message (id, session_id, seq, type, data, time_created) VALUES (?, ?, ?, ?, ?, ?)')
                .run(m.id, m.sessionId, m.seq, m.type, JSON.stringify(m.data), m.timeCreated)
        }
    } finally {
        db.close()
    }
}

const scenario = process.env.SCENARIO

if (scenario === 'sessions') {
    const root = mkdtempSync(join(tmpdir(), 'opencode-sessions-'))
    process.env.OPENCODE_HOME = root
    const dbPath = join(root, 'opencode.db')
    createDb(root)
    const db = new Database(dbPath)
    db.query('INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)').run('session-1', 'Normal session', '/tmp/project', 2000)
    db.query('INSERT INTO session (id, title, directory, time_updated, time_archived) VALUES (?, ?, ?, ?, ?)').run('session-2', 'Archived session', '/tmp/project', 3000, 4000)
    db.query('INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)').run('session-3', 'Malformed', '/tmp/project', 1000)
    db.close()
    insertMessages(dbPath, [
        { id: 'm1-u', sessionId: 'session-1', role: 'user', timeCreated: 1100 },
        { id: 'm1-a', sessionId: 'session-1', role: 'assistant', timeCreated: 1200 },
        { id: 'm2-u', sessionId: 'session-2', role: 'user', timeCreated: 1400 }
    ], [
        { messageId: 'm1-a', type: 'tool' },
        { messageId: 'm1-u', type: 'text', text: 'hello world' },
        { messageId: 'm1-a', type: 'text', text: 'hi there', extra: { time: { end: 1250 } } },
        { messageId: 'm2-u', type: 'text', text: '<system-reminder>internal</system-reminder>' }
    ])
    {
        const db = new Database(dbPath)
        try {
            // malformed message-data JSON row must be skipped silently
            db.query('INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)')
                .run('m3-u', 'session-3', '{invalid json', 1300)
            db.query('INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)')
                .run('part-m3', 'm3-u', JSON.stringify({ type: 'text', text: 'unreachable' }), 1)
        } finally {
            db.close()
        }
    }
    const summaries = await listLocalOpencodeSessionSummaries()
    const sessions = await listLocalOpencodeSessionsWithMessagesByIds(new Set(['session-1', 'session-2']))
    console.log(JSON.stringify({ summaries, sessions }))
} else if (scenario === 'truncate') {
    const root = mkdtempSync(join(tmpdir(), 'opencode-truncate-'))
    process.env.OPENCODE_HOME = root
    const dbPath = join(root, 'opencode.db')
    createDb(root)
    const db = new Database(dbPath)
    db.query('INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)').run('session-long', 'Long', '/tmp/project', 5000)
    db.close()
    insertMessages(dbPath, [
        { id: 'ml-u', sessionId: 'session-long', role: 'user', timeCreated: 5100 }
    ], [
        { messageId: 'ml-u', type: 'text', text: 'x'.repeat(200) }
    ])
    const summaries = await listLocalOpencodeSessionSummaries()
    console.log(JSON.stringify({ summaries }))
} else if (scenario === 'streaming') {
    const root = mkdtempSync(join(tmpdir(), 'opencode-streaming-'))
    process.env.OPENCODE_HOME = root
    const dbPath = join(root, 'opencode.db')
    createDb(root)
    const db = new Database(dbPath)
    db.query('INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)').run('session-stream', 'Streaming', '/tmp/project', 6000)
    db.close()
    insertMessages(dbPath, [
        { id: 'ms-u', sessionId: 'session-stream', role: 'user', timeCreated: 6100 },
        { id: 'ms-a', sessionId: 'session-stream', role: 'assistant', timeCreated: 6200 }
    ], [
        { messageId: 'ms-u', type: 'text', text: 'question' },
        { messageId: 'ms-a', type: 'text', text: 'finished answer', extra: { time: { end: 6300 } } },
        { messageId: 'ms-a', type: 'text', text: 'partial answer being generated' }
    ])
    const sessions = await listLocalOpencodeSessionsWithMessagesByIds(new Set(['session-stream']))
    console.log(JSON.stringify({ sessions }))
} else if (scenario === 'v1only') {
    const root = mkdtempSync(join(tmpdir(), 'opencode-v1only-'))
    process.env.OPENCODE_HOME = root
    const dbPath = join(root, 'opencode.db')
    createDb(root)
    const db = new Database(dbPath)
    db.query('INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)').run('session-v1', 'V1 only session', '/tmp/v1-project', 5000)
    db.close()
    insertMessages(dbPath, [
        { id: 'v1-u', sessionId: 'session-v1', role: 'user', timeCreated: 5100 },
        { id: 'v1-a', sessionId: 'session-v1', role: 'assistant', timeCreated: 5200 }
    ], [
        { messageId: 'v1-u', type: 'text', text: 'v1 question' },
        { messageId: 'v1-a', type: 'text', text: 'v1 answer', extra: { time: { end: 5300 } } }
    ])
    const summaries = await listLocalOpencodeSessionSummaries()
    const sessions = await listLocalOpencodeSessionsWithMessagesByIds(new Set(['session-v1']))
    console.log(JSON.stringify({ summaries, sessions }))
} else if (scenario === 'v2only') {
    const root = mkdtempSync(join(tmpdir(), 'opencode-v2only-'))
    process.env.OPENCODE_HOME = root
    const dbPath = join(root, 'opencode.db')
    const db = createV2Tables(new Database(dbPath))
    insertV2Sessions(db, [
        { id: 'session-v2', title: 'V2 only session', directory: '/tmp/v2-project', model: 'anthropic/claude-sonnet-4', timeCreated: 8000, timeUpdated: 9000 }
    ])
    db.close()
    insertV2Messages(dbPath, [
        { id: 'v2-m1', sessionId: 'session-v2', seq: 1, type: 'user', data: { text: 'v2 question' }, timeCreated: 8100 },
        { id: 'v2-m2', sessionId: 'session-v2', seq: 2, type: 'assistant', data: { content: [{ type: 'tool', id: 'tool-1', name: 'read', state: {}, time: { start: 8200 } }, { type: 'text', text: 'v2 answer' }] }, timeCreated: 8200 },
        { id: 'v2-m3', sessionId: 'session-v2', seq: 3, type: 'user', data: { text: 'v2 follow up' }, timeCreated: 8300 }
    ])
    const summaries = await listLocalOpencodeSessionSummaries()
    const sessions = await listLocalOpencodeSessionsWithMessagesByIds(new Set(['session-v2']))
    console.log(JSON.stringify({ summaries, sessions }))
} else if (scenario === 'migrated') {
    const root = mkdtempSync(join(tmpdir(), 'opencode-migrated-'))
    process.env.OPENCODE_HOME = root
    const dbPath = join(root, 'opencode.db')
    createDb(root)
    const db = new Database(dbPath)
    db.query('INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)').run('session-migrated', 'Migrated session', '/tmp/migrated-project', 2000)
    db.close()
    insertMessages(dbPath, [
        { id: 'm1', sessionId: 'session-migrated', role: 'user', timeCreated: 1000 },
        { id: 'm2', sessionId: 'session-migrated', role: 'assistant', timeCreated: 2000 }
    ], [
        { messageId: 'm1', type: 'text', text: 'old question' },
        { messageId: 'm2', type: 'text', text: 'old answer', extra: { time: { end: 2100 } } }
    ])
    {
        const v2 = createV2Tables(new Database(dbPath))
        try {
            insertV2Sessions(v2, [
                { id: 'session-migrated', title: 'Migrated session v2', directory: '/tmp/migrated-project', model: 'anthropic/claude-sonnet-4', timeCreated: 1000, timeUpdated: 9000 }
            ])
        } finally {
            v2.close()
        }
    }
    insertV2Messages(dbPath, [
        { id: 'm1', sessionId: 'session-migrated', seq: 1, type: 'user', data: { text: 'old question' }, timeCreated: 1000 },
        { id: 'm2', sessionId: 'session-migrated', seq: 2, type: 'assistant', data: { content: [{ type: 'text', text: 'old answer' }] }, timeCreated: 2000 },
        { id: 'm3', sessionId: 'session-migrated', seq: 3, type: 'user', data: { text: 'new question' }, timeCreated: 3000 },
        { id: 'm4', sessionId: 'session-migrated', seq: 4, type: 'assistant', data: { content: [{ type: 'text', text: 'new answer' }] }, timeCreated: 4000 }
    ])
    const summaries = await listLocalOpencodeSessionSummaries()
    const sessions = await listLocalOpencodeSessionsWithMessagesByIds(new Set(['session-migrated']))
    console.log(JSON.stringify({ summaries, sessions }))
} else if (scenario === 'mixed') {
    const root = mkdtempSync(join(tmpdir(), 'opencode-mixed-'))
    process.env.OPENCODE_HOME = root
    const dbPath = join(root, 'opencode.db')
    createDb(root)
    const db = new Database(dbPath)
    db.query('INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)').run('session-v1-only', 'V1 only session', '/tmp/v1-project', 5000)
    db.close()
    insertMessages(dbPath, [
        { id: 'mix-v1-u', sessionId: 'session-v1-only', role: 'user', timeCreated: 5100 }
    ], [
        { messageId: 'mix-v1-u', type: 'text', text: 'v1 only question' }
    ])
    {
        const v2 = createV2Tables(new Database(dbPath))
        try {
            insertV2Sessions(v2, [
                { id: 'session-v2-a', title: 'V2 session A', directory: '/tmp/v2-a-project', timeCreated: 6000, timeUpdated: 7000 },
                { id: 'session-v2-b', title: 'V2 session B', directory: '/tmp/v2-b-project', timeCreated: 2000, timeUpdated: 3000 }
            ])
        } finally {
            v2.close()
        }
    }
    insertV2Messages(dbPath, [
        { id: 'mix-a-u', sessionId: 'session-v2-a', seq: 1, type: 'user', data: { text: 'v2 a question' }, timeCreated: 6100 },
        { id: 'mix-a-a', sessionId: 'session-v2-a', seq: 2, type: 'assistant', data: { content: [{ type: 'text', text: 'v2 a answer' }] }, timeCreated: 6200 },
        { id: 'mix-b-u', sessionId: 'session-v2-b', seq: 1, type: 'user', data: { text: 'v2 b question' }, timeCreated: 2100 }
    ])
    const summaries = await listLocalOpencodeSessionSummaries()
    const sessions = await listLocalOpencodeSessionsWithMessagesByIds(new Set(['session-v1-only', 'session-v2-a', 'session-v2-b']))
    console.log(JSON.stringify({ summaries, sessions }))
} else if (scenario === 'archived') {
    const root = mkdtempSync(join(tmpdir(), 'opencode-archived-'))
    process.env.OPENCODE_HOME = root
    const dbPath = join(root, 'opencode.db')
    createDb(root)
    const db = new Database(dbPath)
    db.query('INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)').run('session-live', 'Live session', '/tmp/live', 5000)
    // archived in v1 only: the migrated v2 row still exists and is not archived
    db.query('INSERT INTO session (id, title, directory, time_updated, time_archived) VALUES (?, ?, ?, ?, ?)').run('session-archived-v1', 'Archived in v1', '/tmp/archived-v1', 6000, 6100)
    // archived in v2 only: the v1 row is still active
    db.query('INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)').run('session-archived-v2', 'Archived in v2', '/tmp/archived-v2', 7000)
    db.close()
    {
        const v2 = createV2Tables(new Database(dbPath))
        try {
            insertV2Sessions(v2, [
                { id: 'session-live', title: 'Live session v2', directory: '/tmp/live', timeCreated: 1000, timeUpdated: 5000 },
                { id: 'session-archived-v1', title: 'Archived in v1', directory: '/tmp/archived-v1', timeCreated: 1000, timeUpdated: 6000 },
                { id: 'session-archived-v2', title: 'Archived in v2', directory: '/tmp/archived-v2', timeCreated: 1000, timeUpdated: 7000, timeArchived: 7100 },
                { id: 'session-v2-archived', title: 'V2 only archived', directory: '/tmp/archived-v2-only', timeCreated: 1000, timeUpdated: 8000, timeArchived: 8100 }
            ])
        } finally {
            v2.close()
        }
    }
    const summaries = await listLocalOpencodeSessionSummaries()
    console.log(JSON.stringify({ summaries }))
} else if (scenario === 'restamped') {
    const root = mkdtempSync(join(tmpdir(), 'opencode-restamped-'))
    process.env.OPENCODE_HOME = root
    const dbPath = join(root, 'opencode.db')
    createDb(root)
    const db = new Database(dbPath)
    db.query('INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)').run('session-restamped', 'Restamped session', '/tmp/restamped', 2000)
    db.close()
    insertMessages(dbPath, [
        { id: 'm1', sessionId: 'session-restamped', role: 'user', timeCreated: 1000 },
        { id: 'm2', sessionId: 'session-restamped', role: 'assistant', timeCreated: 2000 }
    ], [
        { messageId: 'm1', type: 'text', text: 'old question' },
        { messageId: 'm2', type: 'text', text: 'old answer', extra: { time: { end: 2100 } } }
    ])
    {
        const v2 = createV2Tables(new Database(dbPath))
        try {
            insertV2Sessions(v2, [
                { id: 'session-restamped', title: 'Restamped session v2', directory: '/tmp/restamped', timeCreated: 10000, timeUpdated: 20000 }
            ])
        } finally {
            v2.close()
        }
    }
    // The migration re-stamped the timestamps and gave the rows new ids, so
    // the v2 prefix can only be recognized by position.
    insertV2Messages(dbPath, [
        { id: 'x1', sessionId: 'session-restamped', seq: 1, type: 'user', data: { text: 'old question' }, timeCreated: 10000 },
        { id: 'x2', sessionId: 'session-restamped', seq: 2, type: 'assistant', data: { content: [{ type: 'text', text: 'old answer' }] }, timeCreated: 10100 },
        { id: 'x3', sessionId: 'session-restamped', seq: 3, type: 'user', data: { text: 'new question' }, timeCreated: 10200 },
        { id: 'x4', sessionId: 'session-restamped', seq: 4, type: 'assistant', data: { content: [{ type: 'text', text: 'new answer' }] }, timeCreated: 10300 }
    ])
    const summaries = await listLocalOpencodeSessionSummaries()
    const sessions = await listLocalOpencodeSessionsWithMessagesByIds(new Set(['session-restamped']))
    console.log(JSON.stringify({ summaries, sessions }))
} else if (scenario === 'restamped-system') {
    const root = mkdtempSync(join(tmpdir(), 'opencode-restamped-sys-'))
    process.env.OPENCODE_HOME = root
    const dbPath = join(root, 'opencode.db')
    createDb(root)
    const db = new Database(dbPath)
    db.query('INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)').run('session-restamped', 'Restamped session', '/tmp/restamped', 2000)
    db.close()
    // The v1 history carries a non-chat row (system) between the user turns.
    insertMessages(dbPath, [
        { id: 'm1', sessionId: 'session-restamped', role: 'user', timeCreated: 1000 },
        { id: 'm-sys', sessionId: 'session-restamped', role: 'system', timeCreated: 1500 },
        { id: 'm2', sessionId: 'session-restamped', role: 'assistant', timeCreated: 2000 }
    ], [
        { messageId: 'm1', type: 'text', text: 'old question' },
        { messageId: 'm2', type: 'text', text: 'old answer', extra: { time: { end: 2100 } } }
    ])
    {
        const v2 = createV2Tables(new Database(dbPath))
        try {
            insertV2Sessions(v2, [
                { id: 'session-restamped', title: 'Restamped session v2', directory: '/tmp/restamped', timeCreated: 10000, timeUpdated: 20000 }
            ])
        } finally {
            v2.close()
        }
    }
    insertV2Messages(dbPath, [
        { id: 'x1', sessionId: 'session-restamped', seq: 1, type: 'user', data: { text: 'old question' }, timeCreated: 10000 },
        { id: 'x2', sessionId: 'session-restamped', seq: 2, type: 'assistant', data: { content: [{ type: 'text', text: 'old answer' }] }, timeCreated: 10100 },
        { id: 'x3', sessionId: 'session-restamped', seq: 3, type: 'user', data: { text: 'new question' }, timeCreated: 10200 },
        { id: 'x4', sessionId: 'session-restamped', seq: 4, type: 'assistant', data: { content: [{ type: 'text', text: 'new answer' }] }, timeCreated: 10300 }
    ])
    const summaries = await listLocalOpencodeSessionSummaries()
    const sessions = await listLocalOpencodeSessionsWithMessagesByIds(new Set(['session-restamped']))
    console.log(JSON.stringify({ summaries, sessions }))
} else if (scenario === 'v2model') {
    const root = mkdtempSync(join(tmpdir(), 'opencode-v2model-'))
    process.env.OPENCODE_HOME = root
    const dbPath = join(root, 'opencode.db')
    createDb(root)
    const v2 = createV2Tables(new Database(dbPath))
    try {
        insertV2Sessions(v2, [
            { id: 'session-model', title: 'Model session', directory: '/tmp/model', timeCreated: 1000, timeUpdated: 5000, model: 'gpt-5.6' },
            { id: 'session-nomodel', title: 'No model session', directory: '/tmp/model', timeCreated: 1000, timeUpdated: 4000 }
        ])
    } finally {
        v2.close()
    }
    insertV2Messages(dbPath, [
        { id: 'vm1', sessionId: 'session-model', seq: 1, type: 'user', data: { text: 'model question' }, timeCreated: 1100 }
    ])
    const summaries = await listLocalOpencodeSessionSummaries()
    console.log(JSON.stringify({ summaries }))
} else if (scenario === 'systemrows') {
    const root = mkdtempSync(join(tmpdir(), 'opencode-systemrows-'))
    process.env.OPENCODE_HOME = root
    const dbPath = join(root, 'opencode.db')
    const db = createV2Tables(new Database(dbPath))
    insertV2Sessions(db, [
        { id: 'session-system', title: 'Session with system rows', directory: '/tmp/system', timeCreated: 8000, timeUpdated: 9000 }
    ])
    db.close()
    insertV2Messages(dbPath, [
        { id: 's1', sessionId: 'session-system', seq: 1, type: 'user', data: { text: 'first question' }, timeCreated: 8100 },
        { id: 's2', sessionId: 'session-system', seq: 2, type: 'system', data: { text: 'SYSTEM PROMPT ' + 'x'.repeat(200) }, timeCreated: 8150 },
        { id: 's3', sessionId: 'session-system', seq: 3, type: 'synthetic', data: { text: 'synthetic note' }, timeCreated: 8200 },
        { id: 's4', sessionId: 'session-system', seq: 4, type: 'assistant', data: { content: [{ type: 'text', text: 'the answer' }] }, timeCreated: 8300 }
    ])
    const summaries = await listLocalOpencodeSessionSummaries()
    const sessions = await listLocalOpencodeSessionsWithMessagesByIds(new Set(['session-system']))
    console.log(JSON.stringify({ summaries, sessions }))
} else if (scenario === 'queryfail') {
    const root = mkdtempSync(join(tmpdir(), 'opencode-queryfail-'))
    process.env.OPENCODE_HOME = root
    const dbPath = join(root, 'opencode.db')
    createDb(root)
    const db = new Database(dbPath)
    db.query('INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)').run('session-qf', 'QueryFail', '/tmp/project', 7000)
    insertMessages(dbPath, [
        { id: 'mq-u', sessionId: 'session-qf', role: 'user', timeCreated: 7100 },
        { id: 'mq-a', sessionId: 'session-qf', role: 'assistant', timeCreated: 7200 }
    ], [
        { messageId: 'mq-u', type: 'text', text: 'question' },
        { messageId: 'mq-a', type: 'text', text: 'answer', extra: { time: { end: 7300 } } }
    ])
    // Simulate a transient SQLite failure reading parts of later messages.
    db.exec('DROP TABLE part')
    db.close()
    const out = await listLocalOpencodeSessionsWithMessagesByIds(new Set(['session-qf']))
    console.log(JSON.stringify({ sessions: out }))
} else if (scenario === 'failclosed') {
    const missingRoot = mkdtempSync(join(tmpdir(), 'opencode-missing-'))
    process.env.OPENCODE_HOME = missingRoot
    const noDb = {
        path: getOpencodeDbPath(),
        summaries: await listLocalOpencodeSessionSummaries(),
        byIds: await listLocalOpencodeSessionsWithMessagesByIds(new Set(['any']))
    }

    const emptyRoot = mkdtempSync(join(tmpdir(), 'opencode-empty-'))
    process.env.OPENCODE_HOME = emptyRoot
    writeFileSync(join(emptyRoot, 'opencode.db'), '')
    const emptyFile = {
        summaries: await listLocalOpencodeSessionSummaries(),
        byIds: await listLocalOpencodeSessionsWithMessagesByIds(new Set(['any']))
    }

    const partialRoot = mkdtempSync(join(tmpdir(), 'opencode-partial-'))
    process.env.OPENCODE_HOME = partialRoot
    const partial = new Database(join(partialRoot, 'opencode.db'))
    partial.exec('CREATE TABLE session (id TEXT PRIMARY KEY);')
    partial.close()
    const missingTables = {
        summaries: await listLocalOpencodeSessionSummaries(),
        byIds: await listLocalOpencodeSessionsWithMessagesByIds(new Set(['any']))
    }
    console.log(JSON.stringify({ noDb, emptyFile, missingTables }))
}
`

function runScenario(name: string): Record<string, unknown> {
    const result = spawnSync('bun', ['-e', RUNNER], {
        cwd: import.meta.dirname,
        env: { ...process.env, SCENARIO: name },
        encoding: 'utf-8'
    })
    if (result.status !== 0) throw new Error(`bun scenario '${name}' failed:\n${result.stderr}`)
    const line = result.stdout.trim().split('\n').filter(Boolean).pop()
    return JSON.parse(line ?? '{}')
}

describe('local opencode sessions', () => {
    it('lists summaries with lastUserMessage rules and converts message envelopes', () => {
        const output = runScenario('sessions') as any
        expect(output.summaries.map((summary: any) => summary.id)).toEqual(['session-1', 'session-3'])
        expect(output.summaries[0]).toMatchObject({
            id: 'session-1',
            title: 'Normal session',
            cwd: '/tmp/project',
            modifiedAt: 2_000_000,
            lastUserMessage: 'hello world'
        })
        // tool part skipped; malformed-JSON user row yields null lastUserMessage
        expect(output.summaries[1]).toMatchObject({ id: 'session-3', lastUserMessage: null })

        expect(output.sessions.map((session: any) => session.id)).toEqual(['session-2', 'session-1'])
        const archived = output.sessions.find((session: any) => session.id === 'session-2')
        // archived sessions are loadable by ids; their '<'-prefixed user text
        // is excluded from lastUserMessage but still converts to an envelope
        expect(archived?.messages).toHaveLength(1)
        expect(archived?.messages[0]).toMatchObject({ content: { role: 'user' } })
        expect(archived?.lastUserMessage ?? null).toBe(null)
        const normal = output.sessions.find((session: any) => session.id === 'session-1')
        expect(normal?.messages).toHaveLength(2)
        expect(normal.messages[0]).toMatchObject({
            content: { role: 'user', content: { type: 'text', text: 'hello world' }, meta: { sentFrom: 'cli' } }
        })
        expect(normal.messages[1]).toMatchObject({
            content: {
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: 'hi there' } },
                meta: { sentFrom: 'cli' }
            }
        })
        expect(typeof normal.messages[0].localId).toBe('string')
    })

    it('truncates long last user messages to 140 chars', () => {
        const output = runScenario('truncate') as any
        const lastUserMessage = output.summaries[0]?.lastUserMessage as string | undefined
        expect(lastUserMessage).toHaveLength(140)
        expect(lastUserMessage?.endsWith('…')).toBe(true)
    })

    it('skips unfinished assistant text parts that are still streaming', () => {
        const output = runScenario('streaming') as any
        const messages = output.sessions[0]?.messages ?? []
        expect(messages).toHaveLength(2)
        expect(messages[0]).toMatchObject({ content: { role: 'user', content: { type: 'text', text: 'question' } } })
        expect(messages[1]).toMatchObject({
            content: {
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: 'finished answer' } },
                meta: { sentFrom: 'cli' }
            }
        })
    })

    it('never surfaces a holey partial transcript when parts are unreadable', () => {
        const output = runScenario('queryfail') as any
        // Missing part table short-circuits the read entirely — the caller
        // sees an empty result, never a transcript with a hole in the middle.
        expect(output.sessions).toEqual([])
    })

    it('fails closed when the db or required tables are missing', () => {
        const output = runScenario('failclosed') as any
        expect(output.noDb.path.endsWith(join('opencode.db'))).toBe(true)
        expect(output.noDb.summaries).toEqual([])
        expect(output.noDb.byIds).toEqual([])
        expect(output.emptyFile.summaries).toEqual([])
        expect(output.emptyFile.byIds).toEqual([])
        expect(output.missingTables.summaries).toEqual([])
        expect(output.missingTables.byIds).toEqual([])
    })

    it('imports v1-only sessions exactly like before', () => {
        const output = runScenario('v1only') as any
        expect(output.summaries).toHaveLength(1)
        expect(output.summaries[0]).toMatchObject({
            id: 'session-v1',
            title: 'V1 only session',
            cwd: '/tmp/v1-project',
            modifiedAt: 5_000_000,
            lastUserMessage: 'v1 question'
        })
        const messages = output.sessions[0]?.messages ?? []
        expect(messages).toHaveLength(2)
        expect(messages[0]).toMatchObject({
            content: { role: 'user', content: { type: 'text', text: 'v1 question' }, meta: { sentFrom: 'cli' } }
        })
        expect(messages[1]).toMatchObject({
            content: {
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: 'v1 answer' } },
                meta: { sentFrom: 'cli' }
            }
        })
    })

    it('imports v2-only sessions from session_v2 and session_message', () => {
        const output = runScenario('v2only') as any
        expect(output.summaries).toHaveLength(1)
        expect(output.summaries[0]).toMatchObject({
            id: 'session-v2',
            title: 'V2 only session',
            cwd: '/tmp/v2-project',
            modifiedAt: 9_000_000,
            lastUserMessage: 'v2 follow up'
        })
        const messages = output.sessions[0]?.messages ?? []
        // tool items are not imported: v2 parity is text only
        expect(messages).toHaveLength(3)
        expect(messages[0]).toMatchObject({
            content: { role: 'user', content: { type: 'text', text: 'v2 question' }, meta: { sentFrom: 'cli' } }
        })
        expect(messages[1]).toMatchObject({
            content: {
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: 'v2 answer' } },
                meta: { sentFrom: 'cli' }
            }
        })
        expect(messages[2]).toMatchObject({
            content: { role: 'user', content: { type: 'text', text: 'v2 follow up' }, meta: { sentFrom: 'cli' } }
        })
        // v2 text parts have no id: the stable key is "<message id>:<content index>"
        expect(messages[0].localId).toBe('opencode:session-v2:v2-m1:v2-m1:0')
        expect(messages[1].localId).toBe('opencode:session-v2:v2-m2:v2-m2:1')
    })

    it('keeps the v1 prefix and appends the v2 tail of a migrated session', () => {
        const output = runScenario('migrated') as any
        expect(output.summaries).toHaveLength(1)
        expect(output.summaries[0]).toMatchObject({
            id: 'session-migrated',
            title: 'Migrated session v2',
            modifiedAt: 9_000_000,
            lastUserMessage: 'new question'
        })
        const messages = output.sessions[0]?.messages ?? []
        expect(messages).toHaveLength(4)
        expect(messages.map((message: any) => message.content.content.data?.message ?? message.content.content.text))
            .toEqual(['old question', 'old answer', 'new question', 'new answer'])
        // the v1 prefix keeps its v1 local ids, the v2 tail uses the v2 key
        expect(messages[0].localId).toBe('opencode:session-migrated:m1:part-1')
        expect(messages[2].localId).toBe('opencode:session-migrated:m3:m3:0')
        expect(messages[3].localId).toBe('opencode:session-migrated:m4:m4:0')
    })

    it('lists a v1-only session next to v2 sessions', () => {
        const output = runScenario('mixed') as any
        expect(output.summaries.map((summary: any) => summary.id)).toEqual(['session-v2-a', 'session-v1-only', 'session-v2-b'])
        expect(output.sessions.map((session: any) => session.id)).toEqual(['session-v2-a', 'session-v1-only', 'session-v2-b'])
        const v1Only = output.sessions.find((session: any) => session.id === 'session-v1-only')
        expect(v1Only?.messages).toHaveLength(1)
        expect(v1Only?.messages[0]).toMatchObject({
            content: { role: 'user', content: { type: 'text', text: 'v1 only question' } }
        })
        const v2a = output.sessions.find((session: any) => session.id === 'session-v2-a')
        expect(v2a?.messages).toHaveLength(2)
        expect(v2a?.messages[1]).toMatchObject({
            content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'v2 a answer' } } }
        })
    })

    it('hides archived sessions of a migrated database', () => {
        const output = runScenario('archived') as any
        // archived in v1 only, archived in v2 only and archived in v2 only
        // must all stay out of the list
        expect(output.summaries.map((summary: any) => summary.id)).toEqual(['session-live'])
    })

    it('aligns the v1 prefix and the v2 tail by position when the ids differ', () => {
        const output = runScenario('restamped') as any
        expect(output.summaries).toHaveLength(1)
        const messages = output.sessions[0]?.messages ?? []
        // the re-stamped v2 rows mirror the v1 prefix: it must not be imported twice
        expect(messages).toHaveLength(4)
        expect(messages.map((message: any) => message.content.content.data?.message ?? message.content.content.text))
            .toEqual(['old question', 'old answer', 'new question', 'new answer'])
    })

    it('keeps the v2 tail when a non-chat v1 row shifts the positional mirror count', () => {
        const output = runScenario('restamped-system') as any
        const messages = output.sessions[0]?.messages ?? []
        // Only user/assistant v1 rows participate in the positional mirror:
        // the system row must not swallow the 'new question' turn.
        expect(messages.map((message: any) => message.content.content.data?.message ?? message.content.content.text))
            .toEqual(['old question', 'old answer', 'new question', 'new answer'])
    })

    it('carries the session_v2 model as a summary field', () => {
        const output = runScenario('v2model') as any
        const withModel = output.summaries.find((summary: any) => summary.id === 'session-model')
        const withoutModel = output.summaries.find((summary: any) => summary.id === 'session-nomodel')
        expect(withModel).toMatchObject({ id: 'session-model', model: 'gpt-5.6' })
        expect('model' in withoutModel).toBe(false)
    })

    it('does not import system rows as agent messages', () => {
        const output = runScenario('systemrows') as any
        expect(output.summaries[0]).toMatchObject({ id: 'session-system', lastUserMessage: 'first question' })
        const messages = output.sessions[0]?.messages ?? []
        // the system row is a system prompt, not conversation: it maps to nothing
        expect(messages).toHaveLength(3)
        expect(messages[0]).toMatchObject({
            content: { role: 'user', content: { type: 'text', text: 'first question' } }
        })
        expect(messages[1]).toMatchObject({
            content: { role: 'user', content: { type: 'text', text: 'synthetic note' } }
        })
        expect(messages[2]).toMatchObject({
            content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'the answer' } } }
        })
    })

    it('rejects instead of returning a partial transcript when a middle part query fails', async () => {
        const { listLocalOpencodeSessionsWithMessagesByIds } = await import('./opencodeSessions')
        let partReads = 0
        const stmt = (rows: unknown[]) => ({ all: () => rows, get: () => rows[0] })
        const fakeDb = {
            query(sql: string) {
                if (/FROM part WHERE/.test(sql)) {
                    partReads += 1
                    if (partReads === 2) {
                        return { all: () => { throw new Error('injected part read failure') }, get: () => undefined }
                    }
                }
                if (/sqlite_master/.test(sql)) return stmt([{ name: 'x' }])
                if (/FROM session WHERE id/.test(sql)) {
                    return stmt([{ id: 's1', title: 'T', directory: '/tmp', time_updated: 7000 }])
                }
                if (/FROM message WHERE session_id/.test(sql)) {
                    return stmt([
                        { id: 'm1', data: JSON.stringify({ role: 'user' }), time_created: 7100 },
                        { id: 'm2', data: JSON.stringify({ role: 'assistant' }), time_created: 7200 }
                    ])
                }
                return stmt([])
            },
            close: () => {}
        }
        await expect(listLocalOpencodeSessionsWithMessagesByIds(new Set(['s1']), async () => fakeDb))
            .rejects.toThrow('injected part read failure')
    })
})
