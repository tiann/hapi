import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'

const harness = vi.hoisted(() => ({
    registerHandler: vi.fn(),
    session: {
        onUserMessage: vi.fn(),
        onCancelQueuedMessage: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() }
    },
    wrapper: {
        setPermissionMode: vi.fn(),
        setModel: vi.fn(),
        setEffort: vi.fn(),
        pushKeepAlive: vi.fn(),
        stopKeepAlive: vi.fn(),
        kill: vi.fn()
    }
}))

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: vi.fn(async () => ({ api: {}, session: harness.session })),
    bootstrapExistingSession: vi.fn(async () => ({ api: {}, session: harness.session }))
}))

vi.mock('./loop', () => ({
    agyLoop: vi.fn(async (options: Record<string, unknown>) => {
        const onSessionReady = options.onSessionReady as (session: unknown) => void
        onSessionReady(harness.wrapper)
    })
}))

vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn()
}))

vi.mock('@/agent/localHandoff', () => ({
    registerLocalHandoffHandler: vi.fn()
}))

vi.mock('@/agent/runnerLifecycle', () => ({
    createModeChangeHandler: vi.fn(() => vi.fn()),
    createRunnerLifecycle: vi.fn(() => ({
        registerProcessHandlers: vi.fn(),
        cleanupAndExit: vi.fn(async () => {}),
        markCrash: vi.fn(),
        setSessionEndReason: vi.fn()
    }))
}))

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() }
}))

import { runAgy } from './runAgy'

describe('runAgy set-session-config handler', () => {
    beforeEach(() => {
        harness.session.rpcHandlerManager.registerHandler.mockReset()
        harness.wrapper.setPermissionMode.mockReset()
        harness.wrapper.setModel.mockReset()
        harness.wrapper.setEffort.mockReset()
        harness.wrapper.pushKeepAlive.mockReset()
    })

    it('persists null when resetting effort to Auto', async () => {
        await runAgy({ effort: 'high', workingDirectory: '/tmp/project' })
        harness.wrapper.setEffort.mockClear()

        const call = harness.session.rpcHandlerManager.registerHandler.mock.calls.find(
            (args) => args[0] === RPC_METHODS.SetSessionConfig
        )
        expect(call).toBeDefined()

        await call![1]({ effort: null })

        expect(harness.wrapper.setEffort).toHaveBeenCalledWith(null)
    })
})
