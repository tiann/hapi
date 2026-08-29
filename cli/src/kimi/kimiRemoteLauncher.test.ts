import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { KimiMode } from './types'

const harness = vi.hoisted(() => ({
    prompts: [] as unknown[][],
    setConfigOptionCalls: [] as unknown[][],
    rejectedModel: null as string | null,
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
            if (model === harness.rejectedModel) {
                throw new Error('model rejected')
            }
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
        getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) => category === 'model'
            ? { id: 'model', currentValue: 'kimi-default', options: [{ value: 'kimi-default' }] }
            : undefined),
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
    const rpcHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const queue = new MessageQueue2<KimiMode>((mode) => JSON.stringify(mode))
    queue.pushIsolateAndClear('first', firstMode)
    queue.push('second', secondMode)
    queue.close()

    const session = {
        path: '/tmp/kimi-test',
        logPath: '/tmp/kimi-test/test.log',
        client: {
            rpcHandlerManager: {
                registerHandler: vi.fn((method: string, handler: (...args: unknown[]) => unknown) => {
                    rpcHandlers.set(method, handler)
                })
            },
            sendAgentMessage: vi.fn(),
            sendSessionEvent: vi.fn()
        },
        queue,
        sessionId: null as string | null,
        setEffort: vi.fn(),
        setModel: vi.fn(),
        setRemoteEffortApplier: vi.fn(),
        pushKeepAlive: vi.fn(),
        getModel: () => firstMode.model ?? null,
        getPermissionMode: () => 'default' as const,
        onSessionFound(id: string) { session.sessionId = id },
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        rpcHandlers
    }
    return session
}

describe('kimiRemoteLauncher skill lookup instruction', () => {
    afterEach(() => {
        harness.prompts = []
        harness.setConfigOptionCalls = []
        harness.rejectedModel = null
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
        await expect(session.rpcHandlers.get('listSessionReasoningEffortOptions')?.()).resolves.toMatchObject({
            success: true,
            model: 'kimi-new',
            options: [{ value: 'low', name: 'Low' }]
        })
    })

    it('falls back when the startup effort is unsupported by the model', async () => {
        const session = createSession()

        await expect(kimiRemoteLauncher(session as never, { model: 'kimi-k2', effort: 'high' })).resolves.toBe('exit')

        expect(harness.prompts).toHaveLength(2)
        expect(harness.setConfigOptionCalls).not.toContainEqual(['kimi-session-1', 'thought_level', 'high'])
        expect(session.setEffort).toHaveBeenCalledWith('medium')
    })

    it('reports the default HAPI model selection for a concrete backend default', async () => {
        const defaultMode: KimiMode = { permissionMode: 'default' }
        const session = createSession(defaultMode, defaultMode)

        await expect(kimiRemoteLauncher(session as never, {})).resolves.toBe('exit')

        await expect(session.rpcHandlers.get('listSessionReasoningEffortOptions')?.()).resolves.toMatchObject({
            success: true,
            model: null
        })
    })

    it('rolls the HAPI model back when an inline backend switch fails', async () => {
        harness.rejectedModel = 'kimi-bad'
        const session = createSession(
            { permissionMode: 'default', model: 'kimi-k2' },
            { permissionMode: 'default', model: 'kimi-bad' }
        )
        const onModelRollback = vi.fn()
        const options = { model: 'kimi-k2', onModelRollback }

        await expect(kimiRemoteLauncher(session as never, options)).resolves.toBe('exit')

        expect(session.setModel).toHaveBeenCalledWith('kimi-k2')
        expect(onModelRollback).toHaveBeenCalledWith('kimi-k2')
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
