import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { KimiMode } from './types'

const harness = vi.hoisted(() => ({
    prompts: [] as unknown[][],
    configCalls: [] as unknown[][],
    thinking: 'on'
}))

vi.mock('./utils/kimiBackend', () => ({
    createKimiBackend: vi.fn(() => ({
        initialize: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'kimi-session-1'),
        loadSession: vi.fn(async () => 'kimi-session-1'),
        // Mimics config_option_update: a new model reports its own level.
        setModel: vi.fn(async (_sessionId: string, model: string) => {
            if (model === 'kimi-k3') harness.thinking = 'medium'
        }),
        getThoughtLevelConfigOption: vi.fn(() => ({ id: 'thinking', currentValue: harness.thinking, options: [] })),
        setConfigOption: vi.fn(async (...args: unknown[]) => {
            harness.configCalls.push(args)
            harness.thinking = args[2] as string
        }),
        prompt: vi.fn(async (_sessionId: string, content: unknown[]) => {
            harness.prompts.push(content)
        }),
        cancelPrompt: vi.fn(async () => {}),
        respondToPermission: vi.fn(async () => {}),
        onStderrError: vi.fn(),
        setSessionInfoUpdateListener: vi.fn(),
        refreshSessionInfo: vi.fn(async () => {}),
        onPermissionRequest: vi.fn(),
        disconnect: vi.fn(async () => {})
    }))
}))

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: { stop: () => {} },
        mcpServers: {}
    })
}))

vi.mock('./utils/permissionHandler', () => ({
    KimiPermissionHandler: class {
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('@/ui/ink/KimiDisplay', () => ({ KimiDisplay: () => null }))
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))

import { kimiRemoteLauncher } from './kimiRemoteLauncher'

function createSession(modes: KimiMode[] = [
    { permissionMode: 'default', model: 'kimi-k2' },
    { permissionMode: 'default', model: 'kimi-k2' }
]) {
    const queue = new MessageQueue2<KimiMode>((mode) => JSON.stringify(mode))
    queue.pushIsolateAndClear('first', modes[0])
    queue.push('second', modes[1])
    queue.close()

    const session = {
        path: '/tmp/kimi-test',
        logPath: '/tmp/kimi-test/test.log',
        client: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            sendAgentMessage: vi.fn(),
            getMetadata: vi.fn(() => null),
            updateMetadata: vi.fn(),
            sendSessionEvent: vi.fn()
        },
        queue,
        sessionId: null as string | null,
        getPermissionMode: () => 'default' as const,
        onSessionFound(id: string) { session.sessionId = id },
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        setEffort: vi.fn(),
        pushKeepAlive: vi.fn()
    }
    return session
}

describe('kimiRemoteLauncher skill lookup instruction', () => {
    afterEach(() => {
        harness.prompts = []
        harness.configCalls = []
        harness.thinking = 'on'
    })

    it('does not prepend skill_lookup instructions onto user turns', async () => {
        await kimiRemoteLauncher(createSession() as never, { model: 'kimi-k2' })

        expect(harness.prompts).toHaveLength(2)
        expect(JSON.stringify(harness.prompts[0])).toContain('first')
        expect(JSON.stringify(harness.prompts[0])).not.toContain('skill_lookup')
        expect(JSON.stringify(harness.prompts[0])).not.toContain('$name')
        expect(JSON.stringify(harness.prompts[1])).not.toContain('skill_lookup')
    })

    it('applies the queued effort and resets to the agent default', async () => {
        await kimiRemoteLauncher(createSession([
            { permissionMode: 'default', model: 'kimi-k2', effort: 'high' },
            { permissionMode: 'default', model: 'kimi-k2', effort: null }
        ]) as never, { model: 'kimi-k2' })

        expect(harness.configCalls).toEqual([
            ['kimi-session-1', 'thinking', 'high'],
            ['kimi-session-1', 'thinking', 'on']
        ])
    })

    it('re-applies the selected effort after a model switch changes the agent level', async () => {
        await kimiRemoteLauncher(createSession([
            { permissionMode: 'default', model: 'kimi-k2', effort: 'high' },
            { permissionMode: 'default', model: 'kimi-k3', effort: 'high' }
        ]) as never, { model: 'kimi-k2' })

        expect(harness.configCalls).toEqual([
            ['kimi-session-1', 'thinking', 'high'],
            ['kimi-session-1', 'thinking', 'high']
        ])
    })
})
