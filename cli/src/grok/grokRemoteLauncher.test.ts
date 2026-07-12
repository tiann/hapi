import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { GrokMode } from './types'

const harness = vi.hoisted(() => ({
    setModels: [] as Array<{ sessionId: string; modelId: string; flavor?: string }>,
    setModes: [] as Array<{ sessionId: string; modeId: string }>,
    prompts: [] as unknown[][],
    autoCommandAvailable: true,
    stderrHandler: null as null | ((error: { message: string; raw: string }) => void),
    sessionInfoUpdateHandler: null as null | ((update: { title?: string | null }) => void),
    nativeTitle: null as string | null,
    nativeTitleSent: false,
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
            if (harness.nativeTitle !== null && !harness.nativeTitleSent) {
                harness.nativeTitleSent = true
                harness.sessionInfoUpdateHandler?.({ title: harness.nativeTitle })
            }
            if (harness.prompts.length === 1) {
                harness.stderrHandler?.({
                    message: 'status=402 Payment Required model_id=grok-build spending-limit',
                    raw: 'status=402 Payment Required model_id=grok-build spending-limit'
                })
            }
        }),
        cancelPrompt: vi.fn(async () => {}),
        respondToPermission: vi.fn(async () => {}),
        onStderrError: vi.fn((handler) => { harness.stderrHandler = handler }),
        setSessionInfoUpdateListener: vi.fn((handler) => { harness.sessionInfoUpdateHandler = handler }),
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
        })),
        hasAvailableCommand: vi.fn((_sessionId: string, command: string) => (
            command === 'auto' && harness.autoCommandAvailable
        ))
    })),
    formatGrokError: (error: unknown) => error instanceof Error ? error.message : String(error),
    isGrokBuildAuxiliaryQuotaError: (value: string, activeModel?: string | null) => (
        activeModel !== 'grok-build'
        && value.includes('402 Payment Required')
        && value.includes('model_id=grok-build')
    )
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
            sendSessionEvent: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        },
        queue,
        sessionId: null as string | null,
        thinking: false,
        getPermissionMode: () => 'default' as const,
        registerExistingNativeSession(id: string) { session.sessionId = id },
        setModel: vi.fn(),
        setEffort: vi.fn(),
        setPermissionMode: vi.fn(),
        pushKeepAlive: vi.fn(),
        onThinkingChange(thinking: boolean) { session.thinking = thinking },
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
    return { session, rpcHandlers }
}

function createPermissionSession(modes: GrokMode['permissionMode'][]) {
    const { session, rpcHandlers } = createSession()
    session.queue.reset()
    modes.forEach((permissionMode, index) => {
        session.queue.push(`permission-${index + 1}`, {
            permissionMode,
            model: 'grok-a',
            effort: 'low'
        })
    })
    session.queue.close()
    return { session, rpcHandlers }
}

describe('grokRemoteLauncher runtime config', () => {
    afterEach(() => {
        harness.setModels = []
        harness.setModes = []
        harness.prompts = []
        harness.stderrHandler = null
        harness.sessionInfoUpdateHandler = null
        harness.nativeTitle = null
        harness.nativeTitleSent = false
        harness.autoCommandAvailable = true
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
        expect(harness.prompts).toHaveLength(3)
        expect(session.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('402 Payment Required')
        }))
        expect(JSON.stringify(harness.prompts[0])).toContain('/always-approve off')
        expect(JSON.stringify(harness.prompts[1])).toContain('hapi_change_title')
        expect(JSON.stringify(harness.prompts[2])).not.toContain('hapi_change_title')
        expect(await rpcHandlers.get('listGrokModels')?.()).toMatchObject({ success: true, currentModelId: 'grok-a' })
        expect(await rpcHandlers.get('listGrokReasoningEffortOptions')?.()).toMatchObject({ success: true, currentValue: 'low' })
    })

    it('uses Grok slash commands to enter and leave Auto permission mode without model turns', async () => {
        const { session } = createPermissionSession(['auto', 'default'])

        await grokRemoteLauncher(session as never, { model: 'grok-a', effort: 'low' })

        expect(harness.prompts.map((prompt) => JSON.stringify(prompt))).toEqual([
            expect.stringContaining('/auto'),
            expect.stringContaining('permission-1'),
            expect.stringContaining('/always-approve off'),
            expect.stringContaining('permission-2')
        ])
    })

    it('forwards ACP native titles while retaining the prompt fallback', async () => {
        harness.nativeTitle = 'Native Grok title'
        const { session } = createSession()

        await grokRemoteLauncher(session as never, { model: 'grok-a', effort: 'low' })

        expect(session.client.sendClaudeSessionMessage).toHaveBeenCalledWith({
            type: 'summary',
            summary: 'Native Grok title',
            leafUuid: expect.any(String)
        })
        expect(JSON.stringify(harness.prompts[1])).toContain('hapi_change_title')
    })

    it('rolls Auto back to Default when Grok does not advertise the feature', async () => {
        harness.autoCommandAvailable = false
        const { session } = createPermissionSession(['auto'])
        const rollbacks: string[] = []

        await grokRemoteLauncher(session as never, {
            model: 'grok-a',
            effort: 'low',
            onPermissionModeRollback: (mode) => rollbacks.push(mode)
        })

        expect(rollbacks).toEqual(['default'])
        expect(harness.prompts).toHaveLength(2)
        expect(JSON.stringify(harness.prompts[0])).toContain('/always-approve off')
        expect(session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('not enabled')
        }))
    })
})
