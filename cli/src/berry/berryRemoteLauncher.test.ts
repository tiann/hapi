import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { BerryMode } from './types'

const GLM = 'newapi/glm-5.3'
const GLM_FLASH = 'newapi/glm-5.3-flash'
const HAPI_ROW_ID = 'hapi-berry-row-1'
// Pinned by the resolveBerryDataDir mock below — the launcher test only
// asserts that every spawn carries the SAME isolated data dir lever.
const EXPECTED_DATA_DIR = '/mock-home/.hapi/berry-data/hapi-berry-row-1'

const harness = vi.hoisted(() => ({
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    // Every backend the factory created, in order — respawn tests assert on
    // the individual instances (first = startup, second = respawned).
    backends: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
    // Every createBerryBackend(env, opts) call, in order.
    createCalls: [] as Array<{ env?: unknown; opts?: { model?: string; dataDir?: string } }>,
    newSessionConfig: null as unknown,
    prompts: [] as unknown[][],
    loadError: null as Error | null,
    loadSupported: true,
    // Set while suppressUpdatesDuring's callback runs; lets the loadSession
    // mock record whether it executed inside the suppression window.
    insideSuppress: false,
    loadInsideSuppress: null as boolean | null,
    suppressCalls: 0,
    titleListener: null as ((update: { title?: unknown }) => void) | null,
    modelOption: null as { id: string; category?: string; currentValue?: string } | null,
    modelsMetadata: null as {
        availableModels: Array<{ modelId: string; name?: string }>
        currentModelId: string | null
    } | null,
    setConfigOptionCalls: [] as Array<{ sessionId: string; configId: string; value: string }>,
    // Mirrors the backend's advertised promptCapabilities.image gate.
    supportsImages: false,
    // Recorded by the buildBerryPromptContent mock.
    promptContentInputs: [] as Array<{
        text: string
        images: unknown[] | undefined
        sessionId: string | undefined
    }>,
    // Captured constructor args of AcpPermissionHandler.
    permissionHandlerArgs: [] as unknown[][],
    // Backend-death simulation: when set, the (n+1)-th prompt on a backend
    // marks THAT backend's transport dead and throws the transport-death
    // error. The counter is per-backend, so a respawned backend starts
    // healthy — the death does not follow the respawn.
    dieAfterPrompts: null as number | null,
    // One-shot prompt failure that does NOT kill the transport (an ordinary
    // in-band error, e.g. an unknown model).
    promptError: null as Error | null,
    // When set, prompt() parks on this promise — lets tests abort mid-turn.
    promptBlocker: null as null | Promise<void>,
    // When set, cancelPrompt() parks on this promise — lets tests overlap
    // prompt completion with a pending cancel (the queue-reset ordering).
    cancelBlocker: null as null | Promise<void>
}))

vi.mock('./utils/berryBackend', () => ({
    createBerryBackend: vi.fn((env?: unknown, opts?: { model?: string; dataDir?: string }) => {
        harness.createCalls.push({ env, opts })
        const state = { prompts: 0, dead: false }
        const backend = {
            initialize: vi.fn(async () => {}),
            supportsLoadSession: vi.fn(() => harness.loadSupported),
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
                return 'berry-session-1'
            }),
            loadSession: vi.fn(async (config: { sessionId: string }) => {
                harness.loadInsideSuppress = harness.insideSuppress
                if (harness.loadError) throw harness.loadError
                // Mirrors the real AcpSdkBackend.loadSession: berry answers
                // session/load with {} and the backend falls back to the
                // REQUESTED id.
                return config.sessionId
            }),
            isTransportAlive: vi.fn(() => !state.dead),
            supportsImagePrompts: vi.fn(() => harness.supportsImages),
            prompt: vi.fn(async (_sessionId: string, content: unknown[], onUpdate: (message: unknown) => void) => {
                state.prompts += 1
                if (harness.promptBlocker) {
                    await harness.promptBlocker
                }
                if (harness.promptError) {
                    const error = harness.promptError
                    harness.promptError = null
                    throw error
                }
                if (harness.dieAfterPrompts !== null && state.prompts > harness.dieAfterPrompts) {
                    state.dead = true
                    throw deadTransportError()
                }
                harness.prompts.push(content)
                onUpdate({ type: 'text', text: 'answer' })
            }),
            cancelPrompt: vi.fn(async () => {
                if (harness.cancelBlocker) {
                    await harness.cancelBlocker
                }
            }),
            getConfigOptionByCategory: vi.fn(() => harness.modelOption),
            getSessionModelsMetadata: vi.fn(() => harness.modelsMetadata),
            setConfigOption: vi.fn(async (sessionId: string, configId: string, value: string) => {
                harness.setConfigOptionCalls.push({ sessionId, configId, value })
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
    }),
    resolveBerryDataDir: vi.fn(() => EXPECTED_DATA_DIR)
}))

vi.mock('./utils/berryPromptContent', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils/berryPromptContent')>()
    return {
        ...actual,
        buildBerryPromptContent: vi.fn(async (
            _backend: unknown,
            text: string,
            images: unknown[] | undefined,
            opts: { sessionId?: string } | undefined
        ) => {
            harness.promptContentInputs.push({ text, images, sessionId: opts?.sessionId })
            const prompt: Array<Record<string, unknown>> = [{ type: 'text', text }]
            if (images && images.length > 0 && harness.supportsImages) {
                for (const image of images) {
                    const attachment = image as { path: string; mimeType: string }
                    prompt.push({ type: 'image', data: `b64:${attachment.path}`, mimeType: attachment.mimeType })
                }
            }
            return prompt
        })
    }
})

vi.mock('@/modules/common/permission/AcpPermissionHandler', () => ({
    AcpPermissionHandler: class {
        constructor(...args: unknown[]) {
            harness.permissionHandlerArgs.push(args)
        }
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { ACP_INDETERMINATE_SYMBOL } from '@/agent/backends/acp/AcpStdioTransport'
import { BerryRemoteLauncher } from './berryRemoteLauncher'

/** The transport's own typed marker for dead-transport failures (process
 *  exit, closed transport, failed stdin write) — what a real dead-child
 *  session/prompt rejection carries. */
function deadTransportError(message = 'ACP process exited (code=1, signal=null)'): Error {
    const error = new Error(message)
    Object.defineProperty(error, ACP_INDETERMINATE_SYMBOL, { value: true })
    return error
}

function createSessionFromQueue(queue: MessageQueue2<BerryMode>, sessionId: string | null = null) {
    const session = {
        path: '/tmp/berry-test',
        logPath: '/tmp/berry-test/hapi.log',
        client: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            sessionId: HAPI_ROW_ID,
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

function createSessionWithBatches(batches: Array<[string, BerryMode]>, sessionId: string | null = null) {
    const queue = new MessageQueue2<BerryMode>((m) => JSON.stringify(m))
    for (const [message, mode] of batches) {
        queue.push(message, mode)
    }
    queue.close()
    return createSessionFromQueue(queue, sessionId)
}

function createSession(mode?: BerryMode, sessionId: string | null = null) {
    return createSessionWithBatches([['first', mode ?? {}]], sessionId)
}

describe('BerryRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.backends = []
        harness.createCalls = []
        harness.newSessionConfig = null
        harness.prompts = []
        harness.loadError = null
        harness.loadSupported = true
        harness.insideSuppress = false
        harness.loadInsideSuppress = null
        harness.suppressCalls = 0
        harness.titleListener = null
        harness.modelOption = null
        harness.modelsMetadata = null
        harness.setConfigOptionCalls = []
        harness.supportsImages = false
        harness.promptContentInputs = []
        harness.permissionHandlerArgs = []
        harness.dieAfterPrompts = null
        harness.promptError = null
        harness.promptBlocker = null
        harness.cancelBlocker = null
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

    it('spawns the backend with the isolated data dir and the spawn-time model lever', async () => {
        // Berry reads BERRY_AGENT_MODEL/BERRY_AGENT_DATA_DIR only at process
        // spawn; every backend creation must carry both levers.
        const session = createSession({ model: GLM_FLASH })
        const launcher = new BerryRemoteLauncher(session as never, { model: GLM_FLASH })

        await launcher.launch()

        expect(harness.createCalls).toEqual([
            { env: process.env, opts: { model: GLM_FLASH, dataDir: EXPECTED_DATA_DIR } }
        ])
    })

    it('spawns without a model lever when the session has none', async () => {
        const session = createSession()
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.createCalls).toEqual([
            { env: process.env, opts: { model: undefined, dataDir: EXPECTED_DATA_DIR } }
        ])
    })

    it('restores the persisted session through session/load inside suppressUpdatesDuring', async () => {
        // Berry has no session/resume: its restore path is session/load
        // (agentCapabilities.loadSession), which replays the stored history
        // before live attach. The replay must run inside the backend's
        // suppression window so it never reaches the hub transcript.
        const session = createSession(undefined, 'berry-existing-1')
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backend?.loadSession).toHaveBeenCalledWith({
            sessionId: 'berry-existing-1',
            cwd: '/tmp/berry-test',
            mcpServers: []
        })
        expect(harness.loadInsideSuppress).toBe(true)
        expect(harness.suppressCalls).toBe(1)
        expect(harness.backend?.newSession).not.toHaveBeenCalled()
        // session/load returns {} — the requested id is what both sides keep.
        expect(session.onSessionFound).toHaveBeenCalledWith('berry-existing-1')
    })

    it('falls back to a fresh Berry session when session/load fails', async () => {
        const session = createSession(undefined, 'berry-existing-1')
        const launcher = new BerryRemoteLauncher(session as never)
        harness.loadError = new Error('unknown session id')

        await launcher.launch()

        expect(harness.backend?.loadSession).toHaveBeenCalled()
        expect(harness.backend?.newSession).toHaveBeenCalledWith({ cwd: '/tmp/berry-test', mcpServers: [] })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Berry session load failed; starting a new session.'
        })
    })

    it('falls back without probing session/load when the server does not advertise it', async () => {
        const session = createSession(undefined, 'berry-existing-1')
        const launcher = new BerryRemoteLauncher(session as never)
        harness.loadSupported = false

        await launcher.launch()

        expect(harness.backend?.loadSession).not.toHaveBeenCalled()
        expect(harness.backend?.newSession).toHaveBeenCalledWith({ cwd: '/tmp/berry-test', mcpServers: [] })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Berry session load failed; starting a new session.'
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

    it('never pushes a permission mode onto the agent (no set_mode axis) and scopes grants to the session', async () => {
        // Berry implements neither session/set_mode nor any other runtime
        // mode RPC: the HAPI permission bridge is the only live enforcement.
        // The launcher must not try to switch a sandbox axis, and the bridge
        // must treat "allow for session" as allow_once (berry persists
        // allow_always answers stickily in tool-policy.json).
        const session = createSession()
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect('setMode' in (harness.backend ?? {})).toBe(false)
        const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
        const modeFailures = events.filter((call) =>
            String((call[0] as { message?: string } | undefined)?.message ?? '')
                .toLowerCase()
                .includes('mode'))
        expect(modeFailures).toEqual([])
        expect(harness.permissionHandlerArgs).toHaveLength(1)
        expect(harness.permissionHandlerArgs[0][3]).toEqual({ sessionScopedPermissionGrants: true })
        // The bridge still receives the live permission-mode getter.
        expect(typeof harness.permissionHandlerArgs[0][2]).toBe('function')
    })

    it('still sends read-only turns — the HAPI permission bridge decides', async () => {
        // The old read-only skip-turn branch bricked sessions whenever the
        // (phantom) sandbox switch failed; with bridge-only enforcement,
        // read-only turns are sent and the classifier denies writes.
        const session = createSessionWithBatches([
            ['first', { permissionMode: 'read-only' }],
            ['second', { permissionMode: 'yolo' }]
        ])
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
    })

    it('reports the spawn-time model lever without touching any config-option surface', async () => {
        // BERRY_AGENT_MODEL at spawn is berry's only model lever; the
        // config-option discovery/switch path was a phantom rail (berry
        // exposes no model config option at all) and is retired.
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        const onConfigDiscovered = vi.fn()
        const session = createSession()
        const launcher = new BerryRemoteLauncher(session as never, { model: GLM_FLASH, onConfigDiscovered })

        await launcher.launch()

        // No probe of the (nonexistent) option face, no switch call — the
        // host is simply told which model the spawn lever set.
        expect(harness.backend?.getConfigOptionByCategory).not.toHaveBeenCalled()
        expect(harness.setConfigOptionCalls).toEqual([])
        expect(onConfigDiscovered).toHaveBeenCalledWith(GLM_FLASH)
    })

    it('does not attempt a model switch for a queued mode.model (no catalog, no rail)', async () => {
        // No model option and no metadata on the wire — with the rail gone a
        // queued mode.model must be ignored: no set_config_option probe, no
        // 'Cannot switch model' event, and the turn still runs.
        harness.modelOption = null
        harness.modelsMetadata = null
        const session = createSessionWithBatches([['first', { model: GLM_FLASH }]])
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([])
        const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
        const switchFailures = events.filter((call) =>
            String((call[0] as { message?: string } | undefined)?.message ?? '').includes('switch model'))
        expect(switchFailures).toEqual([])
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
    })

    it('ignores an explicit Default (model: null) request — no reset attempt, no event', async () => {
        harness.modelOption = null
        harness.modelsMetadata = null
        const session = createSessionWithBatches([['first', { model: null }]])
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([])
        const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
        const resetFailures = events.filter((call) =>
            String((call[0] as { message?: string } | undefined)?.message ?? '').includes('Cannot reset'))
        expect(resetFailures).toEqual([])
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('routes image attachments into inline ACP image blocks', async () => {
        // Berry advertises promptCapabilities.image: images ride the queued
        // turn's mode and become {type:'image'} content blocks at prompt
        // time, gated on the backend's advertised capability.
        harness.supportsImages = true
        const images = [{ path: '/uploads/shot.png', mimeType: 'image/png', filename: 'shot.png' }]
        const session = createSessionWithBatches([
            ['look at this', { imageAttachments: images }]
        ])
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.promptContentInputs).toEqual([{
            text: 'look at this',
            images,
            sessionId: HAPI_ROW_ID
        }])
        expect(harness.prompts).toEqual([[
            { type: 'text', text: 'look at this' },
            { type: 'image', data: 'b64:/uploads/shot.png', mimeType: 'image/png' }
        ]])
    })

    it('keeps plain text prompts on turns without images', async () => {
        const session = createSession()
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.promptContentInputs).toEqual([{
            text: 'first',
            images: undefined,
            sessionId: HAPI_ROW_ID
        }])
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('does not register the ListBerryModels catalog RPC (model rail retired)', async () => {
        // The hub route is deleted and berry has nothing to serve a catalog
        // from: the RPC must not be registered at all, so a stale client
        // query gets a clean unregistered-method answer instead of a phantom
        // catalog (or a parked handler that can never resolve).
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        harness.modelsMetadata = {
            availableModels: [{ modelId: GLM, name: 'GLM-5.3' }],
            currentModelId: GLM
        }
        const session = createSession()
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        const registered = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
            .map((call) => call[0])
        expect(registered).not.toContain('listBerryModels')
        // No metadata read either — nothing consumes the (phantom) catalog.
        expect(harness.backends[0].getSessionModelsMetadata).not.toHaveBeenCalled()
    })

    it('respawns the backend after a mid-session death without resubmitting the batch', async () => {
        // First backend survives exactly one prompt; the second prompt finds
        // the subprocess dead (indeterminate transport failure). The launcher
        // respawns the backend and restores the persisted session through
        // session/load so the session keeps working — but the failed batch is
        // NOT automatically resubmitted: its outcome is unknowable (the turn
        // may have partially executed, and replaying it can repeat commands),
        // so the uncertain outcome is surfaced for an explicit retry and the
        // NEXT message runs on the fresh backend. (Distinct modes keep the
        // messages in separate queue batches.)
        harness.dieAfterPrompts = 1
        const session = createSessionWithBatches([
            ['first', { permissionMode: 'yolo' }],
            ['second', {}],
            ['third', { permissionMode: 'yolo' }]
        ])
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backends).toHaveLength(2)
        // The dead backend is disposed exactly once.
        expect(harness.backends[0].disconnect).toHaveBeenCalledTimes(1)
        // The respawn restored the persisted ACP session id on the fresh
        // backend via session/load.
        expect(harness.backends[1].initialize).toHaveBeenCalled()
        expect(harness.backends[1].loadSession).toHaveBeenCalledWith({
            sessionId: 'berry-session-1',
            cwd: '/tmp/berry-test',
            mcpServers: []
        })
        expect(session.onSessionFound).toHaveBeenCalledTimes(2)
        // Every spawn carries the isolated data dir lever.
        expect(harness.createCalls).toHaveLength(2)
        for (const call of harness.createCalls) {
            expect(call.opts?.dataDir).toBe(EXPECTED_DATA_DIR)
        }
        // 'second' was attempted once on the dying backend and never
        // resubmitted; 'third' is what runs on the fresh backend.
        expect(harness.backends[1].prompt).toHaveBeenCalledWith(
            'berry-session-1',
            [{ type: 'text', text: 'third' }],
            expect.any(Function)
        )
        expect(harness.backends[1].prompt).not.toHaveBeenCalledWith(
            'berry-session-1',
            [{ type: 'text', text: 'second' }],
            expect.any(Function)
        )
        // The harness records only prompts that ran (the dying 'second'
        // attempt throws before recording): first on the dead backend,
        // third on the replacement.
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'third' }]
        ])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('restarting')
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('Re-send it to retry')
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        // Cleanup tears down the respawned backend.
        expect(harness.backends[1].disconnect).toHaveBeenCalledTimes(1)
    })

    it('starts a fresh session when the respawned backend cannot load the persisted one', async () => {
        // No persisted id at startup (fresh session), so the load error only
        // bites when the respawn tries to load the now-persisted id.
        harness.dieAfterPrompts = 1
        harness.loadError = new Error('session store unavailable')
        const session = createSessionWithBatches([
            ['first', { permissionMode: 'yolo' }],
            ['second', {}]
        ])
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backends).toHaveLength(2)
        expect(harness.backends[1].loadSession).toHaveBeenCalled()
        expect(harness.backends[1].newSession).toHaveBeenCalledWith({
            cwd: '/tmp/berry-test',
            mcpServers: []
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Berry session load failed; starting a new session.'
        })
        // The failed batch is not resubmitted; the NEXT message runs on the
        // fresh session.
        expect(harness.backends[1].newSession).toHaveBeenCalled()
        expect(harness.backends[1].prompt).not.toHaveBeenCalled()
    })

    it('respawns with the same spawn-time model lever and zero model-switch traffic', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: GLM }
        harness.dieAfterPrompts = 1
        const session = createSessionWithBatches([
            ['first', { model: GLM_FLASH }],
            ['second', {}]
        ])
        const launcher = new BerryRemoteLauncher(session as never, { model: GLM_FLASH })

        await launcher.launch()

        // The fresh child re-applies the model through BERRY_AGENT_MODEL at
        // spawn (both create calls carry the lever); no config-option switch
        // is issued on either backend, and the session-scoped permission
        // grants ride both bridges. There is no sandbox-mode axis or model
        // rail to rebind — the bridge reads the live mode.
        expect(harness.backends).toHaveLength(2)
        expect(harness.createCalls.map((call) => call.opts?.model)).toEqual([GLM_FLASH, GLM_FLASH])
        expect(harness.setConfigOptionCalls).toEqual([])
        expect(harness.permissionHandlerArgs).toHaveLength(2)
        for (const args of harness.permissionHandlerArgs) {
            expect(args[3]).toEqual({ sessionScopedPermissionGrants: true })
        }
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

    it('does not respawn on a plain JSON-RPC error whose text merely mentions "process exited"', async () => {
        // Regression: the old raw-text gate matched this LIVE backend's
        // agent-side error and needlessly respawned a healthy transport. Only
        // the transport's typed indeterminate marker may trigger a respawn.
        harness.promptError = new Error(
            'session/prompt failed: the agent process exited unexpectedly while handling the turn (-32603)'
        )
        const session = createSession()
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backends).toHaveLength(1)
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('Berry prompt failed')
        })
        const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
        const restarts = events.filter((call) =>
            String((call[0] as { message?: string } | undefined)?.message ?? '')
                .toLowerCase()
                .includes('restart'))
        expect(restarts).toEqual([])
    })

    it('surfaces the uncertain outcome without resubmitting or a second respawn', async () => {
        // Every prompt attempt dies (dieAfterPrompts = 0): the first prompt
        // dies on the spot, the respawn runs once, and the batch is never
        // resubmitted — the uncertain outcome is surfaced for an explicit
        // retry. No respawn cycle.
        harness.dieAfterPrompts = 0
        const session = createSessionWithBatches([['first', {}]])
        const launcher = new BerryRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backends).toHaveLength(2)
        expect(harness.backends[1].prompt).not.toHaveBeenCalled()
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('Re-send it to retry')
        })
    })

    it('keeps the session alive when a stop arrives while the queue is idle', async () => {
        // Regression (ported from dsh): after the abort swapped in a fresh
        // AbortController, re-reading this.abortController.signal saw the
        // replacement (never aborted) and mistook the aborted idle wait for
        // a closed queue — the loop broke and a Stop on an IDLE session
        // killed the whole session instead of just cancelling the turn.
        const queue = new MessageQueue2<BerryMode>((m) => JSON.stringify(m))
        const session = createSessionFromQueue(queue)
        const launcher = new BerryRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.newSession).toHaveBeenCalled())

        // Stop while the loop is parked on the empty queue.
        await launcher.kill()

        // The session survives: a message sent after the stop still runs.
        queue.push('after-stop', {})
        queue.close()
        await done

        expect(harness.backends).toHaveLength(1)
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'after-stop' }]])
    })

    it('drops a follow-up queued before the stop when the prompt finishes before the cancel', async () => {
        // The queue reset must happen synchronously, BEFORE the cancel
        // awaits (ported from dsh): the in-flight prompt can complete while
        // cancelPrompt is still on the wire, and a follow-up queued ahead of
        // the stop must already be gone when the loop comes back — not run
        // after the user already saw "Session aborted".
        let releasePrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releasePrompt = resolve })
        let releaseCancel!: () => void
        harness.cancelBlocker = new Promise((resolve) => { releaseCancel = resolve })
        const queue = new MessageQueue2<BerryMode>((m) => JSON.stringify(m))
        queue.push('first', {})
        const session = createSessionFromQueue(queue)
        const launcher = new BerryRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalled())

        // Queued BEFORE the stop — must be dropped, not run.
        queue.push('second', {})

        const killPromise = launcher.kill()
        // The prompt settles while the cancel is still pending; the loop
        // returns to the queue in that window.
        releasePrompt()
        releaseCancel()
        await killPromise

        queue.close()
        await done

        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: 'Session aborted' })
    })
})
