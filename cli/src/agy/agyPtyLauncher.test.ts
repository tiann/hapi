/**
 * Tests for the brain-UUID discovery wiring in AgyPtyLauncher.
 *
 * Bug context (2026-07-03 diagnosis, since generalized): the PreToolUse hook
 * discovers the agy brain UUID and calls `session.onSessionFound(uuid)` to
 * persist it to session metadata, but nothing ever told the scanner about
 * it — the scanner only started tailing once its OWN transcript content-match
 * found the brain, which failed outright for a first message with
 * attachments. Root-cause fix: register a sessionFoundCallback on the shared
 * AgentSessionBase registry so hook discovery notifies the scanner.
 *
 * The content-match fallback itself was removed once the PreToolUse and
 * PreInvocation hooks became the sole, authoritative discovery path (see
 * agySessionScanner.ts and the 2026-08-04 agy-preinvocation-discovery plan);
 * this file now only exercises the hook -> scanner bridge.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgyPermissionHandler } from './utils/agyPermissionHandler'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { userRequestMatches } from './agyPtyLauncher'

const harness = vi.hoisted(() => ({
    scannerOnNewSession: vi.fn(),
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
    // Number of launchOnce rounds the mocked respawn loop runs before
    // stopping (see the RemoteLauncherBase mock below). Defaults to 1 to
    // match every existing test's single-spawn assumption; a respawn test
    // bumps this to exercise a second launchOnce call.
    respawnRounds: 1,
    // Phase 2.7 (PreInvocation self-detach/respawn-reattach): every
    // writeAgyHooksJsonAtomic call the launcher makes, in order, so tests can
    // assert both WHICH content was written and WHEN (detach on discovery vs.
    // reattach before a respawn).
    hooksJsonWrites: [] as Array<{ carrierDir: string; content: string }>,
    // Whether agyHookCarrierIsIntact() should report the carrier as present.
    // Flipping this to false simulates the carrier vanishing (e.g. /tmp's
    // 30-day tmpfiles.d sweep) between the initial spawn and a respawn.
    carrierIntact: true,
    // prepareAgyHookCarrier() call count/result for the carrier-recreation path.
    carrierRecreateCalls: 0,
    carrierRecreateResult: undefined as { carrierDir: string } | undefined,
    // hooks.json content prepareAgyHookCarrier() was actually invoked with,
    // one entry per call — R5-2: the carrier-recreation path has its own
    // WITH/WITHOUT variant selection (syncPreInvocationHookForLaunch's
    // `desired`, independent of the in-place writeAgyHooksJsonAtomic path
    // that hooksJsonWrites already tracks) and nothing was asserting it, so
    // a regression there (e.g. reverting to always pass `withDiscovery`)
    // could pass the full suite silently.
    carrierRecreateContents: [] as string[],
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
                getBrainUuid: () => harness.scannerBrainUuid,
                onNewSession: harness.scannerOnNewSession,
            }
        }),
    }
})

vi.mock('./utils/agyHookCarrier', () => ({
    writeAgyHooksJsonAtomic: vi.fn((carrierDir: string, content: string) => {
        harness.hooksJsonWrites.push({ carrierDir, content })
    }),
    agyHookCarrierIsIntact: vi.fn(() => harness.carrierIntact),
    prepareAgyHookCarrier: vi.fn((content: string) => {
        harness.carrierRecreateCalls += 1
        harness.carrierRecreateContents.push(content)
        return harness.carrierRecreateResult
    }),
}))

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
        // Simplified respawn loop: runs launchOnce for harness.respawnRounds
        // rounds (default 1, no retry/backoff) so most wiring tests resolve
        // deterministically after a single spawn. A respawn-path test bumps
        // harness.respawnRounds to observe a second launchOnce call (each
        // round re-reads whatever `this.agySessionId` currently is, exactly
        // like the real loop's launchOnce -> agyPty(resumeSessionId) wiring).
        protected async runRespawnLoop(opts: {
            launchOnce: (signal: AbortSignal) => Promise<unknown>
            onLaunchStart?: (isNewSession: boolean) => void
        }): Promise<void> {
            for (let round = 0; round < harness.respawnRounds; round += 1) {
                // Round 0 always runs regardless of harness.exitReason — several
                // describe blocks' afterEach hooks leave a leftover 'exit' value
                // set as a defensive default between tests, and this mock must
                // match the original single-shot behavior (which never checked
                // exitReason at all) for every test that never opts into a
                // respawn. Only rounds AFTER the first are gated on it, so a
                // respawn test naturally stops once the session actually ends.
                if (round > 0 && harness.exitReason) break
                // Mirrors RemoteLauncherBase's real runRespawnLoop: onLaunchStart
                // runs synchronously before every launchOnce, including the
                // first — see runAgy.ts's Phase 2.7 syncPreInvocationHookForLaunch call.
                opts.onLaunchStart?.(round === 0)
                const controller = new AbortController()
                this.ptyAbortController = controller
                await opts.launchOnce(controller.signal)
            }
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

function createSessionStub(opts?: {
    agyPermissionHandler?: Record<string, unknown> | null
    // Phase 2.7: the PreInvocation self-detach/respawn-reattach cycle only
    // engages when these are set (mirrors runAgy.ts leaving them undefined
    // outside PTY mode) — omitted by default so every pre-existing test in
    // this file exercises the same no-op path it always has.
    hookCarrierDir?: string
    hooksJsonWithPreInvocation?: string
    hooksJsonWithoutPreInvocation?: string
    hookMcpServer?: { command: string; args?: string[] }
}) {
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
    const session = {
        sessionId: null as string | null,
        path: '/tmp/agy-pty-test',
        hookCarrierDir: opts?.hookCarrierDir,
        hookPort: undefined,
        hookToken: undefined,
        hooksJsonWithPreInvocation: opts?.hooksJsonWithPreInvocation,
        hooksJsonWithoutPreInvocation: opts?.hooksJsonWithoutPreInvocation,
        hookMcpServer: opts?.hookMcpServer,
        setHookCarrierDir: (dir: string) => { session.hookCarrierDir = dir },
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
    }
    return { session }
}

describe('agyPtyLauncher session-found wiring (brain UUID -> scanner)', () => {
    afterEach(() => {
        harness.scannerOnNewSession.mockClear()
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
        harness.respawnRounds = 1
        harness.hooksJsonWrites = []
        harness.carrierIntact = true
        harness.carrierRecreateCalls = 0
        harness.carrierRecreateResult = undefined
        harness.carrierRecreateContents = []
        ptyOptsCaptured = null
    })

    it('emits the hub session-ready signal when the AGY PTY becomes usable', async () => {
        const { session } = createSessionStub()

        await agyPtyLauncher(session as never)

        expect(session.client.emitSessionReady).toHaveBeenCalledTimes(1)
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
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

    it('persists the discovered UUID through a respawn, so the next agy spawn resumes via --conversation instead of silently starting a fresh brain (hostile-review finding: crash-recovery resume gap)', async () => {
        // Root-cause regression guard (Fix 7 deleted the previous version of this
        // guard along with the onMessage getBrainUuid() fallback it used as an
        // oracle — that oracle was itself dead code, but the invariant it
        // protected is not: handleSessionFound must persist the uuid to
        // this.agySessionId synchronously, otherwise a PTY crash/respawn between
        // hook discovery and the next spawn reads a stale null resumeSessionId
        // and silently starts a fresh brain instead of resuming the one the user
        // was already talking to. This version drives an actual second
        // launchOnce round (via harness.respawnRounds) and inspects the args the
        // NEXT spawn would actually be launched with — the real symptom of the
        // original defect — instead of a proxy assertion on the first spawn.
        harness.respawnRounds = 2
        const { session } = createSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        expect(harness.foundCallbacks).toHaveLength(1)
        // First spawn has no brain yet: resumeSessionId is unset.
        expect(ptyOptsCaptured.resumeSessionId).toBeUndefined()

        // The hook fires mid-round-1 (agy's PreToolUse/PreInvocation hook ->
        // session.onSessionFound -> this handleSessionFound), then round 1 ends
        // (e.g. the PTY crashes) and the mocked respawn loop starts round 2.
        harness.foundCallbacks[0]('hook-discovered-uuid')
        msgPromise.resolve(null)
        await tick(20)

        // ptyOptsCaptured now reflects the SECOND agyPty(...) call (round 2's
        // spawn args) — this is the assertion that fails if handleSessionFound
        // stops persisting agySessionId synchronously: resumeSessionId would
        // read back undefined and buildAgyPtyArgs would omit --conversation.
        expect(ptyOptsCaptured.resumeSessionId).toBe('hook-discovered-uuid')
        // Real (non-mocked) buildAgyPtyArgs, fetched via importActual so the
        // shared `./agyPty` mock (used by every other test in this file for
        // agyPty itself) stays untouched — this is the pure arg-builder that
        // turns resumeSessionId into the actual `--conversation <uuid>` CLI
        // flag agy would be launched with.
        const { buildAgyPtyArgs } = await vi.importActual<typeof import('./agyPty')>('./agyPty')
        expect(buildAgyPtyArgs(ptyOptsCaptured).join(' ')).toContain('--conversation hook-discovered-uuid')

        harness.exitReason = 'exit'
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

// Phase 2.7 (agy-preinvocation-discovery plan §6.6/§8): PreInvocation fires
// on EVERY model call (measured ~424ms round trip) but is only useful until
// the brain UUID is confirmed — after that it's pure waste. agy re-reads
// hooks.json before every model call, so the carrier's hooks.json can be
// rewritten in place to drop PreInvocation once discovery succeeds, and
// restored before every respawn (a resume that silently fails would
// otherwise leave no way to discover the replacement conversation's UUID).
describe('agyPtyLauncher PreInvocation self-detach/respawn-reattach (Phase 2.7)', () => {
    afterEach(() => {
        harness.scannerOnNewSession.mockClear()
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
        harness.respawnRounds = 1
        harness.hooksJsonWrites = []
        harness.carrierIntact = true
        harness.carrierRecreateCalls = 0
        harness.carrierRecreateResult = undefined
        harness.carrierRecreateContents = []
        ptyOptsCaptured = null
    })

    const HOOKS_JSON_WITH = '{"hapi-bridge":{"PreToolUse":[{"matcher":"*","hooks":[{"command":"pre-tool-use-cmd","timeout":3600}]}],"PreInvocation":[{"type":"command","command":"pre-invocation-cmd","timeout":5}]}}'
    const HOOKS_JSON_WITHOUT = '{"hapi-bridge":{"PreToolUse":[{"matcher":"*","hooks":[{"command":"pre-tool-use-cmd","timeout":3600}]}]}}'

    it('1) drops the PreInvocation block once the brain UUID is confirmed, leaving PreToolUse untouched', async () => {
        const { session } = createSessionStub({
            hookCarrierDir: '/tmp/carrier-a',
            hooksJsonWithPreInvocation: HOOKS_JSON_WITH,
            hooksJsonWithoutPreInvocation: HOOKS_JSON_WITHOUT,
        })
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)
        // Round 1's onLaunchStart already reattached once (idempotent restore
        // of the same with-discovery content the carrier was born with) —
        // clear it so this test only inspects the discovery-triggered write.
        harness.hooksJsonWrites = []

        harness.foundCallbacks[0]('hook-discovered-uuid')

        // Fails if handleSessionFound stops calling detachPreInvocationHook,
        // or if it writes the wrong (with-discovery) content, or writes to
        // the wrong carrier directory.
        expect(harness.hooksJsonWrites).toHaveLength(1)
        expect(harness.hooksJsonWrites[0].carrierDir).toBe('/tmp/carrier-a')
        const parsed = JSON.parse(harness.hooksJsonWrites[0].content)
        const group = Object.values(parsed)[0] as { PreToolUse: Array<{ matcher: string }>; PreInvocation?: unknown }
        expect(group.PreInvocation).toBeUndefined()
        expect(group.PreToolUse[0].matcher).toBe('*')

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('2) keeps PreInvocation detached across a respawn once the brain UUID is already known (Fix N1)', async () => {
        harness.respawnRounds = 2
        const { session } = createSessionStub({
            hookCarrierDir: '/tmp/carrier-b',
            hooksJsonWithPreInvocation: HOOKS_JSON_WITH,
            hooksJsonWithoutPreInvocation: HOOKS_JSON_WITHOUT,
        })
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)
        harness.hooksJsonWrites = []

        // Discovery detaches PreInvocation mid-round-1 (e.g. the PTY then crashes).
        harness.foundCallbacks[0]('hook-discovered-uuid')
        expect(harness.hooksJsonWrites).toHaveLength(1)
        expect(harness.hooksJsonWrites[0].content).toBe(HOOKS_JSON_WITHOUT)

        // Round 1 ends and the mocked respawn loop starts round 2 — its
        // onLaunchStart must NOT re-arm PreInvocation: this.agySessionId is
        // already set from the discovery above, so syncPreInvocationHookForLaunch
        // writes WITHOUT again (a no-op re-assertion of the current state),
        // not WITH. Before Fix N1 this wrote WITH unconditionally, silently
        // undoing detachPreInvocationHook's work on every single respawn —
        // the exact bug this test now guards against (see
        // agyPtyLauncher.ts:syncPreInvocationHookForLaunch's docstring for why
        // resuming the SAME brain via --conversation makes re-arming
        // pointless: a resume failure is out of scope, per Fix N2).
        msgPromise.resolve(null)
        await tick(20)

        // Fails (mutation check: revert syncPreInvocationHookForLaunch to always
        // write `withDiscovery`) if PreInvocation gets re-armed on a respawn
        // after discovery already succeeded.
        expect(harness.hooksJsonWrites).toHaveLength(2)
        expect(harness.hooksJsonWrites[1].content).toBe(HOOKS_JSON_WITHOUT)
        expect(harness.hooksJsonWrites[1].carrierDir).toBe('/tmp/carrier-b')

        harness.exitReason = 'exit'
        await launcherPromise
    })

    it('3) detaches PreInvocation on the very first launch when the session is resume-seeded, and it stays detached across a respawn (Fix N1)', async () => {
        harness.respawnRounds = 2
        const { session } = createSessionStub({
            hookCarrierDir: '/tmp/carrier-resume',
            hooksJsonWithPreInvocation: HOOKS_JSON_WITH,
            hooksJsonWithoutPreInvocation: HOOKS_JSON_WITHOUT,
        })
        // Mirrors loop.ts calling session.onSessionFound(resumeSessionId)
        // BEFORE the launcher is constructed — by the time AgyPtyLauncher's
        // constructor runs, session.sessionId is already the resumed UUID,
        // so this.agySessionId is seeded, and no PreToolUse/PreInvocation
        // hook will ever fire addSessionFoundCallback's handleSessionFound
        // for it (first-wins guard: wrapper.sessionId is already set).
        session.sessionId = 'resumed-uuid'

        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        // Fails (mutation check: revert syncPreInvocationHookForLaunch to always
        // write `withDiscovery`) if a resume-seeded session's first launch
        // still writes WITH — before Fix N1 this never wrote WITHOUT at all
        // for a resume, since handleSessionFound (the only other writer of
        // WITHOUT) never fires for it.
        expect(harness.hooksJsonWrites).toHaveLength(1)
        expect(harness.hooksJsonWrites[0].content).toBe(HOOKS_JSON_WITHOUT)
        expect(harness.hooksJsonWrites[0].carrierDir).toBe('/tmp/carrier-resume')

        // No PreToolUse/PreInvocation hook fires in this test (harness.foundCallbacks
        // is never invoked) — the resumed conversation is assumed to keep
        // resuming successfully, which is the common case (resume-failure
        // detection is explicitly out of scope, per Fix N2).
        msgPromise.resolve(null)
        await tick(20)

        expect(harness.hooksJsonWrites).toHaveLength(2)
        expect(harness.hooksJsonWrites[1].content).toBe(HOOKS_JSON_WITHOUT)

        harness.exitReason = 'exit'
        await launcherPromise
    })

    it('4) recreates a vanished carrier before a respawn and repoints hookCarrierDir for the next agy spawn', async () => {
        harness.respawnRounds = 2
        harness.carrierIntact = false
        harness.carrierRecreateResult = { carrierDir: '/tmp/carrier-c-recreated' }
        const { session } = createSessionStub({
            hookCarrierDir: '/tmp/carrier-c-original',
            hooksJsonWithPreInvocation: HOOKS_JSON_WITH,
            hooksJsonWithoutPreInvocation: HOOKS_JSON_WITHOUT,
        })
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)
        harness.carrierRecreateCalls = 0
        // Round 1's onLaunchStart already recreated the carrier once (the
        // brain UUID isn't known yet at that point, so it recreated with
        // `withDiscovery`) — reset alongside carrierRecreateCalls so what's
        // left below is only round 2's call, the one this test actually
        // targets (recreation happening AFTER discovery, before a respawn).
        harness.carrierRecreateContents = []

        harness.foundCallbacks[0]('hook-discovered-uuid')
        msgPromise.resolve(null)
        await tick(20)

        // Fails if the launcher writes to the (now-nonexistent) old carrier
        // path instead of checking agyHookCarrierIsIntact() and rebuilding,
        // or if it forgets to repoint session.hookCarrierDir afterward.
        expect(harness.carrierRecreateCalls).toBe(1)
        expect(session.hookCarrierDir).toBe('/tmp/carrier-c-recreated')
        // R5-2: the recreation path picks its own WITH/WITHOUT variant
        // independently of the in-place writeAgyHooksJsonAtomic path — by
        // this point in the test, discovery already happened
        // (this.agySessionId is set), so the carrier must be recreated with
        // WITHOUT, never WITH. Mutation check: reverting
        // agyPtyLauncher.ts's prepareAgyHookCarrier(desired, ...) call back
        // to prepareAgyHookCarrier(withDiscovery, ...) keeps every assertion
        // above green (carrierRecreateCalls, hookCarrierDir, --add-dir all
        // still pass) while this one alone catches PreInvocation getting
        // silently re-armed on the recreated carrier.
        expect(harness.carrierRecreateContents).toEqual([HOOKS_JSON_WITHOUT])
        // The recreated carrier is what the SECOND agy spawn must actually
        // use for --add-dir — this is the real symptom a stale hookCarrierDir
        // would produce (agy launched pointed at a directory that no longer
        // carries any hooks at all).
        expect(ptyOptsCaptured.hookCarrierDir).toBe('/tmp/carrier-c-recreated')

        harness.exitReason = 'exit'
        await launcherPromise
    })

    it('6) aborts before agy ever spawns when the carrier cannot be recreated (Fix 1: fail-closed)', async () => {
        harness.carrierIntact = false
        // harness.carrierRecreateResult stays undefined (afterEach's reset
        // default) — simulates prepareAgyHookCarrier() failing (ENOSPC, an
        // unwritable HAPI_HOME, ...).
        const { session } = createSessionStub({
            hookCarrierDir: '/tmp/carrier-fail',
            hooksJsonWithPreInvocation: HOOKS_JSON_WITH,
            hooksJsonWithoutPreInvocation: HOOKS_JSON_WITHOUT,
        })

        const launcherPromise = agyPtyLauncher(session as never)

        // Fails (mutation check: revert syncPreInvocationHookForLaunch's
        // `if (!recreated)` branch back to log-and-return) if the launcher
        // resolves/exits cleanly instead of propagating the fail-closed abort.
        await expect(launcherPromise).rejects.toThrow(/hook carrier/i)

        // The explicit ask this test guards: agyPty (and therefore
        // --dangerously-skip-permissions) must never be spawned when the
        // permission bridge cannot be rebuilt. ptyOptsCaptured is only ever
        // set from inside the mocked agyPty() body (see the top-of-file
        // vi.mock('./agyPty', ...)), so it staying null proves agyPty was
        // never invoked for this launch.
        expect(ptyOptsCaptured).toBeNull()

        // The web chat must show WHY the session ended, not just that it
        // did — mirrors the discovery-timeout warning's
        // sendSessionEvent({type:'error'}) (Fix 6, above).
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error' })
        )
    })

    it('5) detach/reattach do not disturb the existing discovery or resume wiring', async () => {
        harness.respawnRounds = 2
        const { session } = createSessionStub({
            hookCarrierDir: '/tmp/carrier-d',
            hooksJsonWithPreInvocation: HOOKS_JSON_WITH,
            hooksJsonWithoutPreInvocation: HOOKS_JSON_WITHOUT,
        })
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await tick(20)

        harness.foundCallbacks[0]('hook-discovered-uuid')
        // The scanner bridge (pre-existing discovery wiring) must still fire
        // despite the hooks.json rewrite alongside it.
        expect(harness.scannerOnNewSession).toHaveBeenCalledWith('hook-discovered-uuid')

        msgPromise.resolve(null)
        await tick(20)

        // Fails if detachPreInvocationHook/syncPreInvocationHookForLaunch throw
        // (breaking the launcher's promise chain) or otherwise corrupt
        // this.agySessionId — the pre-existing crash-recovery guard (round 2
        // must resume the SAME conversation via --conversation) is the oracle.
        expect(ptyOptsCaptured.resumeSessionId).toBe('hook-discovered-uuid')
        expect(ptyOptsCaptured.hookCarrierDir).toBe(session.hookCarrierDir)
        const { buildAgyPtyArgs } = await vi.importActual<typeof import('./agyPty')>('./agyPty')
        expect(buildAgyPtyArgs(ptyOptsCaptured).join(' ')).toContain('--conversation hook-discovered-uuid')

        harness.exitReason = 'exit'
        await launcherPromise
    })
})

// Fix 6 (hostile-review round 1): dropping the scanner's content-match
// discovery also dropped onDiscoveryAmbiguous, which used to be the ONLY
// path that ever told the user discovery had failed. Without a replacement,
// a hook that never fires (misconfigured bridge, hooks.json didn't load, a
// future agy version drops the field, ...) leaves the web chat silently
// empty forever with no explanation. These tests pin the one-shot timeout
// warning that replaces it.
describe('agyPtyLauncher discovery-timeout warning (Fix 6)', () => {
    afterEach(() => {
        vi.useRealTimers()
        harness.scannerOnNewSession.mockClear()
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
        harness.respawnRounds = 1
        harness.hooksJsonWrites = []
        harness.carrierIntact = true
        harness.carrierRecreateCalls = 0
        harness.carrierRecreateResult = undefined
        harness.carrierRecreateContents = []
        ptyOptsCaptured = null
    })

    const errorEvents = (session: ReturnType<typeof createSessionStub>['session']) =>
        vi.mocked(session.client.sendSessionEvent).mock.calls
            .map(([event]) => event as { type: string; message?: string })
            .filter((event) => event.type === 'error')

    it('does not warn when the PTY is ready but idle — no message ever submitted, no model call started (Fix 9 N1 regression guard)', async () => {
        // onReady only means the TUI prompt can accept keystrokes; a user who
        // spawns agy and reads the prompt for a minute (or switches away) before
        // typing anything is a completely normal, common flow — not a discovery
        // failure. Before Fix 9 (which armed on onReady instead of the first
        // evidence of an actual model call), this was a false positive that
        // fired for every idle new session and burned the one-shot latch before
        // a real failure could ever be reported.
        vi.useFakeTimers()
        const { session } = createSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await vi.advanceTimersByTimeAsync(0)

        // Idle: never call onThinkingChange(true), never fire the discovery
        // hook — just let well over the timeout window pass.
        await vi.advanceTimersByTimeAsync(120_000)

        expect(errorEvents(session)).toHaveLength(0)

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('does not warn when the brain UUID is discovered before the timeout elapses', async () => {
        vi.useFakeTimers()
        const { session } = createSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await vi.advanceTimersByTimeAsync(0)

        // A model call actually starts — this is what arms the timer now.
        ptyOptsCaptured.onThinkingChange(true)
        harness.foundCallbacks[0]('hook-discovered-uuid')
        await vi.advanceTimersByTimeAsync(60_000)

        expect(errorEvents(session)).toHaveLength(0)

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('warns exactly once when a model call starts but the brain UUID is never discovered within the timeout (no duplicate notifications)', async () => {
        vi.useFakeTimers()
        const { session } = createSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await vi.advanceTimersByTimeAsync(0)

        // The model call starting (thinking=true) is what arms the timer —
        // covers both a web-queued submission and text typed directly into the
        // terminal, since both eventually flip agy's busy marker.
        ptyOptsCaptured.onThinkingChange(true)

        await vi.advanceTimersByTimeAsync(60_000)
        expect(errorEvents(session)).toHaveLength(1)
        expect(errorEvents(session)[0]!.message).toMatch(/continue in the terminal/i)

        // Time continuing to pass (e.g. a respawn cycle) must not re-fire it.
        await vi.advanceTimersByTimeAsync(120_000)
        expect(errorEvents(session)).toHaveLength(1)

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('clears the pending timer on session teardown — no leak, no late fire after exit', async () => {
        vi.useFakeTimers()
        const { session } = createSessionStub()
        const msgPromise = deferred<{ message: string } | null>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = agyPtyLauncher(session as never)
        await vi.advanceTimersByTimeAsync(0)

        // Arm the timer first (a model call started) so teardown actually has
        // something pending to clear — without this the assertions below would
        // pass vacuously regardless of whether clearDiscoveryTimeoutWarning()
        // does anything, since an unarmed timer trivially leaves 0 pending.
        ptyOptsCaptured.onThinkingChange(true)
        expect(vi.getTimerCount()).toBeGreaterThan(0)

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise

        expect(vi.getTimerCount()).toBe(0)

        vi.mocked(session.client.sendSessionEvent).mockClear()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(errorEvents(session)).toHaveLength(0)
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
