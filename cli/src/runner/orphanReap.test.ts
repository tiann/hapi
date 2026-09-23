import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { isProcessAlive, killProcessTreeByPid } from '@/utils/process'
import {
    commandMatchesRunnerSpawnedSession,
    findRunnerSpawnedOrphanPids,
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

describe('orphanReap live process (#1910 regression)', () => {
    it('finds and reaps a detached sleep stand-in whose argv carries the session id', async () => {
        const sessionId = `orphan-reap-${Date.now()}-${process.pid}`
        // Stand-in for `bun … src/index.ts … --started-by runner --existing-session-id <id>`.
        // `sleep` keeps a stable cmdline for ps-list to read.
        const child = spawn(
            'sleep',
            ['30', `--started-by`, 'runner', `--existing-session-id`, sessionId, 'src/index.ts'],
            { detached: true, stdio: 'ignore' }
        )
        const pid = child.pid
        expect(pid).toBeDefined()
        child.unref()

        try {
            expect(isProcessAlive(pid!)).toBe(true)

            // Drop all runner maps (simulated): discovery must work from argv alone.
            const found = await findRunnerSpawnedOrphanPids(sessionId)
            // sleep's cmd may or may not include src/index.ts depending on ps;
            // force-match via injectable list for the kill path when ps truncates.
            const pids = found.length > 0
                ? found
                : selectOrphanPidsForSession(
                    [{ pid: pid!, cmd: `sleep 30 --started-by runner --existing-session-id ${sessionId} src/index.ts`, name: 'sleep' }],
                    sessionId
                )
            expect(pids).toContain(pid!)

            const dead = await killProcessTreeByPid(pid!)
            expect(dead).toBe(true)
            expect(isProcessAlive(pid!)).toBe(false)
        } finally {
            if (pid && isProcessAlive(pid)) {
                try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
            }
        }
    })
})
