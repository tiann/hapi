import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { Session } from './session'
import { runClaude } from './runClaude'
import { deriveSpawnArgs, isSessionMaterialized } from './conversationHistory'
import type { EnhancedMode } from './loop'

const harness = vi.hoisted(() => {
    const state = { metadata: {} as any, agentState: {} as any }
    const rpcHandlers = new Map<string, (payload: any) => any>()
    const sessionStub: any = {
        rpcHandlerManager: {
            registerHandler: (method: string, handler: any) => { rpcHandlers.set(method, handler) }
        },
        updateMetadata: (mutator: any, options?: { signal?: AbortSignal }) => {
            if (options?.signal?.aborted) return
            const next = mutator(state.metadata)
            if (next != null) state.metadata = next
        },
        updateAgentState: (mutator: any) => {
            const next = mutator(state.agentState)
            if (next !== undefined) state.agentState = next
        },
        getMetadata: () => state.metadata,
        flushMetadata: async () => true,
        refreshMetadata: async () => true,
        onReconnect: () => {},
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
        onUserMessage: () => {},
        onCancelQueuedMessage: () => {}
    }
    return {
        state,
        rpcHandlers,
        sessionStub,
        loopOpts: null as any,
        runError: null as unknown,
        hookHandlers: null as any
    }
})

vi.mock('@/agent/sessionFactory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agent/sessionFactory')>()
    return {
        ...actual,
        bootstrapSession: async () => ({
            api: {},
            session: harness.sessionStub,
            sessionInfo: { id: 'hapi-unmaterialized-fork-test', metadata: {} }
        }),
        bootstrapExistingSession: async () => ({
            api: {},
            session: harness.sessionStub,
            sessionInfo: { id: 'hapi-unmaterialized-fork-test', metadata: {} }
        })
    }
})

vi.mock('@/claude/loop', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/claude/loop')>()
    return {
        ...actual,
        loop: async (opts: any) => {
            harness.loopOpts = opts
            return new Promise(() => {})
        }
    }
})

vi.mock('@/claude/utils/startHappyServer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/claude/utils/startHappyServer')>()
    return {
        ...actual,
        startHappyServer: async () => ({ url: 'http://127.0.0.1:3998', toolNames: [], stop: async () => {} }),
        toClaudeAllowedHapiMcpTools: (names: string[]) => names
    }
})

vi.mock('@/claude/utils/startHookServer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/claude/utils/startHookServer')>()
    return {
        ...actual,
        startHookServer: async (handlers: any) => {
            harness.hookHandlers = handlers
            return { port: 3998, token: 'test-token', stop: async () => {} }
        }
    }
})

vi.mock('@/modules/common/hooks/generateHookSettings', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/modules/common/hooks/generateHookSettings')>()
    return {
        ...actual,
        generateHookSettingsFile: () => '/tmp/hapi-fork-test-hook-settings.json',
        cleanupHookSettingsFile: () => {}
    }
})

vi.mock('@/claude/sdk/metadataExtractor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/claude/sdk/metadataExtractor')>()
    return {
        ...actual,
        extractSDKMetadata: async () => ({ slashCommands: undefined })
    }
})

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return {
        ...actual,
        execFileSync: () => '2.1.310 (Claude Code)'
    }
})

vi.mock('./sdk/utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./sdk/utils')>()
    return {
        ...actual,
        getDefaultClaudeCodePath: () => '/usr/bin/claude'
    }
})

const WORK_DIR = '/tmp/hapi-unmaterialized-fork-test'
let configRoot: string | null = null
let projectDir = ''

function writeSourceTranscript(sessionId: string): void {
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), [
        JSON.stringify({ type: 'user', uuid: 'uuid-1', message: { role: 'user', content: [{ type: 'text', text: 'turn 1' }] } }),
        JSON.stringify({ type: 'assistant', uuid: 'as-1', parentUuid: 'uuid-1', message: { role: 'assistant', content: [{ type: 'text', text: 'ans 1' }] } }),
        JSON.stringify({ type: 'user', uuid: 'uuid-2', parentUuid: 'as-1', message: { role: 'user', content: [{ type: 'text', text: 'turn 2' }] } }),
        JSON.stringify({ type: 'assistant', uuid: 'as-2', parentUuid: 'uuid-2', message: { role: 'assistant', content: [{ type: 'text', text: 'ans 2' }] } }),
        JSON.stringify({ type: 'user', uuid: 'uuid-3', parentUuid: 'as-2', message: { role: 'user', content: [{ type: 'text', text: 'turn 3' }] } }),
        JSON.stringify({ type: 'assistant', uuid: 'as-3', parentUuid: 'uuid-3', message: { role: 'assistant', content: [{ type: 'text', text: 'ans 3' }] } })
    ].join('\n') + '\n')
}

function createForkRunnerSession(claudeArgs: string[], mode: 'local' | 'remote' = 'remote'): Session {
    const queue = new MessageQueue2<EnhancedMode>((m) => JSON.stringify(m))
    return new Session({
        api: {} as any,
        client: harness.sessionStub,
        path: WORK_DIR,
        logPath: '/tmp/hapi-unmaterialized-fork-test.log',
        sessionId: null,
        claudeEnvVars: {},
        claudeArgs,
        mcpServers: {},
        messageQueue: queue,
        onModeChange: () => {},
        allowedTools: [],
        mode,
        startedBy: 'runner',
        startingMode: mode,
        hookSettingsPath: '/tmp/hapi-fork-test-hook-settings.json',
        permissionMode: 'default'
    })
}

beforeAll(() => {
    configRoot = mkdtempSync(join(tmpdir(), 'hapi-unmaterialized-fork-'))
    projectDir = join(configRoot, 'projects', WORK_DIR.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(projectDir, { recursive: true })
    writeSourceTranscript('source-native-1')
    process.env.CLAUDE_CONFIG_DIR = configRoot
})

afterAll(() => {
    if (configRoot) {
        if (process.env.CLAUDE_CONFIG_DIR === configRoot) delete process.env.CLAUDE_CONFIG_DIR
        rmSync(configRoot, { recursive: true, force: true })
    }
})

describe('runClaude unmaterialized fork child history actions', () => {
    beforeEach(() => {
        harness.state.metadata = {}
        harness.state.agentState = {}
        harness.runError = null
        try {
            rmSync(join(projectDir, 'child-native-after-rewind.jsonl'), { force: true })
        } catch {}
    })

    function snapshotRunner() {
        return {
            loopOpts: harness.loopOpts,
            fork: harness.rpcHandlers.get(RPC_METHODS.ForkConversation),
            rewind: harness.rpcHandlers.get(RPC_METHODS.RewindConversation),
            hooks: harness.hookHandlers
        }
    }

    async function waitForFreshRunner(prev: ReturnType<typeof snapshotRunner>) {
        await vi.waitFor(() => {
            if (harness.runError) throw harness.runError
            expect(harness.loopOpts).toBeTruthy()
            expect(harness.loopOpts).not.toBe(prev.loopOpts)
            expect(harness.rpcHandlers.get(RPC_METHODS.ForkConversation)).not.toBe(prev.fork)
            expect(harness.rpcHandlers.get(RPC_METHODS.RewindConversation)).not.toBe(prev.rewind)
            expect(harness.hookHandlers).not.toBe(prev.hooks)
        }, { timeout: 10_000, interval: 25 })
    }

    it('resolves fork-at-message and fork-current from source transcript when child transcript is not materialized', { timeout: 20_000 }, async () => {
        const claudeArgs = ['--resume', 'source-native-1', '--fork-session']
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: WORK_DIR,
            claudeArgs,
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })
        await waitForFreshRunner(prev)

        const sessionInstance = createForkRunnerSession([...claudeArgs])
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: {
                    'local-1': 'uuid-1',
                    'local-2': 'uuid-2',
                    'local-3': 'uuid-3'
                }
            }))

            // Simulate SessionStart:fork binding the child native session ID before any prompt exists on disk.
            harness.hookHandlers.onSessionHook('child-native-unbuilt', {
                hook_event_name: 'SessionStart',
                source: 'fork'
            })
            expect(sessionInstance.sessionId).toBe('child-native-unbuilt')
            expect(isSessionMaterialized('child-native-unbuilt', WORK_DIR)).toBe(false)

            const fork = harness.rpcHandlers.get(RPC_METHODS.ForkConversation)!
            await expect(fork({ messageLocalId: 'local-2' })).resolves.toEqual({
                nativeSessionId: 'source-native-1',
                forkSession: true,
                resumeSessionAt: 'as-1'
            })
            await expect(fork({})).resolves.toEqual({
                nativeSessionId: 'source-native-1',
                forkSession: true
            })
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('preserves inherited fork-at-message boundary and scopes source turns on an unmaterialized fork-at-message child', { timeout: 20_000 }, async () => {
        const claudeArgs = ['--resume', 'source-native-1', '--fork-session', '--resume-session-at', 'as-2']
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: WORK_DIR,
            claudeArgs,
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })
        await waitForFreshRunner(prev)

        const sessionInstance = createForkRunnerSession([...claudeArgs])
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: {
                    'local-1': 'uuid-1',
                    'local-2': 'uuid-2',
                    'local-3': 'uuid-3'
                }
            }))
            harness.hookHandlers.onSessionHook('child-fork-at-msg-unbuilt', {
                hook_event_name: 'SessionStart',
                source: 'fork'
            })

            const fork = harness.rpcHandlers.get(RPC_METHODS.ForkConversation)!
            // Fork-current preserves the source target and inherited boundary instead of pointing to an absent child file.
            await expect(fork({})).resolves.toEqual({
                nativeSessionId: 'source-native-1',
                forkSession: true,
                resumeSessionAt: 'as-2'
            })
            await expect(fork({ messageLocalId: 'local-2' })).resolves.toEqual({
                nativeSessionId: 'source-native-1',
                forkSession: true,
                resumeSessionAt: 'as-1'
            })
            // Turn 3 lies beyond the child's inherited boundary as-2 and cannot be forked from the child.
            await expect(fork({ messageLocalId: 'local-3' })).rejects.toThrow(/No native history point/)
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('arms rewind on a copied turn before child materialization, restarts with source boundary, and proves once materialized', { timeout: 20_000 }, async () => {
        const claudeArgs = ['--resume', 'source-native-1', '--fork-session', '--resume-session-at', 'as-2']
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: WORK_DIR,
            claudeArgs,
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })
        await waitForFreshRunner(prev)

        let restartCalls = 0
        const sessionInstance = createForkRunnerSession([...claudeArgs])
        sessionInstance.requestRemoteRestart = async () => {
            restartCalls += 1
        }
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: {
                    'local-1': 'uuid-1',
                    'local-2': 'uuid-2'
                }
            }))
            harness.hookHandlers.onSessionHook('child-native-unbuilt', {
                hook_event_name: 'SessionStart',
                source: 'fork'
            })

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            const res = await rewind({ messageLocalId: 'local-2' })
            expect(res).toEqual({ success: true, truncateFromLocalId: 'local-2' })
            expect(restartCalls).toBe(1)
            expect(harness.state.metadata.claudeRewind).toEqual({
                targetLocalId: 'local-2',
                truncateFromLocalId: 'local-2',
                keepBoundary: 'as-1',
                droppedPrompts: ['uuid-2']
            })

            // Next respawn must target source-native-1 with --fork-session and the rewound boundary as-1.
            const derived = deriveSpawnArgs({
                claudeArgs: sessionInstance.claudeArgs,
                sessionId: sessionInstance.sessionId,
                intent: harness.state.metadata.claudeRewind,
                workingDirectory: WORK_DIR
            })
            expect(derived).toEqual({
                args: ['--resume', 'source-native-1', '--fork-session', '--resume-session-at', 'as-1'],
                boundary: 'as-1'
            })

            // When the first prompt runs on the respawned fork, Claude writes the child transcript up to as-1 + new prompt.
            writeFileSync(join(projectDir, 'child-native-after-rewind.jsonl'), [
                JSON.stringify({ type: 'user', uuid: 'uuid-1', message: { role: 'user', content: [{ type: 'text', text: 'turn 1' }] } }),
                JSON.stringify({ type: 'assistant', uuid: 'as-1', parentUuid: 'uuid-1', message: { role: 'assistant', content: [{ type: 'text', text: 'ans 1' }] } }),
                JSON.stringify({ type: 'user', uuid: 'uuid-new', parentUuid: 'as-1', message: { role: 'user', content: [{ type: 'text', text: 'fresh prompt' }] } })
            ].join('\n') + '\n')
            sessionInstance.onSessionFound('child-native-after-rewind')
            sessionInstance.consumeOneTimeFlags()
            sessionInstance.onNativeInputSubmitted?.('uuid-new')

            await vi.waitFor(() => {
                expect(harness.state.metadata.claudeRewind).toBeUndefined()
            })
            expect(deriveSpawnArgs({
                claudeArgs: sessionInstance.claudeArgs,
                sessionId: sessionInstance.sessionId,
                intent: harness.state.metadata.claudeRewind,
                workingDirectory: WORK_DIR
            })).toEqual({ args: undefined, boundary: null })
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('preserves pending claudeRewind across reconcilePendingRewind on an unmaterialized fork restart', { timeout: 20_000 }, async () => {
        const claudeArgs = ['--resume', 'source-native-1', '--fork-session']
        const pendingIntent = {
            targetLocalId: 'local-2',
            truncateFromLocalId: 'local-2',
            keepBoundary: 'as-1',
            droppedPrompts: ['uuid-2', 'uuid-3']
        }
        harness.state.metadata = {
            claudeSessionId: 'child-native-unbuilt',
            claudeRewind: pendingIntent
        }

        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: WORK_DIR,
            claudeArgs,
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })
        await waitForFreshRunner(prev)

        const sessionInstance = createForkRunnerSession([...claudeArgs])
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            expect(harness.state.metadata.claudeRewind).toEqual(pendingIntent)

            // Double rewind remains blocked while the pending rewind waits for a prompt to materialize it.
            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            await expect(rewind({ messageLocalId: 'local-2' })).resolves.toEqual({
                success: false,
                outcome: 'rejected',
                error: 'A rewind is already pending; send a message to settle it first'
            })
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })

    it('rejects unsupported rewind on an unmaterialized fork with a clear prompt-first message', { timeout: 20_000 }, async () => {
        const claudeArgs = ['--resume', 'missing-source-transcript', '--fork-session']
        const prev = snapshotRunner()
        const runPromise = runClaude({
            workingDirectory: WORK_DIR,
            claudeArgs,
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })
        await waitForFreshRunner(prev)

        const sessionInstance = createForkRunnerSession([...claudeArgs])
        sessionInstance.requestRemoteRestart = async () => {}
        try {
            harness.loopOpts.onSessionReady(sessionInstance)
            harness.sessionStub.updateMetadata((metadata: any) => ({
                ...metadata,
                conversationHistoryEntryIds: {
                    'local-1': 'uuid-1',
                    'local-2': 'uuid-2'
                }
            }))
            harness.hookHandlers.onSessionHook('child-missing-source', {
                hook_event_name: 'SessionStart',
                source: 'fork'
            })

            const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
            await expect(rewind({ messageLocalId: 'local-2' })).resolves.toEqual({
                success: false,
                outcome: 'rejected',
                error: 'Send a message in this fork first, then rewind'
            })
        } finally {
            sessionInstance.stopKeepAlive()
        }
    })
})
