import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, writeFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listCodexSessions } from './codexSessions'

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

        await writeFile(recentPath, `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-recent', cwd: '/repo/recent', model: 'gpt-5' } })}\n`)
        await writeFile(oldPath, `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-old', cwd: '/repo/old', model: 'gpt-5' } })}\n`)

        const oldDate = new Date(Date.now() - (190 * 24 * 60 * 60 * 1000))
        await utimes(oldPath, oldDate, oldDate)

        const recentOnly = await listCodexSessions()
        expect(recentOnly.sessions.map((entry) => entry.id)).toEqual(['thread-recent'])

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
})
