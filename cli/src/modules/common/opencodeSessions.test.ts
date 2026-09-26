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
