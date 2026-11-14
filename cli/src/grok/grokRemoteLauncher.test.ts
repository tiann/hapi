import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { GrokMode } from './types'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'

const harness = vi.hoisted(() => ({
    setModels: [] as Array<{ sessionId: string; modelId: string; flavor?: string }>,
    setModes: [] as Array<{ sessionId: string; modeId: string }>,
    prompts: [] as unknown[][],
    backends: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
    deferSetModel: null as null | Promise<void>,
    autoCommandAvailable: true,
    stderrHandler: null as null | ((error: { message: string; raw: string }) => void),
    sessionInfoUpdateHandler: null as null | ((update: { title?: string | null }) => void),
    nativeTitle: null as string | null,
    nativeTitleSent: false,
    loadSessionCalls: [] as string[],
    loadSessionError: null as Error | null,
    newSessionCalls: 0,
}))

vi.mock('./utils/grokBackend', () => ({
    createGrokBackend: vi.fn(() => {
        const backend = {
            initialize: vi.fn(async () => {}),
            newSession: vi.fn(async () => {
                harness.newSessionCalls += 1
                return 'grok-new-session'
            }),
            loadSession: vi.fn(async (params: { sessionId: string }) => {
                harness.loadSessionCalls.push(params.sessionId)
                if (harness.loadSessionError) {
                    throw harness.loadSessionError
                }
                return params.sessionId
            }),
            setModel: vi.fn(async (sessionId: string, modelId: string, opts?: { flavor?: string }) => {
                harness.setModels.push({ sessionId, modelId, flavor: opts?.flavor })
                if (modelId === 'grok-b' && harness.deferSetModel) await harness.deferSetModel
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
        }
        harness.backends.push(backend)
        return backend
    }),
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

import { grokRemoteLauncher, GrokRemoteLauncher } from './grokRemoteLauncher'

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
            updateMetadata: vi.fn(),
            getMetadata: vi.fn(() => null),
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
        harness.loadSessionCalls = []
        harness.loadSessionError = null
        harness.newSessionCalls = 0
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
            { sessionId: 'grok-new-session', modelId: 'grok-b', flavor: 'grok' }
        ])
        expect(harness.setModes).toEqual([
            { sessionId: 'grok-new-session', modeId: 'medium' }
        ])
        expect(harness.prompts).toHaveLength(3)
        expect(session.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('402 Payment Required')
        }))
        expect(JSON.stringify(harness.prompts[0])).toContain('/always-approve off')
        expect(JSON.stringify(harness.prompts[1])).toContain('hapi_change_title')
        expect(JSON.stringify(harness.prompts[1])).toContain('$name')
        expect(JSON.stringify(harness.prompts[1])).toContain('skill_lookup')
        expect(JSON.stringify(harness.prompts[2])).not.toContain('hapi_change_title')
        expect(JSON.stringify(harness.prompts[2])).not.toContain('skill_lookup')
        expect(await rpcHandlers.get('listGrokModels')?.()).toMatchObject({ success: true, currentModelId: 'grok-a' })
        expect(await rpcHandlers.get('listGrokReasoningEffortOptions')?.()).toMatchObject({ success: true, currentValue: 'low' })
    })

    it('does not fall back to newSession when a fork child cannot load its native id', async () => {
        const { session } = createSession()
        session.sessionId = 'grok-forked-native'
        vi.mocked(session.client.getMetadata).mockReturnValue({ forkedFrom: 'parent-session' } as never)
        harness.loadSessionError = new Error('session/load rejected')

        await expect(grokRemoteLauncher(session as never, {
            model: 'grok-a',
            effort: 'low'
        })).rejects.toThrow(/session\/load rejected/)

        expect(harness.loadSessionCalls).toEqual(['grok-forked-native'])
        expect(harness.newSessionCalls).toBe(0)
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

    it('requeues the hub-ACKed batch when a plain Stop lands during the queued model apply', async () => {
        const queue = new MessageQueue2<GrokMode>((mode) => JSON.stringify(mode))
        queue.push('first', { permissionMode: 'default', model: 'grok-b', effort: 'low' }, 'id-first')
        const rpcHandlers = new Map<string, () => unknown>()
        const session = {
            path: '/tmp/grok-test',
            logPath: '/tmp/grok-test/test.log',
            client: {
                rpcHandlerManager: {
                    registerHandler(method: string, handler: () => unknown) { rpcHandlers.set(method, handler) }
                },
                updateMetadata: vi.fn(),
                getMetadata: vi.fn(() => null),
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
            onThinkingChange(thinking: boolean) { session.thinking = thinking },
            sendAgentMessage: vi.fn(),
            sendSessionEvent: vi.fn()
        }
        let releaseModel!: () => void
        harness.deferSetModel = new Promise<void>(resolve => { releaseModel = resolve })
        const consumed = vi.fn()
        queue.onBatchConsumed = consumed
        const launcher = new GrokRemoteLauncher(session as never, { model: 'grok-a', effort: 'low' })
        const launchPromise = launcher.launch()
        let releaseCancel: (() => void) | undefined
        try {
            await vi.waitFor(() => expect(harness.setModels.some(entry => entry.modelId === 'grok-b')).toBe(true))
            const backend = harness.backends.at(-1)!
            backend.cancelPrompt.mockImplementationOnce(() => new Promise<void>(resolve => { releaseCancel = resolve }))
            const stop = rpcHandlers.get(RPC_METHODS.Abort)!() as Promise<unknown>
            await vi.waitFor(() => expect(releaseCancel).toBeTypeOf('function'))
            releaseModel()
            await new Promise<void>(resolve => setImmediate(resolve))
            await new Promise<void>(resolve => setImmediate(resolve))
            // The permission-mode sync may emit its own synthetic prompt; only
            // the queued user turn counts here (the title instruction prefix
            // is prepended at dispatch).
            const userPrompts = harness.prompts.filter(prompt => (prompt[0] as { text?: string })?.text?.endsWith('first'))
            // The batch was dequeued but never hub-ACKed (the ACK is deferred
            // to the dispatch commit); the Stop must preserve it behind the
            // in-flight teardown instead of dispatching a cancelled turn.
            expect(userPrompts).toHaveLength(0)
            expect(consumed).not.toHaveBeenCalled()
            releaseCancel?.()
            await stop
            await vi.waitFor(() => expect(harness.prompts.filter(prompt => (prompt[0] as { text?: string })?.text?.endsWith('first'))).toHaveLength(1))
            expect(consumed).toHaveBeenCalledExactlyOnceWith(['id-first'])
            queue.close()
            await launchPromise
        } finally {
            releaseModel?.()
            releaseCancel?.()
            queue.close()
            await launchPromise.catch(() => {})
        }
    })

    it('an idle switch teardown does not consume a newly arrived row', async () => {
        const queue = new MessageQueue2<GrokMode>((mode) => JSON.stringify(mode))
        const consumed = vi.fn()
        queue.onBatchConsumed = consumed
        const rpcHandlers = new Map<string, () => unknown>()
        const session = {
            path: '/tmp/grok-test',
            logPath: '/tmp/grok-test/test.log',
            client: {
                rpcHandlerManager: {
                    registerHandler(method: string, handler: () => unknown) { rpcHandlers.set(method, handler) }
                },
                updateMetadata: vi.fn(),
                getMetadata: vi.fn(() => null),
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
            onThinkingChange(thinking: boolean) { session.thinking = thinking },
            sendAgentMessage: vi.fn(),
            sendSessionEvent: vi.fn()
        }
        const launcher = new GrokRemoteLauncher(session as never, { model: 'grok-a', effort: 'low' })
        const launchPromise = launcher.launch().catch((error: unknown) => error)
        let releaseCancel: (() => void) | undefined
        try {
            // Wait until the loop is parked: the Switch handler is registered
            // immediately before the drain loop starts.
            await vi.waitFor(() => expect(rpcHandlers.has(RPC_METHODS.Switch)).toBe(true))
            const backend = harness.backends.at(-1)!
            backend.cancelPrompt.mockImplementationOnce(() => new Promise<void>(resolve => { releaseCancel = resolve }))
            const switchPromise = rpcHandlers.get(RPC_METHODS.Switch)!() as Promise<unknown>
            await vi.waitFor(() => expect(releaseCancel).toBeTypeOf('function'))
            queue.push('late', { permissionMode: 'default', model: 'grok-b', effort: 'low' }, 'late')
            await new Promise<void>(resolve => setImmediate(resolve))
            await new Promise<void>(resolve => setImmediate(resolve))
            // Pre-fix the dequeue signal stayed live during the teardown: the
            // row was dequeued+ACKed and its model applied on the closing
            // backend. The teardown must abort the signal at entry instead.
            expect(consumed).not.toHaveBeenCalled()
            expect(harness.setModels.some(entry => entry.modelId === 'grok-b')).toBe(false)
            releaseCancel?.()
            await switchPromise
            expect(queue.pendingLocalIds()).toEqual([])
            queue.close()
            expect(await launchPromise).toBe('switch')
        } finally {
            releaseCancel?.()
            queue.close()
            await launchPromise.catch(() => {})
        }
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
