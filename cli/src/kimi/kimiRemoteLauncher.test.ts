import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { KimiMode } from './types'

const harness = vi.hoisted(() => ({
    prompts: [] as unknown[][],
    setConfigOptionCalls: [] as unknown[][],
    thoughtLevelOption: {
        id: 'thought_level',
        currentValue: 'medium',
        options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }],
    }
}))

vi.mock('./utils/kimiBackend', () => ({
    createKimiBackend: vi.fn(() => ({
        initialize: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'kimi-session-1'),
        loadSession: vi.fn(async () => 'kimi-session-1'),
        setModel: vi.fn(async (_sessionId: string, model: string) => {
            harness.thoughtLevelOption = model === 'kimi-new'
                ? {
                    id: 'thought_level',
                    currentValue: 'low',
                    options: [{ value: 'low', name: 'Low' }],
                }
                : {
                    id: 'thought_level',
                    currentValue: 'medium',
                    options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }],
                }
        }),
        setConfigOption: vi.fn(async (...args: unknown[]) => {
            harness.setConfigOptionCalls.push(args)
        }),
        getThoughtLevelConfigOption: vi.fn(() => harness.thoughtLevelOption),
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

function createSession(
    firstMode: KimiMode = { permissionMode: 'default', model: 'kimi-k2' },
    secondMode: KimiMode = { permissionMode: 'default', model: 'kimi-k2' }
) {
    const queue = new MessageQueue2<KimiMode>((mode) => JSON.stringify(mode))
    queue.pushIsolateAndClear('first', firstMode)
    queue.push('second', secondMode)
    queue.close()

    const session = {
        path: '/tmp/kimi-test',
        logPath: '/tmp/kimi-test/test.log',
        client: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            sendAgentMessage: vi.fn(),
            sendSessionEvent: vi.fn()
        },
        queue,
        sessionId: null as string | null,
        setEffort: vi.fn(),
        setRemoteEffortApplier: vi.fn(),
        pushKeepAlive: vi.fn(),
        getPermissionMode: () => 'default' as const,
        onSessionFound(id: string) { session.sessionId = id },
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
    return session
}

describe('kimiRemoteLauncher skill lookup instruction', () => {
    afterEach(() => {
        harness.prompts = []
        harness.setConfigOptionCalls = []
        harness.thoughtLevelOption = {
            id: 'thought_level',
            currentValue: 'medium',
            options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }],
        }
    })

    it('uses the discovered effort after a model switch invalidates a queued effort', async () => {
        const session = createSession(
            { permissionMode: 'default', model: 'kimi-new', effort: 'high' },
            { permissionMode: 'default', model: 'kimi-new', effort: 'low' }
        )

        await expect(kimiRemoteLauncher(session as never, { model: 'kimi-k2' })).resolves.toBe('exit')

        expect(harness.prompts).toHaveLength(2)
        expect(harness.setConfigOptionCalls).not.toContainEqual(['kimi-session-1', 'thought_level', 'high'])
        expect(session.setEffort).toHaveBeenCalledWith('low')
    })

    it('falls back when the startup effort is unsupported by the model', async () => {
        const session = createSession()

        await expect(kimiRemoteLauncher(session as never, { model: 'kimi-k2', effort: 'high' })).resolves.toBe('exit')

        expect(harness.prompts).toHaveLength(2)
        expect(harness.setConfigOptionCalls).not.toContainEqual(['kimi-session-1', 'thought_level', 'high'])
        expect(session.setEffort).toHaveBeenCalledWith('medium')
    })

    it('does not prepend skill_lookup instructions onto user turns', async () => {
        await kimiRemoteLauncher(createSession() as never, { model: 'kimi-k2' })

        expect(harness.prompts).toHaveLength(2)
        expect(JSON.stringify(harness.prompts[0])).toContain('first')
        expect(JSON.stringify(harness.prompts[0])).not.toContain('skill_lookup')
        expect(JSON.stringify(harness.prompts[0])).not.toContain('$name')
        expect(JSON.stringify(harness.prompts[1])).not.toContain('skill_lookup')
    })
})
