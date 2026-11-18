import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerLifecycle } from './runnerLifecycle'

const harness = vi.hoisted(() => ({
    loop: vi.fn(),
    kill: vi.fn(),
    session: {
        rpcHandlerManager: { registerHandler: vi.fn() },
        onUserMessage: vi.fn(),
        onCancelQueuedMessage: vi.fn(),
        onRetryQueuedMessage: vi.fn(),
        updateMetadata: vi.fn(),
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => true),
        close: vi.fn(async () => {})
    },
    instance: {
        model: null,
        stopKeepAlive: vi.fn(),
        pushKeepAlive: vi.fn(),
        setPermissionMode: vi.fn(),
        setModel: vi.fn(),
        setEffort: vi.fn(),
        setAgentMode: vi.fn(),
        getAgentMode: vi.fn(() => 'interactive'),
        kill: () => harness.kill()
    }
}))

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: async () => ({ api: {}, session: harness.session, metadata: {}, sessionInfo: {} })
}))
vi.mock('@/agent/runnerLifecycle', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./runnerLifecycle')>()
    return {
        ...actual,
        setControlledByUser: vi.fn(),
        createRunnerLifecycle: vi.fn((options: Parameters<typeof actual.createRunnerLifecycle>[0]) => {
            const lifecycle = actual.createRunnerLifecycle(options)
            return { ...lifecycle, registerProcessHandlers: vi.fn(), cleanupAndExit: vi.fn(lifecycle.cleanup) }
        })
    }
})
vi.mock('@/claude/registerKillSessionHandler', () => ({ registerKillSessionHandler: vi.fn() }))
vi.mock('@/agent/localHandoff', () => ({ registerLocalHandoffHandler: vi.fn() }))
vi.mock('@/modules/common/handlers/kimiModels', () => ({ registerKimiSessionModelHandlers: vi.fn() }))
vi.mock('@/kimi/loop', () => ({ kimiLoop: harness.loop }))
vi.mock('@/cursor/loop', () => ({ loop: harness.loop }))
vi.mock('@/copilot/loop', () => ({ copilotLoop: harness.loop }))
vi.mock('@/grok/loop', () => ({ grokLoop: harness.loop }))

import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
import { runKimi } from '@/kimi/runKimi'
import { runCursor } from '@/cursor/runCursor'
import { runCopilot } from '@/copilot/runCopilot'
import { runGrok } from '@/grok/runGrok'

describe('ACP runner shutdown wiring', () => {
    beforeEach(() => vi.clearAllMocks())

    it('archives and closes the session when the launcher kill hook rejects', async () => {
        const remoteLoop = Promise.withResolvers<void>()
        harness.loop.mockImplementation(async (options: { onSessionReady: (instance: unknown) => void }) => {
            options.onSessionReady(harness.instance)
            await remoteLoop.promise
        })
        harness.kill.mockRejectedValue(new Error('launcher kill failed'))
        const running = runKimi({ workingDirectory: process.cwd() })
        const failure = running.catch(() => undefined)
        try {
            await vi.waitFor(() => expect(harness.loop).toHaveBeenCalledOnce())
            const lifecycle = vi.mocked(registerKillSessionHandler).mock.calls[0][1] as RunnerLifecycle
            await expect(lifecycle.cleanupAndExit()).resolves.toBeUndefined()
            expect(harness.kill).toHaveBeenCalledOnce()
            expect(harness.session.updateMetadata).toHaveBeenCalledWith(expect.any(Function))
            expect(harness.session.sendSessionDeath).toHaveBeenCalledExactlyOnceWith('terminated')
            expect(harness.session.close).toHaveBeenCalledOnce()
        } finally {
            remoteLoop.resolve()
            await failure
        }
    })

    it.each([runKimi, runCursor, runCopilot, runGrok])('%s waits for kill before reporting termination', async (run) => {
        const remoteLoop = Promise.withResolvers<void>()
        const disconnect = Promise.withResolvers<void>()
        harness.loop.mockImplementation(async (options: { onSessionReady: (instance: unknown) => void }) => {
            options.onSessionReady(harness.instance)
            await remoteLoop.promise
        })
        harness.kill.mockImplementation(async () => {
            remoteLoop.resolve()
            await disconnect.promise
        })
        const running = run({ workingDirectory: process.cwd() })
        const failure = running.catch(() => undefined)
        try {
            await vi.waitFor(() => expect(harness.loop).toHaveBeenCalledOnce())
            const lifecycle = vi.mocked(registerKillSessionHandler).mock.calls[0][1] as RunnerLifecycle
            const cleaning = lifecycle.cleanupAndExit()
            void cleaning.catch(() => undefined)
            expect(harness.kill).toHaveBeenCalledOnce()
            await vi.waitFor(() => expect(lifecycle.cleanupAndExit).toHaveBeenCalledTimes(2))
            expect(harness.session.sendSessionDeath).not.toHaveBeenCalled()
            disconnect.resolve()
            await cleaning
            await running
            expect(harness.session.sendSessionDeath).toHaveBeenCalledExactlyOnceWith('terminated')
            expect(harness.session.close).toHaveBeenCalledOnce()
        } finally {
            remoteLoop.resolve()
            disconnect.resolve()
            await failure
        }
    })
})
