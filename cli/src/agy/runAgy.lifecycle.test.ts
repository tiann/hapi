import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
    failAt: '' as 'hook' | 'mcp' | 'carrier' | 'permission' | '',
    hookStop: vi.fn(),
    mcpStop: vi.fn(),
    carrierCleanup: vi.fn(),
    sessionClose: vi.fn(),
    sendSessionDeath: vi.fn(),
    lifecycle: null as null | { cleanup: () => Promise<void> },
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
    startHookServer: vi.fn(async () => {
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
    },
}))
vi.mock('./loop', () => ({ agyLoop: vi.fn(async () => {}) }))
vi.mock('@/utils/spawnHappyCLI', () => ({ getHappyCliCommand: vi.fn(() => ({ command: 'hapi', args: [] })) }))
vi.mock('@/modules/common/shellQuote', () => ({ shellJoin: vi.fn(() => 'hapi hook-forwarder') }))
vi.mock('@/modules/common/hooks/generateHookSettings', () => ({ buildAgyHooksJson: vi.fn(() => ({})) }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))

import { runAgy } from './runAgy'

describe('runAgy post-bootstrap setup lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        h.failAt = ''
        h.lifecycle = null
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
})
