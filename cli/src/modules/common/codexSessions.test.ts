import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, writeFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findCodexSessionTitle, listCodexSessions } from './codexSessions'

describe('listCodexSessions', () => {
    const originalCodexHome = process.env.CODEX_HOME
    let codexHome: string

    beforeEach(async () => {
        codexHome = join(tmpdir(), `hapi-codex-sessions-${Date.now()}-${Math.random().toString(16).slice(2)}`)
        process.env.CODEX_HOME = codexHome
        await mkdir(join(codexHome, 'sessions'), { recursive: true })
    })

    afterEach(() => {
        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME
            return
        }
        process.env.CODEX_HOME = originalCodexHome
    })

    it('lists codex sessions and hides old entries by default', async () => {
        const sessionsDir = join(codexHome, 'sessions')
        const recentPath = join(sessionsDir, 'recent.jsonl')
        const oldPath = join(sessionsDir, 'old.jsonl')

        await writeFile(
            recentPath,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: 'thread-recent', cwd: '/repo/recent', model: 'gpt-5' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'agent reply should not win' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'user session title' } })
            ].join('\n') + '\n'
        )
        await writeFile(
            join(codexHome, 'session_index.jsonl'),
            `${JSON.stringify({ id: 'thread-recent', thread_name: 'codex generated title', updated_at: '2026-04-27T00:00:00.000Z' })}\n`
        )
        await writeFile(oldPath, `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-old', cwd: '/repo/old', model: 'gpt-5' } })}\n`)

        const oldDate = new Date(Date.now() - (190 * 24 * 60 * 60 * 1000))
        await utimes(oldPath, oldDate, oldDate)

        const recentOnly = await listCodexSessions()
        expect(recentOnly.sessions.map((entry) => entry.id)).toEqual(['thread-recent'])
        expect(recentOnly.sessions[0]?.title).toBe('codex generated title')

        const withOld = await listCodexSessions({ includeOld: true })
        expect(withOld.sessions.map((entry) => entry.id)).toEqual(['thread-recent', 'thread-old'])
        expect(withOld.sessions[1]?.isOld).toBe(true)
    })

    it('supports cursor pagination', async () => {
        const sessionsDir = join(codexHome, 'sessions')
        for (let i = 0; i < 3; i++) {
            const sessionPath = join(sessionsDir, `s-${i}.jsonl`)
            await writeFile(sessionPath, `${JSON.stringify({ type: 'session_meta', payload: { id: `thread-${i}` } })}\n`)
        }

        const page1 = await listCodexSessions({ includeOld: true, limit: 2 })
        expect(page1.sessions.length).toBe(2)
        expect(page1.nextCursor).toBe('2')

        const page2 = await listCodexSessions({ includeOld: true, limit: 2, cursor: page1.nextCursor ?? undefined })
        expect(page2.sessions.length).toBe(1)
        expect(page2.nextCursor).toBeNull()
    })

    it('uses transcript thread names before first user message', async () => {
        const sessionPath = join(codexHome, 'sessions', 'named.jsonl')
        await writeFile(
            sessionPath,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: 'thread-named', cwd: '/repo/named', model: 'gpt-5' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'long first user message' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'thread_name_updated', thread_id: 'thread-named', thread_name: 'short generated title' } })
            ].join('\n') + '\n'
        )

        const result = await listCodexSessions({ includeOld: true })
        expect(result.sessions[0]?.title).toBe('short generated title')
        await expect(findCodexSessionTitle('thread-named')).resolves.toBe('short generated title')
    })

    it('falls back to the first user message when no generated title exists', async () => {
        const sessionPath = join(codexHome, 'sessions', 'untitled.jsonl')
        await writeFile(
            sessionPath,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: 'thread-untitled', cwd: '/repo/untitled', model: 'gpt-5' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'agent reply should not win' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'first user message fallback' } })
            ].join('\n') + '\n'
        )

        const result = await listCodexSessions({ includeOld: true })
        expect(result.sessions[0]?.title).toBe('first user message fallback')
        await expect(findCodexSessionTitle('thread-untitled')).resolves.toBe('first user message fallback')
    })
})
