import { describe, expect, it } from 'vitest'
import {
    commandMatchesRunnerSpawnedSession,
    reapRunnerSpawnedOrphans,
    selectOrphanPidsForSession,
} from './orphanReap'

describe('orphanReap argv matching', () => {
    const sessionId = 'sess-abc-123'

    it('matches runner-spawned CLI with --existing-session-id', () => {
        const cmd = `bun src/index.ts claude --hapi-starting-mode remote --started-by runner --existing-session-id ${sessionId}`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(true)
    })

    it('matches --hapi-session-id= form', () => {
        const cmd = `hapi cursor --started-by=runner --hapi-session-id=${sessionId}`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(true)
    })

    it('rejects terminal-started sessions', () => {
        const cmd = `bun src/index.ts claude --started-by terminal --existing-session-id ${sessionId}`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(false)
    })

    it('rejects --resume native id that merely equals the session string', () => {
        // Guard: native agent resume ids must not be treated as HAPI row ids.
        const cmd = `bun src/index.ts cursor --resume ${sessionId} --started-by runner`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(false)
    })

    it('rejects substring false positives', () => {
        const cmd = `bun src/index.ts claude --started-by runner --existing-session-id ${sessionId}-extra`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(false)
    })

    it('selectOrphanPidsForSession filters non-hapi and self', () => {
        const pids = selectOrphanPidsForSession(
            [
                { pid: 1, cmd: 'systemd', name: 'systemd' },
                { pid: 42, cmd: `bun src/index.ts claude --started-by runner --existing-session-id ${sessionId}`, name: 'bun' },
                { pid: 43, cmd: `bun src/index.ts claude --started-by runner --existing-session-id other`, name: 'bun' },
                { pid: process.pid, cmd: `bun src/index.ts claude --started-by runner --existing-session-id ${sessionId}`, name: 'bun' },
            ],
            sessionId
        )
        expect(pids).toEqual([42])
    })
})

describe('reapRunnerSpawnedOrphans (stopSession orphan path)', () => {
    it('returns null when no argv orphans match', async () => {
        const status = await reapRunnerSpawnedOrphans('missing-session', {
            findOrphans: async () => [],
            killTree: async () => {
                throw new Error('should not kill')
            },
        })
        expect(status).toBeNull()
    })

    it('kills matching orphan PIDs and returns stopped when maps would have missed', async () => {
        const killed: number[] = []
        const status = await reapRunnerSpawnedOrphans('sess-orphan-1', {
            findOrphans: async (sessionId) => {
                expect(sessionId).toBe('sess-orphan-1')
                return [4242, 4243]
            },
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
        })
        expect(status).toBe('stopped')
        expect(killed).toEqual([4242, 4243])
    })

    it('returns still_alive when the process scan fails', async () => {
        const status = await reapRunnerSpawnedOrphans('sess-orphan-scan-fail', {
            findOrphans: async () => 'scan_failed',
            killTree: async () => {
                throw new Error('should not kill')
            },
        })
        expect(status).toBe('still_alive')
    })

    it('returns still_alive when tree-kill cannot prove death', async () => {
        const status = await reapRunnerSpawnedOrphans('sess-orphan-2', {
            findOrphans: async () => [9999],
            killTree: async () => false,
        })
        expect(status).toBe('still_alive')
    })
})
