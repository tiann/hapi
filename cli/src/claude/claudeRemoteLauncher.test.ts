import { afterEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { EnhancedMode } from './loop'

// These tests cover the one-time --resume flag's lifetime across the relaunch
// loop. The flag lives in session.claudeArgs and is the only resume anchor a
// remote Claude session has until Claude reports a session id back, so it must
// survive launch attempts that never reached Claude, and must be dropped both
// when it has been used and when the user explicitly discards the context.
const harness = vi.hoisted(() => ({
    callCount: 0,
    claudeArgsPerCall: [] as (string[] | undefined)[],
    initialMessages: [] as string[],
    triggerSwitch: null as (() => void) | null,
    switchAfterCall: 2,
    compactContextTokens: null as number | null,
    remoteImplementation: null as ((opts: any) => Promise<void>) | null,
    compactSummary: null as { summary: string; tokensBefore?: number; tokensAfter?: number } | null
}))

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: any) => {
        const { parseSpecialCommand } = await import('@/parsers/specialCommands')

        harness.callCount += 1
        harness.claudeArgsPerCall.push(opts.claudeArgs ? [...opts.claudeArgs] : opts.claudeArgs)
        if (harness.remoteImplementation) return harness.remoteImplementation(opts)

        const initial = await opts.nextMessage()
        if (!initial) {
            // Mirrors claudeRemote()'s early return when the initial
            // nextMessage() resolves null (an isolate message got parked as
            // `pending`): it returns before spawning Claude, so onSessionFound
            // never fires and the --resume flag is never actually used.
            return
        }
        harness.initialMessages.push(initial.message)

        // Mirrors claudeRemote()'s /clear contract: it reports the context as
        // discarded and returns before spawning Claude, so onSessionFound
        // never fires here either.
        if (parseSpecialCommand(initial.message).type === 'clear') {
            opts.onSessionReset()
            return
        }

        // Mirrors a launch that actually spawns Claude and observes the
        // session id via the SDK's system/init message.
        opts.onSessionFound('captured-session-id')

        if (harness.compactSummary !== null) await opts.onReady(undefined, harness.compactSummary)
        if (harness.compactContextTokens !== null) {
            // Mirrors claudeRemote()'s compact-completion onReady: no
            // completion event or summary, just the boundary's post-tokens.
            await opts.onReady(undefined, undefined, harness.compactContextTokens)
        }

        if (harness.callCount === harness.switchAfterCall && harness.triggerSwitch) {
            // Stop the runMainLoop() while-loop so the test doesn't hang
            // waiting on a further claudeRemote() call. Mirrors the real
            // 'switch' RPC exit path already wired by setupAbortHandlers().
            harness.triggerSwitch()
        }
    }
}))

vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class {
        setOnPermissionRequest(): void {}
        getResponses(): Map<string, unknown> { return new Map() }
        onMessage(): void {}
        handleToolCall = async () => ({ behavior: 'allow', updatedInput: {} })
        reset(): void {}
        isAborted(): boolean { return false }
        handleModeChange(): void {}
    }
}))

vi.mock('./utils/sdkToLogConverter', () => ({
    SDKToLogConverter: class {
        static resolvedWindow: number | undefined = undefined
        currentContextWindow(): number | undefined {
            return (this.constructor as { resolvedWindow?: number }).resolvedWindow
        }
        updateSessionId(): void {}
        resetParentChain(): void {}
        convert(): null { return null }
        convertSidechainUserMessage(): null { return null }
        updateSelectedModel(): void {}
        generateInterruptedToolResult(): null { return null }
    }
}))

vi.mock('./utils/OutgoingMessageQueue', () => ({
    OutgoingMessageQueue: class {
        releaseToolCall(): void {}
        enqueue(): void {}
        async flush(): Promise<void> {}
        destroy(): void {}
    }
}))

import { claudeRemoteLauncher } from './claudeRemoteLauncher'
import { Session } from './session'

function createClientStub() {
    const rpcHandlers = new Map<string, () => void | Promise<void>>()
    return {
        rpcHandlerManager: {
            registerHandler: (method: string, handler: () => void | Promise<void>) => {
                rpcHandlers.set(method, handler)
            }
        },
        rpcHandlers,
        keepAlive: () => {},
        updateMetadata: (mutator: (metadata: any) => any) => { mutator({}) },
        emitMessagesConsumed: () => {},
        sendClaudeSessionMessage: () => {},
        sendSessionEvent: (_event: unknown) => {},
        sendAgentMessage: vi.fn(),
        notePendingHubPromptEcho: () => {},
        discardPendingHubPromptEcho: () => {},
        discardPendingHubPromptEchoText: () => {}
    }
}

const RESUME_ARGS = ['--resume', 'original-session-id']

// claudeArgs is required rather than defaulted: passing `undefined` to a
// defaulted parameter would silently fall back to the default and hand the
// no-resume test a --resume flag it is supposed to be running without.
function createSession(
    client: ReturnType<typeof createClientStub>,
    claudeArgs: string[] | undefined,
    startedBy: 'runner' | 'terminal' = 'runner'
) {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode))
    const session = new Session({
        api: {} as any,
        client: client as any,
        path: '/tmp/test',
        logPath: '/tmp/test.log',
        sessionId: null,
        claudeEnvVars: {},
        claudeArgs,
        mcpServers: {},
        messageQueue: queue,
        onModeChange: () => {},
        allowedTools: [],
        mode: 'remote',
        startedBy,
        startingMode: 'remote',
        hookSettingsPath: '/tmp/hook.json',
        permissionMode: 'default'
    })
    return { session, queue }
}

describe('claudeRemoteLauncher resume anchor', () => {
    it('never submits an authoritatively cancelled staged Q and permits new R', async () => {
        const client = createClientStub()
        client.notePendingHubPromptEcho = vi.fn()
        const { session, queue } = createSession(client, undefined)
        session.recoveredRewindInput = {
            deliveredText: 'cancelled Q', items: [{ message: 'cancelled Q', localId: 'q' }],
            isolate: true, mode: { permissionMode: 'plan' }
        }
        queue.push('new R', { permissionMode: 'default' }, 'r')
        session.stageRewindInput = async ids => {
            if (ids[0] === 'q') {
                session.recoveredRewindInput = null
                return false
            }
            return true
        }
        const delivered: string[] = []
        harness.remoteImplementation = async opts => {
            const next = await opts.nextMessage()
            if (harness.callCount === 1) {
                if (next) delivered.push(next.message)
                return
            }
            delivered.push(next.message)
            await opts.onReady()
            void client.rpcHandlers.get(RPC_METHODS.Switch)?.()
        }
        try {
            await claudeRemoteLauncher(session as any)
            expect(delivered).toEqual(['new R'])
            expect(client.notePendingHubPromptEcho).not.toHaveBeenCalledWith('cancelled Q', ['q'])
            expect(queue.size()).toBe(0)
        } finally { session.stopKeepAlive() }
    })

    it('does not let a new R replace the staged Q owner after process recreation', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)
        session.recoveredRewindInput = {
            deliveredText: 'saved exact Q', items: [{ message: 'saved exact Q', localId: 'q' }],
            isolate: true, mode: { permissionMode: 'plan', model: 'haiku' }
        }
        queue.push('different R', { permissionMode: 'default' }, 'r')
        const delivered: string[] = []
        harness.remoteImplementation = async opts => {
            delivered.push((await opts.nextMessage()).message)
            void client.rpcHandlers.get(RPC_METHODS.Switch)?.()
        }
        try {
            await claudeRemoteLauncher(session as any)
            expect(delivered).toEqual(['saved exact Q'])
            expect(queue.peekByLocalId('r')?.message).toBe('different R')
        } finally { session.stopKeepAlive() }
    })

    it('restores exact staged Q before new R, waits for ownership ACK and preserves its mode', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)
        const saved = {
            deliveredText: '/skill expanded Q', items: [{ message: '$skill original Q', localId: 'q' }],
            isolate: true, mode: { permissionMode: 'plan' as const, model: 'haiku', effort: 'low' }
        }
        session.recoveredRewindInput = saved
        queue.push('$skill original Q', { permissionMode: 'default' }, 'q') // stale replay echo
        queue.push('new R', { permissionMode: 'default' }, 'r')
        let resolveAck!: () => void
        const ack = new Promise<void>(resolve => { resolveAck = resolve })
        session.stageRewindInput = async (ids, _text, delivery) => {
            if (ids[0] !== 'q') return true
            expect(delivery).toEqual(saved)
            await ack
            for (const id of ids) queue.cancelByLocalId(id)
            return true
        }
        const delivered: string[] = []
        harness.remoteImplementation = async opts => {
            if (harness.callCount === 1) {
                expect(opts.bootstrapMode).toEqual(saved.mode)
                let handedToSdk = false
                const first = opts.nextMessage().then((value: { message: string }) => { handedToSdk = true; return value })
                await new Promise(resolve => setTimeout(resolve, 10))
                expect(handedToSdk).toBe(false)
                resolveAck()
                delivered.push((await first).message)
                await opts.onReady()
                expect(await opts.nextMessage()).toBeNull() // R's different mode is parked
                return
            }
            delivered.push((await opts.nextMessage()).message)
            await opts.onReady()
            void client.rpcHandlers.get(RPC_METHODS.Switch)?.()
        }
        try {
            await claudeRemoteLauncher(session as any)
            expect(delivered).toEqual(['/skill expanded Q', 'new R'])
            expect(queue.size()).toBe(0)
        } finally { session.stopKeepAlive() }
    })

    it('does not confirm rewind from session discovery or ready without native proof', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, ['--resume-session-at', 'kept-boundary'])
        const ack = vi.fn()
        session.onRewindBranchApplied = async () => { ack() }
        session.rewindProof = () => false
        harness.compactContextTokens = 100
        harness.switchAfterCall = 1
        harness.triggerSwitch = () => { session.rewindProof = null; client.rpcHandlers.get(RPC_METHODS.Switch)?.() }
        queue.push('follow-up', { permissionMode: 'default' }, 'local-follow-up')
        try {
            await claudeRemoteLauncher(session as any)
            expect(ack).not.toHaveBeenCalled()
            expect(session.claudeArgs).toContain('kept-boundary')
        } finally { session.stopKeepAlive() }
    })

    afterEach(() => {
        harness.callCount = 0
        harness.claudeArgsPerCall = []
        harness.initialMessages = []
        harness.triggerSwitch = null
        harness.switchAfterCall = 2
        harness.compactContextTokens = null
        harness.remoteImplementation = null
        harness.compactSummary = null
        vi.clearAllMocks()
    })

    it('restores a later unaccepted batch after the rewound batch completed in the same attempt', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)
        const delivered: string[] = []
        session.onRewindBranchApplied = async () => {}
        queue.push('rewound input', { permissionMode: 'default' }, 'q1')
        harness.remoteImplementation = async opts => {
            if (harness.callCount === 1) {
                delivered.push((await opts.nextMessage()).message)
                await opts.onRewindBranchApplied()
                await opts.onReady()
                queue.push('later input', { permissionMode: 'default' }, 'q2')
                delivered.push((await opts.nextMessage()).message)
                throw new Error('stream failed before later input acceptance')
            }
            delivered.push(queue.size() > 0 ? (await opts.nextMessage()).message : 'missing later input')
            await opts.onReady()
            void client.rpcHandlers.get(RPC_METHODS.Switch)?.()
        }
        try {
            await claudeRemoteLauncher(session as any)
            expect(delivered).toEqual(['rewound input', 'later input', 'later input'])
            expect(queue.size()).toBe(0)
        } finally { session.stopKeepAlive() }
    })

    it.each([true, false])('checks exact native batch acceptance before poll on failure (accepted=%s)', async accepted => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)
        const ownership = vi.fn((ids: string[], text: string) => accepted && ids.join(',') === 'q1' && text === 'one input')
        session.isRewindInputAccepted = ownership
        session.stageRewindInput = vi.fn()
        queue.push('one input', { permissionMode: 'default' }, 'q1')
        harness.remoteImplementation = async opts => {
            if (harness.callCount === 1) {
                await opts.nextMessage()
                // Native write precedes this failure; no applied callback ran.
                throw new Error('stream failed before first proof tick')
            }
            void client.rpcHandlers.get(RPC_METHODS.Switch)?.()
        }
        try {
            await claudeRemoteLauncher(session as any)
            expect(session.stageRewindInput).toHaveBeenCalledWith(['q1'], 'one input', expect.objectContaining({
                deliveredText: 'one input', items: [{ message: 'one input', localId: 'q1' }],
                mode: { permissionMode: 'default' }
            }))
            expect(queue.size()).toBe(accepted ? 0 : 1)
        } finally { session.stopKeepAlive() }
    })

    it('blocks the shared terminal/RPC local-switch handler until pending rewind settles', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined, 'terminal')
        session.rewindProof = () => false
        queue.push('one input', { permissionMode: 'default' }, 'q1')
        harness.remoteImplementation = async opts => {
            await opts.nextMessage()
            await client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            expect(opts.signal.aborted).toBe(false)
            session.rewindProof = null
            void client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            expect(opts.signal.aborted).toBe(true)
        }
        try { expect(await claudeRemoteLauncher(session as any)).toBe('switch') }
        finally { session.stopKeepAlive() }
    })

    it('keeps --resume available for the launch that actually captures the session id', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, [...RESUME_ARGS])

        try {
            // Simulate the reopen-then-idle-then-/compact repro: an
            // isolate-triggering message is already queued before the very
            // first claudeRemote() attempt ever runs.
            queue.pushIsolateAndClear('/compact', { permissionMode: 'default' }, 'local-1')
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            expect(harness.callCount).toBe(2)

            // The first attempt bailed out before Claude ever spawned - it
            // must not have consumed the one-time --resume flag.
            // The second attempt is the one that actually captures the
            // session, and it must still see --resume in claudeArgs.
            expect(harness.claudeArgsPerCall[1]).toEqual(['--resume', 'original-session-id'])
            expect(session.sessionId).toBe('captured-session-id')
        } finally {
            session.stopKeepAlive()
        }
    })

    it('drops --resume when /clear discards the context before any launch reached Claude', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, [...RESUME_ARGS])

        try {
            // /clear is pushed as an isolate message exactly like /compact, so
            // it takes the same reopen-then-idle relaunch path. Unlike /compact
            // it must NOT keep the resume anchor alive: the user asked for the
            // context to be discarded, so the follow-up message has to start a
            // genuinely fresh Claude session rather than resume the cleared one.
            queue.pushIsolateAndClear('/clear', { permissionMode: 'default' }, 'local-1')
            queue.push('hello', { permissionMode: 'default' }, 'local-2')
            harness.switchAfterCall = 3
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            // 1st attempt: bails out (isolate message parked as pending).
            // 2nd attempt: runs /clear -> onSessionReset, still no spawn.
            // 3rd attempt: the follow-up message, which must start fresh.
            expect(harness.callCount).toBe(3)
            expect(harness.claudeArgsPerCall[2]).toBeUndefined()
            expect(session.claudeArgs).toBeUndefined()
        } finally {
            session.stopKeepAlive()
        }
    })

    it('regression: still consumes --resume once the very first attempt captures the session (no relaunch needed)', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, [...RESUME_ARGS])

        try {
            // Ordinary happy path: a normal (non-isolate) message is already
            // queued, so the very first claudeRemote() attempt captures the
            // session immediately - no relaunch/idle gap involved.
            queue.push('hello', { permissionMode: 'default' }, 'local-1')
            harness.switchAfterCall = 1
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            expect(harness.callCount).toBe(1)
            expect(harness.claudeArgsPerCall[0]).toEqual(['--resume', 'original-session-id'])
            expect(session.sessionId).toBe('captured-session-id')
            // The one-time flag must not linger once it has actually been
            // consumed by a launch that captured the session id.
            expect(session.claudeArgs).toBeUndefined()
        } finally {
            session.stopKeepAlive()
        }
    })

    it('regression: fresh spawn with no --resume flag is unaffected', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)

        try {
            queue.push('hello', { permissionMode: 'default' }, 'local-1')
            harness.switchAfterCall = 1
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            expect(harness.callCount).toBe(1)
            expect(harness.claudeArgsPerCall[0]).toBeUndefined()
            expect(session.sessionId).toBe('captured-session-id')
        } finally {
            session.stopKeepAlive()
        }
    })

    it('sends an advertised $skill through Claude native slash invocation', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)

        try {
            session.setNativeSkillNames(['hapi'])
            expect(session.expandSkillReference('$unknown inspect')).toBe('$unknown inspect')
            expect(session.expandSkillReference('ask $hapi')).toBe('ask $hapi')
            queue.push('$hapi inspect', { permissionMode: 'default' }, 'local-1')
            harness.switchAfterCall = 1
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            expect(harness.initialMessages).toEqual(['/hapi inspect'])
        } finally {
            session.stopKeepAlive()
        }
    })

    it('keeps an advertised $skill first when attachments are present', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)

        try {
            session.setNativeSkillNames(['hapi'])
            const prompt = session.expandSkillReference(
                '$hapi inspect',
                '@C:\\Users\\Jane Doe\\input.txt'
            )
            queue.push(prompt, { permissionMode: 'default' }, 'local-1')
            harness.switchAfterCall = 1
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            expect(harness.initialMessages).toEqual([
                '/hapi inspect\n\n@C:\\Users\\Jane Doe\\input.txt'
            ])
        } finally {
            session.stopKeepAlive()
        }
    })

    it('stamps the resolved context window on the post-compaction usage refresh', async () => {
        // The status bar replaces latestUsage wholesale, so a context-only
        // sample without a window would erase a known 1M denominator and
        // fall back to the default heuristic until the next real usage.
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)
        const { SDKToLogConverter } = await import('./utils/sdkToLogConverter')
        ;(SDKToLogConverter as unknown as { resolvedWindow?: number }).resolvedWindow = 1_000_000
        harness.compactContextTokens = 13_681

        try {
            queue.push('hi', { permissionMode: 'default' }, 'local-1')
            harness.switchAfterCall = 1
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            expect(client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'token_count',
                info: expect.objectContaining({
                    contextTokens: 13_681,
                    modelContextWindow: 1_000_000
                })
            }))
        } finally {
            session.stopKeepAlive()
            ;(SDKToLogConverter as unknown as { resolvedWindow?: number }).resolvedWindow = undefined
        }
    })
    it('publishes Claude post_tokens as exact tokensAfter rather than an estimate', async () => {
        const client = createClientStub();const sendEvent = vi.spyOn(client, 'sendSessionEvent')
        const { session, queue } = createSession(client, undefined)
        harness.compactSummary = { summary: 'native summary', tokensBefore: 34492, tokensAfter: 2082 }
        harness.switchAfterCall = 1
        harness.triggerSwitch = () => { client.rpcHandlers.get(RPC_METHODS.Switch)?.() }
        queue.push('hello', { permissionMode: 'default' }, 'compact-facts')
        try {
            await claudeRemoteLauncher(session as never)
            expect(sendEvent).toHaveBeenCalledWith({ type: 'compact-summary', summary: 'native summary', tokensBefore: 34492, tokensAfter: 2082 })
            expect(sendEvent.mock.calls.some(([event]) => 'estimatedTokensAfter' in (event as object))).toBe(false)
        } finally { session.stopKeepAlive() }
    })

})
