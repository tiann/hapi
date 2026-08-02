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

const harness = vi.hoisted(() => ({
    scannerOnNewSession: vi.fn(),
    scannerSetSessionMessageText: vi.fn(),
    scannerCleanupCalls: 0,
    scannerOpts: null as Record<string, unknown> | null,
    scannerBrainUuid: null as string | null,
    foundCallbacks: [] as Array<(sessionId: string) => void>,
    removedCallbacks: [] as Array<(sessionId: string) => void>,
    exitReason: 'exit' as string | null,
    sendKeys: vi.fn(),
    abortHandler: null as (() => void | Promise<void>) | null,
    switchHandler: null as (() => void | Promise<void>) | null,
}))

let ptyOptsCaptured: any = null
vi.mock('./agyPty', () => ({
    agyPty: vi.fn(async (opts: any) => {
        ptyOptsCaptured = opts
        opts.registerControls?.({ sendKeys: harness.sendKeys })
        opts.onReady?.()
        await opts.nextMessage()
    }),
}))

vi.mock('./utils/agySessionScanner', () => ({
    createAgySessionScanner: vi.fn(async (opts: Record<string, unknown>) => {
        harness.scannerOpts = opts
        return {
            cleanup: async () => { harness.scannerCleanupCalls += 1 },
            setSessionMessageText: harness.scannerSetSessionMessageText,
            getBrainUuid: () => harness.scannerBrainUuid,
            onNewSession: harness.scannerOnNewSession,
        }
    }),
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({
    RemoteModeDisplay: () => null,
}))

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}))

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
        harness.exitReason = 'exit'
        harness.sendKeys.mockClear()
        harness.abortHandler = null
        harness.switchHandler = null
        ptyOptsCaptured = null
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
        // callback must persist the UUID through the session state callback
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

        await expect(agyPtyLauncher(session as never)).resolves.toBe('exit')
        expect(harness.scannerSetSessionMessageText).toHaveBeenCalledWith('hello agy')
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
                    resetAgentTerminal: vi.fn(),
                    setAgentTerminalControls: vi.fn(),
                    emitAgentTerminalOutput: vi.fn(),
                    rpcHandlerManager: { registerHandler: () => {} },
                },
            },
        }
    }

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
})
