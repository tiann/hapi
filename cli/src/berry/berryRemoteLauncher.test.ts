import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { BerryMode } from './types'

const GLM = 'newapi/glm-5.3'
const GLM_FLASH = 'newapi/glm-5.3-flash'

const harness = vi.hoisted(() => ({
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    // Every backend the factory created, in order — respawn tests assert on
    // the individual instances (first = startup, second = respawned).
    backends: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
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
    setModeCalls: [] as Array<{ sessionId: string; modeId: string; syncThoughtLevel?: boolean }>,
    setModeError: null as Error | null,
    configOptionError: null as Error | null,
    // When set, newSession() parks on this promise — lets tests query the
    // catalog RPC while session/new is still pending.
    newSessionBlocker: null as null | Promise<void>,
    // Backend-death simulation: when set, the (n+1)-th prompt on a backend
    // marks THAT backend's transport dead and throws the transport-death
    // error. The counter is per-backend, so a respawned backend starts
    // healthy — the death does not follow the respawn.
    dieAfterPrompts: null as number | null,
    // One-shot prompt failure that does NOT kill the transport (an ordinary
    // in-band error, e.g. an unknown model).
    promptError: null as Error | null
}))

vi.mock('./utils/berryBackend', () => ({
    createBerryBackend: vi.fn(() => {
        const state = { prompts: 0, dead: false }
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
                return 'berry-session-1'
            }),
            resumeSession: vi.fn(async (config: { sessionId: string }) => {
                harness.resumeInsideSuppress = harness.insideSuppress
                if (harness.resumeError) throw harness.resumeError
                return config.sessionId
            }),
            isTransportAlive: vi.fn(() => !state.dead),
            prompt: vi.fn(async (_sessionId: string, content: unknown[], onUpdate: (message: unknown) => void) => {
                state.prompts += 1
                if (harness.promptError) {
                    const error = harness.promptError
                    harness.promptError = null
                    throw error
                }
                if (harness.dieAfterPrompts !== null && state.prompts > harness.dieAfterPrompts) {
                    state.dead = true
                    throw new Error('ACP process exited (code=1, signal=null)')
                }
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
            setMode: vi.fn(async (sessionId: string, modeId: string, opts?: { syncThoughtLevel?: boolean }) => {
                harness.setModeCalls.push({ sessionId, modeId, syncThoughtLevel: opts?.syncThoughtLevel })
                if (harness.setModeError) throw harness.setModeError
                return {}
            }),
            onStderrError: vi.fn(),
            onPermissionRequest: vi.fn(),
            setSessionInfoUpdateListener: vi.fn((listener: (update: { title?: unknown }) => void) => {
                harness.titleListener = listener
            }),
            disconnect: vi.fn(async () => {})
        }
        harness.backends.push(backend)
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

import { BerryRemoteLauncher } from './berryRemoteLauncher'

function createSessionWithBatches(batches: Array<[string, BerryMode]>, sessionId: string | null = null) {
    const queue = new MessageQueue2<BerryMode>((m) => JSON.stringify(m))
    for (const [message, mode] of batches) {
        queue.push(message, mode)
    }
    queue.close()

    const session = {
        path: '/tmp/berry-test',
        logPath: '/tmp/berry-test/hapi.log',
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
        // Mirror AgentSessionBase: the ACP session id becomes the session's
        // persisted id, so a respawn resumes it instead of starting over.
        onSessionFound: vi.fn((id: string) => {
            session.sessionId = id
        }),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
    return session
}

function createSession(mode?: BerryMode, sessionId: string | null = null) {
    return createSessionWithBatches([['first', mode ?? {}]], sessionId)
}

describe('BerryRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.backends = []
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
        harness.setModeCalls = []
        harness.setModeError = null
        harness.configOptionError = null
        harness.newSessionBlocker = null
        harness.dieAfterPrompts = null
        harness.promptError = null
    })

    it('creates a fresh ACP session without MCP injection and forwards text prompts', async () => {
        const session = createSession()
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backend?.newSession).toHaveBeenCalledWith({
            cwd: '/tmp/berry-test',
            mcpServers: []
        })
        expect(session.onSessionFound).toHaveBeenCalledWith('berry-session-1')
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
        expect(session.sendAgentMessage).toHaveBeenCalledWith({
            type: 'message',
            message: 'answer'
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        expect(harness.backend?.disconnect).toHaveBeenCalled()
    })

    it('resumes through session/resume inside suppressUpdatesDuring', async () => {
        // Berry replays the restored transcript on session/resume; the call
        // must run inside the backend's suppression window so the replayed
        // session/update stream never reaches the hub transcript.
        const session = createSession(undefined, 'berry-existing-1')
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backend?.resumeSession).toHaveBeenCalledWith({
            sessionId: 'berry-existing-1',
            cwd: '/tmp/berry-test',
            mcpServers: []
        })
        expect(harness.resumeInsideSuppress).toBe(true)
        expect(harness.suppressCalls).toBe(1)
        expect(harness.backend?.newSession).not.toHaveBeenCalled()
        expect(session.onSessionFound).toHaveBeenCalledWith('berry-existing-1')
    })

    it('falls back to a fresh Berry session when native resume fails', async () => {
        const session = createSession(undefined, 'berry-existing-1')
        const launcher = new BerryRemoteLauncher(session as never)
        harness.resumeError = new Error('method not found')

        await launcher.launch()

        expect(harness.backend?.resumeSession).toHaveBeenCalled()
        expect(harness.backend?.newSession).toHaveBeenCalledWith({ cwd: '/tmp/berry-test', mcpServers: [] })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Berry resume failed; starting a new session.'
        })
    })

    it('falls back without probing session/resume when the server does not advertise it', async () => {
        const session = createSession(undefined, 'berry-existing-1')
        const launcher = new BerryRemoteLauncher(session as never)
        harness.resumeSupported = false

        await launcher.launch()

        expect(harness.backend?.resumeSession).not.toHaveBeenCalled()
        expect(harness.backend?.newSession).toHaveBeenCalledWith({ cwd: '/tmp/berry-test', mcpServers: [] })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Berry resume failed; starting a new session.'
        })
    })

    it('does not mirror native session_info_update titles (the Hub owns titles)', async () => {
        const session = createSession()
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        // Berry seeds its native title with the raw first user message;
        // mirroring it would suppress Hub title generation.
        expect(harness.titleListener).toBeNull()
        expect(session.client.sendClaudeSessionMessage).not.toHaveBeenCalled()
    })

    it('applies the session permission mode onto the Berry sandbox axis at startup', async () => {
        const session = createSession()
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        // The fake session reports 'default'; set_mode is issued once without
        // thought-level syncing (berry sandbox modes are not effort values).
        expect(harness.setModeCalls).toEqual([
            { sessionId: 'berry-session-1', modeId: 'default', syncThoughtLevel: false }
        ])
    })

    it('switches the sandbox mode per-turn when the queued mode requests it', async () => {
        const session = createSessionWithBatches([
            ['first', { permissionMode: 'yolo' }],
            ['second', { permissionMode: 'yolo' }],
            ['third', { permissionMode: 'read-only' }],
            ['fourth', { permissionMode: 'safe-yolo' }]
        ])
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        // Startup default, then yolo (dont_ask) once — repeated yolo turns do
        // not re-issue set_mode — then read-only (read_only) and finally
        // safe-yolo (accept_edits).
        expect(harness.setModeCalls.map((call) => call.modeId)).toEqual([
            'default',
            'dont_ask',
            'read_only',
            'accept_edits'
        ])
    })

    it('degrades gracefully when session/set_mode fails', async () => {
        const session = createSessionWithBatches([['first', { permissionMode: 'yolo' }]])
        const launcher = new BerryRemoteLauncher(session as never)
        harness.setModeError = new Error('method not found: session/set_mode')

        await launcher.launch()

        // The turn still runs: HAPI-side auto-approval honors the mode even
        // when the Berry sandbox axis cannot be switched.
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('sandbox mode switch failed')
        })
    })

    it('skips the turn when tightening to read-only fails', async () => {
        const session = createSessionWithBatches([['first', { permissionMode: 'read-only' }]])
        const launcher = new BerryRemoteLauncher(session as never)
        harness.setModeError = new Error('method not found: session/set_mode')

        await launcher.launch()

        // The sandbox is the only enforcement layer for read-only; a failed
        // tightening must not submit the prompt under the writable sandbox.
        expect(harness.prompts).toEqual([])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('read-only sandbox switch')
        })
    })

    it('discovers the current model from the model config option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        const onConfigDiscovered = vi.fn()
        const session = createSession()
        const launcher = new BerryRemoteLauncher(session as never, { onConfigDiscovered })

        await launcher.launch()

        // No override → no set_config_option call, only discovery.
        expect(harness.setConfigOptionCalls).toEqual([])
        expect(onConfigDiscovered).toHaveBeenCalledWith(GLM)
    })

    it('applies a spawn model override through session/set_config_option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        const onConfigDiscovered = vi.fn()
        const session = createSession({ model: GLM_FLASH })
        const launcher = new BerryRemoteLauncher(session as never, { model: GLM_FLASH, onConfigDiscovered })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([{
            sessionId: 'berry-session-1',
            configId: 'model',
            value: GLM_FLASH
        }])
        expect(onConfigDiscovered).toHaveBeenCalledWith(GLM_FLASH)
    })

    it('switches the model per-turn when the queued mode requests a different one', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        const session = createSession({ model: GLM_FLASH })
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([{
            sessionId: 'berry-session-1',
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
        const launcher = new BerryRemoteLauncher(session as never, { model: GLM_FLASH, onConfigDiscovered })

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
        const launcher = new BerryRemoteLauncher(session as never)

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
        const launcher = new BerryRemoteLauncher(session as never, { onModelRollback })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Cannot reset the Berry model: the agent did not report a default model.'
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
        const launcher = new BerryRemoteLauncher(session as never, { onModelRollback })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toHaveLength(1)
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Failed to switch Berry model: unknown model option'
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
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
        const resetFailures = events.filter((call) =>
            String((call[0] as { message?: string } | undefined)?.message ?? '').includes('Cannot reset'))
        expect(resetFailures).toEqual([])
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('answers ListBerryModels once a delayed session/new completes', async () => {
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
        const launcher = new BerryRemoteLauncher(session as never)

        const done = launcher.launch()
        const registered = await vi.waitFor(() => {
            const call = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
                .find((c) => c[0] === 'listBerryModels')
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

    it('serves ListBerryModels with the live current model', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        harness.modelsMetadata = {
            availableModels: [
                { modelId: GLM, name: 'GLM-5.3' },
                { modelId: GLM_FLASH, name: 'GLM-5.3 Flash' }
            ],
            currentModelId: GLM
        }
        const session = createSession()
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        const registered = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
            .find((call) => call[0] === 'listBerryModels')
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

    it('respawns the backend and retries the prompt when the ACP process dies mid-session', async () => {
        // First backend survives exactly one prompt; the second prompt finds
        // the subprocess dead ("ACP process exited"). The launcher must
        // respawn the backend, resume the persisted session, and deliver the
        // message on the fresh backend instead of wedging the session.
        // (Distinct modes keep the two messages in separate queue batches.)
        harness.dieAfterPrompts = 1
        const session = createSessionWithBatches([
            ['first', { permissionMode: 'yolo' }],
            ['second', {}]
        ])
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backends).toHaveLength(2)
        // The dead backend is disposed exactly once.
        expect(harness.backends[0].disconnect).toHaveBeenCalledTimes(1)
        // The respawn resumed the persisted ACP session id on the fresh backend.
        expect(harness.backends[1].initialize).toHaveBeenCalled()
        expect(harness.backends[1].resumeSession).toHaveBeenCalledWith({
            sessionId: 'berry-session-1',
            cwd: '/tmp/berry-test',
            mcpServers: []
        })
        expect(session.onSessionFound).toHaveBeenCalledTimes(2)
        // The retried prompt delivered the second message successfully.
        expect(harness.backends[1].prompt).toHaveBeenCalledWith(
            'berry-session-1',
            [{ type: 'text', text: 'second' }],
            expect.any(Function)
        )
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('restarting')
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        // Cleanup tears down the respawned backend.
        expect(harness.backends[1].disconnect).toHaveBeenCalledTimes(1)
    })

    it('starts a fresh session when the respawned backend cannot resume', async () => {
        // No persisted id at startup (fresh session), so the resume error only
        // bites when the respawn tries to resume the now-persisted id.
        harness.dieAfterPrompts = 1
        harness.resumeError = new Error('session store unavailable')
        const session = createSessionWithBatches([
            ['first', { permissionMode: 'yolo' }],
            ['second', {}]
        ])
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backends).toHaveLength(2)
        expect(harness.backends[1].resumeSession).toHaveBeenCalled()
        expect(harness.backends[1].newSession).toHaveBeenCalledWith({
            cwd: '/tmp/berry-test',
            mcpServers: []
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Berry resume failed; starting a new session.'
        })
        // The retried prompt still ran on the fresh session.
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]])
    })

    it('rebinds the sandbox mode and model override onto the respawned backend', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        harness.dieAfterPrompts = 1
        const session = createSessionWithBatches([
            ['first', { model: GLM_FLASH }],
            ['second', {}]
        ])
        const launcher = new BerryRemoteLauncher(session as never, { model: GLM_FLASH })

        await launcher.launch()

        // The fresh backend gets the sandbox mode re-applied (its
        // lastAppliedAcpMode cache starts empty) ...
        expect(harness.backends[1].setMode).toHaveBeenCalledWith(
            'berry-session-1',
            'default',
            { syncThoughtLevel: false }
        )
        // ... and the live model override re-asserted: spawn-time switch on
        // the first backend, respawn re-assert on the second.
        expect(harness.setConfigOptionCalls.map((call) => call.value)).toEqual([GLM_FLASH, GLM_FLASH])
    })

    it('does not respawn when the prompt failure is not a transport death', async () => {
        // An in-band JSON-RPC error on a live transport (e.g. unknown model)
        // must not spawn a replacement process.
        harness.promptError = new Error('unknown model option')
        const session = createSession()
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backends).toHaveLength(1)
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Berry prompt failed: unknown model option'
        })
    })

    it('reports the failure without a second respawn when the retried prompt fails again', async () => {
        // Every prompt attempt dies (dieAfterPrompts = 0): the respawn runs
        // once, its retry fails, and the error is reported — no respawn cycle.
        harness.dieAfterPrompts = 0
        const session = createSessionWithBatches([['first', {}]])
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backends).toHaveLength(2)
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Berry prompt failed: ACP process exited (code=1, signal=null)'
        })
    })
})
