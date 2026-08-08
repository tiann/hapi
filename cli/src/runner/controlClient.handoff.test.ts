import { describe, expect, it } from 'vitest'
import { waitForRunnerHandoff } from './controlClient'
import type { RunnerLocallyPersistedState } from '@/persistence'

function baseState(overrides: Partial<RunnerLocallyPersistedState>): RunnerLocallyPersistedState {
    return {
        pid: 1,
        httpPort: 1,
        startTime: 'now',
        startedWithCliVersion: '0.1.0',
        ...overrides,
    }
}

describe('waitForRunnerHandoff', () => {
    it('does not confirm handoff when the child has a new PID but no hubReadyAt', async () => {
        const ok = await waitForRunnerHandoff(100, {
            timeoutMs: 80,
            pollIntervalMs: 20,
            readState: async () => baseState({ pid: 200 }),
            isAlive: () => true,
        })
        expect(ok).toBe(false)
    })

    it('times out when the child is alive but never reaches hub readiness (socket never connects)', async () => {
        // Simulates connectUntilReady never resolving: PID claimed, process live,
        // but hubReadyAt never written.
        const ok = await waitForRunnerHandoff(42, {
            timeoutMs: 60,
            pollIntervalMs: 15,
            readState: async () => baseState({ pid: 99 }),
            isAlive: (pid) => pid === 99,
        })
        expect(ok).toBe(false)
    })

    it('confirms handoff when the child has a new live PID with hubReadyAt', async () => {
        const ok = await waitForRunnerHandoff(100, {
            timeoutMs: 500,
            pollIntervalMs: 20,
            readState: async () => baseState({ pid: 200, hubReadyAt: Date.now() }),
            isAlive: () => true,
        })
        expect(ok).toBe(true)
    })
})
