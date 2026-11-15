import { beforeEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { logger } from '@/ui/logger'
import { Session } from './session'
import { runClaude } from './runClaude'
import { deriveSpawnArgs } from './conversationHistory'
import type { EnhancedMode } from './loop'

// Regression for the second-rewind deadlock: settling the first rewind used to
// detach the proof notification (onNativeInputSubmitted = null), but the
// handler is installed once per wrapper lifetime in onSessionReady (the
// launcher reuses the same Session across respawns), so a SECOND rewind in the
// same wrapper never received its native proof: claudeRewind stayed set in
// metadata and history actions stayed blocked until restart. The proof handler
// must survive settlement and be (re)armed with each rewind.
const harness = vi.hoisted(() => {
    const state = { metadata: {} as any, agentState: {} as any }
    const rpcHandlers = new Map<string, (payload: any) => any>()
    const sessionStub: any = {
        rpcHandlerManager: {
            registerHandler: (method: string, handler: any) => { rpcHandlers.set(method, handler) }
        },
        updateMetadata: (mutator: any, options?: { signal?: AbortSignal }) => {
            harness.metadataMutators.push(mutator)
            harness.metadataWriteSignals.push(options?.signal)
            if (options?.signal?.aborted) return
            if (harness.deferUnflushedMetadata) {
                harness.queuedMutators.push(mutator)
                return
            }
            const next = mutator(state.metadata)
            if (next != null) state.metadata = next
        },
        updateAgentState: (mutator: any) => {
            const next = mutator(state.agentState)
            if (next !== undefined) state.agentState = next
        },
        getMetadata: () => state.metadata,
        flushMetadata: async (timeoutMs?: number) => {
            harness.flushTimeouts.push(timeoutMs ?? 0)
            return harness.flushResult ?? true
        },
        refreshMetadata: async () => {
            harness.refreshCalls += 1
            if (harness.refreshImpl) {
                return await harness.refreshImpl()
            }
            if (harness.refreshResult === false) return false
            if (harness.hubMetadata !== undefined) {
                state.metadata = structuredClone(harness.hubMetadata)
            }
            return true
        },
        onReconnect: (handler: ((metadataRefreshed?: boolean) => void) | null) => {
            harness.reconnectHandler = handler
        },
        keepAlive: () => {},
        sendSessionEvent: () => {},
        sendAgentMessage: () => {},
        sendClaudeSessionMessage: () => {},
        sendSessionDeath: () => {},
        flush: async () => true,
        close: async () => {},
        emitMessagesConsumed: () => {},
        notePendingHubPromptEcho: () => {},
        discardPendingHubPromptEcho: () => {},
        discardPendingHubPromptEchoText: () => {},
        onUserMessage: (handler: any) => { harness.userMessageHandler = handler },
        onCancelQueuedMessage: (handler: any) => { harness.cancelQueuedMessageHandler = handler }
    }
    return {
        state,
        rpcHandlers,
        sessionStub,
        loopOpts: null as any,
        loopImpl: null as ((opts: any) => Promise<void>) | null,
        runError: null as unknown,
        hookHandlers: null as any,
        flushResult: null as boolean | null,
        flushTimeouts: [] as number[],
        metadataMutators: [] as Array<(metadata: any) => any>,
        metadataWriteSignals: [] as Array<AbortSignal | undefined>,
        queuedMutators: [] as Array<(metadata: any) => any>,
        deferUnflushedMetadata: false,
        hubMetadata: undefined as any,
        refreshResult: true,
        refreshImpl: null as (() => Promise<boolean>) | null,
        refreshCalls: 0,
        reconnectHandler: null as ((metadataRefreshed?: boolean) => void) | null,
        userMessageHandler: null as ((message: any, localId?: string) => void) | null,
        cancelQueuedMessageHandler: null as ((localId: string) => boolean) | null,
        nativeTurns: null as Array<{ promptUuid: string; endUuid: string }> | null
    }
})

vi.mock('@/agent/sessionFactory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agent/sessionFactory')>()
    return {
        ...actual,
        bootstrapSession: async () => ({
            api: {},
            session: harness.sessionStub,
            sessionInfo: { id: 'hapi-rewind-test', metadata: {} }
        }),
        bootstrapExistingSession: async () => ({
            api: {},
            session: harness.sessionStub,
            sessionInfo: { id: 'hapi-rewind-test', metadata: {} }
        })
    }
})

vi.mock('@/claude/loop', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/claude/loop')>()
    return {
        ...actual,
        loop: async (opts: any) => {
            harness.loopOpts = opts
            if (harness.loopImpl) {
                return await harness.loopImpl(opts)
            }
            // The real loop runs for the session's lifetime; the test drives
            // onSessionReady and the history RPCs directly.
            return new Promise(() => {})
        }
    }
})

vi.mock('./conversationHistory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./conversationHistory')>()
    return {
        ...actual,
        // The RPC-side turn lookup sees a coherent two-turn conversation, so
        // the rewind plan computes real droppedPrompts; the native branch
        // proof is granted immediately, so the settle path runs synchronously
        // inside the notification.
        nativeRewindApplied: () => true,
        claudeConversationHistoryCapabilities: () => ({ forkCurrent: true, forkAtMessage: true, rewindToMessage: true }),
        resolveRewindPlan: () => ({ resumeSessionAt: 'keep-boundary-uuid' }),
        readNativeTurns: () => harness.nativeTurns ?? [
            { promptUuid: 'uuid-1', endUuid: 'as-1' },
            { promptUuid: 'uuid-2', endUuid: 'as-2' }
        ]
    }
})

// The spawn-derivation contract assertions call the REAL readNativeTurns
// (module-internal) against /tmp/hapi-rewind-test: point CLAUDE_CONFIG_DIR at
// a temp root holding an UNPROVEN native-a transcript (both droppable turns
// still on the active chain) so 'rearm' is deterministic and fixture-backed.
let configRoot: string | null = null
beforeAll(() => {
    configRoot = mkdtempSync(join(tmpdir(), 'hapi-rewind-runner-'))
    const projectDir = join(configRoot, 'projects', '/tmp/hapi-rewind-test'.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'native-a.jsonl'), [
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

vi.mock('@/claude/utils/startHappyServer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/claude/utils/startHappyServer')>()
    return {
        ...actual,
        startHappyServer: async () => ({ url: 'http://127.0.0.1:3999', toolNames: [], stop: async () => {} }),
        toClaudeAllowedHapiMcpTools: (names: string[]) => names
    }
})

vi.mock('@/claude/utils/startHookServer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/claude/utils/startHookServer')>()
    return {
        ...actual,
        startHookServer: async (handlers: any) => {
            harness.hookHandlers = handlers
            return { port: 3999, token: 'test-token', stop: async () => {} }
        }
    }
})

vi.mock('@/modules/common/hooks/generateHookSettings', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/modules/common/hooks/generateHookSettings')>()
    return {
        ...actual,
        generateHookSettingsFile: () => '/tmp/hapi-rewind-test-hook-settings.json',
        cleanupHookSettingsFile: () => {}
    }
})

vi.mock('@/claude/sdk/metadataExtractor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/claude/sdk/metadataExtractor')>()
    return {
        ...actual,
        // The real extractor spawns the claude binary; the catalog result is
        // irrelevant here.
        extractSDKMetadata: async () => ({ slashCommands: undefined })
    }
})

vi.mock('./sdk/utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./sdk/utils')>()
    return {
        ...actual,
        // Keep the --version probe failing fast instead of spawning a binary.
        getDefaultClaudeCodePath: () => '/usr/bin/claude'
    }
})

function createRunnerSession(mode: 'local' | 'remote' = 'remote'): Session {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode))
    return new Session({
        api: {} as any,
        client: harness.sessionStub,
        path: '/tmp/hapi-rewind-test',
        logPath: '/tmp/hapi-rewind-test.log',
        sessionId: null,
        claudeEnvVars: {},
        claudeArgs: ['--resume', 'native-a'],
        mcpServers: {},
        messageQueue: queue,
        onModeChange: () => {},
        allowedTools: [],
        mode,
        startedBy: 'runner',
        startingMode: mode,
        hookSettingsPath: '/tmp/hapi-rewind-test-hook-settings.json',
        permissionMode: 'default'
    })
}

describe('runClaude rewind proof lifetime', () => {
    // The session stub's metadata/agentState objects are shared across tests
    // (bootstrapSession returns the same stub); leftovers like a persisted
    // claudeRewind intent or claudeSessionId would leak into the next test's
    // runClaude start (reconcilePendingRewind reads them) and change its
    // behavior. Start each test with clean hub state.
    beforeEach(() => {
        harness.state.metadata = {}
        harness.state.agentState = {}
        harness.metadataMutators = []
        harness.metadataWriteSignals = []
        harness.queuedMutators = []
        harness.deferUnflushedMetadata = false
        harness.hubMetadata = undefined
        harness.refreshResult = true
        harness.refreshImpl = null
        harness.refreshCalls = 0
        harness.reconnectHandler = null
        harness.userMessageHandler = null
        harness.cancelQueuedMessageHandler = null
        harness.flushTimeouts = []
        harness.nativeTurns = null
        harness.loopImpl = null
        harness.runError = null
    })

    // Each test starts its own runClaude() while the previous instance is
    // still alive (the loop mock never resolves), so the shared harness slots
    // must be waited on by IDENTITY: a truthy loopOpts alone would satisfy the
    // wait with the previous instance's registrations and drive a stale
    // closure set.
    async function waitForFreshRunner(prev: { loopOpts: unknown; rewind: unknown; hooks: unknown }) {
        await vi.waitFor(() => {
            if (harness.runError) throw harness.runError
            expect(harness.loopOpts).toBeTruthy()
            expect(harness.loopOpts).not.toBe(prev.loopOpts)
            expect(harness.rpcHandlers.get(RPC_METHODS.RewindConversation)).not.toBe(prev.rewind)
            expect(harness.hookHandlers).not.toBe(prev.hooks)
        }, { timeout: 10_000, interval: 25 })
    }

    function snapshotRunner() {
        return {
            loopOpts: harness.loopOpts,
            rewind: harness.rpcHandlers.get(RPC_METHODS.RewindConversation),
            hooks: harness.hookHandlers
        }
    }

    it('settles a second rewind in the same wrapper lifetime', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        sessionInstance.requestRemoteRestart = async () => {}
        try {
            harness.loopOpts.onSessionReady(sessionInstance)

            // Native history points recorded by the launcher in hub metadata.
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1', 'local-2': 'uuid-2' }
            }))

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(rewind).toBeDefined()

            // First rewind: arm, restart, prove, settle.
            const first = await rewind({ messageLocalId: 'local-1' })
            expect(first).toMatchObject({ success: true })
            expect(harness.state.metadata.claudeRewind).toMatchObject({ keepBoundary: 'keep-boundary-uuid' })
            // The boundary is derived at spawn time from the durable intent;
            // claudeArgs is never mutated by the rewind.
            expect(sessionInstance.claudeArgs).toEqual(['--resume', 'native-a'])
            expect(deriveSpawnArgs({
                claudeArgs: sessionInstance.claudeArgs,
                sessionId: sessionInstance.sessionId,
                intent: harness.state.metadata.claudeRewind,
                workingDirectory: '/tmp/hapi-rewind-test'
            }).boundary).toBe('keep-boundary-uuid')

            sessionInstance.onNativeInputSubmitted?.('uuid-1')
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
            expect(sessionInstance.claudeArgs).toEqual(['--resume', 'native-a'])

            // Second rewind in the SAME wrapper lifetime: the proof handler
            // must be alive again so this intent settles too.
            const second = await rewind({ messageLocalId: 'local-2' })
            expect(second).toMatchObject({ success: true })
            expect(harness.state.metadata.claudeRewind).toMatchObject({ keepBoundary: 'keep-boundary-uuid' })

            sessionInstance.onNativeInputSubmitted?.('uuid-2')
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
            expect(sessionInstance.claudeArgs).toEqual(['--resume', 'native-a'])
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('cancels a pending rewind when the launcher resets the session', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        sessionInstance.requestRemoteRestart = async () => {}
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({ success: true })
            expect(harness.state.metadata.claudeRewind).toMatchObject({ keepBoundary: 'keep-boundary-uuid' })

            // /clear: the launcher consumes the one-shot flags, then reports
            // the reset. A rewind pointing into the discarded conversation can
            // never be proven, so the durable intent must be cancelled instead
            // of blocking fork/rewind forever.
            sessionInstance.consumeOneTimeFlags()
            sessionInstance.onConversationReset?.()
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
            // The reset also takes the boundary flag off claudeArgs - via the
            // launcher's explicit strip and the cancel below - so the next
            // launch starts fresh instead of resuming a discarded conversation.
            expect(sessionInstance.claudeArgs).toBeUndefined()

            // A rewind AFTER the clear (before any new prompt) must be rejected: the
            // live session has no native session id and no --resume anchor left
            // on claudeArgs, so the respawn could not apply a boundary anyway.
            // Falling back to the stale metadata.claudeSessionId would persist a
            // fresh intent, truncate the hub transcript, and then throw
            // 'Pending resume-at request has no native session to resume' on
            // every respawn - an infinite respawn loop with a truncated hub.
            sessionInstance.clearSessionId()
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                claudeSessionId: 'native-a'
            }))
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('settles a pending rewind when a prompt is submitted locally', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'local'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession('local')
        sessionInstance.sessionId = 'native-a'
        sessionInstance.requestRemoteRestart = async () => {}
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({ success: true })
            expect(harness.state.metadata.claudeRewind).toMatchObject({ keepBoundary: 'keep-boundary-uuid' })
            // The boundary is derived at spawn time from the durable intent;
            // claudeArgs is never mutated by the rewind.
            expect(sessionInstance.claudeArgs).toEqual(['--resume', 'native-a'])
            expect(deriveSpawnArgs({
                claudeArgs: sessionInstance.claudeArgs,
                sessionId: sessionInstance.sessionId,
                intent: harness.state.metadata.claudeRewind,
                workingDirectory: '/tmp/hapi-rewind-test'
            }).boundary).toBe('keep-boundary-uuid')

            // A prompt entered in the local TUI re-parents onto the kept
            // boundary exactly like a remote one. The remote launcher's
            // onInputSubmitted never fires in local mode - the local settings
            // file's UserPromptSubmit hook is the only signal - so it must
            // settle the durable intent and consume the boundary flags too,
            // or the intent stays pending forever and a later remote relaunch
            // re-applies the stale boundary over the local turns.
            harness.hookHandlers.onSessionHook('native-a', {
                hook_event_name: 'UserPromptSubmit',
                session_id: 'native-a'
            })

            expect(harness.state.metadata.claudeRewind).toBeUndefined()
            expect(sessionInstance.claudeArgs).toEqual(['--resume', 'native-a'])
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('cancels a pending rewind when a local SessionStart rotates the session', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'local'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession('local')
        sessionInstance.sessionId = 'native-a'
        sessionInstance.requestRemoteRestart = async () => {}
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({ success: true })
            expect(harness.state.metadata.claudeRewind).toMatchObject({ keepBoundary: 'keep-boundary-uuid' })
            // The boundary is derived at spawn time from the durable intent;
            // claudeArgs is never mutated by the rewind.
            expect(sessionInstance.claudeArgs).toEqual(['--resume', 'native-a'])
            expect(deriveSpawnArgs({
                claudeArgs: sessionInstance.claudeArgs,
                sessionId: sessionInstance.sessionId,
                intent: harness.state.metadata.claudeRewind,
                workingDirectory: '/tmp/hapi-rewind-test'
            }).boundary).toBe('keep-boundary-uuid')

            // Local /clear: the TUI ends the native session and the next
            // prompt starts a new one; the SessionStart hook reports the
            // rotation with source 'clear'. Like the remote onSessionReset
            // path, the reset must cancel the durable intent and strip the
            // boundary flags - the cleared session can never prove them, and
            // a later reconcile would re-arm the stale boundary onto the
            // fresh, empty session.
            harness.hookHandlers.onSessionHook('native-b', {
                hook_event_name: 'SessionStart',
                session_id: 'native-b',
                source: 'clear'
            })

            expect(sessionInstance.sessionId).toBe('native-b')
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
            // The rotation consumed the one-shot flags with the conversation
            // (the remote onSessionReset twin): the next local spawn must not
            // resume the cleared session through the stale --resume anchor.
            expect(sessionInstance.claudeArgs).toBeUndefined()

            // A non-clear rotation (genuine resume, startup attach) must keep
            // a pending intent: the rewind re-arm flow itself surfaces as a
            // SessionStart on the respawned process.
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({ success: true })
            harness.hookHandlers.onSessionHook('native-c', {
                hook_event_name: 'SessionStart',
                session_id: 'native-c',
                source: 'resume'
            })
            expect(harness.state.metadata.claudeRewind).toMatchObject({ keepBoundary: 'keep-boundary-uuid' })
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('cancels the queued intent write instead of deleting when the metadata flush fails', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        const restartSpy = vi.fn(async () => {})
        sessionInstance.requestRemoteRestart = restartSpy
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false
            const mutatorsBefore = harness.metadataMutators.length

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })
            // No intent armed locally and no restart; also no deletion write
            // queued behind the failed flush (which could clobber a hub-side
            // intent that landed before the lost reply).
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
            expect(restartSpy).not.toHaveBeenCalled()
            expect(harness.metadataMutators.slice(mutatorsBefore)).toHaveLength(1)
        } finally {
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            sessionInstance.stopKeepAlive()
        }
    })

    it('aborts the queued metadata write signal after a flush failure without deleting hub intent', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        sessionInstance.requestRemoteRestart = async () => {}
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false
            const mutatorsBefore = harness.metadataMutators.length

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })
            expect(harness.state.metadata.claudeRewind).toBeUndefined()

            // apiSession skips retrying once the write's AbortSignal is aborted.
            // No deletion mutator is queued behind it.
            const newMutators = harness.metadataMutators.slice(mutatorsBefore)
            expect(newMutators).toHaveLength(1)
            const writeSignal = harness.metadataWriteSignals.slice(mutatorsBefore)[0]
            expect(writeSignal?.aborted).toBe(true)
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
        } finally {
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            sessionInstance.stopKeepAlive()
        }
    })

    it('rolls back before persisting when the session cannot restart', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        sessionInstance.requestRemoteRestart = null as unknown as () => Promise<void>
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected',
                error: 'Claude session is not ready for a rewind restart'
            })
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('re-arms a preserved rewind intent when a wrapper restarts', { timeout: 20_000 }, async () => {
        // The hub truncated at rewind-RPC success, then the wrapper died
        // before the native branch applied: the reopened session must
        // reconcile the preserved intent (sessionFactory keeps claudeRewind;
        // this pins the runClaude half) and arm the boundary on the first
        // attached session.
        harness.sessionStub.updateMetadata((metadata: any) => ({
            ...metadata,
            claudeSessionId: 'native-a',
            claudeRewind: {
                targetLocalId: 'local-1',
                truncateFromLocalId: 'local-1',
                keepBoundary: 'keep-boundary-uuid',
                droppedPrompts: ['uuid-1']
            },
            conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
        }))
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.requestRemoteRestart = async () => {}
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            // The boundary is derived at spawn time from the durable intent;
            // claudeArgs is never mutated by the rewind.
            expect(sessionInstance.claudeArgs).toEqual(['--resume', 'native-a'])
            expect(deriveSpawnArgs({
                claudeArgs: sessionInstance.claudeArgs,
                sessionId: sessionInstance.sessionId,
                intent: harness.state.metadata.claudeRewind,
                workingDirectory: '/tmp/hapi-rewind-test'
            }).boundary).toBe('keep-boundary-uuid')
            // The intent stays armed until a prompt proves the native branch.
            expect(harness.state.metadata.claudeRewind).toMatchObject({ keepBoundary: 'keep-boundary-uuid' })
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('commits the rewind cancellation before the rotated session id', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'local'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession('local')
        sessionInstance.sessionId = 'native-a'
        sessionInstance.requestRemoteRestart = async () => {}
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({ success: true })

            // Crash-window ordering on a local /clear: the rotation commits
            // the new claudeSessionId and cancels the intent in two metadata
            // writes. If the process dies between them, the hub must never
            // hold {claudeSessionId: <cleared session>, claudeRewind: intent}
            // - reconcile would re-arm the stale boundary onto the freshly
            // cleared, empty session. The deletion therefore queues BEFORE
            // the id commit.
            const mutatorCountBefore = harness.metadataMutators.length
            harness.hookHandlers.onSessionHook('native-b', {
                hook_event_name: 'SessionStart',
                session_id: 'native-b',
                source: 'clear'
            })
            const newMutators = harness.metadataMutators.slice(mutatorCountBefore)
            const keepsRewind = (mutator: (metadata: any) => any) => {
                const result = mutator({ claudeRewind: { keepBoundary: 'k' } }) ?? {}
                return 'claudeRewind' in result
            }
            const deletionIndex = newMutators.findIndex((mutator) => !keepsRewind(mutator))
            const sessionIdIndex = newMutators.findIndex((mutator) => {
                const result = mutator({}) ?? {}
                return result.claudeSessionId === 'native-b'
            })
            expect(deletionIndex).toBeGreaterThanOrEqual(0)
            expect(sessionIdIndex).toBeGreaterThanOrEqual(0)
            expect(deletionIndex).toBeLessThan(sessionIdIndex)
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('gives the rewind persist a hub-visible congestion budget before rejecting', { timeout: 20_000 }, async () => {
        // Major 2 (r6): flushMetadata() default-drains for 5s. A congested
        // socket that delivers the intent write just after that window makes
        // the CLI roll the intent back while the hub's lost-RPC fallback sees
        // it and truncates - hub truncated, native untruncated, intent gone.
        // The persist wait must exceed the transient congestion window (the
        // hub RPC allows 120s), so the common congestion case commits instead
        // of rejecting into the ambiguous state.
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        sessionInstance.requestRemoteRestart = async () => {}
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-2': 'uuid-2' }
            }))

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-2' })).toMatchObject({ success: true })
            expect(harness.flushTimeouts[0]).toBeGreaterThanOrEqual(30_000)
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('re-checks the branch proof when the turn completes', { timeout: 20_000 }, async () => {
        // Minor 2 (r6): the post-submit proof poll gives up after 5s. If the
        // transcript write lands later, the intent stays armed and blocks
        // rewind/fork until another turn or a restart. A turn-completion
        // signal must re-run the proof.
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        sessionInstance.requestRemoteRestart = async () => {}
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1', 'local-2': 'uuid-2' }
            }))

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-2' })).toMatchObject({ success: true })
            expect(harness.state.metadata.claudeRewind).toMatchObject({ keepBoundary: 'keep-boundary-uuid' })

            // No prompt submit ever arrives (the proof poll never ran); the
            // turn completes -> thinking false -> the re-check proves and
            // settles the rewind.
            sessionInstance.onThinkingChange(false)
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('refuses to fork when the live session has no native conversation', { timeout: 20_000 }, async () => {
        // Minor 3 (r6): after a /clear the live session has neither a bound id
        // nor a --resume anchor, but hub metadata still carries the discarded
        // claudeSessionId. ForkConversation must match RewindConversation's
        // live-session guard instead of forking the discarded conversation.
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        // Post-/clear live state: id cleared, one-shot flags consumed.
        sessionInstance.sessionId = null as unknown as string
        sessionInstance.claudeArgs = undefined
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                claudeSessionId: 'stale-old-sess',
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            const fork = harness.rpcHandlers.get(RPC_METHODS.ForkConversation)!
            await expect(fork({ messageLocalId: 'local-1' })).rejects.toThrow(/no active native session/i)
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('clears a stale metadata intent when the reset fires without a live pending rewind', { timeout: 20_000 }, async () => {
        // Minor 5 (r6): cancelPendingRewind early-returns when pendingRewind
        // is null, so an intent that reached metadata without a live pending
        // state (e.g. left by a rejected rewind's flush window) survives a
        // /clear and blocks history actions until a restart.
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            // Simulate an intent that reached metadata without a live pending
            // rewind (rejected-rewind flush window).
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                claudeRewind: {
                    targetLocalId: 'local-2',
                    truncateFromLocalId: 'local-2',
                    keepBoundary: 'keep-boundary-uuid',
                    droppedPrompts: ['uuid-2']
                }
            }))
            expect(harness.state.metadata.claudeRewind).toBeTruthy()

            sessionInstance.onConversationReset?.()
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('clears a stale rewind intent on startup when the native transcript is missing or empty', { timeout: 20_000 }, async () => {
        harness.nativeTurns = []
        harness.sessionStub.updateMetadata((metadata: any) => ({
            ...metadata,
            claudeSessionId: 'missing-native-session',
            claudeRewind: {
                targetLocalId: 'local-1',
                truncateFromLocalId: 'local-1',
                keepBoundary: 'keep-boundary-uuid',
                droppedPrompts: ['uuid-1']
            }
        }))
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        expect(harness.state.metadata.claudeRewind).toBeUndefined()
    })

    it('arms the rewind after reconnect when flush fails but the intent landed on the hub and the rejected reply was lost', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        const restartSpy = vi.fn(async () => {})
        sessionInstance.requestRemoteRestart = restartSpy
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1', 'local-2': 'uuid-2' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false
            const mutatorsBefore = harness.metadataMutators.length

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })

            // No local intent armed and no restart yet.
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
            expect(restartSpy).not.toHaveBeenCalled()

            // Only the intent write was queued; no deletion write was queued on failure.
            const newMutators = harness.metadataMutators.slice(mutatorsBefore)
            expect(newMutators).toHaveLength(1)
            const writeSignal = harness.metadataWriteSignals.slice(mutatorsBefore)[0]
            expect(writeSignal?.aborted).toBe(true)

            // The intent actually landed on the hub before cancellation and the
            // hub's lost-RPC catch path truncated the transcript keeping claudeRewind.
            const landedIntent = {
                targetLocalId: 'local-1',
                truncateFromLocalId: 'local-1',
                keepBoundary: 'keep-boundary-uuid',
                droppedPrompts: ['uuid-1']
            }
            harness.hubMetadata = {
                ...harness.state.metadata,
                claudeRewind: landedIntent
            }

            // Reconnect refreshes metadata from hub and settles: arms rewind + restarts.
            harness.reconnectHandler?.()
            await vi.waitFor(() => {
                expect(restartSpy).toHaveBeenCalledTimes(1)
            })
            expect(harness.hubMetadata.claudeRewind).toEqual(landedIntent)
            expect(harness.state.metadata.claudeRewind).toEqual(landedIntent)

            // Subsequent rewind is blocked while the armed rewind is pending.
            expect(await rewind({ messageLocalId: 'local-2' })).toMatchObject({
                success: false,
                outcome: 'rejected',
                error: expect.stringMatching(/already pending/i)
            })

            // Submitting a prompt settles the armed rewind cleanly.
            harness.deferUnflushedMetadata = false
            harness.flushResult = true
            sessionInstance.onNativeInputSubmitted?.('uuid-1')
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
        } finally {
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            sessionInstance.stopKeepAlive()
        }
    })

    it('clears the unknown rewind flag without restarting when hub metadata has no matching intent on reconnect', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        const restartSpy = vi.fn(async () => {})
        sessionInstance.requestRemoteRestart = restartSpy
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1', 'local-2': 'uuid-2' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })

            // Hub either never received the intent or cleared it on rejected reply.
            harness.hubMetadata = { ...harness.state.metadata }

            harness.reconnectHandler?.()
            await vi.waitFor(() => {
                expect(harness.refreshCalls).toBeGreaterThanOrEqual(1)
            })
            expect(restartSpy).not.toHaveBeenCalled()
            expect(harness.state.metadata.claudeRewind).toBeUndefined()

            // Flag cleared: a subsequent rewind succeeds normally.
            harness.deferUnflushedMetadata = false
            harness.flushResult = true
            expect(await rewind({ messageLocalId: 'local-2' })).toMatchObject({
                success: true,
                truncateFromLocalId: 'local-2'
            })
            expect(restartSpy).toHaveBeenCalledTimes(1)
        } finally {
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            sessionInstance.stopKeepAlive()
        }
    })

    it('rejects next RewindConversation/ForkConversation if metadata refresh fails and settles on a later attempt', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        const restartSpy = vi.fn(async () => {})
        sessionInstance.requestRemoteRestart = restartSpy
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1', 'local-2': 'uuid-2' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            const fork = harness.rpcHandlers.get(RPC_METHODS.ForkConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })

            // Refresh fails: both RewindConversation and ForkConversation reject
            // with a retryable error and keep the unknown flag.
            harness.refreshResult = false
            expect(await rewind({ messageLocalId: 'local-2' })).toMatchObject({
                success: false,
                outcome: 'rejected',
                error: expect.stringMatching(/retry/i)
            })
            await expect(fork({ messageLocalId: 'local-2' })).rejects.toThrow(/retry/i)
            expect(restartSpy).not.toHaveBeenCalled()

            // Next attempt with refresh OK (hub has no intent) settles and proceeds.
            harness.refreshResult = true
            harness.hubMetadata = { ...harness.state.metadata }
            harness.deferUnflushedMetadata = false
            harness.flushResult = true

            expect(await rewind({ messageLocalId: 'local-2' })).toMatchObject({
                success: true,
                truncateFromLocalId: 'local-2'
            })
            expect(restartSpy).toHaveBeenCalledTimes(1)
        } finally {
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            harness.refreshResult = true
            sessionInstance.stopKeepAlive()
        }
    })

    it('re-arms rearmPendingIntent without remote restart when settling in local mode', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        const restartSpy = vi.fn(async () => {})
        sessionInstance.requestRemoteRestart = restartSpy
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })

            // Session switched to local mode before reconnect settled the rewind.
            sessionInstance.mode = 'local'
            sessionInstance.requestRemoteRestart = null
            harness.hubMetadata = {
                ...harness.state.metadata,
                claudeRewind: {
                    targetLocalId: 'local-1',
                    truncateFromLocalId: 'local-1',
                    keepBoundary: 'keep-boundary-uuid',
                    droppedPrompts: ['uuid-1']
                }
            }

            harness.reconnectHandler?.()
            await vi.waitFor(() => {
                expect(harness.state.metadata.claudeRewind).toBeTruthy()
            })
            expect(restartSpy).not.toHaveBeenCalled()
            expect(deriveSpawnArgs({
                claudeArgs: sessionInstance.claudeArgs,
                sessionId: sessionInstance.sessionId,
                intent: harness.state.metadata.claudeRewind,
                workingDirectory: '/tmp/hapi-rewind-test'
            }).boundary).toBe('keep-boundary-uuid')
        } finally {
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            sessionInstance.stopKeepAlive()
        }
    })

    it('settles via ForkConversation by arming a hub-committed rewind and rejecting the fork', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        const restartSpy = vi.fn(async () => {})
        sessionInstance.requestRemoteRestart = restartSpy
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            const fork = harness.rpcHandlers.get(RPC_METHODS.ForkConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })

            harness.hubMetadata = {
                ...harness.state.metadata,
                claudeRewind: {
                    targetLocalId: 'local-1',
                    truncateFromLocalId: 'local-1',
                    keepBoundary: 'keep-boundary-uuid',
                    droppedPrompts: ['uuid-1']
                }
            }
            await expect(fork({ messageLocalId: 'local-1' })).rejects.toThrow(/already pending/i)
            expect(restartSpy).toHaveBeenCalledTimes(1)
        } finally {
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            sessionInstance.stopKeepAlive()
        }
    })

    it('clears unknownRewindIntent when the session resets before settlement', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        sessionInstance.requestRemoteRestart = async () => {}
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })

            // /clear wipes the conversation while unknownRewindIntent is set:
            // reconnect afterwards must NOT re-arm the discarded intent.
            harness.hubMetadata = {
                ...harness.state.metadata,
                claudeRewind: {
                    targetLocalId: 'local-1',
                    truncateFromLocalId: 'local-1',
                    keepBoundary: 'keep-boundary-uuid',
                    droppedPrompts: ['uuid-1']
                }
            }
            harness.deferUnflushedMetadata = false
            harness.flushResult = true
            sessionInstance.onConversationReset?.()
            expect(harness.state.metadata.claudeRewind).toBeUndefined()

            harness.hubMetadata = { ...harness.state.metadata }
            harness.reconnectHandler?.()
            await new Promise((r) => setTimeout(r, 20))
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
        } finally {
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            sessionInstance.stopKeepAlive()
        }
    })

    it('unblocks ForkConversation and RewindConversation once a local-mode settled rewind is proven (item 1)', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession('remote')
        sessionInstance.sessionId = 'native-a'
        sessionInstance.requestRemoteRestart = async () => {}
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
                conversationHistoryEntryIds: { 'local-1': 'uuid-1', 'local-2': 'uuid-2' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            const fork = harness.rpcHandlers.get(RPC_METHODS.ForkConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })

            // Live session switches to local mode; rewind landed on hub.
            sessionInstance.mode = 'local'
            sessionInstance.requestRemoteRestart = null
            harness.hubMetadata = {
                ...harness.state.metadata,
                claudeRewind: {
                    targetLocalId: 'local-1',
                    truncateFromLocalId: 'local-1',
                    keepBoundary: 'keep-boundary-uuid',
                    droppedPrompts: ['uuid-1']
                }
            }
            harness.reconnectHandler?.()
            await vi.waitFor(() => {
                expect(harness.state.metadata.claudeRewind).toBeTruthy()
            })

            // Local input proves the rewind and clears claudeRewind.
            harness.deferUnflushedMetadata = false
            harness.flushResult = true
            sessionInstance.onNativeInputSubmitted?.('uuid-1')
            expect(harness.state.metadata.claudeRewind).toBeUndefined()

            // Fork and Rewind must now be unblocked (rearmPendingIntent must NOT linger).
            await expect(fork({})).resolves.toMatchObject({ forkSession: true })
            sessionInstance.mode = 'remote'
            sessionInstance.requestRemoteRestart = async () => {}
            expect(await rewind({ messageLocalId: 'local-2' })).toMatchObject({
                success: true,
                truncateFromLocalId: 'local-2'
            })
        } finally {
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            sessionInstance.stopKeepAlive()
        }
    })

    it('settles onReconnect using already-refreshed metadata without a second refreshMetadata call (item 3a)', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        const restartSpy = vi.fn(async () => {})
        sessionInstance.requestRemoteRestart = restartSpy
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })

            // Simulate ApiSessionClient having just refreshed metadata on reconnect.
            const landedIntent = {
                targetLocalId: 'local-1',
                truncateFromLocalId: 'local-1',
                keepBoundary: 'keep-boundary-uuid',
                droppedPrompts: ['uuid-1']
            }
            harness.state.metadata = {
                ...harness.state.metadata,
                claudeRewind: landedIntent
            }
            // Even if another refresh HTTP call would fail, reconnectHandler(true)
            // must use the already-loaded metadata with 0 additional refresh calls.
            harness.refreshResult = false
            const refreshCallsBefore = harness.refreshCalls

            harness.reconnectHandler?.(true)
            await vi.waitFor(() => {
                expect(restartSpy).toHaveBeenCalledTimes(1)
            })
            expect(harness.refreshCalls).toBe(refreshCallsBefore)
        } finally {
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            harness.refreshResult = true
            sessionInstance.stopKeepAlive()
        }
    })

    it('settles unknownRewindIntent before handing the next user message to Claude (item 3b)', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        const events: string[] = []
        sessionInstance.requestRemoteRestart = async () => {
            events.push('restart')
        }
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })

            const landedIntent = {
                targetLocalId: 'local-1',
                truncateFromLocalId: 'local-1',
                keepBoundary: 'keep-boundary-uuid',
                droppedPrompts: ['uuid-1']
            }
            harness.hubMetadata = {
                ...harness.state.metadata,
                claudeRewind: landedIntent
            }
            // Hold refreshMetadata so we can prove the user message is NOT pushed
            // to messageQueue before settlement + restart finish.
            let resolveRefresh!: (ok: boolean) => void
            harness.refreshImpl = () => new Promise<boolean>((resolve) => {
                resolveRefresh = resolve
            })

            await new Promise((r) => setTimeout(r, 0))
            harness.userMessageHandler?.({ content: { text: 'continue after rewind', attachments: [] } }, 'user-msg-1')
            await vi.waitFor(() => {
                expect(harness.refreshCalls).toBe(1)
            })
            expect(harness.loopOpts.messageQueue.size()).toBe(0)
            expect(events).toEqual([])

            harness.state.metadata = structuredClone(harness.hubMetadata)
            resolveRefresh(true)

            await vi.waitFor(() => {
                expect(harness.loopOpts.messageQueue.size()).toBe(1)
            })
            expect(events).toEqual(['restart'])
        } finally {
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            harness.refreshImpl = null
            sessionInstance.stopKeepAlive()
        }
    })

    it('keeps user messages deferred on refresh failure, retries with backoff, and delivers in order once settled (finding 1a)', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        const events: string[] = []
        sessionInstance.requestRemoteRestart = async () => {
            events.push('restart')
        }
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })

            const landedIntent = {
                targetLocalId: 'local-1',
                truncateFromLocalId: 'local-1',
                keepBoundary: 'keep-boundary-uuid',
                droppedPrompts: ['uuid-1']
            }
            harness.hubMetadata = {
                ...harness.state.metadata,
                claudeRewind: landedIntent
            }

            // Fail initial attempt + first retry, succeed on third attempt.
            let attempt = 0
            harness.refreshImpl = async () => {
                attempt += 1
                if (attempt < 3) return false
                harness.state.metadata = structuredClone(harness.hubMetadata)
                return true
            }

            await new Promise((r) => setTimeout(r, 0))
            harness.userMessageHandler?.({ content: { text: 'first', attachments: [] } }, 'user-msg-1')
            harness.userMessageHandler?.({ content: { text: 'second', attachments: [] } }, 'user-msg-2')

            await vi.waitFor(() => {
                expect(attempt).toBe(1)
            })
            // Critical: after initial failure, do NOT hand messages to un-rewound Claude.
            expect(harness.loopOpts.messageQueue.size()).toBe(0)
            expect(events).toEqual([])

            await vi.waitFor(() => {
                expect(harness.loopOpts.messageQueue.size()).toBe(2)
            }, { timeout: 6_000 })
            expect(attempt).toBe(3)
            expect(events).toEqual(['restart'])
            expect(harness.loopOpts.messageQueue.queue.map((i: any) => i.localId)).toEqual(['user-msg-1', 'user-msg-2'])
        } finally {
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            harness.refreshImpl = null
            sessionInstance.stopKeepAlive()
        }
    })

    it('keeps messages deferred after retries exhaust, honors cancellation, logs warning, and drains on reconnect (finding 1b)', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        const events: string[] = []
        sessionInstance.requestRemoteRestart = async () => {
            events.push('restart')
        }
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })

            const landedIntent = {
                targetLocalId: 'local-1',
                truncateFromLocalId: 'local-1',
                keepBoundary: 'keep-boundary-uuid',
                droppedPrompts: ['uuid-1']
            }
            harness.hubMetadata = {
                ...harness.state.metadata,
                claudeRewind: landedIntent
            }
            harness.refreshResult = false

            await new Promise((r) => setTimeout(r, 0))
            harness.userMessageHandler?.({ content: { text: 'cancel-me', attachments: [] } }, 'user-msg-cancel')
            harness.userMessageHandler?.({ content: { text: 'keep-me', attachments: [] } }, 'user-msg-keep')

            expect(harness.cancelQueuedMessageHandler?.('user-msg-cancel')).toBe(true)

            // Wait for retry attempts + warning log; message must remain deferred.
            await vi.waitFor(() => {
                expect(warnSpy).toHaveBeenCalled()
            }, { timeout: 10_000 })
            expect(harness.refreshCalls).toBe(4)
            expect(harness.loopOpts.messageQueue.size()).toBe(0)
            expect(events).toEqual([])

            // Next trigger (reconnect with refreshed metadata) settles and drains kept message.
            harness.refreshResult = true
            harness.state.metadata = structuredClone(harness.hubMetadata)
            harness.reconnectHandler?.(true)

            await vi.waitFor(() => {
                expect(harness.loopOpts.messageQueue.size()).toBe(1)
            })
            expect(events).toEqual(['restart'])
            expect(harness.loopOpts.messageQueue.queue.map((i: any) => i.localId)).toEqual(['user-msg-keep'])
        } finally {
            warnSpy.mockRestore()
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            harness.refreshResult = true
            sessionInstance.stopKeepAlive()
        }
    })

    it('settles immediately onReconnect(true) even when an older settle refresh is still in flight and later fails (finding 2)', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        const restartSpy = vi.fn(async () => {})
        sessionInstance.requestRemoteRestart = restartSpy
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            const fork = harness.rpcHandlers.get(RPC_METHODS.ForkConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })

            const landedIntent = {
                targetLocalId: 'local-1',
                truncateFromLocalId: 'local-1',
                keepBoundary: 'keep-boundary-uuid',
                droppedPrompts: ['uuid-1']
            }
            harness.hubMetadata = {
                ...harness.state.metadata,
                claudeRewind: landedIntent
            }

            // Start an older settle via ForkConversation that stalls in refreshMetadata().
            let resolveStalledRefresh!: (ok: boolean) => void
            harness.refreshImpl = () => new Promise<boolean>((resolve) => {
                resolveStalledRefresh = resolve
            })
            const forkPromise = fork({})
            await vi.waitFor(() => {
                expect(harness.refreshCalls).toBe(1)
            })

            // Reconnect refreshes metadata and invokes reconnectHandler(true) while fork is stalled.
            harness.state.metadata = structuredClone(harness.hubMetadata)
            harness.reconnectHandler?.(true)

            await vi.waitFor(() => {
                expect(restartSpy).toHaveBeenCalledTimes(1)
            })

            // Stalled refresh finally fails: it must be a no-op and fork must see "already pending", not "retry".
            resolveStalledRefresh(false)
            await expect(forkPromise).rejects.toThrow(/already pending/i)
            expect(restartSpy).toHaveBeenCalledTimes(1)
        } finally {
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            harness.refreshImpl = null
            sessionInstance.stopKeepAlive()
        }
    })

    it('preserves FIFO message order and defers new messages while settleUnknownRewind awaits armSettledRewind (63hA_G item 1)', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        sessionInstance.stopKeepAlive()

        let resolveRestart!: () => void
        const events: string[] = []
        sessionInstance.requestRemoteRestart = () => new Promise<void>((resolve) => {
            events.push('restart-start')
            resolveRestart = () => {
                events.push('restart-done')
                resolve()
            }
        })
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })

            const landedIntent = {
                targetLocalId: 'local-1',
                truncateFromLocalId: 'local-1',
                keepBoundary: 'keep-boundary-uuid',
                droppedPrompts: ['uuid-1']
            }
            harness.hubMetadata = {
                ...harness.state.metadata,
                claudeRewind: landedIntent
            }

            await startDeferredSettlementWithFakeTimers('M1-first', 'user-msg-1')

            // M1 arrives and short retries fail -> M1 sits in deferredMessages with drainingUserMessages = false.
            await vi.advanceTimersByTimeAsync(1_000)
            expect(harness.refreshCalls).toBe(2)
            await vi.advanceTimersByTimeAsync(2_000)
            expect(harness.refreshCalls).toBe(3)
            await vi.advanceTimersByTimeAsync(4_000)
            expect(harness.refreshCalls).toBe(4)
            expect(harness.loopOpts.messageQueue.size()).toBe(0)

            const pushSpy = vi.spyOn(harness.loopOpts.messageQueue, 'push')
            const clearSpy = vi.spyOn(harness.loopOpts.messageQueue, 'pushIsolateAndClear')

            // Reconnect starts settleUnknownRewind(true): unknownRewindIntent becomes null while
            // requestRemoteRestart() is still awaited.
            harness.state.metadata = structuredClone(harness.hubMetadata)
            harness.reconnectHandler?.(true)
            await Promise.resolve()
            expect(events).toEqual(['restart-start'])

            // M2 (/clear) and M3 arrive while settleUnknownRewind is awaiting armSettledRewind.
            // Neither must jump ahead of M1 or be pushed before restart finishes.
            harness.userMessageHandler?.({ content: { text: '/clear', attachments: [] } }, 'user-msg-2-clear')
            harness.userMessageHandler?.({ content: { text: 'M3-after-clear', attachments: [] } }, 'user-msg-3')

            await Promise.resolve()
            expect(pushSpy).not.toHaveBeenCalled()
            expect(clearSpy).not.toHaveBeenCalled()
            expect(harness.loopOpts.messageQueue.size()).toBe(0)

            resolveRestart()
            await vi.advanceTimersByTimeAsync(0)
            await vi.waitFor(() => {
                expect(harness.loopOpts.messageQueue.queue.map((i: any) => i.localId)).toEqual(['user-msg-2-clear', 'user-msg-3'])
            })
            expect(events).toEqual(['restart-start', 'restart-done'])
            expect(pushSpy.mock.calls.map((c: any[]) => c[2])).toEqual(['user-msg-1', 'user-msg-3'])
            expect(clearSpy.mock.calls.map((c: any[]) => c[2])).toEqual(['user-msg-2-clear'])
        } finally {
            vi.useRealTimers()
            warnSpy.mockRestore()
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            harness.refreshImpl = null
            harness.refreshResult = true
            sessionInstance.stopKeepAlive()
        }
    })

    it('defers a new message arriving while settleUnknownRewind awaits armSettledRewind even when deferredMessages was empty (63hA_G item 1b)', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        let resolveRestart!: () => void
        const events: string[] = []
        sessionInstance.requestRemoteRestart = () => new Promise<void>((resolve) => {
            events.push('restart-start')
            resolveRestart = () => {
                events.push('restart-done')
                resolve()
            }
        })
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            await rewind({ messageLocalId: 'local-1' })

            const landedIntent = {
                targetLocalId: 'local-1',
                truncateFromLocalId: 'local-1',
                keepBoundary: 'keep-boundary-uuid',
                droppedPrompts: ['uuid-1']
            }
            harness.state.metadata = {
                ...harness.state.metadata,
                claudeRewind: landedIntent
            }

            await new Promise((r) => setTimeout(r, 0))

            // Start settlement while deferredMessages is empty; unknownRewindIntent becomes null
            // while requestRemoteRestart() is still awaited.
            harness.reconnectHandler?.(true)
            await Promise.resolve()
            expect(events).toEqual(['restart-start'])

            harness.userMessageHandler?.({ content: { text: 'during-restart', attachments: [] } }, 'user-msg-during-restart')
            await new Promise((r) => setTimeout(r, 10))
            expect(harness.loopOpts.messageQueue.size()).toBe(0)

            resolveRestart()
            await vi.waitFor(() => {
                expect(harness.loopOpts.messageQueue.queue.map((i: any) => i.localId)).toEqual(['user-msg-during-restart'])
            })
            expect(events).toEqual(['restart-start', 'restart-done'])
        } finally {
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            sessionInstance.stopKeepAlive()
        }
    })

    async function startDeferredSettlementWithFakeTimers(messageText: string, localId: string): Promise<void> {
        const targetRefreshCalls = harness.refreshCalls + 1
        let resolveInitialRefresh!: (ok: boolean) => void
        harness.refreshImpl = () => new Promise<boolean>((resolve) => {
            resolveInitialRefresh = resolve
        })
        harness.userMessageHandler?.({ content: { text: messageText, attachments: [] } }, localId)
        // Wait under real timers for getCatalog()/messagePipelineReady and flushUserMessages()
        // to enter the initial refreshMetadata() before switching to fake timers.
        await vi.waitFor(() => {
            expect(harness.refreshCalls).toBe(targetRefreshCalls)
        })
        harness.refreshImpl = null
        harness.refreshResult = false
        vi.useFakeTimers()
        resolveInitialRefresh(false)
        await vi.advanceTimersByTimeAsync(0)
        expect(vi.getTimerCount()).toBeGreaterThan(0)
    }

    it('keeps retrying settle in background with capped backoff while deferredMessages is non-empty (63hA_G item 2a)', { timeout: 20_000 }, async () => {
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await waitForFreshRunner(prev)

        const sessionInstance = createRunnerSession()
        sessionInstance.sessionId = 'native-a'
        sessionInstance.stopKeepAlive()
        const restartSpy = vi.fn(async () => {})
        sessionInstance.requestRemoteRestart = restartSpy
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })

            const landedIntent = {
                targetLocalId: 'local-1',
                truncateFromLocalId: 'local-1',
                keepBoundary: 'keep-boundary-uuid',
                droppedPrompts: ['uuid-1']
            }
            harness.hubMetadata = {
                ...harness.state.metadata,
                claudeRewind: landedIntent
            }

            await startDeferredSettlementWithFakeTimers('bg-deferred', 'user-msg-bg')

            // Initial + 3 short retries (1s, 2s, 4s) fail -> 4 calls.
            await vi.advanceTimersByTimeAsync(1_000)
            expect(harness.refreshCalls).toBe(2)
            await vi.advanceTimersByTimeAsync(2_000)
            expect(harness.refreshCalls).toBe(3)
            await vi.advanceTimersByTimeAsync(4_000)
            expect(harness.refreshCalls).toBe(4)
            expect(warnSpy).toHaveBeenCalledTimes(1)

            // Background retry 1: 15s
            await vi.advanceTimersByTimeAsync(14_999)
            expect(harness.refreshCalls).toBe(4)
            await vi.advanceTimersByTimeAsync(1)
            expect(harness.refreshCalls).toBe(5)

            // Background retry 2: 30s
            await vi.advanceTimersByTimeAsync(29_999)
            expect(harness.refreshCalls).toBe(5)
            await vi.advanceTimersByTimeAsync(1)
            expect(harness.refreshCalls).toBe(6)

            // Background retry 3: 60s
            await vi.advanceTimersByTimeAsync(59_999)
            expect(harness.refreshCalls).toBe(6)
            await vi.advanceTimersByTimeAsync(1)
            expect(harness.refreshCalls).toBe(7)

            // Background retry 4: capped at 60s; succeed on this attempt.
            harness.refreshResult = true
            await vi.advanceTimersByTimeAsync(60_000)
            expect(harness.refreshCalls).toBe(8)
            expect(restartSpy).toHaveBeenCalledTimes(1)
            expect(harness.loopOpts.messageQueue.queue.map((i: any) => i.localId)).toEqual(['user-msg-bg'])
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            vi.useRealTimers()
            warnSpy.mockRestore()
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            harness.refreshImpl = null
            harness.refreshResult = true
            sessionInstance.stopKeepAlive()
        }
    })

    it('cancels background settle retry on empty queue, on settle, and on session close with no leaked timers or unhandled rejections (63hA_G item 2b)', { timeout: 20_000 }, async () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
        const unhandledRejections: unknown[] = []
        const onUnhandled = (reason: unknown) => { unhandledRejections.push(reason) }
        process.on('unhandledRejection', onUnhandled)

        let sessionInstance: Session | null = null
        try {
            // Case A: deferredMessages becomes empty via cancellation + Case B: settle cancels background timer
            const prevA = snapshotRunner()
            const runPromiseA = runClaude({
                workingDirectory: '/tmp/hapi-rewind-test',
                startedBy: 'runner',
                startingMode: 'remote'
            })
            runPromiseA.catch((error) => { harness.runError = error })
            await waitForFreshRunner(prevA)

            sessionInstance = createRunnerSession()
            sessionInstance.sessionId = 'native-a'
            sessionInstance.stopKeepAlive()
            sessionInstance.requestRemoteRestart = async () => {}

            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false
            const rewindA = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            await rewindA({ messageLocalId: 'local-1' })

            await startDeferredSettlementWithFakeTimers('only-msg', 'user-msg-only')
            await vi.advanceTimersByTimeAsync(7_000)
            expect(harness.refreshCalls).toBe(4)
            expect(vi.getTimerCount()).toBeGreaterThan(0)

            // Cancelling the only deferred message empties deferredMessages -> background timer cancelled.
            expect(harness.cancelQueuedMessageHandler?.('user-msg-only')).toBe(true)
            expect(vi.getTimerCount()).toBe(0)
            await vi.advanceTimersByTimeAsync(120_000)
            expect(harness.refreshCalls).toBe(4)

            // Re-defer a message, enter background retry, then settle via reconnect -> timer cancelled.
            harness.userMessageHandler?.({ content: { text: 'second-msg', attachments: [] } }, 'user-msg-second')
            await vi.advanceTimersByTimeAsync(0)
            expect(harness.refreshCalls).toBe(5)
            expect(vi.getTimerCount()).toBeGreaterThan(0)
            await vi.advanceTimersByTimeAsync(7_000)
            expect(harness.refreshCalls).toBe(8)
            expect(vi.getTimerCount()).toBeGreaterThan(0)

            harness.hubMetadata = {
                ...harness.state.metadata,
                claudeRewind: {
                    targetLocalId: 'local-1',
                    truncateFromLocalId: 'local-1',
                    keepBoundary: 'keep-boundary-uuid',
                    droppedPrompts: ['uuid-1']
                }
            }
            harness.state.metadata = structuredClone(harness.hubMetadata)
            harness.reconnectHandler?.(true)
            await vi.advanceTimersByTimeAsync(0)
            expect(vi.getTimerCount()).toBe(0)
            expect(harness.loopOpts.messageQueue.queue.map((i: any) => i.localId)).toEqual(['user-msg-second'])

            vi.useRealTimers()
            sessionInstance.stopKeepAlive()

            // Case C: session close cancels background retry timer and leaves no promises/timers/rejections.
            harness.state.metadata = {}
            harness.refreshCalls = 0
            harness.refreshResult = true
            harness.deferUnflushedMetadata = false
            harness.flushResult = null
            harness.hubMetadata = undefined
            let rejectLoop!: (err: Error) => void
            harness.loopImpl = () => new Promise<void>((_, reject) => { rejectLoop = reject })

            const prevB = snapshotRunner()
            const runPromiseB = runClaude({
                workingDirectory: '/tmp/hapi-rewind-test',
                startedBy: 'runner',
                startingMode: 'remote'
            })
            await waitForFreshRunner(prevB)

            const sessionB = createRunnerSession()
            sessionB.sessionId = 'native-a'
            sessionB.stopKeepAlive()
            sessionB.requestRemoteRestart = async () => {}
            sessionInstance = sessionB

            harness.loopOpts.onSessionReady(sessionB)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            harness.deferUnflushedMetadata = true
            harness.flushResult = false
            const rewindB = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            await rewindB({ messageLocalId: 'local-1' })

            await startDeferredSettlementWithFakeTimers('close-msg', 'user-msg-close')
            await vi.advanceTimersByTimeAsync(7_000)
            expect(harness.refreshCalls).toBe(4)
            expect(vi.getTimerCount()).toBeGreaterThan(0)

            rejectLoop(new Error('session closed'))
            await expect(runPromiseB).rejects.toThrow('session closed')

            expect(vi.getTimerCount()).toBe(0)
            await vi.advanceTimersByTimeAsync(120_000)
            expect(harness.refreshCalls).toBe(4)
            expect(unhandledRejections).toEqual([])
        } finally {
            process.off('unhandledRejection', onUnhandled)
            vi.useRealTimers()
            warnSpy.mockRestore()
            harness.loopImpl = null
            harness.flushResult = null
            harness.deferUnflushedMetadata = false
            harness.refreshImpl = null
            harness.refreshResult = true
            sessionInstance?.stopKeepAlive()
        }
    })
})