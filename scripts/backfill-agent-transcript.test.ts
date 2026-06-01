import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { backfillSessionMessages, transcriptLinesToHapiMessages } from './backfill-agent-transcript'
import { Store } from '../hub/src/store'

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
