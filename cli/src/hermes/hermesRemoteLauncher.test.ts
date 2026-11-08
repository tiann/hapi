import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { HermesMode } from './types'

const GLM = 'newapi:glm-5.3'
const GLM_FLASH = 'newapi:glm-5.3-flash'

const harness = vi.hoisted(() => ({
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    newSessionConfig: null as unknown,
    prompts: [] as unknown[][],
    resumeError: null as Error | null,
    resumeSupported: true,
    // Set while suppressUpdatesDuring's callback runs; lets the resumeSession
    // mock record whether it executed inside the suppression window.
    insideSuppress: false,
    resumeInsideSuppress: null as boolean | null,
    suppressCalls: 0,
    titleListener: null as ((update: { title?: unknown }) => void) | null,
    modelOption: null as { id: string; category?: string; currentValue?: string } | null,
    modelsMetadata: null as {
        availableModels: Array<{ modelId: string; name?: string }>
        currentModelId: string | null
    } | null,
    setConfigOptionCalls: [] as Array<{ sessionId: string; configId: string; value: string }>,
    configOptionError: null as Error | null,
    // When set, newSession() parks on this promise — lets tests query the
    // catalog RPC while session/new is still pending.
    newSessionBlocker: null as null | Promise<void>
}))

vi.mock('./utils/hermesBackend', () => ({
    createHermesBackend: vi.fn(() => {
        const backend = {
            initialize: vi.fn(async () => {}),
            supportsSessionResume: vi.fn(() => harness.resumeSupported),
            suppressUpdatesDuring: vi.fn(async (fn: () => Promise<unknown>) => {
                harness.suppressCalls += 1
                harness.insideSuppress = true
                try {
                    return await fn()
                } finally {
                    harness.insideSuppress = false
                }
            }),
            newSession: vi.fn(async (config: unknown) => {
                harness.newSessionConfig = config
                if (harness.newSessionBlocker) {
                    await harness.newSessionBlocker
                }
                return 'hermes-session-1'
            }),
            resumeSession: vi.fn(async (config: { sessionId: string }) => {
                harness.resumeInsideSuppress = harness.insideSuppress
                if (harness.resumeError) throw harness.resumeError
                return config.sessionId
            }),
            prompt: vi.fn(async (_sessionId: string, content: unknown[], onUpdate: (message: unknown) => void) => {
                harness.prompts.push(content)
                onUpdate({ type: 'text', text: 'answer' })
            }),
            cancelPrompt: vi.fn(async () => {}),
            getConfigOptionByCategory: vi.fn(() => harness.modelOption),
            getSessionModelsMetadata: vi.fn(() => harness.modelsMetadata),
            setConfigOption: vi.fn(async (sessionId: string, configId: string, value: string) => {
                harness.setConfigOptionCalls.push({ sessionId, configId, value })
                if (harness.configOptionError) throw harness.configOptionError
                return {}
            }),
            onStderrError: vi.fn(),
            onPermissionRequest: vi.fn(),
            setSessionInfoUpdateListener: vi.fn((listener: (update: { title?: unknown }) => void) => {
                harness.titleListener = listener
            }),
            disconnect: vi.fn(async () => {})
        }
        harness.backend = backend
        return backend
    })
}))

vi.mock('@/modules/common/permission/AcpPermissionHandler', () => ({
    AcpPermissionHandler: class {
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { HermesRemoteLauncher } from './hermesRemoteLauncher'

function createSessionWithBatches(batches: Array<[string, HermesMode]>, sessionId: string | null = null) {
    const queue = new MessageQueue2<HermesMode>((m) => JSON.stringify(m))
    for (const [message, mode] of batches) {
        queue.push(message, mode)
    }
    queue.close()

    return {
        path: '/tmp/hermes-test',
        logPath: '/tmp/hermes-test/hapi.log',
        client: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            getMetadata: vi.fn(() => ({})),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        },
        queue,
        sessionId,
        getPermissionMode: () => 'default' as const,
        onThinkingChange: vi.fn(),
        onSessionFound: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
}

function createSession(mode?: HermesMode, sessionId: string | null = null) {
    return createSessionWithBatches([['first', mode ?? {}]], sessionId)
}

describe('HermesRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.newSessionConfig = null
        harness.prompts = []
        harness.resumeError = null
        harness.resumeSupported = true
        harness.insideSuppress = false
        harness.resumeInsideSuppress = null
        harness.suppressCalls = 0
        harness.titleListener = null
        harness.modelOption = null
        harness.modelsMetadata = null
        harness.setConfigOptionCalls = []
        harness.configOptionError = null
        harness.newSessionBlocker = null
    })

    it('creates a fresh ACP session without MCP injection and forwards text prompts', async () => {
        const session = createSession()
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backend?.newSession).toHaveBeenCalledWith({
            cwd: '/tmp/hermes-test',
            mcpServers: []
        })
        expect(session.onSessionFound).toHaveBeenCalledWith('hermes-session-1')
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
        expect(session.sendAgentMessage).toHaveBeenCalledWith({
            type: 'message',
            message: 'answer'
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        expect(harness.backend?.disconnect).toHaveBeenCalled()
    })

    it('resumes through session/resume inside suppressUpdatesDuring', async () => {
        // Hermes replays the restored transcript on session/resume; the call
        // must run inside the backend's suppression window so the replayed
        // session/update stream never reaches the hub transcript.
        const session = createSession(undefined, 'hermes-existing-1')
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backend?.resumeSession).toHaveBeenCalledWith({
            sessionId: 'hermes-existing-1',
            cwd: '/tmp/hermes-test',
            mcpServers: []
        })
        expect(harness.resumeInsideSuppress).toBe(true)
        expect(harness.suppressCalls).toBe(1)
        expect(harness.backend?.newSession).not.toHaveBeenCalled()
        expect(session.onSessionFound).toHaveBeenCalledWith('hermes-existing-1')
    })

    it('falls back to a fresh Hermes session when native resume fails', async () => {
        const session = createSession(undefined, 'hermes-existing-1')
        const launcher = new HermesRemoteLauncher(session as never)
        harness.resumeError = new Error('method not found')

        await launcher.launch()

        expect(harness.backend?.resumeSession).toHaveBeenCalled()
        expect(harness.backend?.newSession).toHaveBeenCalledWith({ cwd: '/tmp/hermes-test', mcpServers: [] })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Hermes resume failed; starting a new session.'
        })
    })

    it('falls back without probing session/resume when the server does not advertise it', async () => {
        const session = createSession(undefined, 'hermes-existing-1')
        const launcher = new HermesRemoteLauncher(session as never)
        harness.resumeSupported = false

        await launcher.launch()

        expect(harness.backend?.resumeSession).not.toHaveBeenCalled()
        expect(harness.backend?.newSession).toHaveBeenCalledWith({ cwd: '/tmp/hermes-test', mcpServers: [] })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Hermes resume failed; starting a new session.'
        })
    })

    it('forwards native session_info_update titles into the HAPI session summary', async () => {
        const session = createSession()
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.titleListener).toBeTypeOf('function')
        harness.titleListener!({ title: 'Fix the flaky test' })
        expect(session.client.sendClaudeSessionMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'summary', summary: 'Fix the flaky test' })
        )
    })

    it('discovers the current model from the model config option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        const onConfigDiscovered = vi.fn()
        const session = createSession()
        const launcher = new HermesRemoteLauncher(session as never, { onConfigDiscovered })

        await launcher.launch()

        // No override → no set_config_option call, only discovery.
        expect(harness.setConfigOptionCalls).toEqual([])
        expect(onConfigDiscovered).toHaveBeenCalledWith(GLM)
    })

    it('applies a spawn model override through session/set_config_option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        const onConfigDiscovered = vi.fn()
        const session = createSession({ model: GLM_FLASH })
        const launcher = new HermesRemoteLauncher(session as never, { model: GLM_FLASH, onConfigDiscovered })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([{
            sessionId: 'hermes-session-1',
            configId: 'model',
            value: GLM_FLASH
        }])
        expect(onConfigDiscovered).toHaveBeenCalledWith(GLM_FLASH)
    })

    it('switches the model per-turn when the queued mode requests a different one', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        const session = createSession({ model: GLM_FLASH })
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([{
            sessionId: 'hermes-session-1',
            configId: 'model',
            value: GLM_FLASH
        }])
        // The prompt still ran after the switch.
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('resets to the server default when Default is requested after a spawn-time override', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        const onConfigDiscovered = vi.fn()
        // Production sequence: spawn with an override, user later picks
        // "Default" in the picker, next message carries model: null.
        const session = createSessionWithBatches([['first', { model: null }]])
        const launcher = new HermesRemoteLauncher(session as never, { model: GLM_FLASH, onConfigDiscovered })

        await launcher.launch()

        expect(harness.setConfigOptionCalls.map((call) => call.value)).toEqual([GLM_FLASH, GLM])
        expect(onConfigDiscovered).toHaveBeenCalledWith(GLM_FLASH)
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('resets to the server default when Default is requested after a per-turn switch', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        const session = createSessionWithBatches([
            ['first', { model: GLM_FLASH }],
            ['second', { model: null }]
        ])
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setConfigOptionCalls.map((call) => call.value)).toEqual([GLM_FLASH, GLM])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
    })

    it('keeps the running model and reports back when Default is requested but no default was discovered', async () => {
        // No model config option and no metadata: the server never reported a
        // default to reset to.
        harness.modelOption = null
        harness.modelsMetadata = null
        const onModelRollback = vi.fn()
        const session = createSessionWithBatches([
            ['first', { model: GLM_FLASH }],
            ['second', { model: null }]
        ])
        const launcher = new HermesRemoteLauncher(session as never, { onModelRollback })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Cannot reset the Hermes model: the agent did not report a default model.'
        })
        // Both prompts still ran.
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
    })

    it('keeps the previous model and rolls back when a per-turn switch fails', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        harness.configOptionError = new Error('unknown model option')
        const onModelRollback = vi.fn()
        const session = createSession({ model: GLM_FLASH })
        const launcher = new HermesRemoteLauncher(session as never, { onModelRollback })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toHaveLength(1)
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Failed to switch Hermes model: unknown model option'
        })
        expect(onModelRollback).toHaveBeenCalledWith(GLM)
        // The prompt still ran with the unchanged model.
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('does not treat an ordinary turn without model metadata as a reset request', async () => {
        // No model option and no metadata: the server never reported a model,
        // so a preference-less turn (mode {}) must run as an ordinary prompt
        // without emitting the reset-failure event.
        harness.modelOption = null
        harness.modelsMetadata = null
        const session = createSession()
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
        const resetFailures = events.filter((call) =>
            String((call[0] as { message?: string } | undefined)?.message ?? '').includes('Cannot reset'))
        expect(resetFailures).toEqual([])
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('answers ListHermesModels once a delayed session/new completes', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        harness.modelsMetadata = {
            availableModels: [{ modelId: GLM, name: 'GLM-5.3' }],
            currentModelId: GLM
        }
        // Park session/new: the picker's catalog query arrives while the ACP
        // session is still being created.
        let releaseNewSession!: () => void
        harness.newSessionBlocker = new Promise((resolve) => { releaseNewSession = resolve })
        const session = createSession()
        const launcher = new HermesRemoteLauncher(session as never)

        const done = launcher.launch()
        const registered = await vi.waitFor(() => {
            const call = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
                .find((c) => c[0] === 'listHermesModels')
            expect(call).toBeTruthy()
            return call!
        })

        // The handler is registered before initialization; invoking it while
        // session/new is pending must park on readiness, not fail.
        const pending = (registered[1] as () => Promise<unknown>)()
        releaseNewSession()
        await done

        await expect(pending).resolves.toEqual({
            success: true,
            availableModels: [{ modelId: GLM, name: 'GLM-5.3' }],
            currentModelId: GLM
        })
    })

    it('serves ListHermesModels with the live current model', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        harness.modelsMetadata = {
            availableModels: [
                { modelId: GLM, name: 'GLM-5.3' },
                { modelId: GLM_FLASH, name: 'GLM-5.3 Flash' }
            ],
            currentModelId: GLM
        }
        const session = createSession()
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        const registered = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
            .find((call) => call[0] === 'listHermesModels')
        expect(registered).toBeTruthy()
        const handler = registered![1] as () => Promise<unknown>
        await expect(handler()).resolves.toEqual({
            success: true,
            availableModels: [
                { modelId: GLM, name: 'GLM-5.3' },
                { modelId: GLM_FLASH, name: 'GLM-5.3 Flash' }
            ],
            currentModelId: GLM
        })
    })
})
