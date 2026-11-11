import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { HermesMode } from './types'

const GLM = 'newapi:glm-5.3'
const GLM_FLASH = 'newapi:glm-5.3-flash'

const harness = vi.hoisted(() => ({
    // Latest created backend (existing tests assert against it); `backends`
    // records every creation in order so respawn tests can tell the dead
    // backend from its replacement apart.
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    backends: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
    newSessionConfig: null as unknown,
    prompts: [] as unknown[][],
    promptErrorQueue: [] as unknown[],
    initializeErrorQueue: [] as unknown[],
    resumeError: null as Error | null,
    resumeSupported: true,
    // When non-empty, each resumeSession() call parks on the next entry
    // (shifted off the front; a resolved entry passes straight through) —
    // lets tests abort inside a chosen respawn window without parking the
    // initial establishment's resume too.
    resumeBlockerQueue: [] as Array<Promise<void>>,
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
    // When set, disconnect() parks on this promise — lets tests query the
    // catalog RPC while a respawn is still tearing the dead backend down.
    disconnectBlocker: null as null | Promise<void>
}))

vi.mock('./utils/hermesBackend', () => ({
    createHermesBackend: vi.fn(() => {
        const backend = {
            initialize: vi.fn(async () => {
                if (harness.initializeErrorQueue.length > 0) {
                    const error = harness.initializeErrorQueue.shift()
                    if (error) throw error
                }
            }),
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
                const blocker = harness.resumeBlockerQueue.shift()
                if (blocker) {
                    await blocker
                }
                if (harness.resumeError) throw harness.resumeError
                return config.sessionId
            }),
            prompt: vi.fn(async (_sessionId: string, content: unknown[], onUpdate: (message: unknown) => void) => {
                // Record every attempt (failed ones too) so respawn tests can
                // prove the SAME batch was retried.
                harness.prompts.push(content)
                if (harness.promptErrorQueue.length > 0) {
                    const error = harness.promptErrorQueue.shift()
                    if (error) throw error
                }
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
            disconnect: vi.fn(async () => {
                if (harness.disconnectBlocker) {
                    await harness.disconnectBlocker
                }
            })
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

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: vi.fn(async () => ({
        server: { url: 'http://127.0.0.1:0/mcp', stop: vi.fn() },
        mcpServers: {}
    }))
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { ACP_INDETERMINATE_SYMBOL } from '@/agent/backends/acp/AcpStdioTransport'
import { HermesRemoteLauncher } from './hermesRemoteLauncher'

/** The transport's own typed marker for dead-transport failures (process
 *  exit, closed transport, failed stdin write) — what a real dead-child
 *  session/prompt rejection carries. */
function deadTransportError(message = 'ACP process exited (code=1, signal=null)'): Error {
    const error = new Error(message)
    Object.defineProperty(error, ACP_INDETERMINATE_SYMBOL, { value: true })
    return error
}

/** Whether `promise` settled within a short window (true) or is still parked
 * (false) — proves a catalog query parks through a blocked window instead of
 * answering a terminal error immediately. */
async function settlesQuickly(promise: Promise<unknown>): Promise<boolean> {
    return await Promise.race([
        promise.then(() => true, () => true),
        new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 25) })
    ])
}

function createSessionFromQueue(queue: MessageQueue2<HermesMode>, sessionId: string | null = null) {
    return {
        path: '/tmp/hermes-test',
        logPath: '/tmp/hermes-test/hapi.log',
        client: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            getMetadata: vi.fn(() => ({})),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            flushMetadata: vi.fn(async () => true)
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

function createSessionWithBatches(batches: Array<[string, HermesMode]>, sessionId: string | null = null) {
    const queue = new MessageQueue2<HermesMode>((m) => JSON.stringify(m))
    for (const [message, mode] of batches) {
        queue.push(message, mode)
    }
    queue.close()
    return createSessionFromQueue(queue, sessionId)
}

function createSession(mode?: HermesMode, sessionId: string | null = null) {
    return createSessionWithBatches([['first', mode ?? {}]], sessionId)
}

describe('HermesRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.backends = []
        harness.newSessionConfig = null
        harness.prompts = []
        harness.promptErrorQueue = []
        harness.initializeErrorQueue = []
        harness.resumeError = null
        harness.resumeSupported = true
        harness.resumeBlockerQueue = []
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
        harness.disconnectBlocker = null
    })

    it('creates a fresh ACP session and forwards text prompts', async () => {
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

    it('does not mirror native session_info_update titles (the Hub owns titles)', async () => {
        const session = createSession()
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        // Hermes seeds its native title with the raw first user message;
        // mirroring it would suppress Hub title generation.
        expect(harness.titleListener).toBeNull()
        expect(session.client.sendClaudeSessionMessage).not.toHaveBeenCalled()
    })

    it('applies the session permission mode onto the Hermes edit-approval axis at startup', async () => {
        const session = createSession()
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        // The fake session reports 'default'; set_mode is issued once without
        // thought-level syncing (hermes edit modes are not effort values).
        expect(harness.setModeCalls).toEqual([
            { sessionId: 'hermes-session-1', modeId: 'default', syncThoughtLevel: false }
        ])
    })

    it('switches the edit mode per-turn when the queued mode requests yolo', async () => {
        const session = createSessionWithBatches([
            ['first', { permissionMode: 'yolo' }],
            ['second', { permissionMode: 'yolo' }],
            ['third', { permissionMode: 'safe-yolo' }]
        ])
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        // Startup default, then yolo (dont_ask) once — repeated yolo turns do
        // not re-issue set_mode — and finally safe-yolo (accept_edits).
        expect(harness.setModeCalls.map((call) => call.modeId)).toEqual([
            'default',
            'dont_ask',
            'accept_edits'
        ])
    })

    it('degrades gracefully when session/set_mode fails', async () => {
        const session = createSessionWithBatches([['first', { permissionMode: 'yolo' }]])
        const launcher = new HermesRemoteLauncher(session as never)
        harness.setModeError = new Error('method not found: session/set_mode')

        await launcher.launch()

        // The turn still runs: HAPI-side auto-approval honors the mode even
        // when the Hermes edit axis cannot be switched.
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('edit mode switch failed')
        })
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

    it('parks a ListHermesModels query that arrives during the MCP bridge build, then answers it', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        harness.modelsMetadata = {
            availableModels: [{ modelId: GLM, name: 'GLM-5.3' }],
            currentModelId: GLM
        }
        // Park the bridge build: the picker's catalog query arrives while the
        // bridge HTTP server is still being created — before the first
        // establishment has run at all.
        const { buildHapiMcpBridge } = await import('@/codex/utils/buildHapiMcpBridge')
        let releaseBridge!: () => void
        const bridgeBlocker = new Promise<void>((resolve) => { releaseBridge = resolve })
        vi.mocked(buildHapiMcpBridge).mockImplementationOnce(async () => {
            await bridgeBlocker
            return {
                server: { url: 'http://127.0.0.1:0/mcp', stop: vi.fn() },
                mcpServers: {}
            }
        })
        const session = createSession()
        const launcher = new HermesRemoteLauncher(session as never)

        const done = launcher.launch()
        const registered = await vi.waitFor(() => {
            const call = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
                .find((c) => c[0] === 'listHermesModels')
            expect(call).toBeTruthy()
            return call!
        })

        // While the bridge build is pending the query must PARK on the
        // seeded placeholder readiness — the pre-fix launcher answered a
        // terminal 'Hermes session is not available' error in this window.
        const pending = (registered[1] as () => Promise<unknown>)()
        await expect(settlesQuickly(pending)).resolves.toBe(false)
        releaseBridge()
        await done

        // The first establishment adopts the placeholder and settles it: the
        // parked query now answers with the discovered catalog.
        await expect(pending).resolves.toEqual({
            success: true,
            availableModels: [{ modelId: GLM, name: 'GLM-5.3' }],
            currentModelId: GLM
        })
    })

    it('parks a ListHermesModels query that arrives during respawn teardown, then answers from the replacement', async () => {
        harness.promptErrorQueue = [deadTransportError()]
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        harness.modelsMetadata = {
            availableModels: [{ modelId: GLM, name: 'GLM-5.3' }],
            currentModelId: GLM
        }
        // The first prompt dies with the transport marker; the dead backend's
        // disconnect parks, so the respawn is mid-teardown (readiness already
        // swapped, replacement not yet established) when the query arrives.
        let releaseDisconnect!: () => void
        harness.disconnectBlocker = new Promise<void>((resolve) => { releaseDisconnect = resolve })
        const session = createSessionWithBatches([['hello', {}]], 'hermes-existing-1')
        const launcher = new HermesRemoteLauncher(session as never)

        const done = launcher.launch()
        const registered = await vi.waitFor(() => {
            const call = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
                .find((c) => c[0] === 'listHermesModels')
            expect(call).toBeTruthy()
            return call!
        })
        await vi.waitFor(() => {
            const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
            expect(events.some((call) =>
                String((call[0] as { message?: string } | undefined)?.message ?? '').includes('reconnecting'))).toBe(true)
        })

        // Mid-teardown the query must PARK on the fresh pending handshake
        // armed at the top of the respawn — the pre-fix launcher served the
        // settled handshake's dead backend here.
        const pending = (registered[1] as () => Promise<unknown>)()
        await expect(settlesQuickly(pending)).resolves.toBe(false)
        releaseDisconnect()
        await done

        await expect(pending).resolves.toEqual({
            success: true,
            availableModels: [{ modelId: GLM, name: 'GLM-5.3' }],
            currentModelId: GLM
        })
        // The answer was served from the REPLACEMENT backend's metadata,
        // never from the corpse.
        expect(harness.backends[1].getSessionModelsMetadata).toHaveBeenCalledWith('hermes-existing-1')
        expect(harness.backends[0].getSessionModelsMetadata).not.toHaveBeenCalled()
    })

    it('respawns the ACP backend and retries the same batch when the child process dies', async () => {
        // Gateway daemon restart killed the `hermes acp` child: the first
        // prompt rejects with the transport's typed dead-marker.
        harness.promptErrorQueue = [deadTransportError()]
        const session = createSessionWithBatches([['hello', {}]], 'hermes-existing-1')
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        // The dead backend was disconnected and a fresh one created + initialized.
        expect(harness.backends).toHaveLength(2)
        expect(harness.backends[0].disconnect).toHaveBeenCalled()
        expect(harness.backends[1].initialize).toHaveBeenCalled()
        // The respawn resumes the persisted daemon session id, inside the
        // same replay suppression as the initial resume.
        expect(harness.backends[1].resumeSession).toHaveBeenCalledWith({
            sessionId: 'hermes-existing-1',
            cwd: '/tmp/hermes-test',
            mcpServers: []
        })
        expect(harness.resumeInsideSuppress).toBe(true)
        // The SAME batch ran against the dead transport and again on the
        // replacement — and the retry's answer reached the hub.
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'hello' }],
            [{ type: 'text', text: 'hello' }]
        ])
        expect(session.sendAgentMessage).toHaveBeenCalledWith({
            type: 'message',
            message: 'answer'
        })
        // Exactly one reconnect status line for the whole respawn.
        const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
        const reconnectLines = events.filter((call) =>
            String((call[0] as { message?: string } | undefined)?.message ?? '').includes('reconnecting'))
        expect(reconnectLines).toHaveLength(1)
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Hermes connection lost; reconnecting…'
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        expect(harness.backends[1].disconnect).toHaveBeenCalled()
    })

    it('re-applies the edit mode on the respawned backend before the retried batch', async () => {
        harness.promptErrorQueue = [deadTransportError()]
        const session = createSessionWithBatches([['hello', { permissionMode: 'yolo' }]], 'hermes-existing-1')
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        // Startup default + queued yolo on the first backend; the respawn
        // re-issues the session-stored default and then yolo for the retry —
        // the fresh process must not silently fall back to default mode.
        expect(harness.setModeCalls.map((call) => call.modeId)).toEqual([
            'default',
            'dont_ask',
            'default',
            'dont_ask'
        ])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'hello' }],
            [{ type: 'text', text: 'hello' }]
        ])
    })

    it('drops the retried batch when a user stop lands during the respawn', async () => {
        // Abort-generation guard (ported from dsh): a stop that lands while
        // the replacement backend is being established must discard the
        // already-dequeued batch — the user saw 'Session aborted' and the
        // queue was reset, so the retry would run a message the user killed.
        harness.promptErrorQueue = [deadTransportError()]
        // Park only the RESPAWN's session/resume (the initial
        // establishment's resume passes through a resolved slot) so the stop
        // lands inside the reconnect window.
        let releaseResume!: () => void
        const park = new Promise<void>((resolve) => { releaseResume = resolve })
        harness.resumeBlockerQueue = [Promise.resolve(), park]
        const queue = new MessageQueue2<HermesMode>((m) => JSON.stringify(m))
        queue.push('hello', {})
        const session = createSessionFromQueue(queue, 'hermes-existing-1')
        const launcher = new HermesRemoteLauncher(session as never)

        const done = launcher.launch()
        // 'hello' ran once and died with the transport; the respawn parks
        // inside session/resume on the fresh backend.
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
        await vi.waitFor(() => expect(harness.backends[1]?.resumeSession).toHaveBeenCalled())

        const killPromise = launcher.kill()
        releaseResume()
        await killPromise

        // The aborted 'hello' must be dropped, not retried; the loop stays
        // alive and the NEXT message runs on the respawned backend.
        queue.push('third', {})
        queue.close()
        await done

        expect(harness.backends).toHaveLength(2)
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'hello' }],
            [{ type: 'text', text: 'third' }]
        ])
        expect(harness.backends[1].prompt).toHaveBeenCalledWith(
            'hermes-existing-1',
            [{ type: 'text', text: 'third' }],
            expect.any(Function)
        )
    })

    it('surfaces the error and keeps the loop alive when the respawn also fails', async () => {
        harness.promptErrorQueue = [deadTransportError()]
        // First initialize succeeds (initial establishment), the respawn's
        // initialize fails (gateway still down); the next message's fresh
        // respawn attempt succeeds again.
        harness.initializeErrorQueue = [null, new Error('Failed to spawn hermes: not found')]
        // Distinct modes so the queue keeps the two messages as separate
        // batches instead of merging them into one turn.
        const session = createSessionWithBatches([
            ['a', {}],
            ['b', { permissionMode: 'yolo' }]
        ], 'hermes-existing-1')
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()
        // Initial backend, the failed respawn's partial backend (dropped and
        // disconnected), and the successful respawn for the later message.
        expect(harness.backends).toHaveLength(3)
        expect(harness.backends[0].disconnect).toHaveBeenCalled()
        expect(harness.backends[1].disconnect).toHaveBeenCalled()
        // 'a' ran once against the dead transport (no retry — the respawn
        // failed); the error was surfaced and the loop continued into 'b',
        // which respawned fresh and ran on the new backend.
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'a' }],
            [{ type: 'text', text: 'b' }]
        ])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Hermes reconnect failed: Failed to spawn hermes: not found'
        })
        expect(harness.backends[2].resumeSession).toHaveBeenCalledWith({
            sessionId: 'hermes-existing-1',
            cwd: '/tmp/hermes-test',
            mcpServers: []
        })
    })

    it('does not respawn when the prompt fails with a regular agent error', async () => {
        harness.promptErrorQueue = [new Error('unknown session')]
        const session = createSession()
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        // A JSON-RPC rejection is not a dead transport: old behavior only.
        expect(harness.backends).toHaveLength(1)
        expect(harness.backends[0].disconnect).toHaveBeenCalledTimes(1)
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Hermes prompt failed: unknown session'
        })
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('mounts the hapi MCP bridge servers on a fresh ACP session and stops the server with the launcher', async () => {
        const { buildHapiMcpBridge } = await import('@/codex/utils/buildHapiMcpBridge')
        const stop = vi.fn()
        vi.mocked(buildHapiMcpBridge).mockResolvedValueOnce({
            server: { url: 'http://127.0.0.1:9/mcp', stop },
            mcpServers: {
                hapi: { command: '/usr/local/bin/hapi', args: ['mcp', '--url', 'http://127.0.0.1:9/mcp'], tools: {} }
            }
        } as never)
        const session = createSession()
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        expect(buildHapiMcpBridge).toHaveBeenCalledWith(session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: '/tmp/hermes-test', flavor: 'hermes' }
        })
        expect(harness.backend?.newSession).toHaveBeenCalledWith({
            cwd: '/tmp/hermes-test',
            mcpServers: [{
                name: 'hapi',
                command: '/usr/local/bin/hapi',
                args: ['mcp', '--url', 'http://127.0.0.1:9/mcp'],
                env: []
            }]
        })
        // The bridge HTTP server is torn down with the launcher.
        expect(stop).toHaveBeenCalled()
    })

    it('remounts the same hapi MCP bridge servers on resume and on the respawned backend', async () => {
        const { buildHapiMcpBridge } = await import('@/codex/utils/buildHapiMcpBridge')
        vi.mocked(buildHapiMcpBridge).mockResolvedValueOnce({
            server: { url: 'http://127.0.0.1:9/mcp', stop: vi.fn() },
            mcpServers: {
                hapi: { command: '/usr/local/bin/hapi', args: ['mcp', '--url', 'http://127.0.0.1:9/mcp'], tools: {} }
            }
        } as never)
        // Gateway daemon restart mid-conversation: the first prompt dies with
        // the transport's typed dead-marker and the launcher respawns.
        harness.promptErrorQueue = [deadTransportError()]
        const session = createSessionWithBatches([['hello', {}]], 'hermes-existing-1')
        const launcher = new HermesRemoteLauncher(session as never)

        await launcher.launch()

        const expectedServers = [{
            name: 'hapi',
            command: '/usr/local/bin/hapi',
            args: ['mcp', '--url', 'http://127.0.0.1:9/mcp'],
            env: []
        }]
        // Hermes mounts client MCP servers on resume too: the initial resume
        // and the respawn's resume both carry the SAME bridge list — built
        // once per launcher, remounted by every establishment.
        expect(harness.backends[0].resumeSession).toHaveBeenCalledWith({
            sessionId: 'hermes-existing-1',
            cwd: '/tmp/hermes-test',
            mcpServers: expectedServers
        })
        expect(harness.backends[1].resumeSession).toHaveBeenCalledWith({
            sessionId: 'hermes-existing-1',
            cwd: '/tmp/hermes-test',
            mcpServers: expectedServers
        })
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'hello' }],
            [{ type: 'text', text: 'hello' }]
        ])
    })
})
