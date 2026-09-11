import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { AGENT_FLAVORS } from '@hapi/protocol/modes'
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/rpcTypes'

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(), available: vi.fn(() => ({ available: true })),
    validate: vi.fn(async () => ({ type: 'success', created: false })),
    control: vi.fn(), kill: vi.fn(async () => false)
}))
vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: mocks.spawn }))
vi.mock('@/agent/agentAvailability', () => ({ getAgentAvailability: mocks.available, agentUnavailableMessage: () => 'unavailable' }))
vi.mock('./validateWorkspaceDirectory', () => ({ validateWorkspaceDirectory: mocks.validate }))
vi.mock('./controlServer', () => ({ startRunnerControlServer: mocks.control }))
vi.mock('./controlClient', () => ({
    isRunnerRunningCurrentlyInstalledHappyVersion: async () => false, stopRunner: async () => {}
}))
vi.mock('@/persistence', () => ({ acquireRunnerLock: async () => ({}), readRunnerState: async () => null }))
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: async () => ({ machineId: 'test' }) }))
vi.mock('@/ui/doctor', () => ({ getEnvironmentInfo: () => ({}) }))
vi.mock('@/ui/logger', () => ({ logger: { debug() {}, debugLargeJson() {} } }))
vi.mock('node:fs', async (original) => ({
    ...await original<typeof import('node:fs')>(),
    existsSync: () => false, writeFileSync: () => {}, renameSync: () => {}
}))
vi.mock('@/utils/process', () => ({
    isWindows: () => false, isProcessAlive: () => true, getProcessStartMarker: () => 'test-generation',
    killProcessByChildProcess: mocks.kill
}))

import { startRunner } from './run'

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    mocks.spawn.mockReset()
    mocks.available.mockReset().mockReturnValue({ available: true })
    mocks.validate.mockReset().mockResolvedValue({ type: 'success', created: false })
})

async function withRunner(run: (spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>) => Promise<void>) {
    const listeners = new Map(process.eventNames().map((event) => [event, new Set(process.listeners(event))]))
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.stubEnv('HAPI_RUNNER_HANDOFF_FROM_PID', '')
    vi.stubEnv('HAPI_RUNNER_WEBHOOK_TIMEOUT_MS', '20')
    let assertionError: unknown
    let entered = false
    mocks.control.mockImplementation(async (handlers) => {
        entered = true
        try { await run(handlers.spawnSession) } catch (error) { assertionError = error }
        throw new Error('End isolated runner test before connecting to hub')
    })
    try {
        await startRunner()
        expect(entered).toBe(true)
        if (assertionError) throw assertionError
    } finally {
        for (const event of process.eventNames()) {
            for (const listener of process.listeners(event)) {
                if (!listeners.get(event)?.has(listener)) process.removeListener(event, listener)
            }
        }
    }
}

describe('runner spawn process provenance', () => {
    it('reports false for unavailable agents, path rejection and thrown validation', async () => {
        await withRunner(async (spawn) => {
            for (const agent of AGENT_FLAVORS) {
                mocks.available.mockReturnValueOnce({ available: false })
                expect(await spawn({ directory: '/workspace', agent })).toMatchObject({ type: 'error', processStarted: false })
            }
            expect(await spawn({ directory: '/workspace', validateDirectory: async () => false })).toMatchObject({ type: 'error', processStarted: false })
            mocks.validate.mockRejectedValueOnce(new Error('validation failed'))
            expect(await spawn({ directory: '/workspace' })).toMatchObject({ type: 'error', processStarted: false })
            expect(mocks.spawn).not.toHaveBeenCalled()
        })
    })

    it('reports false for no-PID and synchronous spawn failures, but true after a PID exists', async () => {
        await withRunner(async (spawn) => {
            mocks.spawn.mockReturnValueOnce(new EventEmitter())
            expect(await spawn({ directory: '/workspace' })).toMatchObject({ type: 'error', processStarted: false })
            mocks.spawn.mockImplementationOnce(() => { throw new Error('spawn failed') })
            expect(await spawn({ directory: '/workspace' })).toMatchObject({ type: 'error', processStarted: false })
            mocks.spawn.mockReturnValueOnce(Object.assign(new EventEmitter(), { pid: 123456 }))
            expect(await spawn({ directory: '/workspace', existingSessionId: 'child' })).toMatchObject({ type: 'error', processStarted: true })
            // Timeout may have initiated termination, but it is not proof of no process.
            expect(mocks.kill).toHaveBeenCalled()
        })
    })

    it('keeps started evidence after an exit or process error before the webhook', async () => {
        await withRunner(async (spawn) => {
            for (const event of ['exit', 'error']) {
                mocks.spawn.mockImplementationOnce(() => {
                    const child = Object.assign(new EventEmitter(), { pid: 123456 })
                    setImmediate(() => event === 'exit' ? child.emit('exit', 1, null) : child.emit('error', new Error('failed')))
                    return child
                })
                expect(await spawn({ directory: '/workspace', existingSessionId: `child-${event}` })).toMatchObject({ type: 'error', processStarted: true })
            }
        })
    })
})
