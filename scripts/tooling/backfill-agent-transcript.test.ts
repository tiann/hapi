import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { backfillSessionMessages, resolveTranscriptPath, transcriptLinesToHapiMessages } from './backfill-agent-transcript'
import { Store } from '../../hub/src/store'

describe('transcriptLinesToHapiMessages', () => {
    it('maps cursor user/assistant lines to HAPI envelopes', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-backfill-'))
        const path = join(dir, 'chat.jsonl')
        writeFileSync(path, [
            JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }),
            JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'world' }] }, id: 'a1' })
        ].join('\n') + '\n')

        const messages = transcriptLinesToHapiMessages('cursor', path)
        expect(messages).toHaveLength(2)
        expect(messages[0]).toMatchObject({ role: 'user', content: { type: 'text', text: 'hello' } })
        expect(messages[1]?.role).toBe('agent')
        rmSync(dir, { recursive: true, force: true })
    })
})

describe('backfillSessionMessages', () => {
    const dirs: string[] = []

    afterEach(() => {
        for (const dir of dirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('inserts deduped rows with local_id backfill keys', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-backfill-db-'))
        dirs.push(dir)
        const dbPath = join(dir, 'hapi.db')
        const transcript = join(dir, 't.jsonl')
        writeFileSync(transcript, JSON.stringify({
            role: 'user',
            message: { content: [{ type: 'text', text: 'ping' }] }
        }) + '\n')

        const store = new Store(dbPath)
        const session = store.sessions.getOrCreateSession('backfill-test', {
            path: dir,
            host: 'test',
            flavor: 'cursor',
            cursorSessionId: '11111111-1111-4111-8111-111111111111'
        }, null, 'default')
        store.close()

        const first = backfillSessionMessages({
            dbPath,
            sessionId: session.id,
            agent: 'cursor',
            chatId: '11111111-1111-4111-8111-111111111111',
            transcriptPath: transcript
        })
        expect(first.inserted).toBe(1)

        const db = new Database(dbPath)
        const invoked = db.prepare(
            'SELECT invoked_at FROM messages WHERE session_id = ? AND local_id LIKE ?'
        ).get(session.id, 'backfill:%') as { invoked_at: number | null }
        expect(invoked?.invoked_at).not.toBeNull()
        db.close()

        const second = backfillSessionMessages({
            dbPath,
            sessionId: session.id,
            agent: 'cursor',
            chatId: '11111111-1111-4111-8111-111111111111',
            transcriptPath: transcript,
            force: true
        })
        expect(second.skipped).toBe(1)
        expect(second.inserted).toBe(0)
    })
})

describe('resolveTranscriptPath: duplicate UUID across Cursor projects', () => {
    it('prefers projectHint slug; falls back to larger file', () => {
        const fakeRoot = mkdtempSync(join(tmpdir(), 'hapi-resolve-root-'))
        try {
            const uuid = '720a4be5-a991-4123-a36d-b6e908ea671c'
            // Stub (wrong slug, tiny)
            const wrongSlug = 'home-heavygee'
            const wrongDir = join(fakeRoot, wrongSlug, 'agent-transcripts', uuid)
            mkdirSync(wrongDir, { recursive: true })
            writeFileSync(join(wrongDir, `${uuid}.jsonl`), 'x')

            // Real chat (project slug, big)
            const projectSlug = 'home-heavygee-coding-openab'
            const realDir = join(fakeRoot, projectSlug, 'agent-transcripts', uuid)
            mkdirSync(realDir, { recursive: true })
            writeFileSync(join(realDir, `${uuid}.jsonl`), 'x'.repeat(10_000))

            // No hint -> larger file wins
            const noHint = resolveTranscriptPath('cursor', uuid, undefined, fakeRoot)
            expect(noHint).toBe(join(realDir, `${uuid}.jsonl`))

            // Matching hint -> slug-match wins (still the project slug here)
            const hinted = resolveTranscriptPath('cursor', uuid, '/home/heavygee/coding/openab', fakeRoot)
            expect(hinted).toBe(join(realDir, `${uuid}.jsonl`))

            // Unrelated hint -> falls back to larger file
            const wrongHint = resolveTranscriptPath('cursor', uuid, '/home/heavygee/coding/nonexistent', fakeRoot)
            expect(wrongHint).toBe(join(realDir, `${uuid}.jsonl`))

            // Hint matching the SMALLER, wrong slug -> hint wins even though file is smaller
            const stubHint = resolveTranscriptPath('cursor', uuid, '/home/heavygee', fakeRoot)
            expect(stubHint).toBe(join(wrongDir, `${uuid}.jsonl`))
        } finally {
            rmSync(fakeRoot, { recursive: true, force: true })
        }
    })

    it('returns null when no candidates exist', () => {
        const fakeRoot = mkdtempSync(join(tmpdir(), 'hapi-resolve-empty-'))
        try {
            expect(resolveTranscriptPath('cursor', 'missing-uuid', undefined, fakeRoot)).toBeNull()
        } finally {
            rmSync(fakeRoot, { recursive: true, force: true })
        }
    })
})

describe('backfillSessionMessages: truncation reporting', () => {
    const dirs: string[] = []
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    })

    it('flags truncated=true when transcript exceeds --max-messages cap', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-backfill-trunc-'))
        dirs.push(dir)
        const dbPath = join(dir, 'hapi.db')
        const transcript = join(dir, 't.jsonl')
        // 5 user turns, cap at 3 -> truncated
        writeFileSync(transcript, Array.from({ length: 5 }, (_, i) =>
            JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `msg ${i}` }] } })
        ).join('\n') + '\n')

        const store = new Store(dbPath)
        const session = store.sessions.getOrCreateSession('trunc-test', {
            path: dir, host: 'test', flavor: 'cursor',
            cursorSessionId: '22222222-2222-4222-8222-222222222222'
        }, null, 'default')
        store.close()

        const result = backfillSessionMessages({
            dbPath,
            sessionId: session.id,
            agent: 'cursor',
            chatId: '22222222-2222-4222-8222-222222222222',
            transcriptPath: transcript,
            maxMessages: 3
        })
        expect(result.rawTranscriptLines).toBe(5)
        expect(result.maxMessagesApplied).toBe(3)
        expect(result.truncated).toBe(true)
        expect(result.inserted).toBe(3)
    })

    it('flags truncated=false when transcript fits within cap', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-backfill-fit-'))
        dirs.push(dir)
        const dbPath = join(dir, 'hapi.db')
        const transcript = join(dir, 't.jsonl')
        writeFileSync(transcript, JSON.stringify({
            role: 'user', message: { content: [{ type: 'text', text: 'one and done' }] }
        }) + '\n')

        const store = new Store(dbPath)
        const session = store.sessions.getOrCreateSession('fit-test', {
            path: dir, host: 'test', flavor: 'cursor',
            cursorSessionId: '33333333-3333-4333-8333-333333333333'
        }, null, 'default')
        store.close()

        const result = backfillSessionMessages({
            dbPath,
            sessionId: session.id,
            agent: 'cursor',
            chatId: '33333333-3333-4333-8333-333333333333',
            transcriptPath: transcript
        })
        expect(result.rawTranscriptLines).toBe(1)
        expect(result.truncated).toBe(false)
        expect(result.inserted).toBe(1)
    })
})
