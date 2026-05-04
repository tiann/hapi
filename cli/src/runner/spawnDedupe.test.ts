import { describe, it, expect } from 'vitest'
import { buildRunnerSpawnKey, findReusableRunnerSpawnSession } from './spawnDedupe'

describe('runner spawn dedupe helpers', () => {
    it('builds the same key for the same simple runner target', () => {
        const first = buildRunnerSpawnKey({
            directory: './repo',
            sessionId: 'hub-session-a',
            machineId: 'machine-a',
            agent: 'codex',
            resumeSessionId: 'codex-thread-1',
            model: 'gpt-5.5',
            modelReasoningEffort: 'xhigh',
            permissionMode: 'yolo',
        })
        const second = buildRunnerSpawnKey({
            directory: './repo',
            sessionId: 'hub-session-b',
            machineId: 'machine-b',
            agent: 'codex',
            resumeSessionId: 'codex-thread-1',
            model: 'gpt-5.5',
            modelReasoningEffort: 'xhigh',
            permissionMode: 'yolo',
        })

        expect(first).toBe(second)
    })

    it('separates different resume targets and auth tokens', () => {
        const base = buildRunnerSpawnKey({
            directory: './repo',
            agent: 'codex',
            resumeSessionId: 'codex-thread-1',
            token: 'token-a',
        })
        const differentResume = buildRunnerSpawnKey({
            directory: './repo',
            agent: 'codex',
            resumeSessionId: 'codex-thread-2',
            token: 'token-a',
        })
        const differentToken = buildRunnerSpawnKey({
            directory: './repo',
            agent: 'codex',
            resumeSessionId: 'codex-thread-1',
            token: 'token-b',
        })

        expect(base).not.toBe(differentResume)
        expect(base).not.toBe(differentToken)
        expect(differentToken).not.toContain('token-b')
    })

    it('treats missing and false yolo as the same target', () => {
        const withoutYolo = buildRunnerSpawnKey({
            directory: './repo',
            agent: 'codex',
            resumeSessionId: 'codex-thread-1',
        })
        const falseYolo = buildRunnerSpawnKey({
            directory: './repo',
            agent: 'codex',
            resumeSessionId: 'codex-thread-1',
            yolo: false,
        })

        expect(withoutYolo).toBe(falseYolo)
    })

    it('finds only live runner-spawned sessions with the same key', () => {
        const spawnKey = buildRunnerSpawnKey({
            directory: './repo',
            agent: 'codex',
            resumeSessionId: 'codex-thread-1',
        })
        expect(spawnKey).not.toBeNull()
        const liveSpawnKey = spawnKey!

        const reusable = findReusableRunnerSpawnSession([
            { startedBy: 'runner', pid: 10, spawnKey: 'other-key', happySessionId: 'other-session' },
            { startedBy: 'hapi directly - likely by user from terminal', pid: 11, spawnKey: liveSpawnKey, happySessionId: 'terminal-session' },
            { startedBy: 'runner', pid: 12, spawnKey: liveSpawnKey, happySessionId: 'dead-session' },
            { startedBy: 'runner', pid: 13, spawnKey: liveSpawnKey, happySessionId: 'live-session' },
        ], liveSpawnKey, (pid) => pid === 13)

        expect(reusable?.happySessionId).toBe('live-session')
    })
})
