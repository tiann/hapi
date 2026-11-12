import { describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { Session } from './session'
import { runClaude } from './runClaude'
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
            const next = mutator(state.metadata)
            if (next !== undefined) state.metadata = next
        },
        updateAgentState: (mutator: any) => {
            const next = mutator(state.agentState)
            if (next !== undefined) state.agentState = next
        },
        getMetadata: () => state.metadata,
        flushMetadata: async () => true,
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
        runError: null as unknown
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
        // The native branch proof is granted immediately, so the settle path
        // runs synchronously inside the notification.
        nativeRewindApplied: () => true,
        claudeConversationHistoryCapabilities: () => ({ forkCurrent: true, forkAtMessage: true, rewindToMessage: true }),
        resolveRewindPlan: () => ({ resumeSessionAt: 'keep-boundary-uuid' }),
        readNativeTurns: () => []
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
        startHookServer: async () => ({ port: 3999, token: 'test-token', stop: async () => {} })
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

function createRunnerSession(): Session {
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
        mode: 'remote',
        startedBy: 'runner',
        startingMode: 'remote',
        hookSettingsPath: '/tmp/hapi-rewind-test-hook-settings.json',
        permissionMode: 'default'
    })
}

describe('runClaude rewind proof lifetime', () => {
    it('settles a second rewind in the same wrapper lifetime', { timeout: 20_000 }, async () => {
        const runPromise = runClaude({
            workingDirectory: '/tmp/hapi-rewind-test',
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await vi.waitFor(() => {
            if (harness.runError) throw harness.runError
            expect(harness.loopOpts).toBeTruthy()
        }, { timeout: 10_000, interval: 25 })

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
            expect(sessionInstance.claudeArgs).toEqual(['--resume', 'native-a', '--resume-session-at', 'keep-boundary-uuid'])

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
})