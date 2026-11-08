import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol'

const harness = vi.hoisted(() => {
    const session = {
        rpcHandlerManager: { registerHandler: vi.fn() },
        keepAlive: vi.fn(),
        emitMessagesConsumed: vi.fn(),
        updateMetadata: vi.fn(),
        onUserMessage: vi.fn(),
        onCancelQueuedMessage: vi.fn()
    }
    const lifecycleOptions: { stopKeepAlive?: () => void; onBeforeClose?: () => void | Promise<void> } = {}
    const lifecycle = {
        registerProcessHandlers: vi.fn(),
        cleanupAndExit: vi.fn(async () => {
            lifecycleOptions.stopKeepAlive?.()
        }),
        markCrash: vi.fn(),
        setSessionEndReason: vi.fn(),
        setArchiveReason: vi.fn()
    }

    return {
        session,
        lifecycle,
        lifecycleOptions,
        bootstrapExistingSession: vi.fn(),
        bootstrapSession: vi.fn(),
        setControlledByUser: vi.fn(),
        createRunnerLifecycle: vi.fn((options: typeof lifecycleOptions) => {
            lifecycleOptions.stopKeepAlive = options.stopKeepAlive
            lifecycleOptions.onBeforeClose = options.onBeforeClose
            return lifecycle
        }),
        registerKillSessionHandler: vi.fn(),
        registerSessionConfigRpc: vi.fn(),
        launcherLaunch: vi.fn(async () => {}),
        launcherConstructor: vi.fn()
    }
})

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapExistingSession: harness.bootstrapExistingSession,
    bootstrapSession: harness.bootstrapSession
}))
vi.mock('@/agent/runnerLifecycle', () => ({
    createRunnerLifecycle: harness.createRunnerLifecycle,
    setControlledByUser: harness.setControlledByUser
}))
vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: harness.registerKillSessionHandler
}))
vi.mock('@/agent/sessionConfigRpc', () => ({
    registerSessionConfigRpc: harness.registerSessionConfigRpc
}))
vi.mock('@/ui/logger', () => ({
    logger: {
        getLogPath: vi.fn(() => '/tmp/hermes-test/hapi.log'),
        debug: vi.fn()
    }
}))
vi.mock('./hermesRemoteLauncher', () => ({
    HermesRemoteLauncher: class {
        constructor(...args: unknown[]) {
            harness.launcherConstructor(...args)
        }

        async launch(): Promise<void> {
            await harness.launcherLaunch()
        }

        async kill(): Promise<void> {}
    }
}))

import { runHermes } from './runHermes'

describe('runHermes', () => {
    beforeEach(() => {
        harness.session.rpcHandlerManager.registerHandler.mockClear()
        harness.lifecycleOptions.stopKeepAlive = undefined
        harness.lifecycleOptions.onBeforeClose = undefined
        harness.bootstrapExistingSession.mockReset()
        harness.bootstrapSession.mockReset()
        harness.setControlledByUser.mockClear()
        harness.createRunnerLifecycle.mockClear()
        harness.registerKillSessionHandler.mockClear()
        harness.registerSessionConfigRpc.mockClear()
        harness.launcherLaunch.mockClear()
        harness.launcherConstructor.mockClear()
        harness.bootstrapExistingSession.mockResolvedValue({
            api: {},
            session: harness.session,
            sessionInfo: {
                id: 'hapi-session-hermes',
                metadata: { hermesSessionId: 'hermes-session-1' }
            }
        })
    })

    it('registers the local handoff RPC for an active Hermes resume', async () => {
        await runHermes({
            existingSessionId: 'hapi-session-hermes',
            resumeSessionId: 'hermes-session-1',
            startedBy: 'terminal',
            startingMode: 'remote',
            workingDirectory: '/tmp/project'
        })

        expect(harness.session.rpcHandlerManager.registerHandler).toHaveBeenCalledWith(
            RPC_METHODS.HandoffLocal,
            expect.any(Function)
        )
    })

    it('registers the session config RPC with nullable models and ignored efforts', async () => {
        await runHermes({
            existingSessionId: 'hapi-session-hermes',
            startedBy: 'terminal',
            workingDirectory: '/tmp/project'
        })

        expect(harness.registerSessionConfigRpc).toHaveBeenCalledWith(expect.objectContaining({
            flavor: 'hermes',
            modelMode: 'nullable',
            modelReasoningEffortMode: 'ignore',
            effortMode: 'ignore'
        }))
    })

    it('hands the stored hermesSessionId to the launcher when no explicit resume id is given', async () => {
        await runHermes({
            existingSessionId: 'hapi-session-hermes',
            startedBy: 'terminal',
            workingDirectory: '/tmp/project'
        })

        // The launcher's first constructor argument is the HermesSession; its
        // native id is seeded from metadata.hermesSessionId.
        const sessionArg = harness.launcherConstructor.mock.calls[0]?.[0] as { sessionId?: string | null }
        expect(sessionArg.sessionId).toBe('hermes-session-1')
    })
})
