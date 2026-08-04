import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
    failAt: '' as 'hook' | 'mcp' | 'carrier' | 'permission' | '',
    hookStop: vi.fn(),
    mcpStop: vi.fn(),
    carrierCleanup: vi.fn(),
    sessionClose: vi.fn(),
    sendSessionDeath: vi.fn(),
    lifecycle: null as null | { cleanup: () => Promise<void> },
    // Captures the options passed to startHookServer so tests can invoke
    // onPreToolUse/onAgyPreInvocation directly, as agy would.
    hookServerOpts: null as null | {
        onPreToolUse?: (data: Record<string, unknown>) => Promise<unknown>
        onAgyPreInvocation?: (data: Record<string, unknown>) => void
    },
    // When set, the mocked agyLoop invokes onSessionReady with this fake
    // wrapper (mirroring how the real AgySession is handed to onSessionReady
    // once the PTY session is up) so tests can control wrapper.sessionId.
    sessionReadyWrapper: null as null | {
        sessionId: string | null
        onSessionFound: (id: string) => void
        setPermissionMode: () => void
        setModel: () => void
        setEffort: () => void
        pushKeepAlive: () => void
    },
    // Captures the options buildAgyHooksJson was called with, so tests can
    // assert the PreToolUse/PreInvocation commands were not swapped.
    buildAgyHooksJsonOptions: null as null | { preToolUseCommand: string; preInvocationCommand: string; hookName?: string },
}))

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapExistingSession: vi.fn(),
    bootstrapSession: vi.fn(async () => ({
        api: { sendSessionDeath: h.sendSessionDeath },
        session: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            onUserMessage: vi.fn(),
            onCancelQueuedMessage: vi.fn(),
            updateMetadata: vi.fn(),
            sendSessionDeath: h.sendSessionDeath,
            flush: vi.fn(async () => {}),
            close: h.sessionClose,
        },
    })),
}))

vi.mock('@/agent/runnerLifecycle', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agent/runnerLifecycle')>()
    return {
        ...actual,
        setControlledByUser: vi.fn(),
        createModeChangeHandler: vi.fn(() => vi.fn()),
        createRunnerLifecycle: vi.fn((options: Parameters<typeof actual.createRunnerLifecycle>[0]) => {
            const lifecycle = actual.createRunnerLifecycle(options)
            h.lifecycle = lifecycle
            return lifecycle
        }),
    }
})

vi.mock('@/claude/registerKillSessionHandler', () => ({ registerKillSessionHandler: vi.fn() }))
vi.mock('@/agent/localHandoff', () => ({ registerLocalHandoffHandler: vi.fn() }))
vi.mock('@/agent/sessionConfigRpc', () => ({ registerSessionConfigRpc: vi.fn() }))
vi.mock('@/claude/utils/startHookServer', () => ({
    startHookServer: vi.fn(async (opts: unknown) => {
        h.hookServerOpts = opts as typeof h.hookServerOpts
        if (h.failAt === 'hook') throw new Error('hook failed')
        return { port: 1234, token: 'token', stop: h.hookStop }
    }),
    extractToolName: vi.fn(), extractToolInput: vi.fn(), extractToolUseId: vi.fn(),
}))
vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: vi.fn(async () => {
        if (h.failAt === 'mcp') throw new Error('mcp failed')
        return { mcpServers: { hapi: { command: 'node', args: [] } }, server: { stop: h.mcpStop } }
    }),
}))
vi.mock('./utils/agyHookCarrier', () => ({
    prepareAgyHookCarrier: vi.fn(() => h.failAt === 'carrier' ? null : { carrierDir: '/tmp/carrier' }),
    cleanupAgyHookCarrier: h.carrierCleanup,
}))
vi.mock('./utils/agyPermissionHandler', () => ({
    AgyPermissionHandler: class {
        constructor() { if (h.failAt === 'permission') throw new Error('permission failed') }
        cancelAll() {}
        requestDecision = vi.fn(async () => ({ permissionDecision: 'allow' as const }))
    },
}))
vi.mock('./loop', () => ({
    agyLoop: vi.fn(async (opts: { onSessionReady?: (wrapper: unknown) => void }) => {
        if (h.sessionReadyWrapper) opts.onSessionReady?.(h.sessionReadyWrapper)
    }),
}))
// Reflect the real args back out (rather than a fixed constant) so the
// PreToolUse and PreInvocation forwarder commands built in runAgy.ts come out
// distinguishable — a fixed-constant mock can't catch the two commands being
// passed to buildAgyHooksJson in the wrong slots.
vi.mock('@/utils/spawnHappyCLI', () => ({ getHappyCliCommand: vi.fn((args: string[]) => ({ command: 'hapi', args })) }))
vi.mock('@/modules/common/shellQuote', () => ({ shellJoin: vi.fn((parts: string[]) => parts.join(' ')) }))
vi.mock('@/modules/common/hooks/generateHookSettings', () => ({
    buildAgyHooksJson: vi.fn((opts: { preToolUseCommand: string; preInvocationCommand: string; hookName?: string }) => {
        h.buildAgyHooksJsonOptions = opts
        return '{}'
    }),
}))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))

import { runAgy } from './runAgy'

describe('runAgy post-bootstrap setup lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        h.failAt = ''
        h.lifecycle = null
        h.hookServerOpts = null
        h.sessionReadyWrapper = null
        h.buildAgyHooksJsonOptions = null
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
        vi.spyOn(process, 'on').mockImplementation((() => process) as never)
    })

    for (const scenario of [
        { at: 'hook' as const, hook: 0, mcp: 0, carrier: 1 },
        { at: 'mcp' as const, hook: 1, mcp: 0, carrier: 1 },
        { at: 'carrier' as const, hook: 1, mcp: 1, carrier: 1 },
        { at: 'permission' as const, hook: 1, mcp: 1, carrier: 1 },
    ]) {
        it(`cleans every acquired resource exactly once when ${scenario.at} setup fails`, async () => {
            h.failAt = scenario.at
            await runAgy({ startingMode: 'pty', workingDirectory: '/tmp/project' })

            expect(h.sendSessionDeath).toHaveBeenCalledWith('error')
            expect(h.sendSessionDeath).toHaveBeenCalledTimes(1)
            expect(h.sessionClose).toHaveBeenCalledTimes(1)
            expect(h.hookStop).toHaveBeenCalledTimes(scenario.hook)
            expect(h.mcpStop).toHaveBeenCalledTimes(scenario.mcp)
            expect(h.carrierCleanup).toHaveBeenCalledTimes(scenario.carrier)

            await h.lifecycle?.cleanup()
            expect(h.sendSessionDeath).toHaveBeenCalledTimes(1)
            expect(h.sessionClose).toHaveBeenCalledTimes(1)
            expect(h.hookStop).toHaveBeenCalledTimes(scenario.hook)
            expect(h.mcpStop).toHaveBeenCalledTimes(scenario.mcp)
            expect(h.carrierCleanup).toHaveBeenCalledTimes(scenario.carrier)
        })
    }

    it('never swaps the fail-closed PreToolUse command with the fail-open PreInvocation command', async () => {
        await runAgy({ startingMode: 'pty', workingDirectory: '/tmp/project' })

        const opts = h.buildAgyHooksJsonOptions
        expect(opts).not.toBeNull()
        // Only the PreInvocation command is built with --event pre-invocation;
        // a positional-arg swap would put this string in preToolUseCommand
        // instead, silently turning the permission bridge fail-open.
        expect(opts!.preInvocationCommand).toContain('--event pre-invocation')
        expect(opts!.preToolUseCommand).not.toContain('--event')
    })
})

function fakeSessionWrapper(sessionId: string | null, onSessionFound: (id: string) => void) {
    return {
        sessionId,
        onSessionFound,
        setPermissionMode: vi.fn(),
        setModel: vi.fn(),
        setEffort: vi.fn(),
        pushKeepAlive: vi.fn(),
    }
}

describe('runAgy brain UUID adoption via agy hooks', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        h.failAt = ''
        h.lifecycle = null
        h.hookServerOpts = null
        h.sessionReadyWrapper = null
        h.buildAgyHooksJsonOptions = null
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
        vi.spyOn(process, 'on').mockImplementation((() => process) as never)
    })

    it('adopts the brain UUID from a PreInvocation hook when no sessionId is set yet', async () => {
        const onSessionFound = vi.fn()
        h.sessionReadyWrapper = fakeSessionWrapper(null, onSessionFound)

        await runAgy({ startingMode: 'pty', workingDirectory: '/tmp/project' })

        h.hookServerOpts!.onAgyPreInvocation!({ conversationId: 'new-uuid' })
        expect(onSessionFound).toHaveBeenCalledWith('new-uuid')
    })

    it('does not let a PreInvocation hook overwrite a resume-seeded sessionId (hostile-review risk card: resume/reconnect regression)', async () => {
        const onSessionFound = vi.fn()
        h.sessionReadyWrapper = fakeSessionWrapper('resumed-uuid', onSessionFound)

        await runAgy({ startingMode: 'pty', workingDirectory: '/tmp/project', resumeSessionId: 'resumed-uuid' })

        h.hookServerOpts!.onAgyPreInvocation!({ conversationId: 'different-uuid' })
        expect(onSessionFound).not.toHaveBeenCalled()
    })

    it('does not let a PreToolUse hook overwrite a resume-seeded sessionId (same first-wins guard, PreToolUse side)', async () => {
        const onSessionFound = vi.fn()
        h.sessionReadyWrapper = fakeSessionWrapper('resumed-uuid', onSessionFound)

        await runAgy({ startingMode: 'pty', workingDirectory: '/tmp/project', resumeSessionId: 'resumed-uuid' })

        await h.hookServerOpts!.onPreToolUse!({ conversationId: 'different-uuid', toolCall: { name: 'run_command' } })
        expect(onSessionFound).not.toHaveBeenCalled()
    })

    it('a PreInvocation hook with no conversationId is a no-op (agy always sends one, but stay defensive)', async () => {
        const onSessionFound = vi.fn()
        h.sessionReadyWrapper = fakeSessionWrapper(null, onSessionFound)

        await runAgy({ startingMode: 'pty', workingDirectory: '/tmp/project' })

        h.hookServerOpts!.onAgyPreInvocation!({})
        expect(onSessionFound).not.toHaveBeenCalled()
    })
})
