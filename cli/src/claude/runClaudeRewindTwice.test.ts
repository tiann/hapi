import { beforeEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageQueue2 } from '@/utils/MessageQueue2'
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
        updateMetadata: (mutator: any) => {
            harness.metadataMutators.push(mutator)
            const next = mutator(state.metadata)
            if (next !== undefined) state.metadata = next
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
        keepAlive: () => {},
        sendSessionEvent: () => {},
        sendAgentMessage: () => {},
        sendClaudeSessionMessage: () => {},
        emitMessagesConsumed: () => {},
        notePendingHubPromptEcho: () => {},
        discardPendingHubPromptEcho: () => {},
        discardPendingHubPromptEchoText: () => {},
        onUserMessage: () => {},
        onCancelQueuedMessage: () => {}
    }
    return {
        state,
        rpcHandlers,
        sessionStub,
        loopOpts: null as any,
        runError: null as unknown,
        hookHandlers: null as any,
        flushResult: null as boolean | null,
        flushTimeouts: [] as number[],
        metadataMutators: [] as Array<(metadata: any) => any>
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
        readNativeTurns: () => [
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
        harness.flushTimeouts = []
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

    it('rolls back the intent when the metadata flush fails', { timeout: 20_000 }, async () => {
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
        harness.flushResult = false
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })
            // The queued metadata write keeps retrying in the background; the
            // rollback must queue the deletion behind it so the retries
            // converge without the intent - the hub never truncated for a
            // rejected rewind, and a stranded intent would rewind natively on
            // the next start without a matching hub cut.
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
        } finally {
            harness.flushResult = null
            sessionInstance.stopKeepAlive()
        }
    })

    it('converges retried metadata writes to no intent after a flush failure', { timeout: 20_000 }, async () => {
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
        harness.flushResult = false
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: { 'local-1': 'uuid-1' }
            }))

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            expect(await rewind({ messageLocalId: 'local-1' })).toMatchObject({
                success: false,
                outcome: 'rejected'
            })
            expect(harness.state.metadata.claudeRewind).toBeUndefined()

            // apiSession re-invokes the queued write's handler on every
            // backoff retry with the current metadata. A rejected rewind's
            // stuck write must converge to metadata WITHOUT the intent - the
            // hub never truncated for it - instead of re-adding the intent
            // after the rollback. The rewind RPC queues exactly two mutators
            // on this path: the persist write, then the rollback deletion.
            const persistMutator = harness.metadataMutators[harness.metadataMutators.length - 2]
            expect(persistMutator).toBeTruthy()
            harness.sessionStub.updateMetadata(persistMutator!)
            expect(harness.state.metadata.claudeRewind).toBeUndefined()
        } finally {
            harness.flushResult = null
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
})