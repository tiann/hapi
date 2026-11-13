import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { DshMode } from './types'

const FLASH = '["deepseek-official","deepseek-flash"]'
const PRO = '["deepseek-official","deepseek-v4-pro"]'

const harness = vi.hoisted(() => ({
    // Latest created backend (existing tests assert against it); `backends`
    // records every creation in order so respawn tests can tell the dead
    // backend from its replacement apart.
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    backends: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
    createCalls: [] as Array<{ opts?: { permissionMode?: string } }>,
    newSessionConfig: null as unknown,
    newSessionCalls: [] as unknown[],
    promptSessionIds: [] as string[],
    prompts: [] as unknown[][],
    // Per-attempt prompt failures (shifted off the front); a null slot parks
    // the queue without failing, letting tests stage N failures + success.
    promptErrorQueue: [] as Array<Error | null>,
    initializeErrorQueue: [] as Array<Error | null>,
    // When set, prompt() finishes by emitting turn_complete with this reason.
    promptStopReason: null as string | null,
    supportsResume: false,
    resumeCalls: [] as unknown[],
    resumeError: null as Error | null,
    // When set, newSession() rejects with this — lets tests kill the backend
    // inside every recovery/reconnect window.
    newSessionError: null as Error | null,
    // When set, resumeSession() parks on this promise — lets tests abort
    // inside the post-abort restart window.
    resumeBlocker: null as null | Promise<void>,
    // Captured 3rd constructor arg of AcpPermissionHandler: the live
    // permission-mode getter consulted by the ACP permission bridge on every
    // permission request.
    permissionGetMode: null as (() => string | undefined) | null,
    // Captured 4th constructor arg (options): onCancelIssued arms the dsh
    // implicit session-end detector on permission 'abort' decisions.
    permissionCancelIssued: null as (() => void) | null,
    // When set, prompt() parks on this promise — lets tests abort mid-turn.
    promptBlocker: null as null | Promise<void>,
    // When set, newSession() parks on this promise — lets tests abort inside
    // the respawn window, or query the catalog RPC while session/new is still
    // pending.
    newSessionBlocker: null as null | Promise<void>,
    // When set, disconnect() parks on this promise — lets tests query the
    // catalog RPC while a respawn is still tearing the dead backend down.
    disconnectBlocker: null as null | Promise<void>,
    modelOption: null as { id: string; category?: string; currentValue?: string } | null,
    thoughtLevelOption: null as { id: string; category?: string; currentValue?: string } | null,
    modelsMetadata: null as {
        availableModels: Array<{ modelId: string; name?: string }>
        currentModelId: string | null
    } | null,
    setConfigOptionCalls: [] as Array<{ sessionId: string; configId: string; value: string }>,
    configOptionError: null as Error | null,
    // Per-call set_config_option failures (shifted off the front); a null
    // slot succeeds — lets tests stage apply-then-fail sequences.
    setConfigOptionErrorQueue: [] as Array<Error | null>,
    // Mirrors the backend's advertised promptCapabilities.image gate.
    supportsImages: false,
    // Recorded by the buildDshPromptContent mock.
    promptContentInputs: [] as Array<{ text: string; images: unknown[] | undefined }>
}))

vi.mock('./utils/dshBackend', () => ({
    createDshBackend: vi.fn((_env?: unknown, opts?: { permissionMode?: string }) => {
        harness.createCalls.push({ opts })
        const backend = {
            initialize: vi.fn(async () => {
                if (harness.initializeErrorQueue.length > 0) {
                    const error = harness.initializeErrorQueue.shift()
                    if (error) throw error
                }
            }),
            newSession: vi.fn(async (config: unknown) => {
                harness.newSessionConfig = config
                harness.newSessionCalls.push(config)
                if (harness.newSessionBlocker) {
                    await harness.newSessionBlocker
                }
                if (harness.newSessionError) throw harness.newSessionError
                return `dsh-session-${harness.newSessionCalls.length}`
            }),
            prompt: vi.fn(async (sessionId: string, content: unknown[], onUpdate: (message: unknown) => void) => {
                harness.promptSessionIds.push(sessionId)
                harness.prompts.push(content)
                if (harness.promptBlocker) {
                    await harness.promptBlocker
                }
                if (harness.promptErrorQueue.length > 0) {
                    const error = harness.promptErrorQueue.shift()
                    if (error) throw error
                }
                onUpdate({ type: 'text', text: 'answer' })
                if (harness.promptStopReason !== null) {
                    onUpdate({ type: 'turn_complete', stopReason: harness.promptStopReason })
                }
            }),
            cancelPrompt: vi.fn(async () => {}),
            supportsSessionResume: vi.fn(() => harness.supportsResume),
            resumeSession: vi.fn(async (config: unknown) => {
                harness.resumeCalls.push(config)
                if (harness.resumeBlocker) {
                    await harness.resumeBlocker
                }
                if (harness.resumeError) throw harness.resumeError
                return (config as { sessionId: string }).sessionId
            }),
            supportsImagePrompts: vi.fn(() => harness.supportsImages),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) =>
                category === 'thought_level' ? harness.thoughtLevelOption : harness.modelOption),
            getSessionModelsMetadata: vi.fn(() => harness.modelsMetadata),
            setConfigOption: vi.fn(async (sessionId: string, configId: string, value: string) => {
                harness.setConfigOptionCalls.push({ sessionId, configId, value })
                if (harness.setConfigOptionErrorQueue.length > 0) {
                    const error = harness.setConfigOptionErrorQueue.shift()
                    if (error) throw error
                }
                if (harness.configOptionError) throw harness.configOptionError
                return {}
            }),
            onStderrError: vi.fn(),
            onPermissionRequest: vi.fn(),
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

vi.mock('./utils/dshPromptContent', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils/dshPromptContent')>()
    return {
        ...actual,
        buildDshPromptContent: vi.fn(async (
            _backend: unknown,
            text: string,
            images: unknown[] | undefined,
            _opts: unknown
        ) => {
            harness.promptContentInputs.push({ text, images })
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

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: vi.fn(async () => ({
        server: { url: 'http://127.0.0.1:0/mcp', stop: vi.fn() },
        mcpServers: {}
    }))
}))

vi.mock('@/modules/common/permission/AcpPermissionHandler', () => ({
    AcpPermissionHandler: class {
        constructor(
            _session: unknown,
            _backend: unknown,
            getPermissionMode: () => string | undefined,
            options?: { onCancelIssued?: () => void }
        ) {
            harness.permissionGetMode = getPermissionMode
            harness.permissionCancelIssued = options?.onCancelIssued ?? null
        }
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { ACP_INDETERMINATE_SYMBOL } from '@/agent/backends/acp/AcpStdioTransport'
import { DshRemoteLauncher } from './dshRemoteLauncher'

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

function createQueue() {
    const queue = new MessageQueue2<DshMode>((mode) => JSON.stringify(mode))
    return queue
}

function createSession(queue = createQueue(), sessionId: string | null = null) {
    const session = {
        path: '/tmp/dsh-test',
        logPath: '/tmp/dsh-test/hapi.log',
        client: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateMetadata: vi.fn((fn: (metadata: unknown) => unknown) => fn({})),
            flushMetadata: vi.fn(async () => true)
        },
        queue,
        sessionId,
        // Mirrors AgentSessionBase.onSessionFound: re-pin the id and write
        // dshSessionId metadata through the client.
        onSessionFound: vi.fn((id: string) => {
            session.sessionId = id
            session.client.updateMetadata((metadata: unknown) => ({ ...(metadata as Record<string, unknown>), dshSessionId: id }))
        }),
        // Annotated wide so tests can override the method with any mode (or
        // undefined) — the launcher only reads it through the captured getter.
        getPermissionMode: (): string | undefined => 'default',
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
    return session
}

function createSessionWithBatches(batches: Array<[string, DshMode]>, sessionId: string | null = null) {
    const queue = createQueue()
    for (const [message, mode] of batches) {
        queue.push(message, mode)
    }
    queue.close()
    return createSession(queue, sessionId)
}

function createSessionWithMode(mode?: DshMode) {
    return createSessionWithBatches([['first', mode ?? {}]])
}

describe('DshRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.backends = []
        harness.createCalls = []
        harness.newSessionConfig = null
        harness.newSessionCalls = []
        harness.promptSessionIds = []
        harness.prompts = []
        harness.promptErrorQueue = []
        harness.initializeErrorQueue = []
        harness.promptStopReason = null
        harness.supportsResume = false
        harness.resumeCalls = []
        harness.resumeError = null
        harness.newSessionError = null
        harness.resumeBlocker = null
        harness.permissionGetMode = null
        harness.permissionCancelIssued = null
        harness.promptBlocker = null
        harness.newSessionBlocker = null
        harness.disconnectBlocker = null
        harness.modelOption = null
        harness.modelsMetadata = null
        harness.thoughtLevelOption = null
        harness.setConfigOptionCalls = []
        harness.configOptionError = null
        harness.setConfigOptionErrorQueue = []
        harness.supportsImages = false
        harness.promptContentInputs = []
    })

    it('creates a fresh ACP session and forwards text prompts', async () => {
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backend?.newSession).toHaveBeenCalledWith({
            cwd: '/tmp/dsh-test',
            mcpServers: []
        })
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
        expect(session.sendAgentMessage).toHaveBeenCalledWith({
            type: 'message',
            message: 'answer'
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        expect(harness.backend?.disconnect).toHaveBeenCalled()
    })

    it('wires the session permission mode into the ACP permission bridge', async () => {
        // The bridge must consult the live session mode on every permission
        // request — without this wiring, yolo cannot auto-approve and every
        // request escalates to a permission card.
        const session = createSessionWithMode()
        session.getPermissionMode = () => 'yolo'
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.permissionGetMode).not.toBeNull()
        expect(harness.permissionGetMode?.()).toBe('yolo')
    })

    it('reads the permission mode through the session on each request, not a launch-time copy', async () => {
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()
        session.getPermissionMode = () => 'yolo'

        expect(harness.permissionGetMode?.()).toBe('yolo')
    })

    it('reports an unset permission mode to the bridge (card escalation)', async () => {
        const session = createSessionWithMode()
        session.getPermissionMode = () => undefined
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.permissionGetMode?.()).toBeUndefined()
    })

    it('resumes the stored ACP session instead of creating a fresh one', async () => {
        harness.supportsResume = true
        const queue = createQueue()
        queue.push('hello again', {})
        queue.close()
        const session = createSession(queue, 'dsh-stored-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.resumeCalls).toEqual([{
            sessionId: 'dsh-stored-1',
            cwd: '/tmp/dsh-test',
            mcpServers: []
        }])
        expect(harness.newSessionCalls).toHaveLength(0)
        expect(harness.promptSessionIds).toEqual(['dsh-stored-1'])
        // Resumed id unchanged → still re-pinned: the write is an idempotent
        // metadata merge that self-heals rows whose earlier pin was lost.
        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-stored-1')
        expect(session.client.flushMetadata).toHaveBeenCalled()
    })

    it('persists the native id when an explicit resume opens a fresh HAPI row', async () => {
        // `hapi dsh --resume <id>` without --existing-session-id starts from a
        // new row whose metadata has no dshSessionId; the launcher must pin
        // the id even though the resume returns exactly the requested one.
        harness.supportsResume = true
        const queue = createQueue()
        queue.push('continue', {})
        queue.close()
        const session = createSession(queue, 'dsh-explicit-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.resumeCalls).toHaveLength(1)
        expect(harness.promptSessionIds).toEqual(['dsh-explicit-1'])
        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-explicit-1')
        expect(session.client.flushMetadata).toHaveBeenCalled()
    })

    it('falls back to a fresh session when resume fails and re-pins metadata', async () => {
        harness.supportsResume = true
        harness.resumeError = new Error('session not found on disk')
        const queue = createQueue()
        queue.push('hello', {})
        queue.close()
        const session = createSession(queue, 'dsh-stale-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.resumeCalls).toHaveLength(1)
        expect(harness.newSessionCalls).toHaveLength(1)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1'])
        // The fresh id must replace the stale one in metadata.
        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-session-1')
        expect(session.client.flushMetadata).toHaveBeenCalled()
        expect(session.sessionId).toBe('dsh-session-1')
    })

    it('falls back without probing session/resume when the server does not advertise it', async () => {
        harness.supportsResume = false
        const session = createSessionWithBatches([['first', {}]], 'dsh-existing-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.resumeCalls).toEqual([])
        expect(harness.newSessionCalls).toEqual([{ cwd: '/tmp/dsh-test', mcpServers: [] }])
    })

    it('pins dshSessionId metadata for a fresh session before the main loop', async () => {
        const queue = createQueue()
        queue.push('first', {})
        queue.close()
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-session-1')
        expect(session.client.updateMetadata).toHaveBeenCalledWith(expect.any(Function))
        expect(session.client.flushMetadata).toHaveBeenCalled()
        expect(session.sessionId).toBe('dsh-session-1')
    })

    it('does not restart the session after a standard session/cancel abort', async () => {
        // The official dsh server keeps the session alive across
        // session/cancel (verified against 0.2.2-rc.1): the next message must
        // run on the SAME session — no resume, no session/new.
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        const killPromise = launcher.kill()
        expect(harness.backend?.cancelPrompt).toHaveBeenCalledWith('dsh-session-1')
        releaseFirstPrompt()
        await killPromise

        queue.push('second', {})
        queue.close()
        await done

        expect(harness.newSessionCalls).toHaveLength(1)
        expect(harness.resumeCalls).toEqual([])
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-1'])
    })

    it('treats a terminal session-gone prompt rejection after a cancel as an implicit session end', async () => {
        // Custom dsh wrappers may CLOSE the ACP session on session/cancel
        // without exiting the process — invisible on the standard-cancel path
        // (no close event exists there). The next prompt's terminal
        // unknown/expired-session rejection is the only observable signal:
        // it must mark the session ended so the following message re-enters
        // the restart branch instead of failing on the dead session forever.
        harness.supportsResume = true
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // Standard cancel (notification, no session-close event); the
        // wrapper closes the session behind it while the cancelled prompt
        // itself still resolves normally.
        const killPromise = launcher.kill()
        releaseFirstPrompt()
        await killPromise

        // The next prompt lands on the closed session and is rejected.
        harness.promptErrorQueue = [new Error('Session not found: dsh-session-1')]
        queue.push('second', {})
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(2))

        queue.push('third', {})
        queue.close()
        await done

        // 'second' failed with the implicit-end surfaced...
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'DSH prompt failed (session closed by the earlier cancel; restarting it for the next message): Session not found: dsh-session-1'
        })
        // ...and 'third' re-entered the restart branch: the stored id is
        // resumed and the turn runs on it.
        expect(harness.resumeCalls).toEqual([{
            sessionId: 'dsh-session-1',
            cwd: '/tmp/dsh-test',
            mcpServers: []
        }])
        expect(harness.newSessionCalls).toHaveLength(1)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-1', 'dsh-session-1'])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }],
            [{ type: 'text', text: 'third' }]
        ])
    })

    it('keeps the ordinary failure surface when a session-gone rejection arrives without a prior cancel', async () => {
        // Without an armed cancel the same rejection is NOT an implicit
        // session end: attributing it to a cancel that never happened would
        // restart healthy sessions. Ordinary surface-and-continue only.
        harness.supportsResume = true
        harness.promptErrorQueue = [new Error('Session not found: dsh-session-1')]
        // Distinct modes keep the two messages as separate queue batches (an
        // empty image list is inert here — it only changes the mode hash).
        const session = createSessionWithBatches([
            ['first', {}],
            ['second', { imageAttachments: [] }]
        ])
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'DSH prompt failed: Session not found: dsh-session-1'
        })
        expect(harness.resumeCalls).toEqual([])
        expect(harness.newSessionCalls).toHaveLength(1)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-1'])
    })

    it('arms the implicit-end detector when a permission abort cancels through the backend directly', async () => {
        // A permission denied with decision 'abort' cancels through
        // AcpPermissionHandler → backend.cancelPrompt, bypassing handleAbort.
        // The handler's onCancelIssued hook must arm the implicit-end
        // detector so a session-gone rejection after THAT cancel is
        // attributable and the session restarts for the next message.
        harness.supportsResume = true
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // The permission handler's abort path: the hook fires around the
        // direct backend cancellation.
        harness.permissionCancelIssued?.()
        releaseFirstPrompt()

        // The next prompt lands on the (wrapper-)closed session and fails.
        harness.promptErrorQueue = [new Error('Session not found: dsh-session-1')]
        queue.push('second', {})
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(2))

        queue.push('third', {})
        queue.close()
        await done

        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'DSH prompt failed (session closed by the earlier cancel; restarting it for the next message): Session not found: dsh-session-1'
        })
        // 'third' restarted the stored id.
        expect(harness.resumeCalls).toEqual([{
            sessionId: 'dsh-session-1',
            cwd: '/tmp/dsh-test',
            mcpServers: []
        }])
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-1', 'dsh-session-1'])
    })

    it('re-applies the model and effort preferences on the fresh session after an implicit end', async () => {
        // The fresh session created by the post-abort fallback starts from
        // the server default — the closed session's config died with it. The
        // respawn contract must be mirrored here: re-apply the live model and
        // reasoning-effort preferences so the next batch does not silently
        // run on the default while the hub picker still shows the user's
        // choice.
        harness.supportsResume = true
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.thoughtLevelOption = { id: 'reasoning_effort', category: 'thought_level', currentValue: '' }
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        // Turn 1 carries both preferences: the model switch and the effort
        // switch below record them as the session's live preferences.
        queue.push('first', { model: PRO, modelReasoningEffort: 'high' })
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // Standard cancel; the wrapper closes the session behind it.
        const killPromise = launcher.kill()
        releaseFirstPrompt()
        await killPromise

        // 'second' lands on the closed session → implicit end.
        harness.promptErrorQueue = [new Error('Session not found: dsh-session-1')]
        queue.push('second', {})
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(2))

        // The closed session vanishes on disk: the recovery branch falls
        // back to a FRESH session, which must get both preferences re-applied.
        harness.resumeError = new Error('session not found on disk')
        queue.push('third', {})
        queue.close()
        await done

        expect(harness.newSessionCalls).toHaveLength(2)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-1', 'dsh-session-2'])
        // Turn 1's two switches, then the fresh-session re-apply of both —
        // on the NEW session id.
        expect(harness.setConfigOptionCalls.map((call) => call.value)).toEqual([PRO, 'high', PRO, 'high'])
        expect(harness.setConfigOptionCalls[2]).toEqual({
            sessionId: 'dsh-session-2',
            configId: 'model',
            value: PRO
        })
        expect(harness.setConfigOptionCalls[3]).toEqual({
            sessionId: 'dsh-session-2',
            configId: 'reasoning_effort',
            value: 'high'
        })
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }],
            [{ type: 'text', text: 'third' }]
        ])
    })

    it('drops the dequeued message when an abort lands while the closed session is being resumed', async () => {
        // An abort inside the post-abort resume window targets the already
        // closed session id; the generation check must discard the dequeued
        // batch and re-enter the restart branch for the next message.
        harness.supportsResume = true
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        const killPromise = launcher.kill()
        releaseFirstPrompt()
        await killPromise

        // 'second' lands on the closed session → implicit end.
        harness.promptErrorQueue = [new Error('Session not found: dsh-session-1')]
        queue.push('second', {})
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(2))

        // 'third' enters the restart branch; park session/resume.
        let releaseResume!: () => void
        harness.resumeBlocker = new Promise((resolve) => { releaseResume = resolve })
        queue.push('third', {})
        await vi.waitFor(() => expect(harness.resumeCalls).toHaveLength(1))

        // Abort inside the resume window, then let session/resume resolve.
        const secondKill = launcher.kill()
        await secondKill
        releaseResume()

        // The aborted 'third' must be dropped, not executed; 'fourth' resumes
        // the still-stored id cleanly.
        queue.push('fourth', {})
        queue.close()
        await done

        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-1', 'dsh-session-1'])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }],
            [{ type: 'text', text: 'fourth' }]
        ])
    })

    it('drops the dequeued message when an abort lands during the reconnect before the batch runs', async () => {
        // The mid-prompt respawn fails, so the NEXT message enters the
        // top-of-loop reconnect with no backend. An abort landing inside
        // that respawn window must discard the already-dequeued batch —
        // the same contract as the mid-prompt and recovery windows.
        harness.promptErrorQueue = [deadTransportError()]
        harness.initializeErrorQueue = [null, new Error('Failed to spawn dsh: not found')]
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        // Initial establishment + the failed mid-prompt respawn.
        await vi.waitFor(() => expect(harness.backends).toHaveLength(2))

        // 'second' enters the top-of-loop reconnect; park session/new.
        let releaseNewSession!: () => void
        harness.newSessionBlocker = new Promise((resolve) => { releaseNewSession = resolve })
        queue.push('second', {})
        await vi.waitFor(() => expect(harness.newSessionCalls).toHaveLength(2))

        // Abort inside the reconnect window, then let the respawn finish.
        const killPromise = launcher.kill()
        await killPromise
        releaseNewSession()
        queue.close()
        await done

        // 'second' was dropped after the reconnect completed: only 'first'
        // ever reached prompt, and no retry of it ran either.
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
    })

    it('keeps the loop alive when the backend dies during closed-session recovery', async () => {
        // A child exit inside the post-abort recovery window rejects every
        // RPC on the dead backend; the failure must surface as one error and
        // a reconnect on the next message instead of escaping the loop.
        harness.supportsResume = true
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
        const killPromise = launcher.kill()
        releaseFirstPrompt()
        await killPromise

        // 'second' hits the closed session → implicit end.
        harness.promptErrorQueue = [new Error('Session not found: dsh-session-1')]
        queue.push('second', {})
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(2))

        // 'third' enters recovery; the backend dies inside it (resume AND
        // the fresh session/new both reject).
        harness.resumeError = deadTransportError('session/resume failed: ACP process exited (code=1)')
        harness.newSessionError = deadTransportError('session/new failed: ACP process exited (code=1)')
        queue.push('third', {})
        queue.close()
        await done

        // The loop survived: the recovery failure was surfaced as an error
        // event, 'third' never ran, and no unhandled rejection escaped.
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'DSH session restart failed: session/new failed: ACP process exited (code=1)'
        })
    })

    it('discovers the current model from the model config option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const onConfigDiscovered = vi.fn()
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never, { onConfigDiscovered })

        await launcher.launch()

        // No override → no set_config_option call, only discovery.
        expect(harness.setConfigOptionCalls).toEqual([])
        expect(onConfigDiscovered).toHaveBeenCalledWith(FLASH)
    })

    it('applies a spawn model override through session/set_config_option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const onConfigDiscovered = vi.fn()
        const session = createSessionWithMode({ model: PRO })
        const launcher = new DshRemoteLauncher(session as never, { model: PRO, onConfigDiscovered })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([{
            sessionId: 'dsh-session-1',
            configId: 'model',
            value: PRO
        }])
        expect(onConfigDiscovered).toHaveBeenCalledWith(PRO)
    })

    it('switches the model per-turn when the queued mode requests a different one', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const session = createSessionWithMode({ model: PRO })
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([{
            sessionId: 'dsh-session-1',
            configId: 'model',
            value: PRO
        }])
        // The prompt still ran after the switch.
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('applies reasoning effort through the thought_level config option, mapping Default to empty string', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.thoughtLevelOption = { id: 'reasoning_effort', category: 'thought_level', currentValue: '' }
        const session = createSessionWithBatches([
            ['first', { modelReasoningEffort: 'high' }],
            ['second', { modelReasoningEffort: null }]
        ])
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        const effortCalls = harness.setConfigOptionCalls.filter((call) => call.configId === 'reasoning_effort')
        expect(effortCalls).toEqual([
            { sessionId: 'dsh-session-1', configId: 'reasoning_effort', value: 'high' },
            // null ("Default" in the picker) maps to DSH's '' = Provider default.
            { sessionId: 'dsh-session-1', configId: 'reasoning_effort', value: '' }
        ])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
    })

    it('skips reasoning effort with a status note when the model exposes no thought_level option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.thoughtLevelOption = null
        const session = createSessionWithBatches([['first', { modelReasoningEffort: 'high' }]])
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setConfigOptionCalls.filter((call) => call.configId === 'reasoning_effort')).toEqual([])
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('keeps the previous effort and rolls back the host tracking when a per-turn switch fails', async () => {
        // Same contract as the model switch: a failed set_config_option must
        // not leave the hub picker showing the failed value, and later turns
        // must stop re-requesting it — the rollback reports the live value.
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.thoughtLevelOption = { id: 'reasoning_effort', category: 'thought_level', currentValue: '' }
        const onEffortRollback = vi.fn()
        const queue = createQueue()
        queue.push('first', { modelReasoningEffort: 'high' })
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never, { onEffortRollback })

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
        // The second pick fails: the model rejects the effort value.
        harness.configOptionError = new Error('invalid effort value')
        queue.push('second', { modelReasoningEffort: 'max' })
        queue.close()
        await done

        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Failed to switch DSH reasoning effort: invalid effort value'
        })
        // The host is told the LIVE preference ('high' — the last applied
        // value), not the failed 'max'.
        expect(onEffortRollback).toHaveBeenCalledWith('high')
        // Both turns still ran.
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
    })

    it('rolls the effort tracking back to unset when no thought_level option exists', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.thoughtLevelOption = null
        const onEffortRollback = vi.fn()
        const session = createSessionWithBatches([['first', { modelReasoningEffort: 'high' }]])
        const launcher = new DshRemoteLauncher(session as never, { onEffortRollback })

        await launcher.launch()

        // Nothing was ever applied: the host drops the preference entirely so
        // subsequent turns stop carrying the effort field (and the repeated
        // "no thought levels" note stops).
        expect(onEffortRollback).toHaveBeenCalledWith(undefined)
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('drops the effort preference when the respawn re-apply fails', async () => {
        // The preference was proven on the dead session, but the fresh one
        // rejects it (e.g. a model switch): the respawn re-apply drops the
        // preference instead of failing the establishment or retrying the
        // stale value on every later respawn, and tells the host.
        harness.modelOption = null
        harness.modelsMetadata = null
        harness.thoughtLevelOption = { id: 'reasoning_effort', category: 'thought_level', currentValue: '' }
        // First apply succeeds, the respawn's re-apply fails.
        harness.setConfigOptionErrorQueue = [null, new Error('unknown effort value')]
        harness.promptErrorQueue = [deadTransportError()]
        const onEffortRollback = vi.fn()
        const session = createSessionWithBatches([['hello', { modelReasoningEffort: 'high' }]], 'dsh-existing-1')
        const launcher = new DshRemoteLauncher(session as never, { onEffortRollback })

        await launcher.launch()

        const effortCalls = harness.setConfigOptionCalls.filter((call) => call.configId === 'reasoning_effort')
        expect(effortCalls.map((call) => call.value)).toEqual(['high', 'high'])
        // The failed re-apply surfaced once and dropped the preference.
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Failed to switch DSH reasoning effort: unknown effort value'
        })
        expect(onEffortRollback).toHaveBeenCalledWith(undefined)
        // The respawn still delivered the retried batch.
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'hello' }],
            [{ type: 'text', text: 'hello' }]
        ])
    })

    it('resets to the server default when Default is requested after a spawn-time override', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const onConfigDiscovered = vi.fn()
        // Production sequence: spawn with an override, user later picks
        // "Default" in the picker, next message carries model: null.
        const session = createSessionWithBatches([['first', { model: null }]])
        const launcher = new DshRemoteLauncher(session as never, { model: PRO, onConfigDiscovered })

        await launcher.launch()

        expect(harness.setConfigOptionCalls.map((call) => call.value)).toEqual([PRO, FLASH])
        expect(onConfigDiscovered).toHaveBeenCalledWith(PRO)
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('resets to the server default when Default is requested after a per-turn switch', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const session = createSessionWithBatches([
            ['first', { model: PRO }],
            ['second', { model: null }]
        ])
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.setConfigOptionCalls.map((call) => call.value)).toEqual([PRO, FLASH])
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
            ['first', { model: PRO }],
            ['second', { model: null }]
        ])
        const launcher = new DshRemoteLauncher(session as never, { onModelRollback })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toEqual([])
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Cannot reset the DSH model: the agent did not report a default model.'
        })
        // Both prompts still ran.
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
    })

    it('keeps the previous model and rolls back when a per-turn switch fails', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.configOptionError = new Error('unknown model option')
        const onModelRollback = vi.fn()
        const session = createSessionWithMode({ model: PRO })
        const launcher = new DshRemoteLauncher(session as never, { onModelRollback })

        await launcher.launch()

        expect(harness.setConfigOptionCalls).toHaveLength(1)
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Failed to switch DSH model: unknown model option'
        })
        expect(onModelRollback).toHaveBeenCalledWith(FLASH)
        // The prompt still ran with the unchanged model.
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('does not treat an ordinary turn without model metadata as a reset request', async () => {
        // No model option and no metadata: the server never reported a model,
        // so a preference-less turn (mode {}) must run as an ordinary prompt
        // without emitting the reset-failure event.
        harness.modelOption = null
        harness.modelsMetadata = null
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
        const resetFailures = events.filter((call) =>
            String((call[0] as { message?: string } | undefined)?.message ?? '').includes('Cannot reset'))
        expect(resetFailures).toEqual([])
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('answers ListDshModels once a delayed session/new completes', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.modelsMetadata = {
            availableModels: [{ modelId: FLASH, name: 'DeepSeek-V41-Flash' }],
            currentModelId: FLASH
        }
        // Park session/new: the picker's catalog query arrives while the ACP
        // session is still being created.
        let releaseNewSession!: () => void
        harness.newSessionBlocker = new Promise((resolve) => { releaseNewSession = resolve })
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        const registered = await vi.waitFor(() => {
            const call = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
                .find((c) => c[0] === 'listDshModels')
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
            availableModels: [{ modelId: FLASH, name: 'DeepSeek-V41-Flash' }],
            currentModelId: FLASH
        })
    })

    it('serves ListDshModels with the live current model', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.modelsMetadata = {
            availableModels: [
                { modelId: FLASH, name: 'DeepSeek-V41-Flash' },
                { modelId: PRO, name: 'DeepSeek-V4-Pro' }
            ],
            currentModelId: FLASH
        }
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        const registered = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
            .find((call) => call[0] === 'listDshModels')
        expect(registered).toBeTruthy()
        const handler = registered![1] as () => Promise<unknown>
        await expect(handler()).resolves.toEqual({
            success: true,
            availableModels: [
                { modelId: FLASH, name: 'DeepSeek-V41-Flash' },
                { modelId: PRO, name: 'DeepSeek-V4-Pro' }
            ],
            currentModelId: FLASH
        })
    })

    it('parks a ListDshModels query that arrives during the MCP bridge build, then answers it', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.modelsMetadata = {
            availableModels: [{ modelId: FLASH, name: 'DeepSeek-V41-Flash' }],
            currentModelId: FLASH
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
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        const registered = await vi.waitFor(() => {
            const call = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
                .find((c) => c[0] === 'listDshModels')
            expect(call).toBeTruthy()
            return call!
        })

        // While the bridge build is pending the query must PARK on the
        // seeded placeholder readiness — the pre-fix launcher answered a
        // terminal 'DSH session is not available' error in this window.
        const pending = (registered[1] as () => Promise<unknown>)()
        await expect(settlesQuickly(pending)).resolves.toBe(false)
        releaseBridge()
        await done

        // The first establishment adopts the placeholder and settles it: the
        // parked query now answers with the discovered catalog.
        await expect(pending).resolves.toEqual({
            success: true,
            availableModels: [{ modelId: FLASH, name: 'DeepSeek-V41-Flash' }],
            currentModelId: FLASH
        })
    })

    it('parks a ListDshModels query that arrives during respawn teardown, then answers from the replacement', async () => {
        harness.promptErrorQueue = [deadTransportError()]
        harness.supportsResume = true
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        harness.modelsMetadata = {
            availableModels: [{ modelId: FLASH, name: 'DeepSeek-V41-Flash' }],
            currentModelId: FLASH
        }
        // The first prompt dies with the transport marker; the dead backend's
        // disconnect parks, so the respawn is mid-teardown (readiness already
        // swapped, replacement not yet established) when the query arrives.
        let releaseDisconnect!: () => void
        harness.disconnectBlocker = new Promise<void>((resolve) => { releaseDisconnect = resolve })
        const session = createSessionWithBatches([['hello', {}]], 'dsh-existing-1')
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        const registered = await vi.waitFor(() => {
            const call = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>).mock.calls
                .find((c) => c[0] === 'listDshModels')
            expect(call).toBeTruthy()
            return call!
        })
        await vi.waitFor(() => {
            const events = (session.sendSessionEvent as ReturnType<typeof vi.fn>).mock.calls
            expect(events.some((call) =>
                String((call[0] as { message?: string } | undefined)?.message ?? '').includes('reconnecting'))).toBe(true)
        })

        // Mid-teardown the query must PARK on the fresh pending handshake
        // armed at the top of the respawn — a stale answer served off the
        // corpse's settled handshake is what this guards against.
        const pending = (registered[1] as () => Promise<unknown>)()
        await expect(settlesQuickly(pending)).resolves.toBe(false)
        releaseDisconnect()
        await done

        await expect(pending).resolves.toEqual({
            success: true,
            availableModels: [{ modelId: FLASH, name: 'DeepSeek-V41-Flash' }],
            currentModelId: FLASH
        })
        // The answer was served from the REPLACEMENT backend's metadata,
        // never from the corpse.
        expect(harness.backends[1].getSessionModelsMetadata).toHaveBeenCalledWith('dsh-existing-1')
        expect(harness.backends[0].getSessionModelsMetadata).not.toHaveBeenCalled()
    })

    it('respawns the ACP backend and retries the same batch when the child process dies', async () => {
        // The dsh child died mid-prompt: session/prompt rejects with the
        // transport's typed dead-marker. The launcher must disconnect the
        // corpse, respawn a fresh child, resume the PINNED durable
        // dshSessionId (same cwd — dsh compares resume cwds by realpath),
        // and retry the SAME batch exactly once.
        harness.supportsResume = true
        harness.promptErrorQueue = [deadTransportError()]
        const queue = createQueue()
        queue.push('hello', {})
        queue.close()
        const session = createSession(queue, 'dsh-stored-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        // The dead backend was disconnected and a fresh one created + initialized.
        expect(harness.backends).toHaveLength(2)
        expect(harness.backends[0].disconnect).toHaveBeenCalled()
        expect(harness.backends[1].initialize).toHaveBeenCalled()
        // The respawn resumes the pinned durable id with the SAME cwd used
        // originally — dsh rejects mismatched resume cwds terminally.
        expect(harness.backends[1].resumeSession).toHaveBeenCalledWith({
            sessionId: 'dsh-stored-1',
            cwd: '/tmp/dsh-test',
            mcpServers: []
        })
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
            message: 'DSH connection lost; reconnecting…'
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        expect(harness.backends[1].disconnect).toHaveBeenCalled()
    })

    it('re-applies the live model on the respawned backend before the retried batch', async () => {
        // The fresh child starts from whatever the server persisted; the
        // respawn must re-apply the session's live model so the retry does
        // not silently run on the server default.
        harness.supportsResume = true
        harness.promptErrorQueue = [deadTransportError()]
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const queue = createQueue()
        queue.push('hello', { model: PRO })
        queue.close()
        const session = createSession(queue, 'dsh-stored-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        // Discovery default, the batch's switch to PRO on the first backend,
        // then the respawn's restore of PRO on the replacement.
        expect(harness.setConfigOptionCalls.map((call) => call.value)).toEqual([PRO, PRO])
        expect(harness.setConfigOptionCalls[1].sessionId).toBe('dsh-stored-1')
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'hello' }],
            [{ type: 'text', text: 'hello' }]
        ])
    })

    it('surfaces the error and keeps the loop alive when the respawn also fails', async () => {
        harness.supportsResume = true
        harness.promptErrorQueue = [deadTransportError()]
        // First initialize succeeds (initial establishment), the respawn's
        // initialize fails (dsh binary gone); the next message's fresh
        // respawn attempt succeeds again.
        harness.initializeErrorQueue = [null, new Error('Failed to spawn dsh: not found')]
        // Distinct modes so the queue keeps the two messages as separate
        // batches instead of merging them into one turn.
        const session = createSessionWithBatches([
            ['a', {}],
            ['b', { model: PRO }]
        ], 'dsh-stored-1')
        const launcher = new DshRemoteLauncher(session as never)

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
            message: 'DSH reconnect failed: Failed to spawn dsh: not found'
        })
        expect(harness.backends[2].resumeSession).toHaveBeenCalledWith({
            sessionId: 'dsh-stored-1',
            cwd: '/tmp/dsh-test',
            mcpServers: []
        })
    })

    it('does not respawn when the prompt fails with a regular agent error', async () => {
        harness.promptErrorQueue = [new Error('some agent-side failure')]
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        // A JSON-RPC rejection is not a dead transport: old behavior only.
        expect(harness.backends).toHaveLength(1)
        expect(harness.backends[0].disconnect).toHaveBeenCalledTimes(1)
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'DSH prompt failed: some agent-side failure'
        })
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('reports a distinct truncation line for a max_tokens turn', async () => {
        // dsh reports stopReason end_turn|max_tokens|cancelled; a turn cut
        // short by the context limit must not read as a normal completion.
        // (Captured via the buffer listener: finalizeTerminal clears the
        // buffer before launch() resolves.)
        harness.promptStopReason = 'max_tokens'
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)
        const lines = new Set<string>()
        ;(launcher as unknown as {
            messageBuffer: { onUpdate: (listener: (messages: Array<{ content: string }>) => void) => void }
        }).messageBuffer.onUpdate((messages) => {
            for (const message of messages) lines.add(message.content)
        })

        await launcher.launch()

        expect([...lines]).toContain('Turn truncated: context limit reached')
        expect([...lines]).not.toContain('Turn complete')
        // Remote clients read the session event channel, not the local
        // buffer: the truncation must be published there too.
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Turn truncated: the model hit its output limit before finishing (max_tokens).'
        })
    })

    it('reports the normal completion line for an end_turn turn', async () => {
        harness.promptStopReason = 'end_turn'
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)
        const lines = new Set<string>()
        ;(launcher as unknown as {
            messageBuffer: { onUpdate: (listener: (messages: Array<{ content: string }>) => void) => void }
        }).messageBuffer.onUpdate((messages) => {
            for (const message of messages) lines.add(message.content)
        })

        await launcher.launch()

        expect([...lines]).toContain('Turn complete')
        expect([...lines]).not.toContain('Turn truncated: context limit reached')
    })

    it('mounts the hapi MCP bridge servers on the ACP session', async () => {
        const { buildHapiMcpBridge } = await import('@/codex/utils/buildHapiMcpBridge')
        const stop = vi.fn()
        vi.mocked(buildHapiMcpBridge).mockResolvedValueOnce({
            server: { url: 'http://127.0.0.1:9/mcp', stop },
            mcpServers: {
                hapi: { command: '/usr/local/bin/hapi', args: ['mcp', '--url', 'http://127.0.0.1:9/mcp'], tools: {} }
            }
        } as never)
        const session = createSessionWithMode()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(buildHapiMcpBridge).toHaveBeenCalledWith(session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: '/tmp/dsh-test', flavor: 'dsh' }
        })
        expect(harness.newSessionCalls[0]).toEqual({
            cwd: '/tmp/dsh-test',
            mcpServers: [{
                name: 'hapi',
                command: '/usr/local/bin/hapi',
                args: ['mcp', '--url', 'http://127.0.0.1:9/mcp'],
                env: []
            }]
        })
        // The bridge server is torn down with the launcher.
        expect(stop).toHaveBeenCalled()
    })

    it('threads the spawn-time permission mode into createDshBackend', async () => {
        // The env overlay itself (read-only → DSH_PERMISSION_MODE=read-only,
        // yolo → danger-full-access, default/safe-yolo unset) is unit-tested
        // against the real createDshBackend in dshBackend.test.ts; this pins
        // the launcher-side threading of the spawn-time mode.
        const session = createSessionWithMode()
        await new DshRemoteLauncher(session as never, { permissionMode: 'read-only' }).launch()

        expect(harness.createCalls).toHaveLength(1)
        expect(harness.createCalls[0].opts?.permissionMode).toBe('read-only')
    })

    it('upgrades image attachments to ACP image blocks when the backend advertises image prompts', async () => {
        harness.supportsImages = true
        const images = [{ path: '/uploads/screenshot.png', mimeType: 'image/png', filename: 'screenshot.png' }]
        const queue = createQueue()
        queue.push('look at this', { imageAttachments: images })
        queue.close()
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.promptContentInputs).toEqual([{ text: 'look at this', images }])
        expect(harness.prompts).toEqual([[
            { type: 'text', text: 'look at this' },
            { type: 'image', data: 'b64:/uploads/screenshot.png', mimeType: 'image/png' }
        ]])
    })

    it('keeps an image turn prompt text-only when the backend does not advertise image prompts', async () => {
        // Older dsh / pinned community wrappers without
        // promptCapabilities.image: the fallback @path form is produced by
        // buildDshPromptContent itself; here the gate must simply keep the
        // turn text-only rather than sending rejected image blocks.
        harness.supportsImages = false
        const queue = createQueue()
        queue.push('look at this', {
            imageAttachments: [{ path: '/uploads/screenshot.png', mimeType: 'image/png' }]
        })
        queue.close()
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.prompts).toEqual([[{ type: 'text', text: 'look at this' }]])
    })
})
