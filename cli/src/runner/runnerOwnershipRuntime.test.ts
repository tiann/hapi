import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startVerifiedRunnerOwnership } from './runnerOwnershipRuntime'

const helperCommand = {
    executable: 'bun',
    argsPrefix: [join(process.cwd(), 'src/index.ts'), '__hapi_internal_runner_lock_helper_v1']
}

const homes: string[] = []
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))))

describe('startVerifiedRunnerOwnership', () => {
    it('holds one persistent kernel lock and opens the durable journal for this runner instance', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-runner-ownership-'))
        homes.push(home)
        const first = await startVerifiedRunnerOwnership({ home, runnerInstanceId: 'runner-a', helperCommand })
        try {
            await expect(startVerifiedRunnerOwnership({ home, runnerInstanceId: 'runner-b', helperCommand })).rejects.toThrow('already locked')
            expect((await first.journal.snapshot()).writerId).toBe(`${first.installationId}:runner-a`)
            expect((await stat(join(home, 'runner.lock'))).isFile()).toBe(true)
        } finally {
            await first.close('test-complete')
        }
        expect((await stat(join(home, 'runner.lock'))).isFile()).toBe(true)
    })

    it('requires a continuous ready heartbeat window before clearing crash-loop evidence', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-runner-ownership-'))
        homes.push(home)
        const owner = await startVerifiedRunnerOwnership({
            home, runnerInstanceId: 'runner-health', helperCommand, healthyResetMs: 40
        })
        try {
            owner.markHealthyHeartbeat()
            owner.markHeartbeatUnhealthy()
            await new Promise((resolve) => setTimeout(resolve, 55))
            expect(Object.values((await owner.journal.snapshot()).startAttempts)[0]?.status).toBe('open')

            owner.markHealthyHeartbeat()
            await vi.waitFor(async () => {
                expect(Object.values((await owner.journal.snapshot()).startAttempts)[0]?.status).toBe('complete')
            })
        } finally {
            await owner.close('test-complete')
        }
    })

    it('awaits the timer-owned durable completion instead of completing the start attempt twice', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-runner-ownership-'))
        homes.push(home)
        const owner = await startVerifiedRunnerOwnership({
            home, runnerInstanceId: 'runner-completion-race', helperCommand, healthyResetMs: 5
        })
        const originalComplete = owner.journal.completeStartAttempt.bind(owner.journal)
        let releaseCompletion!: () => void
        const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve })
        let completionCalls = 0
        owner.journal.completeStartAttempt = async (...args) => {
            completionCalls += 1
            await completionGate
            await originalComplete(...args)
        }

        let closePromise: Promise<void> | null = null
        try {
            owner.markHealthyHeartbeat()
            await vi.waitFor(() => expect(completionCalls).toBe(1))

            closePromise = owner.close('test-complete')
            await new Promise((resolve) => setImmediate(resolve))
            const callsBeforeRelease = completionCalls
            releaseCompletion()

            await expect(closePromise).resolves.toBeUndefined()
            expect(callsBeforeRelease).toBe(1)
            expect(completionCalls).toBe(1)
        } finally {
            releaseCompletion()
            await closePromise?.catch(() => {})
            await owner.helper.close()
        }
    })
})
