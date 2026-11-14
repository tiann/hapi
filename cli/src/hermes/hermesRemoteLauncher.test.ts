import { afterEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { HermesMode } from './types'

const harness = vi.hoisted(() => ({
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    newSessionConfig: null as unknown,
    loadSessionError: null as Error | null,
    prompts: [] as unknown[][],
    modelsMetadata: null as {
        availableModels: Array<{ modelId: string; name?: string; description?: string }>
        currentModelId: string | null
    } | null,
    setModelCalls: [] as Array<{ sessionId: string; model: string }>,
    setModeCalls: [] as Array<{ sessionId: string; modeId: string }>,
    newSessionBlocker: null as null | Promise<void>,
    promptBlocker: null as null | Promise<void>,
    permissionModeGetter: null as (() => unknown) | null,
    happyServerStopped: false
}))

vi.mock('./utils/hermesConfiguredModels', () => ({
    resolveHermesConfigModels: vi.fn(() => null)
}))

vi.mock('./utils/hermesBackend', () => ({
    createHermesBackend: vi.fn(() => {
        const backend = {
            initialize: vi.fn(async () => {}),
            newSession: vi.fn(async (config: unknown) => {
                harness.newSessionConfig = config
                if (harness.newSessionBlocker) {
                    await harness.newSessionBlocker
                }
                return 'hermes-session-1'
            }),
            loadSession: vi.fn(async (config: { sessionId: string }) => {
                if (harness.loadSessionError) throw harness.loadSessionError
                return config.sessionId
            }),
            prompt: vi.fn(async (_sessionId: string, content: unknown[], onUpdate: (message: unknown) => void) => {
                harness.prompts.push(content)
                if (harness.promptBlocker) {
                    await harness.promptBlocker
                }
                onUpdate({ type: 'text', text: 'answer' })
            }),
            cancelPrompt: vi.fn(async () => {}),
            getSessionModelsMetadata: vi.fn(() => harness.modelsMetadata),
            setModel: vi.fn(async (sessionId: string, model: string) => {
                harness.setModelCalls.push({ sessionId, model })
            }),
            setMode: vi.fn(async (sessionId: string, modeId: string) => {
                harness.setModeCalls.push({ sessionId, modeId })
            }),
            onSessionInfoUpdate: vi.fn(),
            onStderrError: vi.fn(),
            onPermissionRequest: vi.fn(),
            disconnect: vi.fn(async () => {})
        }
        harness.backend = backend
        return backend
    })
}))

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: vi.fn(async () => ({
        server: {
            stop: () => {
                harness.happyServerStopped = true
            }
        },
        mcpServers: {
            happy: { command: 'node', args: ['bridge.js'] }
        }
    }))
}))

vi.mock('@/agent/acpSessionTitle', () => ({
    createAcpSessionTitleSync: vi.fn(() => ({ markManualTitle: vi.fn() })),
    registerAcpSessionTitleSync: vi.fn()
}))

vi.mock('@/modules/common/permission/AcpPermissionHandler', () => ({
    AcpPermissionHandler: class {
        constructor(_client: unknown, _backend: unknown, getPermissionMode: () => unknown) {
            harness.permissionModeGetter = getPermissionMode
        }
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { HermesRemoteLauncher } from './hermesRemoteLauncher'

function createSessionWithBatches(
    batches: Array<[string, HermesMode]>,
    opts: { sessionId?: string | null; permissionMode?: 'default' | 'read-only' | 'safe-yolo' | 'yolo'; keepQueueOpen?: boolean } = {}
) {
    const queue = new MessageQueue2<HermesMode>((m) => JSON.stringify(m))
    for (const [message, mode] of batches) {
        queue.push(message, mode)
    }
    if (!opts.keepQueueOpen) queue.close()

    const handlers = new Map<string, (params?: unknown) => Promise<unknown>>()
    let currentSessionId = opts.sessionId ?? null
    let currentPermissionMode = opts.permissionMode ?? 'default'

    const session = {
        path: '/tmp/project',
        logPath: '/tmp/hermes.log',
        get sessionId() {
            return currentSessionId
        },
        getPermissionMode: () => currentPermissionMode,
        queue,
        onSessionFound: vi.fn((id: string) => {
            currentSessionId = id
        }),
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        client: {
            rpcHandlerManager: {
                registerHandler: vi.fn((name: string, fn: (params?: unknown) => Promise<unknown>) => {
                    handlers.set(name, fn)
                })
            }
        }
    }

    return { session, handlers }
}

describe('HermesRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.newSessionConfig = null
        harness.loadSessionError = null
        harness.prompts = []
        harness.modelsMetadata = null
        harness.setModelCalls = []
        harness.setModeCalls = []
        harness.newSessionBlocker = null
        harness.promptBlocker = null
        harness.permissionModeGetter = null
        harness.happyServerStopped = false
    })

    it('registers ListHermesModels before startup completes and returns available models', async () => {
        let unblock!: () => void
        harness.newSessionBlocker = new Promise<void>((resolve) => {
            unblock = resolve
        })
        harness.modelsMetadata = {
            availableModels: [
                { modelId: 'openrouter:anthropic/claude-sonnet-4', name: 'anthropic/claude-sonnet-4' },
                { modelId: 'openrouter:openai/gpt-5', name: 'openai/gpt-5' }
            ],
            currentModelId: 'openrouter:anthropic/claude-sonnet-4'
        }

        const { session, handlers } = createSessionWithBatches([])
        const launcher = new HermesRemoteLauncher(session as never)
        const launchPromise = launcher.launch()

        // Wait a microtask for registerHandler to run while newSession is parked
        await new Promise((r) => setTimeout(r, 10))
        const listModels = handlers.get(RPC_METHODS.ListHermesModels)
        expect(listModels).toBeDefined()

        const catalogPromise = listModels!()
        unblock()
        const catalog = await catalogPromise
        await launchPromise

        expect(catalog).toEqual({
            success: true,
            availableModels: harness.modelsMetadata.availableModels,
            currentModelId: 'openrouter:anthropic/claude-sonnet-4'
        })
        expect(harness.happyServerStopped).toBe(true)
    })

    it('wires HAPI MCP bridge, permissionMode -> ACP setMode, and model reset to initialBackendModel', async () => {
        harness.modelsMetadata = {
            availableModels: [
                { modelId: 'openrouter:anthropic/claude-sonnet-4', name: 'anthropic/claude-sonnet-4' },
                { modelId: 'openrouter:openai/gpt-5', name: 'openai/gpt-5' }
            ],
            currentModelId: 'openrouter:anthropic/claude-sonnet-4'
        }

        const { session } = createSessionWithBatches(
            [
                ['first', { permissionMode: 'yolo', model: 'openrouter:openai/gpt-5' }],
                ['second', { permissionMode: 'safe-yolo', model: null }]
            ],
            { permissionMode: 'yolo' }
        )

        const launcher = new HermesRemoteLauncher(session as never)
        await launcher.launch()

        expect(harness.newSessionConfig).toEqual({
            cwd: '/tmp/project',
            mcpServers: [{ name: 'happy', command: 'node', args: ['bridge.js'], env: [] }]
        })
        expect(harness.permissionModeGetter?.()).toBe('yolo')
        expect(harness.setModeCalls).toEqual([
            { sessionId: 'hermes-session-1', modeId: 'dont_ask' },
            { sessionId: 'hermes-session-1', modeId: 'accept_edits' }
        ])
        expect(harness.setModelCalls).toEqual([
            { sessionId: 'hermes-session-1', model: 'openrouter:openai/gpt-5' },
            { sessionId: 'hermes-session-1', model: 'openrouter:anthropic/claude-sonnet-4' }
        ])
        expect(harness.prompts).toHaveLength(2)
    })

    it('cancels prompt on abort without disconnecting the backend', async () => {
        harness.modelsMetadata = {
            availableModels: [{ modelId: 'openrouter:anthropic/claude-sonnet-4', name: 'claude-sonnet-4' }],
            currentModelId: 'openrouter:anthropic/claude-sonnet-4'
        }

        let releasePrompt!: () => void
        harness.promptBlocker = new Promise<void>((resolve) => {
            releasePrompt = resolve
        })

        const { session, handlers } = createSessionWithBatches([['hello', { permissionMode: 'default' }]])
        const launcher = new HermesRemoteLauncher(session as never)
        const launchPromise = launcher.launch()

        await new Promise((r) => setTimeout(r, 10))
        const backend = harness.backend!
        const abortHandler = handlers.get('abort')
        expect(abortHandler).toBeDefined()
        await abortHandler!()
        releasePrompt()
        session.queue.close()
        await launchPromise

        expect(backend.cancelPrompt).toHaveBeenCalledWith('hermes-session-1')
    })

    it('keeps an idle session connected after abort and accepts the next prompt', async () => {
        const { session, handlers } = createSessionWithBatches([], { keepQueueOpen: true })
        const wait = vi.spyOn(session.queue, 'waitForMessagesAndGetAsString')
        const launcher = new HermesRemoteLauncher(session as never)
        const launchPromise = launcher.launch()

        try {
            await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(1))
            const backend = harness.backend!
            await handlers.get('abort')!()
            await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(2))
            expect(backend.disconnect).not.toHaveBeenCalled()
            expect(harness.happyServerStopped).toBe(false)

            session.queue.push('after abort', { permissionMode: 'default' })
            await vi.waitFor(() => expect(harness.prompts).toEqual([
                [{ type: 'text', text: 'after abort' }]
            ]))
        } finally {
            session.queue.close()
            await launchPromise
        }
    })

    it('falls back to newSession when loadSession fails on resume', async () => {
        harness.loadSessionError = new Error('session not found')
        harness.modelsMetadata = {
            availableModels: [{ modelId: 'openrouter:anthropic/claude-sonnet-4', name: 'claude-sonnet-4' }],
            currentModelId: 'openrouter:anthropic/claude-sonnet-4'
        }

        const { session } = createSessionWithBatches([], { sessionId: 'stale-hermes-id' })
        const launcher = new HermesRemoteLauncher(session as never)
        await launcher.launch()

        expect(harness.backend?.loadSession).toHaveBeenCalled()
        expect(harness.backend?.newSession).toHaveBeenCalled()
        expect(session.onSessionFound).toHaveBeenCalledWith('hermes-session-1')
    })
})
