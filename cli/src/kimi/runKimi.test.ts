import { describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    order: [] as string[],
    registered: [] as Array<{ manager: unknown; getCwd: () => string }>,
    loopOptions: null as Record<string, unknown> | null,
    createSession: () => ({
        rpcHandlerManager: { registerHandler: vi.fn() },
        onUserMessage: vi.fn(),
        onCancelQueuedMessage: vi.fn()
    })
}))

vi.mock('@/modules/common/handlers/kimiModels', () => ({
    registerKimiSessionModelHandlers: (manager: unknown, getCwd: () => string) => {
        harness.order.push('register-kimi-models')
        harness.registered.push({ manager, getCwd })
    }
}))

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: async () => {
        harness.order.push('bootstrap')
        return {
            api: {},
            session: harness.createSession(),
            sessionInfo: {},
            metadata: {},
            machineId: 'machine-1',
            startedBy: 'terminal',
            workingDirectory: '/work/project'
        }
    },
    bootstrapExistingSession: async () => {
        harness.order.push('bootstrap')
        return {
            api: {},
            session: harness.createSession(),
            sessionInfo: {},
            metadata: {},
            machineId: 'machine-1',
            startedBy: 'terminal',
            workingDirectory: '/work/project'
        }
    }
}))

vi.mock('./loop', () => ({
    kimiLoop: async (options: Record<string, unknown>) => {
        harness.order.push('loop')
        harness.loopOptions = options
    }
}))

vi.mock('@/agent/runnerLifecycle', () => ({
    createRunnerLifecycle: () => ({
        registerProcessHandlers: vi.fn(),
        markCrash: vi.fn(),
        setExitCode: vi.fn(),
        setArchiveReason: vi.fn(),
        setSessionEndReason: vi.fn(),
        cleanupAndExit: async () => {}
    }),
    createModeChangeHandler: () => vi.fn(),
    setControlledByUser: vi.fn()
}))

vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn()
}))
vi.mock('@/agent/localHandoff', () => ({
    registerLocalHandoffHandler: vi.fn()
}))
vi.mock('./utils/config', () => ({
    resolveKimiRuntimeConfig: () => ({ model: undefined, modelSource: 'default' })
}))

import { runKimi } from './runKimi'

describe('runKimi session model discovery', () => {
    it('registers the session catalog before the local/remote loop starts', async () => {
        harness.order = []
        harness.registered = []
        harness.loopOptions = null

        await runKimi({ workingDirectory: '/work/project', startingMode: 'local' })

        // A locally running session must answer the picker's request even
        // though no remote launcher (and no ACP backend) exists yet.
        expect(harness.order).toEqual(['bootstrap', 'register-kimi-models', 'loop'])
        expect(harness.registered).toHaveLength(1)
    })

    it('probes the working directory the session was started in', async () => {
        harness.order = []
        harness.registered = []
        harness.loopOptions = null

        await runKimi({ workingDirectory: '/work/other-project', startingMode: 'local' })

        const loopOptions = harness.loopOptions as Record<string, unknown> | null
        expect(harness.registered[0]?.getCwd()).toBe('/work/other-project')
        expect(loopOptions?.path).toBe('/work/other-project')
    })
})
