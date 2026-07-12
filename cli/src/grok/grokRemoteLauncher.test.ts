import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { GrokMode } from './types'

const harness = vi.hoisted(() => ({
    setModels: [] as Array<{ sessionId: string; modelId: string; flavor?: string }>,
    setModes: [] as Array<{ sessionId: string; modeId: string }>,
    prompts: [] as unknown[][],
}))

vi.mock('./utils/grokBackend', () => ({
    createGrokBackend: vi.fn(() => ({
        initialize: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'grok-session-1'),
        loadSession: vi.fn(async () => 'grok-session-1'),
        setModel: vi.fn(async (sessionId: string, modelId: string, opts?: { flavor?: string }) => {
            harness.setModels.push({ sessionId, modelId, flavor: opts?.flavor })
        }),
        setMode: vi.fn(async (sessionId: string, modeId: string) => {
            harness.setModes.push({ sessionId, modeId })
        }),
        prompt: vi.fn(async (_sessionId: string, content: unknown[]) => {
            harness.prompts.push(content)
        }),
        cancelPrompt: vi.fn(async () => {}),
        respondToPermission: vi.fn(async () => {}),
        onStderrError: vi.fn(),
        onPermissionRequest: vi.fn(),
        disconnect: vi.fn(async () => {}),
        getSessionModelsMetadata: vi.fn(() => ({
            availableModels: [{ modelId: 'grok-a' }, { modelId: 'grok-b' }],
            currentModelId: 'grok-a'
        })),
        getThoughtLevelConfigOption: vi.fn(() => ({
            id: 'x.ai/reasoning-effort',
            currentValue: 'low',
            options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }]
        }))
    })),
    formatGrokError: (error: unknown) => error instanceof Error ? error.message : String(error)
}))

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({ server: { stop: () => {} }, mcpServers: {} })
}))
vi.mock('./utils/permissionHandler', () => ({
    GrokPermissionHandler: class { async cancelAll(): Promise<void> {} }
}))
vi.mock('@/ui/ink/GrokDisplay', () => ({ GrokDisplay: () => null }))
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))

import { grokRemoteLauncher } from './grokRemoteLauncher'

function createSession() {
    const queue = new MessageQueue2<GrokMode>((mode) => JSON.stringify(mode))
    queue.pushIsolateAndClear('first', { permissionMode: 'default', model: 'grok-a', effort: 'low' })
    queue.push('second', { permissionMode: 'default', model: 'grok-b', effort: 'medium' })
    queue.close()
    const rpcHandlers = new Map<string, () => unknown>()
    const session = {
        path: '/tmp/grok-test',
        logPath: '/tmp/grok-test/test.log',
        client: {
            rpcHandlerManager: {
                registerHandler(method: string, handler: () => unknown) { rpcHandlers.set(method, handler) }
            },
            sendAgentMessage: vi.fn(),
            sendSessionEvent: vi.fn()
        },
        queue,
        sessionId: null as string | null,
        thinking: false,
        getPermissionMode: () => 'default' as const,
        registerExistingNativeSession(id: string) { session.sessionId = id },
        setModel: vi.fn(),
        setEffort: vi.fn(),
        pushKeepAlive: vi.fn(),
        onThinkingChange(thinking: boolean) { session.thinking = thinking },
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
    return { session, rpcHandlers }
}

describe('grokRemoteLauncher runtime config', () => {
    afterEach(() => {
        harness.setModels = []
        harness.setModes = []
        harness.prompts = []
    })

    it('switches model and effort between turns and exposes session catalogs', async () => {
        const { session, rpcHandlers } = createSession()
        const discovered: unknown[] = []

        await grokRemoteLauncher(session as never, {
            model: 'grok-a',
            effort: 'low',
            onConfigDiscovered: (config) => discovered.push(config)
        })

        expect(discovered).toEqual([{ model: 'grok-a', effort: 'low' }])
        expect(harness.setModels).toEqual([
            { sessionId: 'grok-session-1', modelId: 'grok-b', flavor: 'grok' }
        ])
        expect(harness.setModes).toEqual([
            { sessionId: 'grok-session-1', modeId: 'medium' }
        ])
        expect(harness.prompts).toHaveLength(2)
        expect(JSON.stringify(harness.prompts[0])).toContain('hapi_change_title')
        expect(JSON.stringify(harness.prompts[1])).not.toContain('hapi_change_title')
        expect(await rpcHandlers.get('listGrokModels')?.()).toMatchObject({ success: true, currentModelId: 'grok-a' })
        expect(await rpcHandlers.get('listGrokReasoningEffortOptions')?.()).toMatchObject({ success: true, currentValue: 'low' })
    })
})
