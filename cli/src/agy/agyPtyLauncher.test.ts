/**
 * Tests for the brain-UUID discovery wiring in AgyPtyLauncher.
 *
 * Bug context (2026-07-03 diagnosis): the PreToolUse hook discovers the agy
 * brain UUID and calls `session.onSessionFound(uuid)` to persist it to
 * session metadata, but nothing ever told the scanner about it — the scanner
 * only started tailing once its OWN content-match found the brain. For a
 * first message with attachments, content-match fails (see
 * agySessionScanner.test.ts), so the chat stayed empty even though the hook
 * had already discovered the UUID. Root-cause fix: register a
 * sessionFoundCallback on the shared AgentSessionBase registry so any
 * discovery path (hook OR scanner content-match) notifies the scanner.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgyPermissionHandler } from './utils/agyPermissionHandler'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { userRequestMatches } from './agyPtyLauncher'

const harness = vi.hoisted(() => ({
    scannerOnNewSession: vi.fn(),
    scannerSetSessionMessageText: vi.fn(),
    scannerCleanupCalls: 0,
    scannerOpts: null as Record<string, unknown> | null,
    scannerBrainUuid: null as string | null,
    foundCallbacks: [] as Array<(sessionId: string) => void>,
    removedCallbacks: [] as Array<(sessionId: string) => void>,
    exitReason: null as string | null,
    sendKeys: vi.fn(),
    invalidateInputReady: vi.fn(),
    abortHandler: null as (() => void | Promise<void>) | null,
    switchHandler: null as (() => void | Promise<void>) | null,
    liveModelHandler: null as ((model: string | null) => Promise<void>) | null,
    afterNextMessage: null as null | ((opts: any, next: unknown) => void | Promise<void>),
}))

let ptyOptsCaptured: any = null
vi.mock('./agyPty', () => ({
    agyPty: vi.fn(async (opts: any) => {
        ptyOptsCaptured = opts
        opts.registerControls?.({ sendKeys: harness.sendKeys, invalidateInputReady: harness.invalidateInputReady })
        opts.onReady?.()
        const next = await opts.nextMessage()
        await harness.afterNextMessage?.(opts, next)
    }),
}))

vi.mock('./utils/agySessionScanner', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils/agySessionScanner')>()
    return {
        extractBodyText: actual.extractBodyText,
        extractUserRequest: actual.extractUserRequest,
        normalizeUserInput: actual.normalizeUserInput,
        createAgySessionScanner: vi.fn(async (opts: Record<string, unknown>) => {
            harness.scannerOpts = opts
            return {
                cleanup: async () => { harness.scannerCleanupCalls += 1 },
                setSessionMessageText: harness.scannerSetSessionMessageText,
                getBrainUuid: () => harness.scannerBrainUuid,
                onNewSession: harness.scannerOnNewSession,
            }
        }),
    }
})

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({
    RemoteModeDisplay: () => null,
}))

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn() },
}))

describe('userRequestMatches', () => {
    it('requires an exact text-only request', () => {
        expect(userRequestMatches('hello', '<USER_REQUEST>\nhello\n</USER_REQUEST>')).toBe(true)
        expect(userRequestMatches('hello', '<USER_REQUEST>\nhello extra\n</USER_REQUEST>')).toBe(false)
        // Same normalization the scanner applies, so the two matchers cannot
        // disagree on a CRLF or a trailing space.
        expect(userRequestMatches('hello', '<USER_REQUEST>\r\nhello \r\n</USER_REQUEST>')).toBe(true)
    })

    it('uses an exact body fallback for attachments and fails closed for attachment-only input', () => {
        expect(userRequestMatches(
            '@/tmp/image.png\n\ninspect this',
            '<USER_REQUEST>\n@/tmp/image.png\ninspect this\n</USER_REQUEST>',
        )).toBe(true)
        expect(userRequestMatches(
            '@/tmp/a.png @/tmp/b.png\n\ninspect this',
            '<USER_REQUEST>\n@/tmp/b.png @/tmp/a.png\ninspect this\n</USER_REQUEST>',
        )).toBe(true)
        expect(userRequestMatches(
            '@/tmp/image.png\n\ninspect this',
            '<USER_REQUEST>\n@/tmp/other.png\ninspect this\n</USER_REQUEST>',
        )).toBe(false)
        expect(userRequestMatches(
            '@/tmp/image.png\n\ninspect this',
            '<USER_REQUEST>\nunrelated instructions\ninspect this\n</USER_REQUEST>',
        )).toBe(false)
        expect(userRequestMatches(
            '@/tmp/image.png\n\n',
            '<USER_REQUEST>\n@/tmp/image.png\n</USER_REQUEST>',
        )).toBe(false)
    })
})

vi.mock('@/modules/common/remote/RemoteLauncherBase', () => ({
    RemoteLauncherBase: class {
        get exitReason() { return harness.exitReason }
        set exitReason(v) { harness.exitReason = v }
        protected hasTTY = false
        protected messageBuffer = { addMessage: () => {} }
        protected ptyAbortController: AbortController | null = null
        constructor(_logPath?: string) {}
        // Real setupAbortHandlers registers onAbort/onSwitch on the RPC handler
        // manager; here we just capture the handlers directly so tests can
        // invoke handleAbortRequest()/handleSwitchRequest() without needing a
        // real RPC dispatch.
        protected setupAbortHandlers(_rpcHandlerManager: unknown, handlers: { onAbort: () => void | Promise<void>; onSwitch: () => void | Promise<void> }) {
            harness.abortHandler = handlers.onAbort
            harness.switchHandler = handlers.onSwitch
        }
        protected clearAbortHandlers() {}
        protected async requestExit(reason: string, handler: () => void | Promise<void>) {
            harness.exitReason = reason
            await handler()
        }
        // Simplified respawn loop: runs launchOnce exactly once (no retry/backoff)
        // so the wiring test resolves deterministically.
        protected async runRespawnLoop(opts: { launchOnce: (signal: AbortSignal) => Promise<unknown> }): Promise<void> {
            const controller = new AbortController()
            this.ptyAbortController = controller
            await opts.launchOnce(controller.signal)
            this.ptyAbortController = null
        }
        async start(): Promise<string> {
            await (this as unknown as { runMainLoop: () => Promise<void> }).runMainLoop()
            return harness.exitReason || 'exit'
        }
    },
}))

import { agyPtyLauncher } from './agyPtyLauncher'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void
    return { promise: new Promise<T>((r) => { resolve = r }), resolve }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

function createSessionStub(opts?: { agyPermissionHandler?: Record<string, unknown> | null }) {
    const passedHandler = opts?.agyPermissionHandler
    // Merge a default registerQuestionRequest/cancelPendingQuestions into
    // whatever the test passes, so tests that only care about one method
    // don't have to restate the other (real AgyPermissionHandler always has
    // both). `agyPermissionHandler: null` (explicit) stays null for the
    // "no handler wired" defensive-no-op tests.
    const agyPermissionHandler = passedHandler === null
        ? null
        : {
            registerQuestionRequest: vi.fn().mockResolvedValue(null),
            cancelPendingQuestions: vi.fn(),
            cancelAll: vi.fn(),
            ...(passedHandler ?? {}),
        }
    return {
        session: {
            sessionId: null,
            path: '/tmp/agy-pty-test',
            hookCarrierDir: undefined,
            hookPort: undefined,
            hookToken: undefined,
            agyPermissionHandler,
            getModel: () => null,
            setLiveModelHandler: (handler: ((model: string | null) => Promise<void>) | null) => { harness.liveModelHandler = handler },
            onThinkingChange: vi.fn(),
            setKillHandler: (_h: () => void) => {},
            onSessionFound: vi.fn(),
            addSessionFoundCallback: (cb: (sessionId: string) => void) => { harness.foundCallbacks.push(cb) },
            removeSessionFoundCallback: (cb: (sessionId: string) => void) => { harness.removedCallbacks.push(cb) },
            queue: {
                waitForMessagesAndGetAsString: vi.fn().mockResolvedValue(null),
            },
            client: {
                sendAgySessionMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
                emitSessionReady: vi.fn(),
                emitMessagesConsumed: vi.fn(),
                resetAgentTerminal: vi.fn(),
                setAgentTerminalControls: vi.fn(),
                emitAgentTerminalOutput: vi.fn(),
                rpcHandlerManager: { registerHandler: () => {} },
            },
        },
    }
}

describe('agyPtyLauncher session-found wiring (brain UUID -> scanner)', () => {
    afterEach(() => {
        harness.scannerOnNewSession.mockClear()
        harness.scannerSetSessionMessageText.mockClear()
        harness.scannerCleanupCalls = 0
        harness.scannerOpts = null
        harness.scannerBrainUuid = null
        harness.foundCallbacks = []
        harness.removedCallbacks = []
        harness.exitReason = null
        harness.sendKeys.mockClear()
        harness.abortHandler = null
        harness.switchHandler = null
        harness.liveModelHandler = null
        harness.afterNextMessage = null
        ptyOptsCaptured = null
    })

    it('emits the hub session-ready signal when the AGY PTY becomes usable', async () => {
        const { session } = createSessionStub()

        await agyPtyLauncher(session as never)

        expect(session.client.emitSessionReady).toHaveBeenCalledTimes(1)
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
    })

    it('surfaces ambiguous brain discovery without exposing conversation identities', async () => {
        const { session } = createSessionStub()

        await agyPtyLauncher(session as never)
        const onDiscoveryAmbiguous = harness.scannerOpts!.onDiscoveryAmbiguous as (count: number) => void
        onDiscoveryAmbiguous(2)

        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'error',
            message: 'Antigravity session could not be identified because 2 conversations matched the first message. Continue in the terminal or start a new session with a more specific prompt.',
        })
    })

    it('changes the live AGY model only after the picker and completion markers are observed', async () => {
        const { session } = createSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)
        expect(harness.liveModelHandler).not.toBeNull()

        const applied = harness.liveModelHandler!('gemini-3.6-flash-low')
        await tick(10)
        expect(harness.sendKeys).toHaveBeenCalledWith('/model\r')

        ptyOptsCaptured.onMessage('\u001b[2JSwitch Model\n  Gemini 3.6 Flash\n> Gemini 3.5 Flash             (current)')
        await tick(10)
        expect(harness.sendKeys).toHaveBeenCalledWith(`\u001b[A${'\u001b[D'.repeat(3)}`)

        ptyOptsCaptured.onMessage('Model set to Gemini 3.6 Flash (Low)')
        await expect(applied).resolves.toBeUndefined()

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
        expect(harness.liveModelHandler).toBeNull()
    })

    it('rejects an active model waiter on exit and does not invalidate the respawned prompt for a stale queued change', async () => {
        const { session } = createSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)
        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        const first = harness.liveModelHandler!('gemini-3.5-flash-low')
        await tick(10)
        const second = harness.liveModelHandler!('gemini-3.6-flash-low')
        await tick(5)

        ptyOptsCaptured.onExit(1)
        const respawnedInvalidateInputReady = vi.fn()
        ptyOptsCaptured.registerControls?.({ sendKeys: vi.fn(), invalidateInputReady: respawnedInvalidateInputReady })

        await expect(first).rejects.toThrow('AGY PTY ended')
        await expect(second).rejects.toThrow('AGY PTY restarted')
        expect(respawnedInvalidateInputReady).not.toHaveBeenCalled()

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('rejects model changes during an active agent run instead of outliving the RPC', async () => {
        const { session } = createSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)
        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)
        ptyOptsCaptured.onMessageSubmitted?.('current turn')

        await expect(harness.liveModelHandler!('gemini-3.5-flash-low'))
            .rejects.toThrow('Wait for the current AGY turn to finish')
        expect(harness.sendKeys).not.toHaveBeenCalledWith('/model\r')

        await ptyOptsCaptured.onAgentRunCompleted?.()
        expect(harness.sendKeys).not.toHaveBeenCalledWith('/model\r')

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('rejects model changes while an agent run is reserved for submission', async () => {
        const { session } = createSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)
        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        await ptyOptsCaptured.onBeforeAgentRunStart?.()
        await expect(harness.liveModelHandler!('gemini-3.5-flash-low'))
            .rejects.toThrow('Wait for the current AGY turn to finish')
        expect(harness.sendKeys).not.toHaveBeenCalledWith('/model\r')

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('waits for a model picker that started while the message queue was idle', async () => {
        const { session } = createSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)
        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        const applied = harness.liveModelHandler!('gemini-3.5-flash-low')
        await tick(10)
        expect(harness.sendKeys).toHaveBeenCalledWith('/model\r')

        let boundaryReached = false
        const boundary = ptyOptsCaptured.onBeforeAgentRunStart?.().then(() => {
            boundaryReached = true
        })
        await tick(10)
        expect(boundaryReached).toBe(false)

        ptyOptsCaptured.onMessage('Switch Model\n> Gemini 3.5 Flash             (current)')
        await tick(10)
        ptyOptsCaptured.onMessage('Model set to Gemini 3.5 Flash (Low)')
        await boundary
        await applied
        expect(boundaryReached).toBe(true)

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('registers a session-found callback that notifies the scanner when the hook discovers the brain UUID', async () => {
        const { session } = createSessionStub()
        // Keep the PTY "session" alive (nextMessage hangs) so the assertion runs
        // while this.scanner is still assigned — a real hook firing happens
        // mid-session, not after the launcher has already torn down.
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        expect(harness.foundCallbacks).toHaveLength(1)

        // Simulate the PreToolUse hook firing session.onSessionFound(uuid) — this
        // is the discovery path the scanner previously never heard about.
        harness.foundCallbacks[0]('hook-discovered-uuid')

        expect(harness.scannerOnNewSession).toHaveBeenCalledWith('hook-discovered-uuid')

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('persists the discovered UUID so a later PTY onMessage does not re-fire session.onSessionFound (hostile-review finding: crash-recovery resume gap)', async () => {
        // Root-cause regression guard for a gap the initial fix missed: the hook
        // callback must persist the uuid through the shared launcher contract
        // handleSessionFound does (this.claudeSessionId = sessionId), otherwise a
        // respawn between hook discovery and the next PTY output chunk would read
        // a stale null resumeSessionId and silently start a fresh brain instead of
        // resuming. onMessage's `if (!this.agySessionId)` fallback guard doubles as
        // an oracle here: if the hook path failed to persist agySessionId, this
        // guard would incorrectly re-fire session.onSessionFound on the next chunk.
        const { session } = createSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        harness.foundCallbacks[0]('hook-discovered-uuid')
        // The real scanner's onNewSession() synchronously updates foundBrainUuid,
        // so getBrainUuid() reflects it immediately — mirror that here.
        harness.scannerBrainUuid = 'hook-discovered-uuid'

        expect(ptyOptsCaptured).toBeTruthy()
        ptyOptsCaptured.onMessage('some pty output chunk')

        expect(session.onSessionFound).not.toHaveBeenCalled()

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('removes the session-found callback on teardown (no listener leak across re-spawns)', async () => {
        const { session } = createSessionStub()
        await agyPtyLauncher(session as never)

        expect(harness.removedCallbacks).toHaveLength(1)
        expect(harness.removedCallbacks[0]).toBe(harness.foundCallbacks[0])
    })

    it('cleans up the scanner after the main loop ends', async () => {
        const { session } = createSessionStub()
        await agyPtyLauncher(session as never)

        expect(harness.scannerCleanupCalls).toBe(1)
    })

    it('forwards a queued user message with the current scanner interface', async () => {
        const { session } = createSessionStub()
        vi.mocked(session.queue.waitForMessagesAndGetAsString)
            .mockResolvedValueOnce({ message: 'hello agy', mode: 'default' } as never)
        harness.afterNextMessage = async (opts) => {
            await opts.onBeforeMessageSubmit?.('hello agy')
        }

        await expect(agyPtyLauncher(session as never)).resolves.toBe('exit')
        expect(harness.scannerSetSessionMessageText).toHaveBeenCalledWith('hello agy')
    })

    it('acknowledges a dequeued web message only after a matching USER_INPUT is observed', async () => {
        const { session } = createSessionStub()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockResolvedValueOnce({
            message: 'hello agy',
            mode: 'default',
            isolate: false,
            hash: 'default',
            items: [{ message: 'hello agy', localId: 'local-1' }],
        } as never)
        harness.afterNextMessage = async (opts) => {
            await opts.onMessageSubmitted?.('hello agy')
            expect(session.client.emitMessagesConsumed).not.toHaveBeenCalled()

            const onEntry = harness.scannerOpts!.onEntry as (entry: unknown) => void
            onEntry({
                type: 'USER_INPUT',
                step_index: 10,
                content: '<USER_REQUEST>\nhello agy\n</USER_REQUEST>',
            })
        }

        await agyPtyLauncher(session as never)

        expect(session.client.emitMessagesConsumed).toHaveBeenCalledTimes(1)
        expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1'])
    })

    it('forwards a direct terminal USER_INPUT without duplicating a matching web prompt', async () => {
        const { session } = createSessionStub()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockResolvedValueOnce({
            message: 'web message',
            items: [{ message: 'web message', localId: 'local-direct' }],
        } as never)
        harness.afterNextMessage = async (opts) => {
            await opts.onMessageSubmitted?.('web message')
            const onEntry = harness.scannerOpts!.onEntry as (entry: unknown) => void
            onEntry({ type: 'USER_INPUT', step_index: 20, content: '<USER_REQUEST>\nterminal message\n</USER_REQUEST>' })
            onEntry({ type: 'USER_INPUT', step_index: 21, content: '<USER_REQUEST>\nweb message\n</USER_REQUEST>' })
        }

        await agyPtyLauncher(session as never)

        const forwardedUserInputs = vi.mocked(session.client.sendAgySessionMessage).mock.calls
            .map(([entry]) => entry)
            .filter((entry) => entry.type === 'USER_INPUT')
        expect(forwardedUserInputs).toEqual([
            expect.objectContaining({ content: '<USER_REQUEST>\nterminal message\n</USER_REQUEST>' }),
        ])
        expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['local-direct'])
    })

    it('keeps a mismatched web message pending until the matching USER_INPUT arrives', async () => {
        const { session } = createSessionStub()
        vi.mocked(session.queue.waitForMessagesAndGetAsString)
            .mockResolvedValueOnce({
                message: 'web message',
                mode: 'default',
                isolate: false,
                hash: 'default',
                items: [{ message: 'web message', localId: 'local-2' }],
            } as never)
            .mockResolvedValueOnce({ message: 'following message', items: [] } as never)
        harness.afterNextMessage = async (opts) => {
            await opts.onMessageSubmitted?.('web message')
            const onEntry = harness.scannerOpts!.onEntry as (entry: unknown) => void
            onEntry({
                type: 'USER_INPUT',
                step_index: 11,
                content: '<USER_REQUEST>\ndirect terminal message\n</USER_REQUEST>',
            })
            const nextMessage = opts.nextMessage()
            let nextMessageResolved = false
            void nextMessage.then(() => { nextMessageResolved = true })
            await Promise.resolve()

            expect(nextMessageResolved).toBe(false)
            expect(session.client.emitMessagesConsumed).not.toHaveBeenCalled()

            onEntry({
                type: 'USER_INPUT',
                step_index: 12,
                content: '<USER_REQUEST>\nweb message\n</USER_REQUEST>',
            })
            await expect(nextMessage).resolves.toMatchObject({ message: 'following message' })
        }

        await agyPtyLauncher(session as never)

        expect(session.client.emitMessagesConsumed).toHaveBeenCalledTimes(1)
        expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['local-2'])
    })

    it('releases a submitted delivery at the agent-run boundary when the transcript never echoes it', async () => {
        // A transcript echo that differs from the submitted text (agy re-wrapping,
        // a duplicated write from submitMessage's retry, ...) must not wedge the
        // queue forever: the run boundary is proof the prompt did reach agy.
        const { session } = createSessionStub()
        vi.mocked(session.queue.waitForMessagesAndGetAsString)
            .mockResolvedValueOnce({
                message: 'web message',
                items: [{ message: 'web message', localId: 'local-stuck' }],
            } as never)
            .mockResolvedValueOnce({ message: 'following message', items: [] } as never)
        harness.afterNextMessage = async (opts) => {
            await opts.onBeforeMessageSubmit?.('web message')
            await opts.onMessageSubmitted?.('web message')
            const onEntry = harness.scannerOpts!.onEntry as (entry: unknown) => void
            onEntry({
                type: 'USER_INPUT',
                step_index: 3,
                content: '<USER_REQUEST>\nweb messageweb message\n</USER_REQUEST>',
            })
            const blocked = opts.nextMessage()
            let settled = false
            void blocked.then(() => { settled = true })
            await tick()
            expect(settled).toBe(false)

            await opts.onAgentRunCompleted?.()
            await expect(blocked).resolves.toMatchObject({ message: 'following message' })
        }

        await agyPtyLauncher(session as never)

        expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['local-stuck'])
    })

    it('restores a submitted web prompt exactly once on abort and never after completion', async () => {
        const { session } = createSessionStub()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockResolvedValueOnce({
            message: 'restore me',
            items: [{ message: 'restore me', localId: 'local-restore' }],
        } as never)
        harness.afterNextMessage = async (opts) => {
            await opts.onBeforeMessageSubmit?.('restore me')
            await opts.onMessageSubmitted?.('restore me')
            await harness.abortHandler?.()
            await harness.abortHandler?.()
            await opts.onAgentRunCompleted?.()
            await harness.abortHandler?.()
        }

        await agyPtyLauncher(session as never)

        expect(vi.mocked(session.client.sendSessionEvent).mock.calls
            .map(([event]) => event)
            .filter((event) => event.type === 'abort-restore'))
            .toEqual([{ type: 'abort-restore', text: 'restore me' }])
    })

    it('consumes a skipped slash command and releases the next delivery boundary', async () => {
        const { session } = createSessionStub()
        vi.mocked(session.queue.waitForMessagesAndGetAsString)
            .mockResolvedValueOnce({
                message: '/clear',
                items: [{ message: '/clear', localId: 'local-clear' }],
            } as never)
            .mockResolvedValueOnce({ message: 'following prompt', items: [] } as never)
        harness.afterNextMessage = async (opts) => {
            await opts.onMessageSkipped?.('/clear')
            await expect(opts.nextMessage()).resolves.toMatchObject({ message: 'following prompt' })
            await opts.onBeforeMessageSubmit?.('following prompt')
        }

        await agyPtyLauncher(session as never)

        expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['local-clear'])
        expect(harness.scannerSetSessionMessageText).toHaveBeenCalledOnce()
        expect(harness.scannerSetSessionMessageText).toHaveBeenCalledWith('following prompt')
    })

    it('ends the launcher instead of respawning when PTY exits with an unconfirmed web delivery', async () => {
        harness.exitReason = null
        const { session } = createSessionStub()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockResolvedValueOnce({
            message: 'unconfirmed',
            mode: 'default',
            isolate: false,
            hash: 'default',
            items: [{ message: 'unconfirmed', localId: 'local-exit' }],
        } as never)
        harness.afterNextMessage = async (opts) => {
            await opts.onMessageSubmitted?.('unconfirmed')
            const blockedNext = opts.nextMessage()
            let settled = false
            void blockedNext.then(() => { settled = true })
            await tick()
            expect(settled).toBe(false)
            opts.onExit?.(1)
            await expect(blockedNext).resolves.toBeNull()
        }

        await agyPtyLauncher(session as never)

        expect(session.client.emitMessagesConsumed).not.toHaveBeenCalled()
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'agy PTY exited before delivery could be confirmed',
        })
    })

    it('pairs a planner tool_call with the following action entry so the tool card has input', async () => {
        // agy splits the invocation (PLANNER_RESPONSE.tool_calls) from its result
        // (the following action entry). The launcher must buffer the planner's
        // calls and hand the matching one to sendAgySessionMessage so the web tool
        // card can render the command/args, not just the raw result.
        const { session } = createSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        const onEntry = harness.scannerOpts!.onEntry as (e: unknown) => void
        // Planner declares the invocation…
        onEntry({ type: 'PLANNER_RESPONSE', step_index: 3, content: '', tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls -la' } }] })
        // …the next action entry carries the result and gets paired with it.
        onEntry({ type: 'RUN_COMMAND', step_index: 4, content: 'Output: files' })
        // A second action with no fresh planner has no pending call left (FIFO drained).
        onEntry({ type: 'RUN_COMMAND', step_index: 5, content: 'Output: more' })

        const calls = vi.mocked(session.client.sendAgySessionMessage).mock.calls
        const actionCalls = calls.filter((c) => (c[0] as { type: string }).type === 'RUN_COMMAND')
        expect(actionCalls).toHaveLength(2)
        // First action paired with the planner's tool_call as the 3rd arg…
        expect(actionCalls[0][2]).toEqual({ name: 'run_command', args: { CommandLine: 'ls -la' } })
        // …second action has no invocation to pair (undefined), not a stale reuse.
        expect(actionCalls[1][2]).toBeUndefined()

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('does not let ERROR_MESSAGE / SYSTEM_MESSAGE consume a pending tool_call (no FIFO drift)', async () => {
        // agy interleaves meta entries (a model parse error, a system notice) into
        // a planner batch without a corresponding tool_call. If they consumed a
        // pending invocation, the real action after them would be mis-paired.
        const { session } = createSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        const onEntry = harness.scannerOpts!.onEntry as (e: unknown) => void
        onEntry({ type: 'PLANNER_RESPONSE', step_index: 3, content: '', tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/a.ts' } }] })
        // Meta entries in the same batch must NOT consume the pending view_file call.
        onEntry({ type: 'ERROR_MESSAGE', step_index: 4, content: 'Error invalid tool call' })
        onEntry({ type: 'SYSTEM_MESSAGE', step_index: 5, content: 'A system notice' })
        // The real action still pairs with the (un-consumed) view_file invocation.
        onEntry({ type: 'VIEW_FILE', step_index: 6, content: 'file body' })

        const calls = vi.mocked(session.client.sendAgySessionMessage).mock.calls
        const byType = (t: string) => calls.filter((c) => (c[0] as { type: string }).type === t)
        expect(byType('ERROR_MESSAGE')[0][2]).toBeUndefined()
        expect(byType('SYSTEM_MESSAGE')[0][2]).toBeUndefined()
        expect(byType('VIEW_FILE')[0][2]).toEqual({ name: 'view_file', args: { AbsolutePath: '/a.ts' } })

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    // --- ask_question: Phase 1 (surface) + Phase 2 (answer -> PTY keys) ---
    // agy never routes ask_question through the PreToolUse hook (it's a pure
    // TUI interaction with no side effect to gate — see agyPermissionHandler
    // docstring), so the launcher must detect it directly from the transcript
    // and register/answer it itself, NOT via the generic requestDecision path.

    it('excludes ask_question from pendingAgyToolCalls so a later real action is never mis-paired (FIFO drift guard)', async () => {
        const { session } = createSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        const onEntry = harness.scannerOpts!.onEntry as (e: unknown) => void
        onEntry({
            type: 'PLANNER_RESPONSE',
            step_index: 10,
            content: '',
            tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Pick', options: ['A', 'B'], is_multi_select: false }] } }]
        })
        // A real action arriving afterward must NOT be paired with the
        // ask_question call — nothing should ever consume it via shift().
        onEntry({ type: 'RUN_COMMAND', step_index: 11, content: 'Output: x' })

        const calls = vi.mocked(session.client.sendAgySessionMessage).mock.calls
        const runCommandCall = calls.find((c) => (c[0] as { type: string }).type === 'RUN_COMMAND')
        expect(runCommandCall?.[2]).toBeUndefined()

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('registers ask_question as a pending request via agyPermissionHandler (surfaced in chat, Phase 1)', async () => {
        const registerQuestionRequest = vi.fn().mockReturnValue(new Promise(() => {}))
        const { session } = createSessionStub({ agyPermissionHandler: { registerQuestionRequest } })
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        const onEntry = harness.scannerOpts!.onEntry as (e: unknown) => void
        onEntry({
            type: 'PLANNER_RESPONSE',
            step_index: 7,
            content: '',
            tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Which fruit?', options: ['Apple', 'Banana'], is_multi_select: false }] } }]
        })

        expect(registerQuestionRequest).toHaveBeenCalledTimes(1)
        const [, canonicalInput] = registerQuestionRequest.mock.calls[0]
        expect(canonicalInput).toEqual({
            questions: [{ question: 'Which fruit?', options: [{ label: 'Apple' }, { label: 'Banana' }], multiSelect: false }]
        })

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('injects the built PTY key sequence into ptyControls.sendKeys once the question is answered (Phase 2)', async () => {
        const { promise: answerPromise, resolve: resolveAnswer } = deferred<Record<string, string[]> | null>()
        const registerQuestionRequest = vi.fn().mockReturnValue(answerPromise)
        const { session } = createSessionStub({ agyPermissionHandler: { registerQuestionRequest } })
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        const onEntry = harness.scannerOpts!.onEntry as (e: unknown) => void
        onEntry({
            type: 'PLANNER_RESPONSE',
            step_index: 8,
            content: '',
            tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Which fruit?', options: ['Apple', 'Banana', 'Cherry'], is_multi_select: false }] } }]
        })

        expect(harness.sendKeys).not.toHaveBeenCalled()

        resolveAnswer({ '0': ['Cherry'] })
        await tick(10)

        // Cherry is the 3rd listed option -> bare digit '3' (Phase 0 ground truth).
        expect(harness.sendKeys).toHaveBeenCalledWith('3')

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('does not throw / send keys when the question is answered with no answers (denied/canceled)', async () => {
        const { session } = createSessionStub({ agyPermissionHandler: { registerQuestionRequest: vi.fn().mockResolvedValue(null) } })
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        const onEntry = harness.scannerOpts!.onEntry as (e: unknown) => void
        onEntry({
            type: 'PLANNER_RESPONSE',
            step_index: 9,
            content: '',
            tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Pick', options: ['A', 'B'], is_multi_select: false }] } }]
        })
        await tick(10)

        // null answers -> Escape (Skip) for the one pending question.
        expect(harness.sendKeys).toHaveBeenCalledWith('\x1b')

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('does not crash when no agyPermissionHandler is present (defensive no-op)', async () => {
        const { session } = createSessionStub({ agyPermissionHandler: null })
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        const onEntry = harness.scannerOpts!.onEntry as (e: unknown) => void
        expect(() => onEntry({
            type: 'PLANNER_RESPONSE',
            step_index: 12,
            content: '',
            tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Pick', options: ['A'], is_multi_select: false }] } }]
        })).not.toThrow()

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    // --- Finding F6: toolUseId disambiguation for 2+ ask_question calls in one batch ---

    it('disambiguates two ask_question calls within the same planner batch via callIndex (Finding F6)', async () => {
        const registerQuestionRequest = vi.fn().mockReturnValue(new Promise(() => {}))
        const { session } = createSessionStub({ agyPermissionHandler: { registerQuestionRequest } })
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        const onEntry = harness.scannerOpts!.onEntry as (e: unknown) => void
        onEntry({
            type: 'PLANNER_RESPONSE',
            step_index: 30,
            content: '',
            tool_calls: [
                { name: 'ask_question', args: { questions: [{ question: 'Q1', options: ['A'], is_multi_select: false }] } },
                { name: 'ask_question', args: { questions: [{ question: 'Q2', options: ['B'], is_multi_select: false }] } },
            ]
        })

        expect(registerQuestionRequest).toHaveBeenCalledTimes(2)
        const [firstId] = registerQuestionRequest.mock.calls[0]
        const [secondId] = registerQuestionRequest.mock.calls[1]
        // Distinct IDs — without callIndex disambiguation both calls would
        // compute the identical composite key (same session/step) and
        // collide in agentState.requests (the second registration would
        // silently overwrite the first's pending entry).
        expect(firstId).not.toBe(secondId)
        expect(firstId).toContain('ask0')
        expect(secondId).toContain('ask1')

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })
})

describe('agyPtyLauncher quota visibility', () => {
    const quotaFrame = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 7h28m43s. Error ID: f5bb4da7-3689-4eca-b1ea-fd171bae4f71-215 How\'s the CLI experience so far? Help us improve: ? for shortcuts'

    async function launchForQuotaTest() {
        harness.exitReason = null
        const { session } = createSessionStub()
        const nextMessage = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => nextMessage.promise)
        const launcher = agyPtyLauncher(session as never)
        await tick(20)
        vi.mocked(session.client.sendSessionEvent).mockClear()
        return { session, nextMessage, launcher }
    }

    async function closeQuotaTest(nextMessage: ReturnType<typeof deferred<{ message: string } | null>>, launcher: Promise<unknown>) {
        harness.exitReason = 'exit'
        nextMessage.resolve(null)
        await launcher
    }

    it('reports one quota error for the screenshot-verified AGY frame while preserving raw terminal chunks', async () => {
        const { session, nextMessage, launcher } = await launchForQuotaTest()

        await ptyOptsCaptured.onBeforeMessageSubmit?.()
        ptyOptsCaptured.onMessage(quotaFrame)
        ptyOptsCaptured.onMessage(quotaFrame)

        expect(session.client.emitAgentTerminalOutput).toHaveBeenCalledWith(quotaFrame)
        expect(session.client.sendSessionEvent).toHaveBeenCalledTimes(1)
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'error',
            message: 'Antigravity quota reached · resets in 7h28m43s',
        })

        await closeQuotaTest(nextMessage, launcher)
    })

    it('invalidates PTY input readiness so the next prompt is not typed into the quota screen', async () => {
        // The only idle marker is '? for shortcuts', and the quota frame carries
        // that same footer — without invalidating readiness the driver would
        // treat the quota screen as an editor and the delivery would stall.
        const { session, nextMessage, launcher } = await launchForQuotaTest()
        harness.invalidateInputReady.mockClear()

        await ptyOptsCaptured.onBeforeMessageSubmit?.()
        ptyOptsCaptured.onMessage(quotaFrame)

        expect(harness.invalidateInputReady).toHaveBeenCalledTimes(1)

        await closeQuotaTest(nextMessage, launcher)
    })

    it('detects a raw frame split through ANSI escape fragments', async () => {
        const { session, nextMessage, launcher } = await launchForQuotaTest()
        const split = [
            'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 7h',
            '28m43s. Error ID: f5bb4da7-3689-4eca-b1ea-fd171bae4f71-215 How\'s the CLI experience so far? Help us ',
            '\x1b[',
            '31mimprove:\x1b[0m ? for shortcuts',
        ]

        await ptyOptsCaptured.onBeforeMessageSubmit?.()
        split.forEach((chunk) => ptyOptsCaptured.onMessage(chunk))

        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'error',
            message: 'Antigravity quota reached · resets in 7h28m43s',
        })
        await closeQuotaTest(nextMessage, launcher)
    })

    it('reports the quota failure without a reset countdown when that optional text is absent', async () => {
        const { session, nextMessage, launcher } = await launchForQuotaTest()
        const frameWithoutReset = quotaFrame.replace('Resets in 7h28m43s. ', '')

        await ptyOptsCaptured.onBeforeMessageSubmit?.()
        ptyOptsCaptured.onMessage(frameWithoutReset)

        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'error',
            message: 'Antigravity quota reached',
        })
        await closeQuotaTest(nextMessage, launcher)
    })

    it('fails closed for user echo before arming and agent prose without AGY-only frame context', async () => {
        const { session, nextMessage, launcher } = await launchForQuotaTest()
        const quotedQuota = 'Individual quota reached. Please upgrade your subscription to increase your limits.'

        ptyOptsCaptured.onMessage(`${quotedQuota} ${quotaFrame.slice(quotaFrame.indexOf('Resets in'))}`)
        await ptyOptsCaptured.onBeforeAgentRunStart?.()
        ptyOptsCaptured.onMessage(`The user quoted: ${quotedQuota}`)
        ptyOptsCaptured.onAgentRunCompleted?.()
        ptyOptsCaptured.onMessage(quotaFrame)

        expect(session.client.sendSessionEvent).not.toHaveBeenCalled()
        await closeQuotaTest(nextMessage, launcher)
    })

    it('does not arm at the run boundary until after the outgoing text echo', async () => {
        const { session, nextMessage, launcher } = await launchForQuotaTest()

        await ptyOptsCaptured.onBeforeAgentRunStart?.()
        ptyOptsCaptured.onMessage(quotaFrame)
        expect(session.client.sendSessionEvent).not.toHaveBeenCalled()

        await ptyOptsCaptured.onBeforeMessageSubmit?.()
        ptyOptsCaptured.onMessage(quotaFrame)
        ptyOptsCaptured.onMessageSubmitted?.('new turn')

        expect(session.client.sendSessionEvent).toHaveBeenCalledTimes(1)
        await closeQuotaTest(nextMessage, launcher)
    })

    it('clears the prior frame at each run boundary and re-emits only for a second actual quota frame', async () => {
        const { session, nextMessage, launcher } = await launchForQuotaTest()

        await ptyOptsCaptured.onBeforeMessageSubmit?.()
        ptyOptsCaptured.onMessage(quotaFrame)
        await ptyOptsCaptured.onAgentRunCompleted?.()
        await ptyOptsCaptured.onBeforeMessageSubmit?.()
        ptyOptsCaptured.onMessage('ordinary output after the new run started')
        expect(session.client.sendSessionEvent).toHaveBeenCalledTimes(1)

        ptyOptsCaptured.onMessage(quotaFrame)
        expect(session.client.sendSessionEvent).toHaveBeenCalledTimes(2)
        await closeQuotaTest(nextMessage, launcher)
    })
})

// --- Finding F1: a question must never outlive the TUI selector it answers ---
// The pending request registered via agyPermissionHandler.registerQuestionRequest
// is normally only settled by the web `permission` RPC. If the PTY crashes/
// respawns (runRespawnLoop) or the turn is aborted (Ctrl-C interrupt) while a
// question is still pending, Phase 0 measured that the native selector state is
// NOT recoverable — a resume lands on a plain idle prompt, and an abort kills
// the in-flight turn. A stale web answer arriving afterward must never be
// injected as keystrokes into whatever is now on screen. These tests use the
// REAL AgyPermissionHandler (not a stub double) so that a "stale answer
// arriving after invalidation" can be simulated end-to-end via the same
// `permission` RPC handler the hub uses in production, proving the pending
// request is actually rejected/removed — not just that a wiring call happened.
describe('agyPtyLauncher ask_question safety: invalidate stale pending questions on PTY exit / abort (Finding F1)', () => {
    afterEach(() => {
        harness.scannerOnNewSession.mockClear()
        harness.scannerCleanupCalls = 0
        harness.scannerOpts = null
        harness.scannerBrainUuid = null
        harness.foundCallbacks = []
        harness.removedCallbacks = []
        harness.exitReason = 'exit'
        harness.sendKeys.mockClear()
        harness.abortHandler = null
        harness.switchHandler = null
        ptyOptsCaptured = null
    })

    function createRealHandlerSessionStub() {
        let permissionRpcHandler: ((response: {
            id: string
            approved: boolean
            reason?: string
            answers?: Record<string, string[]>
        }) => Promise<void> | void) | null = null

        const handler = new AgyPermissionHandler(
            {
                rpcHandlerManager: {
                    registerHandler: (method: string, fn: unknown) => {
                        if (method === RPC_METHODS.Permission) {
                            permissionRpcHandler = fn as typeof permissionRpcHandler
                        }
                    },
                },
                updateAgentState: () => {},
            },
            { getPermissionMode: () => 'default' }
        )

        return {
            handler,
            respondAsWeb: (response: { id: string; approved: boolean; reason?: string; answers?: Record<string, string[]> }) => {
                if (!permissionRpcHandler) throw new Error('Permission RPC handler not registered')
                return permissionRpcHandler(response)
            },
            session: {
                sessionId: null,
                path: '/tmp/agy-pty-test',
                hookCarrierDir: undefined,
                hookPort: undefined,
                hookToken: undefined,
                agyPermissionHandler: handler,
                getModel: () => null,
                setLiveModelHandler: (liveHandler: ((model: string | null) => Promise<void>) | null) => { harness.liveModelHandler = liveHandler },
                onThinkingChange: vi.fn(),
                setKillHandler: (_h: () => void) => {},
                onSessionFound: vi.fn(),
                addSessionFoundCallback: (cb: (sessionId: string) => void) => { harness.foundCallbacks.push(cb) },
                removeSessionFoundCallback: (cb: (sessionId: string) => void) => { harness.removedCallbacks.push(cb) },
                queue: {
                    waitForMessagesAndGetAsString: vi.fn().mockResolvedValue(null),
                },
                client: {
                    sendAgySessionMessage: vi.fn(),
                    sendSessionEvent: vi.fn(),
                    emitSessionReady: vi.fn(),
                    emitMessagesConsumed: vi.fn(),
                    resetAgentTerminal: vi.fn(),
                    setAgentTerminalControls: vi.fn(),
                    emitAgentTerminalOutput: vi.fn(),
                    rpcHandlerManager: { registerHandler: () => {} },
                },
            },
        }
    }

    it('cancels an ordinary tool approval when the PTY exits', async () => {
        const { session, handler, respondAsWeb } = createRealHandlerSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)
        const pending = handler.requestDecision(
            'run-command:0',
            'run_command',
            { CommandLine: 'echo stale', Cwd: '/tmp' }
        )
        let rejected = false
        void pending.catch(() => { rejected = true })

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)
        ptyOptsCaptured.onExit(1)
        await tick(5)

        expect(rejected).toBe(true)
        await respondAsWeb({ id: 'run-command:0', approved: true })
        await expect(pending).rejects.toThrow('agy PTY exited')

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('never injects keys for a question that was pending when the PTY exited (crash/respawn safety)', async () => {
        const { session, handler, respondAsWeb } = createRealHandlerSessionStub()
        const registerSpy = vi.spyOn(handler, 'registerQuestionRequest')
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        const onEntry = harness.scannerOpts!.onEntry as (e: unknown) => void
        onEntry({
            type: 'PLANNER_RESPONSE',
            step_index: 40,
            content: '',
            tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Pick', options: ['A', 'B'], is_multi_select: false }] } }]
        })
        await tick(5)
        expect(registerSpy).toHaveBeenCalledTimes(1)
        const [toolUseId] = registerSpy.mock.calls[0]

        // Simulate a PTY crash: onExit fires while the question is still
        // unanswered (the selector it would answer into is gone).
        expect(ptyOptsCaptured).toBeTruthy()
        ptyOptsCaptured.onExit(1)

        // Simulate the respawn establishing a NEW live PTY generation (a
        // fresh registerControls call, exactly like a real respawn) BEFORE
        // the stale answer arrives — this is the actual danger the finding
        // describes: sendKeys becomes live again on the new PTY by the time
        // the stale answer resolves, unless the pending request was already
        // invalidated at exit time.
        const respawnedSendKeys = vi.fn()
        ptyOptsCaptured.registerControls?.({ sendKeys: respawnedSendKeys })
        await tick(10)

        // A stale web answer arrives AFTER the exit+respawn (e.g. the user
        // finally clicks an option in a chat card that should have been
        // invalidated).
        await respondAsWeb({ id: toolUseId, approved: true, answers: { '0': ['B'] } })
        await tick(10)

        // Must never inject the stale answer's keys into the NEW PTY
        // generation — the request was already rejected/removed by the
        // exit-time invalidation, so this response hits
        // handleMissingPendingResponse (no-op) instead of resolving.
        expect(respawnedSendKeys).not.toHaveBeenCalled()
        expect(harness.sendKeys).not.toHaveBeenCalled()

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('never injects keys for a question that was pending when the turn was aborted', async () => {
        const { session, handler, respondAsWeb } = createRealHandlerSessionStub()
        const registerSpy = vi.spyOn(handler, 'registerQuestionRequest')
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        const onEntry = harness.scannerOpts!.onEntry as (e: unknown) => void
        onEntry({
            type: 'PLANNER_RESPONSE',
            step_index: 41,
            content: '',
            tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Pick', options: ['A', 'B'], is_multi_select: false }] } }]
        })
        await tick(5)
        expect(registerSpy).toHaveBeenCalledTimes(1)
        const [toolUseId] = registerSpy.mock.calls[0]

        expect(harness.abortHandler).toBeTruthy()
        await harness.abortHandler!()

        // The interrupt keystroke is still sent (existing turn-abort behavior)…
        expect(harness.sendKeys).toHaveBeenCalledWith('\x03')
        harness.sendKeys.mockClear()

        // …a stale web answer arrives after the abort…
        await respondAsWeb({ id: toolUseId, approved: true, answers: { '0': ['B'] } })
        await tick(10)

        // …but must never be injected: the abort invalidated the pending
        // question, so nothing types a stray answer into whatever the
        // interrupt left on screen.
        expect(harness.sendKeys).not.toHaveBeenCalled()

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('drops an answered question queued behind another interaction when the turn is aborted', async () => {
        harness.exitReason = null
        const { session, handler, respondAsWeb } = createRealHandlerSessionStub()
        const registerSpy = vi.spyOn(handler, 'registerQuestionRequest')
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        const modelChange = harness.liveModelHandler!('gemini-3.5-flash-low')
        await tick(10)
        expect(harness.sendKeys).toHaveBeenCalledWith('/model\r')

        const onEntry = harness.scannerOpts!.onEntry as (e: unknown) => void
        onEntry({
            type: 'PLANNER_RESPONSE',
            step_index: 42,
            content: '',
            tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Pick', options: ['A', 'B'], is_multi_select: false }] } }]
        })
        await tick(5)
        const [toolUseId] = registerSpy.mock.calls[0]
        await respondAsWeb({ id: toolUseId, approved: true, answers: { '0': ['B'] } })
        await tick(5)

        await harness.abortHandler!()
        harness.sendKeys.mockClear()
        ptyOptsCaptured.onMessage('Switch Model\n> Gemini 3.5 Flash             (current)')
        await tick(5)
        ptyOptsCaptured.onMessage('Model set to Gemini 3.5 Flash (Low)')
        await modelChange
        await tick(10)

        expect(harness.sendKeys).not.toHaveBeenCalledWith('2')

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('drops an answered question queued behind another interaction after PTY exit and respawn', async () => {
        harness.exitReason = null
        const { session, handler, respondAsWeb } = createRealHandlerSessionStub()
        const registerSpy = vi.spyOn(handler, 'registerQuestionRequest')
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        const modelChange = harness.liveModelHandler!('gemini-3.5-flash-low')
        await tick(10)
        const onEntry = harness.scannerOpts!.onEntry as (e: unknown) => void
        onEntry({
            type: 'PLANNER_RESPONSE',
            step_index: 43,
            content: '',
            tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Pick', options: ['A', 'B'], is_multi_select: false }] } }]
        })
        await tick(5)
        const [toolUseId] = registerSpy.mock.calls[0]
        await respondAsWeb({ id: toolUseId, approved: true, answers: { '0': ['B'] } })
        await tick(5)

        ptyOptsCaptured.onExit(1)
        const respawnedSendKeys = vi.fn()
        const respawnedInvalidateInputReady = vi.fn()
        ptyOptsCaptured.registerControls?.({
            sendKeys: respawnedSendKeys,
            invalidateInputReady: respawnedInvalidateInputReady,
        })
        ptyOptsCaptured.onMessage('Switch Model\n> Gemini 3.5 Flash             (current)')
        await tick(5)
        ptyOptsCaptured.onMessage('Model set to Gemini 3.5 Flash (Low)')
        await modelChange.catch(() => {})
        await tick(10)

        expect(respawnedSendKeys).not.toHaveBeenCalled()
        expect(respawnedInvalidateInputReady).not.toHaveBeenCalled()

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })
})
