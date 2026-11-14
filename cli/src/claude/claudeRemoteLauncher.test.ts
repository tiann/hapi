import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { claudeBatchModeHash, type EnhancedMode } from './loop'

// These tests cover the one-time --resume flag's lifetime across the relaunch
// loop. The flag lives in session.claudeArgs and is the only resume anchor a
// remote Claude session has until Claude reports a session id back, so it must
// survive launch attempts that never reached Claude, and must be dropped both
// when it has been used and when the user explicitly discards the context.
const harness = vi.hoisted(() => ({
    callCount: 0,
    claudeArgsPerCall: [] as (string[] | undefined)[],
    bootstrapModePerCall: [] as unknown[],
    initialMessages: [] as string[],
    inputSubmittedCalls: [] as string[],
    metadataWrites: [] as Record<string, any>,
    metadata: {} as Record<string, any>,
    triggerSwitch: null as (() => void) | null,
    switchAfterCall: 2,
    afterFirstCall: null as (() => void) | null,
    afterSecondCall: null as (() => void) | null,
    promptlessCalls: [] as number[],
    promptlessSessionId: null as string | null,
    compactContextTokens: null as number | null,
    compactSummary: null as { summary: string; tokensBefore?: number; tokensAfter?: number } | null
}))

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: any) => {
        const { parseSpecialCommand } = await import('@/parsers/specialCommands')

        harness.callCount += 1
        harness.claudeArgsPerCall.push(opts.claudeArgs ? [...opts.claudeArgs] : opts.claudeArgs)
        harness.bootstrapModePerCall.push(opts.bootstrapMode)

        if (harness.promptlessCalls.includes(harness.callCount)) {
            // Model a resume-at respawn with an empty queue: query() starts
            // before any prompt exists and this attempt ends without ever
            // delivering a message.
            opts.onSessionFound(harness.promptlessSessionId ?? 'captured-session-id')
            if (harness.callCount === harness.switchAfterCall && harness.triggerSwitch) {
                harness.triggerSwitch()
            }
            return
        }

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
        // Mirrors the SDK echo of a submitted user message: the native prompt
        // uuid the transcript entry carries for this turn.
        const nativePromptUuid = `native-uuid-${harness.callCount}`
        opts.onInputSubmitted?.(nativePromptUuid)
        harness.inputSubmittedCalls.push(nativePromptUuid)

        if (harness.compactSummary !== null) await opts.onReady(undefined, harness.compactSummary)
        if (harness.compactContextTokens !== null) {
            // Mirrors claudeRemote()'s compact-completion onReady: no
            // completion event or summary, just the boundary's post-tokens.
            await opts.onReady(undefined, undefined, harness.compactContextTokens)
        }

        if (harness.callCount === 1 && harness.afterFirstCall) harness.afterFirstCall()
        if (harness.callCount === 2 && harness.afterSecondCall) harness.afterSecondCall()

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

// The intent-armed derivation reads the REAL native transcript for
// /tmp/test + captured-session-id: point CLAUDE_CONFIG_DIR at a temp root
// holding an UNPROVEN chain (the droppable turn still on it) so 'rearm' is
// deterministic and fixture-backed instead of relying on a missing file.
let configRoot: string | null = null
beforeAll(() => {
    configRoot = mkdtempSync(join(tmpdir(), 'hapi-rewind-launcher-'))
    const projectDir = join(configRoot, 'projects', '/tmp/test'.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'captured-session-id.jsonl'), [
        JSON.stringify({ type: 'user', uuid: 'uuid-1', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } }),
        JSON.stringify({ type: 'assistant', uuid: 'as-1', parentUuid: 'uuid-1', message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] } }),
        JSON.stringify({ type: 'user', uuid: 'uuid-2', parentUuid: 'as-1', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } }),
        JSON.stringify({ type: 'assistant', uuid: 'as-2', parentUuid: 'uuid-2', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } })
    ].join('\n') + '\n')
    process.env.CLAUDE_CONFIG_DIR = configRoot
})
afterAll(() => {
    if (configRoot) {
        if (process.env.CLAUDE_CONFIG_DIR === configRoot) delete process.env.CLAUDE_CONFIG_DIR
        rmSync(configRoot, { recursive: true, force: true })
    }
})

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
        getMetadata: () => harness.metadata,
        updateMetadata: (mutator: (metadata: any) => any) => {
            harness.metadataWrites.push(mutator({}))
        },
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
    claudeArgs: string[] | undefined
) {
    // The real queue hashes batches with claudeBatchModeHash (runClaude's
    // constructor); the launcher's resume-at spawn gate compares incoming
    // batches against the seeded spawn config with the same function.
    const queue = new MessageQueue2<EnhancedMode>(claudeBatchModeHash)
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
        startedBy: 'runner',
        startingMode: 'remote',
        hookSettingsPath: '/tmp/hook.json',
        permissionMode: 'default'
    })
    return { session, queue }
}

describe('claudeRemoteLauncher resume anchor', () => {
    afterEach(() => {
        harness.callCount = 0
        harness.claudeArgsPerCall = []
        harness.bootstrapModePerCall = []
        harness.initialMessages = []
        harness.inputSubmittedCalls = []
        harness.metadataWrites = []
        harness.metadata = {}
        harness.triggerSwitch = null
        harness.switchAfterCall = 2
        harness.afterFirstCall = null
        harness.afterSecondCall = null
        harness.promptlessCalls = []
        harness.promptlessSessionId = null
        harness.compactContextTokens = null
        harness.compactSummary = null
        vi.clearAllMocks()
    })

    it('publishes conversation history points and native entry ids for submitted user turns', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)
        harness.switchAfterCall = 1
        harness.triggerSwitch = () => {
            client.rpcHandlers.get(RPC_METHODS.Switch)?.()
        }

        try {
            queue.push('hello there', { permissionMode: 'default' }, 'local-1')

            await claudeRemoteLauncher(session as any)

            expect(harness.inputSubmittedCalls).toContain('native-uuid-1')
            const pointWrites = (harness.metadataWrites as Record<string, any>[]).filter(
                (metadata: Record<string, any>) => metadata.conversationHistoryPoints?.['local-1'] === true
            )
            expect(pointWrites.length).toBeGreaterThan(0)
            expect(pointWrites.at(-1)?.conversationHistoryEntryIds?.['local-1']).toBe('native-uuid-1')
        } finally {
            session.stopKeepAlive()
        }
    })

    it('delivers the queued prompt after a resume-at respawn truncates native history', async () => {
        const client = createClientStub()
        // The runner arms the one-shot boundary on the live session before the
        // restart (rewind); the respawned claudeRemote must start query()
        // immediately and deliver the queued message once init arrives.
        const { session, queue } = createSession(client, ['--resume', 'native-session-id', '--resume-session-at', 'keep-boundary-uuid'])
        harness.switchAfterCall = 1
        harness.triggerSwitch = () => {
            client.rpcHandlers.get(RPC_METHODS.Switch)?.()
        }

        try {
            queue.push('what was the last thing I asked you?', { permissionMode: 'default' }, 'local-1')

            await claudeRemoteLauncher(session as any)

            // The attempt started query() with the truncation flag and then
            // consumed the queued message as its first turn.
            expect(harness.initialMessages).toEqual(['what was the last thing I asked you?'])
            expect(harness.inputSubmittedCalls).toContain('native-uuid-1')
            const entryWrites = (harness.metadataWrites as Record<string, any>[]).filter(
                (metadata: Record<string, any>) => metadata.conversationHistoryEntryIds?.['local-1'] === 'native-uuid-1'
            )
            expect(entryWrites.length).toBeGreaterThan(0)
        } finally {
            session.stopKeepAlive()
        }
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

    it('cancels the pending rewind on /clear and stops deriving its boundary', async () => {
        const client = createClientStub()
        // The runner armed a rewind (durable intent in metadata); the user
        // then discards the context with /clear. The reset reports the
        // runner's onConversationReset, which cancels the durable intent -
        // the follow-up spawn's boundary derivation then sees no intent and
        // starts fresh, instead of resuming the cleared conversation.
        const { session, queue } = createSession(client, undefined)
        harness.metadata = {
            claudeRewind: {
                targetLocalId: 'local-1',
                truncateFromLocalId: 'local-1',
                keepBoundary: 'keep-boundary-uuid',
                droppedPrompts: ['uuid-1']
            }
        }
        const resetCancels: number[] = []
        ;(session as unknown as { onConversationReset?: () => void }).onConversationReset = () => {
            resetCancels.push(1)
            // Mirror the runner's cancelPendingRewind: the durable intent is
            // the boundary's single source of truth.
            delete harness.metadata.claudeRewind
        }

        try {
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
            expect(resetCancels).toHaveLength(1)
            expect(harness.claudeArgsPerCall[2] ?? []).not.toContain('--resume-session-at')
        } finally {
            session.stopKeepAlive()
        }
    })

    it('keeps the delivered launch configuration on a resume-at respawn', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)
        const configMode: EnhancedMode = {
            permissionMode: 'default',
            customSystemPrompt: 'CUSTOM SYSTEM PROMPT',
            appendSystemPrompt: 'APPENDED PROMPT',
            fallbackModel: 'fallback-model-x',
            allowedTools: ['Read'],
            disallowedTools: ['WebFetch', 'Bash']
        }
        // A config change arriving with a queued message: mode fields like
        // customSystemPrompt ride the message (runClaude's onUserMessage), so
        // the respawn seed must come from the batch that is about to be
        // delivered, not from the last delivered one.
        const changedMode: EnhancedMode = {
            permissionMode: 'default',
            customSystemPrompt: 'CHANGED SYSTEM PROMPT',
            appendSystemPrompt: 'CHANGED APPEND',
            fallbackModel: 'fallback-model-y',
            allowedTools: ['Grep'],
            disallowedTools: ['WebSearch']
        }

        try {
            queue.push('first prompt', { ...configMode }, 'local-1')
            harness.switchAfterCall = 3
            harness.promptlessCalls = [3]
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }
            // After the first delivery, the runner arms a rewind (durable
            // intent in metadata): the respawn is promptless (query() starts
            // before any prompt), so claudeRemote's first-mode overwrite
            // never runs and bootstrapMode is the entire launch
            // configuration. The session config also changed between
            // queueing and the respawn (e.g. SetSessionConfig while the
            // rewind restart was starting): the queued batch's own
            // permissionMode/model/effort must reach the spawn, because
            // awaitingResumeAtInit skips the first-message overwrite that
            // would normally reconcile them.
            harness.afterFirstCall = () => {
                harness.metadata = {
                    claudeRewind: {
                        targetLocalId: 'local-2',
                        truncateFromLocalId: 'local-2',
                        keepBoundary: 'boundary-1',
                        droppedPrompts: ['uuid-2']
                    }
                }
                session.setPermissionMode('plan')
                queue.push('second prompt', { ...changedMode }, 'local-2')
            }
            // After the second delivery, re-arm with an EMPTY queue: the
            // seed can only come from the last delivered mode.
            harness.afterSecondCall = () => {
                harness.metadata = {
                    claudeRewind: {
                        targetLocalId: 'local-2',
                        truncateFromLocalId: 'local-2',
                        keepBoundary: 'boundary-2',
                        droppedPrompts: ['uuid-2']
                    }
                }
            }

            await claudeRemoteLauncher(session as any)

            expect(harness.callCount).toBe(3)
            // Normal attempts are unchanged: the live getters seed the three
            // RPC-tracked fields and the first message's mode overwrites the
            // rest before the process spawns.
            expect(harness.bootstrapModePerCall[0]).toEqual({
                permissionMode: 'default',
                model: undefined,
                effort: undefined
            })
            // The queued config change must reach the spawn options.
            expect(harness.bootstrapModePerCall[1]).toMatchObject({
                permissionMode: 'default',
                customSystemPrompt: 'CHANGED SYSTEM PROMPT',
                appendSystemPrompt: 'CHANGED APPEND',
                fallbackModel: 'fallback-model-y',
                allowedTools: ['Grep'],
                disallowedTools: ['WebSearch']
            })
            // With the queue empty, the last delivered mode is the seed for
            // the process-affecting fields, while the live getters own the
            // three RPC-tracked fields (the session config changed to 'plan'
            // above and no queued batch carries the older values).
            expect(harness.bootstrapModePerCall[2]).toMatchObject({
                permissionMode: 'plan',
                customSystemPrompt: 'CHANGED SYSTEM PROMPT',
                fallbackModel: 'fallback-model-y',
                disallowedTools: ['WebSearch']
            })
        } finally {
            session.stopKeepAlive()
        }
    })

    it('compares the first arriving batch against the spawned resume-at config', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)
        const changedMode: EnhancedMode = {
            permissionMode: 'default',
            customSystemPrompt: 'CHANGED SYSTEM PROMPT',
            disallowedTools: ['WebSearch']
        }

        try {
            harness.switchAfterCall = 2
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }
            // The rewind respawns with an EMPTY queue: the spawn can only seed
            // from the live getters. The user's prompt arrives after the spawn
            // with a config that needs a different process. The runner arms
            // the rewind as the durable intent.
            harness.metadata = {
                claudeRewind: {
                    targetLocalId: 'local-1',
                    truncateFromLocalId: 'local-1',
                    keepBoundary: 'boundary-1',
                    droppedPrompts: ['uuid-1']
                }
            }
            session.sessionId = 'captured-session-id'
            const run = claudeRemoteLauncher(session as any)
            await vi.waitFor(() => expect(harness.callCount).toBe(1))
            queue.push('new prompt', { ...changedMode }, 'local-2')
            // A different process key: collectBatch must not merge it into the
            // first batch, and the mode gate keeps the flow terminating.
            queue.push('follow-up', { permissionMode: 'default', customSystemPrompt: 'FOLLOW-UP PROMPT' }, 'local-3')
            await run

            // The prompt must have been delivered by the attempt whose spawn
            // options carry its own config - not handed straight into the
            // pre-arrival spawn that was seeded with the stale getters.
            const firstDeliveryCall = Number(harness.inputSubmittedCalls[0]!.replace('native-uuid-', ''))
            expect(firstDeliveryCall).toBe(2)
            expect(harness.bootstrapModePerCall[firstDeliveryCall - 1]).toMatchObject({
                permissionMode: 'default',
                customSystemPrompt: 'CHANGED SYSTEM PROMPT',
                disallowedTools: ['WebSearch']
            })
        } finally {
            session.stopKeepAlive()
        }
    })

    it('stops applying the fork boundary once the child session materializes', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, ['--resume', 'source-id', '--fork-session', '--resume-session-at', 'fork-boundary'])
        harness.metadata = {}

        try {
            harness.switchAfterCall = 2
            harness.promptlessCalls = [1]
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }
            queue.push('child prompt', { permissionMode: 'default' }, 'local-1')

            await claudeRemoteLauncher(session as any)

            expect(harness.callCount).toBe(2)
            // Attempt 1: the child has not materialized (sessionId null) and
            // the fork boundary applies. Attempt 1 ends right after init.
            expect(harness.claudeArgsPerCall[0]).toContain('--resume-session-at')
            // Attempt 2: the child exists (sessionId captured, --fork-session
            // consumed) - the boundary must be gone, or every later respawn
            // of this fork child would truncate the post-fork turns.
            expect(harness.claudeArgsPerCall[1] ?? []).not.toContain('--resume-session-at')
        } finally {
            session.stopKeepAlive()
        }
    })

    it('re-derives the rewind boundary from the durable intent on every attempt', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)
        harness.metadata = {
            claudeRewind: {
                targetLocalId: 'local-1',
                truncateFromLocalId: 'local-1',
                keepBoundary: 'keep-boundary-uuid',
                droppedPrompts: ['uuid-1']
            }
        }
        session.sessionId = 'captured-session-id'

        try {
            harness.switchAfterCall = 2
            harness.promptlessCalls = [1]
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }
            queue.push('first prompt after rewind', { permissionMode: 'default' }, 'local-1')

            await claudeRemoteLauncher(session as any)

            expect(harness.callCount).toBe(2)
            // The boundary comes from the durable intent, not from a mutated
            // claudeArgs buffer: both attempts derive it fresh while the
            // intent is unproven, so a post-init retry still truncates.
            expect(harness.claudeArgsPerCall[0]).toContain('--resume-session-at')
            expect(harness.claudeArgsPerCall[1]).toContain('--resume-session-at')
            expect(harness.claudeArgsPerCall[1]).toContain('keep-boundary-uuid')
        } finally {
            session.stopKeepAlive()
        }
    })

    it('does not apply a stale boundary flag left on claudeArgs after the rewind settled', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, ['--resume', 'native-a', '--resume-session-at', 'stale-boundary'])
        harness.metadata = {}
        session.sessionId = 'native-a'

        try {
            harness.switchAfterCall = 1
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }
            queue.push('next prompt', { permissionMode: 'default' }, 'local-1')

            await claudeRemoteLauncher(session as any)

            // No intent: the spawn args must carry no boundary even though a
            // stale one sits on claudeArgs - and --resume must survive the
            // filter (only boundary flags are stripped).
            expect(harness.claudeArgsPerCall[0]).not.toContain('--resume-session-at')
            expect(harness.claudeArgsPerCall[0]).toContain('--resume')
        } finally {
            session.stopKeepAlive()
        }
    })

    it('keeps the fork boundary when a SessionStart hook bound the id before the transcript exists', async () => {
        // Major 1 (r6): the remote SessionStart:fork hook binds
        // session.sessionId before system/init consumes the one-shot flags. An
        // attempt that exits at the hook_response unlock (mode mismatch,
        // parked isolate head, abort) leaves the id bound with no child
        // transcript on disk; the next attempt must still truncate, or it
        // re-forks the source untruncated / double-forks the bound child.
        const client = createClientStub()
        const { session, queue } = createSession(client, ['--resume', 'source-id', '--fork-session', '--resume-session-at', 'fork-boundary'])
        harness.metadata = {}
        // Simulate the hook-path bind: id captured, flags NOT consumed, no
        // transcript on disk for this id.
        session.sessionId = 'bound-child-sess'

        try {
            harness.switchAfterCall = 1
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }
            queue.push('child prompt', { permissionMode: 'default' }, 'local-1')

            await claudeRemoteLauncher(session as any)

            // The hook bound the id, but no child transcript exists: the fork
            // is not materialized, so the boundary AND the fork flag must
            // survive into the spawn args.
            expect(harness.claudeArgsPerCall[0]).toContain('--resume-session-at')
            expect(harness.claudeArgsPerCall[0]).toContain('--fork-session')
        } finally {
            session.stopKeepAlive()
        }
    })

    it('does not consume one-shot fork flags in onSessionFound before the child transcript materializes on disk', async () => {
        const client = createClientStub()
        const forkArgs = ['--resume', 'source-id', '--fork-session', '--resume-session-at', 'fork-boundary']
        const { session, queue } = createSession(client, [...forkArgs])
        harness.metadata = {}

        try {
            harness.switchAfterCall = 2
            harness.promptlessCalls = [1]
            harness.promptlessSessionId = 'unmaterialized-child-sess'
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }
            queue.push('child prompt', { permissionMode: 'default' }, 'local-1')

            await claudeRemoteLauncher(session as any)

            expect(harness.callCount).toBe(2)
            expect(harness.claudeArgsPerCall[0]).toEqual(forkArgs)
            expect(harness.claudeArgsPerCall[1]).toEqual(forkArgs)
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
