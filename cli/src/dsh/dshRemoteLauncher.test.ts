import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { DshMode } from './types'

const FLASH = '["deepseek-official","deepseek-flash"]'
const PRO = '["deepseek-official","deepseek-v4-pro"]'

const harness = vi.hoisted(() => ({
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    newSessionConfig: null as unknown,
    prompts: [] as unknown[][],
    newSessionCalls: [] as unknown[],
    promptSessionIds: [] as string[],
    modelOption: null as { id: string; category?: string; currentValue?: string } | null,
    modelsMetadata: null as {
        availableModels: Array<{ modelId: string; name?: string }>
        currentModelId: string | null
    } | null,
    setConfigOptionCalls: [] as Array<{ sessionId: string; configId: string; value: string }>,
    configOptionError: null as Error | null,
    supportsCancel: true,
    // When set, newSession() parks on this promise — lets tests query the
    // catalog RPC while session/new is still pending, or abort inside the
    // respawn window.
    newSessionBlocker: null as null | Promise<void>,
    // Registered by onSessionClosedByCancel; fired by the cancelPrompt mock
    // on the close path, mirroring the real backend.
    sessionClosedHandler: null as (() => void) | null,
    // Captured 4th constructor arg of AcpPermissionHandler: the synchronous
    // pending-close handoff for permission 'abort' decisions.
    permissionAbortClose: null as ((cancellation: Promise<void>) => void) | null,
    // When set, prompt() parks on this promise — lets tests abort mid-turn.
    promptBlocker: null as null | Promise<void>,
    // When set, a close-path cancelPrompt parks on this promise — lets tests
    // overlap prompt completion with a pending session/close response.
    cancelBlocker: null as null | Promise<void>,
    supportsResume: false,
    resumeCalls: [] as unknown[],
    resumeError: null as Error | null,
    permissionGetMode: null as (() => string | undefined) | null,
    sessionPermissionMode: undefined as string | undefined
}))

vi.mock('./utils/dshBackend', () => ({
    createDshBackend: vi.fn(() => {
        const backend = {
            initialize: vi.fn(async () => {}),
            newSession: vi.fn(async (config: unknown) => {
                harness.newSessionConfig = config
                harness.newSessionCalls.push(config)
                if (harness.newSessionBlocker) {
                    await harness.newSessionBlocker
                }
                return `dsh-session-${harness.newSessionCalls.length}`
            }),
            prompt: vi.fn(async (sessionId: string, content: unknown[], onUpdate: (message: unknown) => void) => {
                harness.promptSessionIds.push(sessionId)
                harness.prompts.push(content)
                if (harness.promptBlocker) {
                    await harness.promptBlocker
                }
                onUpdate({ type: 'text', text: 'answer' })
            }),
            cancelPrompt: vi.fn(async () => {
                if (harness.supportsCancel) return
                if (harness.cancelBlocker) {
                    await harness.cancelBlocker
                }
                harness.sessionClosedHandler?.()
            }),
            getConfigOptionByCategory: vi.fn(() => harness.modelOption),
            getSessionModelsMetadata: vi.fn(() => harness.modelsMetadata),
            setConfigOption: vi.fn(async (sessionId: string, configId: string, value: string) => {
                harness.setConfigOptionCalls.push({ sessionId, configId, value })
                if (harness.configOptionError) throw harness.configOptionError
                return {}
            }),
            supportsCancelNotification: vi.fn(() => harness.supportsCancel),
            supportsSessionResume: vi.fn(() => harness.supportsResume),
            resumeSession: vi.fn(async (config: unknown) => {
                harness.resumeCalls.push(config)
                if (harness.resumeError) throw harness.resumeError
                return (config as { sessionId: string }).sessionId
            }),
            onStderrError: vi.fn(),
            onSessionClosedByCancel: vi.fn((handler: () => void) => {
                harness.sessionClosedHandler = handler
            }),
            onPermissionRequest: vi.fn(),
            disconnect: vi.fn(async () => {})
        }
        harness.backend = backend
        return backend
    })
}))

vi.mock('@/modules/common/permission/AcpPermissionHandler', () => ({
    AcpPermissionHandler: class {
        constructor(
            _session: unknown,
            _backend: unknown,
            getPermissionMode: () => string | undefined,
            onAbortClose?: (cancellation: Promise<void>) => void
        ) {
            harness.permissionGetMode = getPermissionMode
            harness.permissionAbortClose = onAbortClose ?? null
        }
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { DshRemoteLauncher } from './dshRemoteLauncher'

function createSessionWithBatches(batches: Array<[string, DshMode]>) {
    const queue = new MessageQueue2<DshMode>((m) => JSON.stringify(m))
    for (const [message, mode] of batches) {
        queue.push(message, mode)
    }
    queue.close()
    return createSessionWithQueue(queue)
}

function createQueue() {
    const queue = new MessageQueue2<DshMode>((mode) => JSON.stringify(mode))
    return queue
}

function createSessionWithQueue(queue = createQueue(), sessionId: string | null = null) {
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
        getPermissionMode: () => harness.sessionPermissionMode,
        // Mirrors AgentSessionBase.onSessionFound: re-pin the id and write
        // dshSessionId metadata through the client.
        onSessionFound: vi.fn((id: string) => {
            session.sessionId = id
            session.client.updateMetadata((metadata: unknown) => ({ ...(metadata as Record<string, unknown>), dshSessionId: id }))
        }),
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
    return session
}


function createSession(mode?: DshMode) {
    return createSessionWithBatches([['first', mode ?? {}]])
}

describe('DshRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.newSessionConfig = null
        harness.newSessionCalls = []
        harness.promptSessionIds = []
        harness.prompts = []
        harness.modelOption = null
        harness.modelsMetadata = null
        harness.setConfigOptionCalls = []
        harness.configOptionError = null
        harness.newSessionBlocker = null
        harness.supportsCancel = true
        harness.sessionClosedHandler = null
        harness.permissionAbortClose = null
        harness.promptBlocker = null
        harness.cancelBlocker = null
        harness.supportsResume = false
        harness.resumeCalls = []
        harness.resumeError = null
        harness.permissionGetMode = null
        harness.sessionPermissionMode = undefined
    })

    it('creates a fresh ACP session without MCP injection and forwards text prompts', async () => {
        const queue = createQueue()
        queue.push('first', {})
        queue.close()
        const session = createSessionWithQueue(queue)
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
        harness.sessionPermissionMode = 'yolo'
        const queue = createQueue()
        queue.push('first', {})
        queue.close()
        const session = createSessionWithQueue(queue)
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.permissionGetMode).not.toBeNull()
        expect(harness.permissionGetMode?.()).toBe('yolo')
    })

    it('observes runtime mode changes made after launch (SetSessionConfig wiring)', async () => {
        // The mode picker applies changes via SetSessionConfig →
        // session.setPermissionMode; the bridge must read through to the
        // session on each permission request, not a launch-time copy.
        harness.sessionPermissionMode = 'default'
        const queue = createQueue()
        queue.push('first', {})
        queue.close()
        const session = createSessionWithQueue(queue)
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()
        session.getPermissionMode = () => 'yolo'

        expect(harness.permissionGetMode?.()).toBe('yolo')
    })

    it('reports an unset permission mode to the bridge (card escalation)', async () => {
        const queue = createQueue()
        queue.push('first', {})
        queue.close()
        const session = createSessionWithQueue(queue)
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.permissionGetMode?.()).toBeUndefined()
    })

    it('discovers the current model from the model config option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const onConfigDiscovered = vi.fn()
        const session = createSession()
        const launcher = new DshRemoteLauncher(session as never, { onConfigDiscovered })

        await launcher.launch()

        // No override → no set_config_option call, only discovery.
        expect(harness.setConfigOptionCalls).toEqual([])
        expect(onConfigDiscovered).toHaveBeenCalledWith(FLASH)
    })

    it('applies a spawn model override through session/set_config_option', async () => {
        harness.modelOption = { id: 'model', category: 'model', currentValue: FLASH }
        const onConfigDiscovered = vi.fn()
        const session = createSession({ model: PRO })
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
        const session = createSession({ model: PRO })
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
        const session = createSession({ model: PRO })
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
        const session = createSession()
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
        const session = createSession()
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
        const session = createSession()
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

    it('respawns the ACP session for the next message after a close-based abort', async () => {
        // dsh advertises close/list/resume without cancel: abort falls back to
        // session/close, which ends the ACP session but leaves the process
        // alive. The launcher must open a fresh session before the next prompt.
        harness.supportsCancel = false
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSessionWithQueue(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // Abort while the first turn is still in flight (the real-world path).
        const killPromise = launcher.kill()
        expect(harness.backend?.cancelPrompt).toHaveBeenCalledWith('dsh-session-1')
        releaseFirstPrompt()
        await killPromise

        queue.push('second', {})
        queue.close()
        await done

        expect(harness.newSessionCalls).toHaveLength(2)
        expect(harness.newSessionCalls[1]).toEqual({ cwd: '/tmp/dsh-test', mcpServers: [] })
        // The post-abort message must run on the respawned session id.
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-2'])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
    })

    it('does not respawn the session after a cancel-notification abort', async () => {
        harness.supportsCancel = true
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSessionWithQueue(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        const killPromise = launcher.kill()
        releaseFirstPrompt()
        await killPromise

        queue.push('second', {})
        queue.close()
        await done

        // session/cancel keeps the ACP session alive: same session for both turns.
        expect(harness.newSessionCalls).toHaveLength(1)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-1'])
    })

    it('respawns the session after a permission abort cancels through the backend directly', async () => {
        // A permission denied with decision 'abort' cancels through
        // AcpPermissionHandler → backend.cancelPrompt, bypassing handleAbort.
        // The backend's close-path event must still mark the session ended so
        // the next message respawns instead of targeting the closed session.
        harness.supportsCancel = false
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSessionWithQueue(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // The permission handler's abort path: direct backend cancellation.
        await (harness.backend?.cancelPrompt as unknown as (sessionId: string) => Promise<void>)('dsh-session-1')

        releaseFirstPrompt()
        queue.push('second', {})
        queue.close()
        await done

        expect(harness.newSessionCalls).toHaveLength(2)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-2'])
    })

    it('discards a follow-up queued before the stop when the prompt finishes before the close', async () => {
        // The in-flight prompt can complete while the session/close response
        // is still on the wire; handleAbort clears the queue synchronously at
        // the top, so a message queued before the stop is dropped before the
        // loop can dequeue it — it must never run on the respawned session.
        harness.supportsCancel = false
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        let releaseClose!: () => void
        harness.cancelBlocker = new Promise((resolve) => { releaseClose = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSessionWithQueue(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // A second message is queued before the abort starts.
        queue.push('second', {})

        // Abort: the close request parks on cancelBlocker.
        const killPromise = launcher.kill()
        await vi.waitFor(() => expect(harness.backend?.cancelPrompt).toHaveBeenCalled())

        // The first turn completes while the close response is still pending.
        releaseFirstPrompt()
        await vi.waitFor(() => expect(harness.promptSessionIds).toHaveLength(1))
        releaseClose()
        await killPromise

        queue.close()
        await done

        // 'second' was queued before the stop, so the synchronous queue.reset()
        // in handleAbort discarded it: no respawn (it is lazy, on next message)
        // and no second prompt.
        expect(harness.newSessionCalls).toHaveLength(1)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1'])
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
    })

    it('defers a queued message when a permission-abort close is still pending', async () => {
        // A permission denied with decision 'abort' cancels through
        // AcpPermissionHandler → backend.cancelPrompt and hands the pending
        // close to the launcher synchronously. The loop must park on it even
        // though handleAbort never ran, so the follow-up never targets the
        // closing session.
        harness.supportsCancel = false
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        let releaseClose!: () => void
        harness.cancelBlocker = new Promise((resolve) => { releaseClose = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSessionWithQueue(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        queue.push('second', {})

        // The permission handler's abort path: start the close (parks on
        // cancelBlocker) and hand the pending promise to the launcher before
        // awaiting it — exactly what the real handler does.
        const cancellation = (harness.backend?.cancelPrompt as unknown as (sessionId: string) => Promise<void>)('dsh-session-1')
        harness.permissionAbortClose?.(cancellation)

        // The prompt completes while the close response is still on the wire.
        releaseFirstPrompt()
        await new Promise((resolve) => setTimeout(resolve, 20))
        // The queued follow-up must NOT have been sent to the closing session.
        expect(harness.promptSessionIds).toEqual(['dsh-session-1'])

        releaseClose()
        await cancellation
        queue.close()
        await done

        expect(harness.newSessionCalls).toHaveLength(2)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-2'])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'second' }]
        ])
    })

    it('drops the dequeued message when an abort lands while the session is being recreated', async () => {
        // During the respawn's session/new request, session.sessionId still
        // names the closed session; an abort in that window must discard the
        // already-dequeued batch instead of running it on the fresh session.
        harness.supportsCancel = false
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSessionWithQueue(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // Abort while the first turn is still in flight (the real-world path).
        const killPromise = launcher.kill()
        releaseFirstPrompt()
        await killPromise

        // The next message enters the respawn branch; park session/new.
        let releaseNewSession!: () => void
        harness.newSessionBlocker = new Promise((resolve) => { releaseNewSession = resolve })
        queue.push('second', {})
        await vi.waitFor(() => expect(harness.newSessionCalls).toHaveLength(2))

        // Abort inside the recreation window, then let session/new resolve.
        const secondKill = launcher.kill()
        await secondKill
        releaseNewSession()

        // The aborted 'second' must be dropped, not executed.
        queue.push('third', {})
        queue.close()
        await done

        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-3'])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'third' }]
        ])
    })

    it('drops the dequeued message when a user stop lands while it waits for a pending close', async () => {
        // A permission-abort close can still be on the wire when the loop
        // dequeues the next message; a user stop during that wait resets the
        // queue but cannot discard the already-dequeued batch. The generation
        // snapshot taken before the wait must drop it.
        harness.supportsCancel = false
        let releaseFirstPrompt!: () => void
        harness.promptBlocker = new Promise((resolve) => { releaseFirstPrompt = resolve })
        let releaseClose!: () => void
        harness.cancelBlocker = new Promise((resolve) => { releaseClose = resolve })
        const queue = createQueue()
        queue.push('first', {})
        const session = createSessionWithQueue(queue)
        const launcher = new DshRemoteLauncher(session as never)

        const done = launcher.launch()
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))

        // A follow-up is queued, then a permission abort starts a close that
        // parks on cancelBlocker and hands the pending close to the launcher.
        queue.push('second', {})
        const cancellation = (harness.backend?.cancelPrompt as unknown as (sessionId: string) => Promise<void>)('dsh-session-1')
        harness.permissionAbortClose?.(cancellation)

        // The first turn completes; the loop dequeues 'second' and parks on
        // the pending close.
        releaseFirstPrompt()
        await vi.waitFor(() => expect(harness.promptSessionIds).toHaveLength(1))
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(harness.newSessionCalls).toHaveLength(1)

        // The user stops while 'second' waits for the close response.
        const killPromise = launcher.kill()
        releaseClose()
        await killPromise

        // The aborted 'second' must be dropped; 'third' runs on the
        // respawned session.
        queue.push('third', {})
        queue.close()
        await done

        expect(harness.newSessionCalls).toHaveLength(2)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1', 'dsh-session-2'])
        expect(harness.prompts).toEqual([
            [{ type: 'text', text: 'first' }],
            [{ type: 'text', text: 'third' }]
        ])
    })

    it('resumes the stored ACP session instead of creating a fresh one', async () => {
        harness.supportsResume = true
        const queue = createQueue()
        queue.push('hello again', {})
        queue.close()
        const session = createSessionWithQueue(queue, 'dsh-stored-1')
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
        const session = createSessionWithQueue(queue, 'dsh-explicit-1')
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
        const session = createSessionWithQueue(queue, 'dsh-stale-1')
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

    it('pins dshSessionId metadata for a fresh session before the main loop', async () => {
        const queue = createQueue()
        queue.push('first', {})
        queue.close()
        const session = createSessionWithQueue(queue)
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-session-1')
        expect(session.client.updateMetadata).toHaveBeenCalledWith(expect.any(Function))
        expect(session.client.flushMetadata).toHaveBeenCalled()
        expect(session.sessionId).toBe('dsh-session-1')
    })
})
