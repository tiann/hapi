import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol'
import { MessageQueue2 } from '@/utils/MessageQueue2'

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
        getLogPath: vi.fn(() => '/tmp/dsh-test/hapi.log'),
        debug: vi.fn()
    }
}))
vi.mock('./dshRemoteLauncher', () => ({
    DshRemoteLauncher: class {
        constructor(...args: unknown[]) {
            harness.launcherConstructor(...args)
        }

        async launch(): Promise<void> {
            await harness.launcherLaunch()
        }

        async kill(): Promise<void> {}
    }
}))

import { runDsh } from './runDsh'

describe('runDsh', () => {
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
                id: 'hapi-session-dsh',
                metadata: { dshSessionId: 'dsh-session-1' }
            }
        })
    })

    type LauncherOpts = {
        onEffortRollback?: (effort: string | null | undefined) => void
        onEffortDiscovered?: (effort: string) => void
        onConfigDiscovered?: (model: string | null) => void
    }

    /** A fresh (not resumed) DSH session; returns what the launcher was built with. */
    async function launchFresh(opts: { modelReasoningEffort?: string } = {}): Promise<LauncherOpts> {
        harness.bootstrapSession.mockResolvedValue({
            api: {},
            session: harness.session,
            sessionInfo: { id: 'hapi-session-dsh', metadata: {} },
            metadata: {}
        })
        await runDsh({ startedBy: 'runner', workingDirectory: '/tmp/project', ...opts })
        return harness.launcherConstructor.mock.calls.at(-1)![1] as LauncherOpts
    }

    function lastKeepAliveRuntime(): Record<string, unknown> {
        return harness.session.keepAlive.mock.calls.at(-1)![2] as Record<string, unknown>
    }

    /** Drive one user turn through the registered callback and return the queued mode. */
    function queuedMode(): Record<string, unknown> {
        const push = vi.spyOn(MessageQueue2.prototype, 'push')
        try {
            // The session mock is shared across tests: the LAST registration is this run's.
            const onUserMessage = harness.session.onUserMessage.mock.calls.at(-1)![0] as (message: unknown, localId: string) => void
            onUserMessage({ content: { text: 'hello', attachments: [] } }, 'local-1')
            return push.mock.calls[0]![1] as Record<string, unknown>
        } finally {
            push.mockRestore()
        }
    }

    it('seeds a spawn-time reasoning effort into the hub row and every queued turn', async () => {
        const launcherOpts = await launchFresh({ modelReasoningEffort: 'max' })

        expect(harness.bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({ flavor: 'dsh', modelReasoningEffort: 'max' }))
        launcherOpts.onConfigDiscovered?.('["deepseek-official","glm-5.4"]')
        expect(lastKeepAliveRuntime().modelReasoningEffort).toBe('max')
        expect(queuedMode().modelReasoningEffort).toBe('max')
    })

    it('shows the level the agent really runs with when nothing was requested', async () => {
        const launcherOpts = await launchFresh()

        launcherOpts.onEffortDiscovered?.('high')
        expect(lastKeepAliveRuntime().modelReasoningEffort).toBe('high')
        expect(queuedMode().modelReasoningEffort).toBe('high')
    })

    it('clears a dropped effort once, then carries no effort opinion on later turns', async () => {
        const launcherOpts = await launchFresh()

        launcherOpts.onEffortRollback?.('max')
        launcherOpts.onEffortRollback?.(undefined)
        // This one keepalive overwrites the hub value (null), so the picker
        // drops the failed pick…
        expect(lastKeepAliveRuntime().modelReasoningEffort).toBeNull()
        // …and later turns carry NO effort field: normalizing the dropped
        // preference to null would re-request "Default" (which dsh rejects)
        // and fail on every single turn.
        expect(queuedMode()).not.toHaveProperty('modelReasoningEffort')
    })

    it('registers the local handoff RPC for an active DSH resume', async () => {
        await runDsh({
            existingSessionId: 'hapi-session-dsh',
            resumeSessionId: 'dsh-session-1',
            startedBy: 'terminal',
            startingMode: 'remote',
            workingDirectory: '/tmp/project'
        })

        expect(harness.session.rpcHandlerManager.registerHandler).toHaveBeenCalledWith(
            RPC_METHODS.HandoffLocal,
            expect.any(Function)
        )
    })
})
