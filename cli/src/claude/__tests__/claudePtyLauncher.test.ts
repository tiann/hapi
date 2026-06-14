import { afterEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    scannerOnMessage: null as ((message: Record<string, unknown>) => void) | null,
    scannerOpts: null as Record<string, unknown> | null,
    cleanupCalls: 0,
    foundCallbacks: [] as Array<(sessionId: string) => void>,
    exitReason: 'exit' as string | null,
}))

let lastSendKeysSpy = vi.fn()
let ptyOptsCaptured: any = null
vi.mock('../claudePty', () => ({
    claudePty: vi.fn(async (opts: any) => {
        ptyOptsCaptured = opts
        lastSendKeysSpy = vi.fn()
        opts.registerControls?.({
            resize: () => {},
            sendKeys: lastSendKeysSpy
        })
        opts.onReady?.()
        await opts.nextMessage()
    }),
}))

vi.mock('../utils/sessionScanner', () => ({
    createSessionScanner: async (opts: { onMessage: (message: Record<string, unknown>) => void }) => {
        harness.scannerOnMessage = opts.onMessage
        harness.scannerOpts = opts
        return {
            cleanup: async () => { harness.cleanupCalls += 1 },
            onNewSession: () => {},
        }
    },
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({
    RemoteModeDisplay: () => null,
}))

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}))

let mockAbortHandlers: any = null
vi.mock('@/modules/common/remote/RemoteLauncherBase', () => ({
    RemoteLauncherBase: class {
        get exitReason() { return harness.exitReason }
        set exitReason(v) { harness.exitReason = v }
        protected hasTTY = false
        protected messageBuffer = { addMessage: () => {} }
        protected ptyAbortController: AbortController | null = null
        constructor(_logPath?: string) {}
        protected setupAbortHandlers(rpc: any, handlers: any) {
            mockAbortHandlers = handlers
        }
        protected clearAbortHandlers() {}
        protected async requestExit(reason: string, handler: Function) {
            harness.exitReason = reason
            await handler()
        }
        protected async runRespawnLoop(opts: any): Promise<void> {
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

import { claudePtyLauncher, lastUserPromptText, transcriptConfirmsDelivery } from '../claudePtyLauncher'

describe('transcriptConfirmsDelivery', () => {
    const userLine = (text: string) => JSON.stringify({ type: 'user', message: { content: text } })
    const assistantLine = (text: string) =>
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

    it('confirms when the just-submitted message is the last prompt', () => {
        const transcript = [userLine('first'), assistantLine('ok'), userLine('continue the task')].join('\n')
        expect(transcriptConfirmsDelivery(transcript, 'continue the task')).toBe(true)
    })

    it('does NOT confirm on a stale substring of the prior prompt (resume false-positive guard)', () => {
        // Prior turn typed "please continue the task"; on --resume the new message
        // "continue" has NOT landed yet, so the last prompt is still the prior one.
        // A substring check would wrongly confirm and suppress the re-type.
        const transcript = [userLine('please continue the task'), assistantLine('done')].join('\n')
        expect(transcriptConfirmsDelivery(transcript, 'continue')).toBe(false)
    })

    it('ignores trailing whitespace differences', () => {
        const transcript = userLine('hello world\n')
        expect(transcriptConfirmsDelivery(transcript, 'hello world')).toBe(true)
    })

    it('falls back to whole-file match when no user prompt parses', () => {
        expect(transcriptConfirmsDelivery('not json\n{"type":"assistant"}', 'assistant')).toBe(true)
        expect(transcriptConfirmsDelivery('', 'anything')).toBe(false)
    })
})

describe('lastUserPromptText', () => {
    const userLine = (text: string) => JSON.stringify({ type: 'user', message: { content: text } })
    const userBlocks = (text: string) =>
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } })
    const assistantLine = (text: string) =>
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
    const toolResultLine = JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'PINGA file output' }] },
    })

    it('returns the most recent typed prompt, ignoring assistant turns', () => {
        const transcript = [userLine('PINGA'), assistantLine('ok'), userLine('PONGB')].join('\n')
        expect(lastUserPromptText(transcript)).toBe('PONGB')
    })

    it('does not match stale pre-resume history (the false-positive guard)', () => {
        // Replayed history contains PINGA; the just-submitted prompt is PONGB.
        const transcript = [userLine('PINGA'), assistantLine('A'), userBlocks('PONGB')].join('\n')
        const result = lastUserPromptText(transcript)
        expect(result).toBe('PONGB')
        // The whole-file substring would have matched PINGA; the anchored check must not.
        expect(result?.includes('PINGA')).toBe(false)
    })

    it('skips tool_result user entries (no typed text)', () => {
        const transcript = [userLine('PINGA'), toolResultLine].join('\n')
        expect(lastUserPromptText(transcript)).toBe('PINGA')
    })

    it('returns null when there is no parseable user prompt', () => {
        expect(lastUserPromptText('')).toBeNull()
        expect(lastUserPromptText('not json\n{"type":"assistant"}')).toBeNull()
        expect(lastUserPromptText(toolResultLine)).toBeNull()
    })
})

function createSessionStub() {
    const sentMessages: Array<Record<string, unknown>> = []
    return {
        session: {
            sessionId: 'pty-session',
            path: '/tmp/pty-test',
            startedBy: 'terminal' as const,
            startingMode: 'remote' as const,
            claudeEnvVars: {},
            claudeArgs: [],
            hookSettingsPath: '/tmp/hooks/pty.json',
            consumeOneTimeFlags: () => {},
            setKillHandler: (_handler: () => void) => {},
            setConfigChangeHandler: (_handler: (() => void) | null) => {},
            getModel: () => null,
            getEffort: () => undefined,
            addSessionFoundCallback: (cb: (sessionId: string) => void) => { harness.foundCallbacks.push(cb) },
            removeSessionFoundCallback: () => {},
            queue: {
                waitForMessagesAndGetAsString: vi.fn().mockResolvedValue(null)
            },
            client: {
                sendClaudeSessionMessage: (msg: Record<string, unknown>) => { sentMessages.push(msg) },
                sendSessionEvent: () => {},
                emitAgentTerminalOutput: () => {},
                setAgentTerminalControls: () => {},
                rpcHandlerManager: { registerHandler: () => {} },
            },
        },
        sentMessages,
    }
}

describe('claudePtyLauncher structured message forwarding', () => {
    afterEach(() => {
        harness.scannerOnMessage = null
        harness.scannerOpts = null
        harness.cleanupCalls = 0
        harness.foundCallbacks = []
    })

    it('creates the scanner with the session id and working directory', async () => {
        const { session } = createSessionStub()
        await claudePtyLauncher(session as never)

        expect(harness.scannerOpts).toMatchObject({
            sessionId: 'pty-session',
            workingDirectory: '/tmp/pty-test',
        })
    })

    it('registers a session-found callback and cleans up the scanner', async () => {
        const { session } = createSessionStub()
        await claudePtyLauncher(session as never)

        expect(harness.foundCallbacks).toHaveLength(1)
        expect(harness.cleanupCalls).toBe(1)
    })

    it('registers a kill handler so the lifecycle can tear down the PTY on archive', async () => {
        const { session } = createSessionStub()
        let killHandler: (() => void) | undefined
        session.setKillHandler = (h: () => void) => { killHandler = h }
        await claudePtyLauncher(session as never)
        // onBeforeClose calls session.kill() → this handler → launcher.abort().
        expect(killHandler).toBeTypeOf('function')
    })

    it('filters out summary messages', async () => {
        const { session, sentMessages } = createSessionStub()
        await claudePtyLauncher(session as never)

        harness.scannerOnMessage!({ type: 'summary', leafUuid: '1' })

        expect(sentMessages).toHaveLength(0)
    })

    it('filters out invisible system messages', async () => {
        const { session, sentMessages } = createSessionStub()
        await claudePtyLauncher(session as never)

        harness.scannerOnMessage!({ type: 'system', subtype: 'init', uuid: '1' })
        harness.scannerOnMessage!({ type: 'system', subtype: 'stop_hook_summary', uuid: '2' })
        harness.scannerOnMessage!({ type: 'system', uuid: '3' })

        expect(sentMessages).toHaveLength(0)
    })

    it('filters out isMeta and isCompactSummary messages', async () => {
        const { session, sentMessages } = createSessionStub()
        await claudePtyLauncher(session as never)

        harness.scannerOnMessage!({ type: 'user', isMeta: true, uuid: '1' })
        harness.scannerOnMessage!({ type: 'assistant', isCompactSummary: true, uuid: '2' })

        expect(sentMessages).toHaveLength(0)
    })

    it('forwards normal conversation messages to the hub', async () => {
        const { session, sentMessages } = createSessionStub()
        await claudePtyLauncher(session as never)

        harness.scannerOnMessage!({ type: 'user', uuid: '1' })
        harness.scannerOnMessage!({ type: 'assistant', uuid: '2' })

        expect(sentMessages).toHaveLength(2)
    })
})

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void
    return { promise: new Promise<T>((r) => { resolve = r }), resolve }
}

describe('claudePtyLauncher turn-interrupt', () => {
    afterEach(() => {
        harness.exitReason = 'exit'
        mockAbortHandlers = null
        ptyOptsCaptured = null
    })

    const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

    it('sends Esc key to PTY when aborted/stopped and PTY controls are active', async () => {
        harness.exitReason = null

        const { session } = createSessionStub()
        const msgPromise = deferred<any>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const launcherPromise = claudePtyLauncher(session as never)

        await tick(50)

        expect(mockAbortHandlers).toBeTruthy()
        expect(mockAbortHandlers.onAbort).toBeTypeOf('function')

        // Trigger turn interrupt
        await mockAbortHandlers.onAbort()

        // Should write Esc key (\x1b) to PTY controls
        expect(lastSendKeysSpy).toHaveBeenCalledWith('\x1b')

        // Should NOT abort the PTY spawn signal
        expect(ptyOptsCaptured.signal.aborted).toBe(false)

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })

    it('kills the PTY session (aborts the controller) when aborted and PTY controls are NOT active', async () => {
        harness.exitReason = null

        const { session } = createSessionStub()
        const msgPromise = deferred<any>()
        vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(() => msgPromise.promise)

        const { claudePty: mockedClaudePty } = await import('../claudePty')
        vi.mocked(mockedClaudePty).mockImplementationOnce(async (opts: any) => {
            ptyOptsCaptured = opts
            opts.onReady?.()
            await opts.nextMessage()
        })

        const launcherPromise = claudePtyLauncher(session as never)

        await tick(50)

        expect(mockAbortHandlers).toBeTruthy()

        // Trigger turn interrupt
        await mockAbortHandlers.onAbort()

        // No controls registered, should fallback to aborting the controller
        expect(ptyOptsCaptured.signal.aborted).toBe(true)

        harness.exitReason = 'exit'
        msgPromise.resolve(null)
        await launcherPromise
    })
})
