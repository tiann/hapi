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
            prompt: vi.fn(async (
                _sessionId: string,
                content: unknown[],
                onUpdate: (message: unknown) => void,
                options?: { shouldSend?: () => boolean; timing?: { onSent?: () => void } }
            ) => {
                if (options?.shouldSend && !options.shouldSend()) {
                    return false
                }
                options?.timing?.onSent?.()
                harness.prompts.push(content)
                if (harness.promptBlocker) {
                    await harness.promptBlocker
                }
                onUpdate({ type: 'text', text: 'answer' })
                return true
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
            emitSessionReady: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn((name: string, fn: (params?: unknown) => Promise<unknown>) => {
                    handlers.set(name, fn)
                })
            }
        }
    }

    return {
        session,
        handlers,
        setPermissionMode: (mode: 'default' | 'read-only' | 'safe-yolo' | 'yolo') => {
            currentPermissionMode = mode
        }
    }
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

        const { session, handlers } = createSessionWithBatches([['hello', { permissionMode: 'default' }]], { keepQueueOpen: true })
        const launcher = new HermesRemoteLauncher(session as never)
        const launchPromise = launcher.launch()

        await new Promise((r) => setTimeout(r, 10))
        const backend = harness.backend!
        const abortHandler = handlers.get('abort')
        expect(abortHandler).toBeDefined()
        session.queue.push('follow-up', { permissionMode: 'default' })
        await abortHandler!()
        releasePrompt()
        session.queue.close()
        await launchPromise

        expect(harness.prompts.at(-1)).toEqual([{ type: 'text', text: 'follow-up' }])
        expect(backend.cancelPrompt).toHaveBeenCalledWith('hermes-session-1')
    })

    it('keeps a failed permission downgrade queued and cancellable without dispatch', async () => {
        const { session, handlers } = createSessionWithBatches([['first', { permissionMode: 'yolo' }]], { keepQueueOpen: true })
        const launcher = new HermesRemoteLauncher(session as never)
        const running = launcher.launch()
        try {
            await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
            harness.backend!.setMode.mockRejectedValueOnce(new Error('mode rejected'))
            session.queue.push('restricted', { permissionMode: 'read-only' }, 'pending')
            await vi.waitFor(() => expect(session.sendSessionEvent).toHaveBeenCalledWith({
                type: 'message', message: expect.stringContaining('permission change failed')
            }))
            expect(session.queue.cancelByLocalId('pending')).toBe(true)
            expect(harness.prompts).toHaveLength(1)
        } finally {
            session.queue.close()
            await handlers.get('abort')!()
            await running
        }
    })

    it('defers acknowledgement and retries a batch stopped during model selection', async () => {
        const { session, handlers } = createSessionWithBatches([], { keepQueueOpen: true })
        const commit = vi.spyOn(session.queue, 'commitBatch')
        const running = new HermesRemoteLauncher(session as never).launch()
        let release!: () => void
        try {
            await vi.waitFor(() => expect(handlers.has('abort')).toBe(true))
            harness.backend!.setModel.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
            session.queue.push('queued', { model: 'new-model', permissionMode: 'default' })
            await vi.waitFor(() => expect(release).toBeDefined())
            await handlers.get('abort')!()
            expect(commit).not.toHaveBeenCalled()
            expect(harness.prompts).toHaveLength(0)
            release()
            await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
            expect(commit).toHaveBeenCalledTimes(1)
        } finally {
            release?.()
            session.queue.close()
            await running
        }
    })

    it('keeps an idle session connected after abort and accepts the next prompt', async () => {
        const { session, handlers } = createSessionWithBatches([], { keepQueueOpen: true })
        const wait = vi.spyOn(session.queue, 'waitForDeferredBatch')
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

    it('preserves the existing native session ID and surfaces the error when loadSession fails on resume', async () => {
        harness.loadSessionError = new Error('session not found')
        harness.modelsMetadata = {
            availableModels: [{ modelId: 'openrouter:anthropic/claude-sonnet-4', name: 'claude-sonnet-4' }],
            currentModelId: 'openrouter:anthropic/claude-sonnet-4'
        }

        const { session } = createSessionWithBatches([], { sessionId: 'stale-hermes-id' })
        const launcher = new HermesRemoteLauncher(session as never)
        await expect(launcher.launch()).rejects.toThrow('session not found')

        expect(harness.backend?.loadSession).toHaveBeenCalled()
        expect(harness.backend?.newSession).not.toHaveBeenCalled()
        expect(session.onSessionFound).not.toHaveBeenCalled()
        expect(session.sessionId).toBe('stale-hermes-id')
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Hermes resume failed: session not found'
        })
    })

    it('defers acknowledgement and requeues a batch when Stop arrives during the ACP pre-send wait', async () => {
        const { session, handlers } = createSessionWithBatches([], { keepQueueOpen: true })
        const commit = vi.spyOn(session.queue, 'commitBatch')
        const running = new HermesRemoteLauncher(session as never).launch()
        let releasePreSend!: () => void
        try {
            await vi.waitFor(() => expect(handlers.has('abort')).toBe(true))
            harness.backend!.prompt.mockImplementationOnce(async (
                _sessionId: string,
                content: unknown[],
                onUpdate: (message: unknown) => void,
                options?: { shouldSend?: () => boolean; timing?: { onSent?: () => void } }
            ) => {
                await new Promise<void>((resolve) => {
                    releasePreSend = resolve
                })
                if (options?.shouldSend && !options.shouldSend()) {
                    return false
                }
                options?.timing?.onSent?.()
                harness.prompts.push(content)
                onUpdate({ type: 'text', text: 'answer' })
                return true
            })

            session.queue.push('stopped during pre-send drain', { permissionMode: 'default' })
            await vi.waitFor(() => expect(releasePreSend).toBeDefined())
            expect(commit).not.toHaveBeenCalled()

            await handlers.get('abort')!()
            expect(commit).not.toHaveBeenCalled()
            expect(harness.prompts).toHaveLength(0)

            releasePreSend()
            await vi.waitFor(() => expect(harness.prompts).toEqual([
                [{ type: 'text', text: 'stopped during pre-send drain' }]
            ]))
            expect(commit).toHaveBeenCalledTimes(1)
        } finally {
            releasePreSend?.()
            session.queue.close()
            await running
        }
    })

    it('reconnects and reloads the native session when the transport closes before mode setup', async () => {
        const { session } = createSessionWithBatches([['first', { permissionMode: 'default' }]], { keepQueueOpen: true })
        const commit = vi.spyOn(session.queue, 'commitBatch')
        const running = new HermesRemoteLauncher(session as never).launch()
        try {
            await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
            const firstBackend = harness.backend!
            firstBackend.setMode.mockRejectedValueOnce(new Error('ACP transport is closed'))

            session.queue.push('after transport closed', { permissionMode: 'yolo' })
            await vi.waitFor(() => expect(harness.prompts).toHaveLength(2))

            expect(firstBackend.disconnect).toHaveBeenCalledTimes(1)
            expect(harness.backend).not.toBe(firstBackend)
            expect(harness.backend!.loadSession).toHaveBeenCalledWith(
                expect.objectContaining({ sessionId: 'hermes-session-1' })
            )
            expect(harness.prompts[1]).toEqual([{ type: 'text', text: 'after transport closed' }])
            expect(commit).toHaveBeenCalledTimes(2)
        } finally {
            session.queue.close()
            await running
        }
    })

    it('exits with an error and keeps the batch unacknowledged when transport reconnect fails', async () => {
        const { session } = createSessionWithBatches([['first', { permissionMode: 'default' }]], { keepQueueOpen: true })
        const commit = vi.spyOn(session.queue, 'commitBatch')
        const release = vi.spyOn(session.queue, 'releaseBatch')
        const running = new HermesRemoteLauncher(session as never).launch()

        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
        expect(commit).toHaveBeenCalledTimes(1)

        harness.backend!.setMode.mockRejectedValueOnce(new Error('ACP transport is closed'))
        harness.loadSessionError = new Error('ACP transport is closed')
        session.queue.push('unsent turn', { permissionMode: 'yolo' }, 'unsent-local-id')

        await expect(running).rejects.toThrow('ACP transport is closed')
        expect(commit).toHaveBeenCalledTimes(1)
        expect(release).toHaveBeenCalledTimes(1)
        expect(harness.prompts).toHaveLength(1)
    })

    it('emits session-ready only after loadSession succeeds on resume', async () => {
        const { session: okSession } = createSessionWithBatches([], { sessionId: 'resume-ok-id' })
        await new HermesRemoteLauncher(okSession as never).launch()
        expect(okSession.client.emitSessionReady).toHaveBeenCalledTimes(1)

        harness.loadSessionError = new Error('load failed')
        const { session: failSession } = createSessionWithBatches([], { sessionId: 'resume-fail-id' })
        await expect(new HermesRemoteLauncher(failSession as never).launch()).rejects.toThrow('load failed')
        expect(failSession.client.emitSessionReady).not.toHaveBeenCalled()
    })

    it('pins AcpPermissionHandler mode to the active turn even if session preference flips mid-turn or after reconnect', async () => {
        let releasePrompt!: () => void
        harness.promptBlocker = new Promise<void>((resolve) => {
            releasePrompt = resolve
        })
        const { session, setPermissionMode } = createSessionWithBatches(
            [['first turn', { permissionMode: 'default' }]],
            { permissionMode: 'default', keepQueueOpen: true }
        )
        const running = new HermesRemoteLauncher(session as never).launch()
        try {
            await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
            expect(harness.permissionModeGetter?.()).toBe('default')

            // User upgrades session preference to yolo while turn 1 is in flight.
            setPermissionMode('yolo')
            expect(harness.permissionModeGetter?.()).toBe('default')

            releasePrompt()
            harness.promptBlocker = null
            await vi.waitFor(() => expect(harness.permissionModeGetter?.()).toBe('yolo'))

            // Also verify reconnect preserves turn-scoped isolation.
            harness.promptBlocker = new Promise<void>((resolve) => {
                releasePrompt = resolve
            })
            harness.backend!.setMode.mockRejectedValueOnce(new Error('ACP transport is closed'))
            setPermissionMode('read-only')
            session.queue.push('second turn', { permissionMode: 'read-only' })
            await vi.waitFor(() => expect(harness.prompts).toHaveLength(2))
            expect(harness.permissionModeGetter?.()).toBe('read-only')
            setPermissionMode('yolo')
            expect(harness.permissionModeGetter?.()).toBe('read-only')

            releasePrompt()
            await vi.waitFor(() => expect(harness.permissionModeGetter?.()).toBe('yolo'))
        } finally {
            releasePrompt?.()
            session.queue.close()
            await running
        }
    })

    it('handles /model <arg> via backend.setModel, notifies state, avoids stale revert, and passes bare /model through', async () => {
        harness.modelsMetadata = {
            availableModels: [
                { modelId: 'model-a', name: 'Model A' },
                { modelId: 'model-b', name: 'Model B' }
            ],
            currentModelId: 'model-a'
        }
        const onModelChanged = vi.fn(() => 1)
        const onModelRollback = vi.fn()
        const { session, handlers } = createSessionWithBatches([], { keepQueueOpen: true })
        const launcher = new HermesRemoteLauncher(session as never, {
            initialModelRevision: 0,
            onModelChanged,
            onModelRollback
        })
        const running = launcher.launch()
        try {
            await vi.waitFor(() => expect(handlers.has(RPC_METHODS.ListHermesModels)).toBe(true))

            // 1. /model model-b calls backend.setModel without backend.prompt and updates catalog + revision.
            session.queue.push('/model model-b', { permissionMode: 'default', model: 'model-a', modelRevision: 0 })
            await vi.waitFor(() => expect(onModelChanged).toHaveBeenCalledWith('model-b', 0))
            expect(harness.setModelCalls).toEqual([{ sessionId: 'hermes-session-1', model: 'model-b' }])
            expect(harness.prompts).toHaveLength(0)
            expect(session.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'message',
                message: 'Switched model to model-b'
            }))
            expect(await handlers.get(RPC_METHODS.ListHermesModels)!()).toMatchObject({
                success: true,
                currentModelId: 'model-b'
            })

            // 2. A stale queued prompt carrying rev 0 & model-a does not revert backend back to model-a.
            session.queue.push('stale batch turn', { permissionMode: 'default', model: 'model-a', modelRevision: 0 })
            await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
            expect(harness.setModelCalls).toHaveLength(1)

            // 3. Explicit UI switch back to model-a with newer revision (rev 2) DOES switch backend to model-a.
            session.queue.push('explicit switch back', { permissionMode: 'default', model: 'model-a', modelRevision: 2 })
            await vi.waitFor(() => expect(harness.prompts).toHaveLength(2))
            expect(harness.setModelCalls).toEqual([
                { sessionId: 'hermes-session-1', model: 'model-b' },
                { sessionId: 'hermes-session-1', model: 'model-a' }
            ])
            expect(onModelRollback).not.toHaveBeenCalled()

            // 4. Bare /model continues through backend.prompt for Hermes native status/help output.
            session.queue.push('/model', { permissionMode: 'default', model: 'model-a', modelRevision: 2 })
            await vi.waitFor(() => expect(harness.prompts).toHaveLength(3))
            expect(harness.prompts[2]).toEqual([{ type: 'text', text: '/model' }])
        } finally {
            session.queue.close()
            await running
        }
    })

    it('preserves a newer picker model selection if a slash /model switch completes while the picker already moved on', async () => {
        harness.modelsMetadata = {
            availableModels: [
                { modelId: 'model-a', name: 'Model A' },
                { modelId: 'model-b', name: 'Model B' }
            ],
            currentModelId: 'model-init'
        }
        let releaseSlash!: () => void
        let modelRevision = 0
        let pickerModel = 'model-init'
        const onModelChanged = vi.fn((model: string | null, expectedRev?: number) => {
            if (expectedRev !== undefined && expectedRev !== modelRevision) {
                return null
            }
            modelRevision += 1
            pickerModel = model ?? 'model-init'
            return modelRevision
        })

        const { session, handlers } = createSessionWithBatches([], { keepQueueOpen: true })
        const running = new HermesRemoteLauncher(session as never, {
            initialModelRevision: 0,
            onModelChanged
        }).launch()
        try {
            await vi.waitFor(() => expect(handlers.has(RPC_METHODS.ListHermesModels)).toBe(true))
            harness.backend!.setModel.mockImplementationOnce(async (sessionId: string, model: string) => {
                harness.setModelCalls.push({ sessionId, model })
                await new Promise<void>((resolve) => {
                    releaseSlash = resolve
                })
            })

            session.queue.push('/model model-a', { permissionMode: 'default', model: 'model-init', modelRevision: 0 })
            await vi.waitFor(() => expect(releaseSlash).toBeDefined())

            // User concurrently selects model-b in the web picker (advancing revision to 1)
            // and queues a follow-up prompt before /model model-a finishes.
            modelRevision = 1
            pickerModel = 'model-b'
            session.queue.push('turn after picker change', {
                permissionMode: 'default',
                model: 'model-b',
                modelRevision: 1
            })

            releaseSlash()
            await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

            expect(onModelChanged).toHaveBeenCalledWith('model-a', 0)
            expect(pickerModel).toBe('model-b')
            expect(harness.setModelCalls).toEqual([
                { sessionId: 'hermes-session-1', model: 'model-a' },
                { sessionId: 'hermes-session-1', model: 'model-b' }
            ])
        } finally {
            releaseSlash?.()
            session.queue.close()
            await running
        }
    })
})
