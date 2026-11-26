import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getProjectPath } from './utils/path'
import { runClaude } from './runClaude'
import { claudeLocalLauncher } from './claudeLocalLauncher'
import { Session } from './session'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { EnhancedMode } from './loop'

const harness = vi.hoisted(() => {
    const rpcHandlers = new Map<string, (payload: any) => any>()
    const localSpawns: Array<{ path: string; sessionId: string | null; claudeArgs?: string[] }> = []
    const sessionEvents: any[] = []
    const modeChanges: Array<'local' | 'remote'> = []
    let hookHandlers: { onSessionHook: (sessionId: string, data: any) => void } | null = null
    let runnerSeq = 0
    let activeLocalResolve: (() => void) | null = null
    let runError: unknown = null

    let localMetadata: Record<string, any> = {}
    let hubMetadata: Record<string, any> = {}
    let agentState: Record<string, any> = {}
    let flushResult = true
    let refreshImpl: (() => Promise<boolean>) | null = null
    let refreshResult = true
    let refreshCalls = 0
    let reconnectHandlers: Array<() => void | Promise<void>> = []
    let queuedSignalWrites: Array<{ mutator: (m: any) => any; signal: AbortSignal }> = []
    let autoResolveNextLocal = false
    let flushGate: Promise<void> | null = null

    const resetHub = () => {
        localMetadata = {}
        hubMetadata = {}
        agentState = {}
        flushResult = true
        refreshImpl = null
        refreshResult = true
        refreshCalls = 0
        reconnectHandlers = []
        queuedSignalWrites = []
        autoResolveNextLocal = false
        flushGate = null
    }

    const sessionStub: any = {
        rpcHandlerManager: {
            registerHandler: (method: string, handler: any) => {
                rpcHandlers.set(method, handler)
            }
        },
        updateMetadata: (mutator: any, options?: { signal?: AbortSignal }) => {
            if (options?.signal?.aborted) return
            if (options?.signal) {
                queuedSignalWrites.push({ mutator, signal: options.signal })
                return
            }
            const next = mutator(localMetadata)
            if (next != null) localMetadata = next
        },
        updateAgentState: (mutator: any) => {
            const next = mutator(agentState)
            if (next !== undefined) agentState = next
        },
        getMetadata: () => localMetadata,
        getAgentState: () => agentState,
        flushMetadata: async () => {
            const pending = queuedSignalWrites.splice(0)
            if (flushGate) await flushGate
            if (flushResult) {
                for (const item of pending) {
                    if (item.signal.aborted) continue
                    const next = item.mutator(localMetadata)
                    if (next != null) localMetadata = next
                }
                // The hub applies its transcript cut with the rewind RPC
                // outcome, so a successful intent flush means the hub confirmed
                // the cut. Mirror that marker back, as the real metadata would.
                if (localMetadata?.claudeRewind && !localMetadata.claudeRewind.hubCutApplied) {
                    localMetadata = {
                        ...localMetadata,
                        claudeRewind: { ...localMetadata.claudeRewind, hubCutApplied: true }
                    }
                }
                hubMetadata = structuredClone(localMetadata)
            }
            return flushResult
        },
        refreshMetadata: async () => {
            refreshCalls += 1
            const ok = refreshImpl ? await refreshImpl() : refreshResult
            if (ok) {
                localMetadata = structuredClone(hubMetadata)
            }
            return ok
        },
        onReconnect: (cb: () => void | Promise<void>) => {
            reconnectHandlers.push(cb)
        },
        keepAlive: (_thinking: boolean, _mode: 'local' | 'remote') => {},
        sendSessionEvent: (event: any) => {
            sessionEvents.push(event)
            if (event?.type === 'switch' && (event.mode === 'local' || event.mode === 'remote')) {
                modeChanges.push(event.mode)
            }
        },
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
        rpcHandlers,
        localSpawns,
        sessionEvents,
        modeChanges,
        sessionStub,
        get hookHandlers() { return hookHandlers },
        set hookHandlers(value) { hookHandlers = value },
        get runnerSeq() { return runnerSeq },
        bumpRunnerSeq: () => { runnerSeq += 1 },
        get activeLocalResolve() { return activeLocalResolve },
        set activeLocalResolve(fn: (() => void) | null) { activeLocalResolve = fn },
        get runError() { return runError },
        set runError(err: unknown) { runError = err },
        get localMetadata() { return localMetadata },
        set localMetadata(m: Record<string, any>) { localMetadata = m },
        get hubMetadata() { return hubMetadata },
        set hubMetadata(m: Record<string, any>) { hubMetadata = m },
        get flushResult() { return flushResult },
        set flushResult(v: boolean) { flushResult = v },
        get refreshImpl() { return refreshImpl },
        set refreshImpl(fn: (() => Promise<boolean>) | null) { refreshImpl = fn },
        get refreshResult() { return refreshResult },
        set refreshResult(v: boolean) { refreshResult = v },
        get refreshCalls() { return refreshCalls },
        get flushGate() { return flushGate },
        set flushGate(v: Promise<void> | null) { flushGate = v },
        get autoResolveNextLocal() { return autoResolveNextLocal },
        set autoResolveNextLocal(v: boolean) { autoResolveNextLocal = v },
        triggerReconnect: async () => {
            for (const cb of reconnectHandlers) {
                await cb()
            }
        },
        resetHub
    }
})

vi.mock('@/agent/sessionFactory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agent/sessionFactory')>()
    return {
        ...actual,
        bootstrapSession: async () => ({
            api: {},
            session: harness.sessionStub,
            sessionInfo: { id: 'hapi-local-switch-settle-test', metadata: harness.localMetadata }
        }),
        bootstrapExistingSession: async () => ({
            api: {},
            session: harness.sessionStub,
            sessionInfo: { id: 'hapi-local-switch-settle-test', metadata: harness.localMetadata }
        })
    }
})

vi.mock('./claudeLocal', () => ({
    claudeLocal: async (opts: { path: string; sessionId: string | null; claudeArgs?: string[]; abort: AbortSignal }) => {
        harness.localSpawns.push({
            path: opts.path,
            sessionId: opts.sessionId,
            claudeArgs: opts.claudeArgs ? [...opts.claudeArgs] : undefined
        })
        if (harness.autoResolveNextLocal) {
            harness.autoResolveNextLocal = false
            return
        }
        if (opts.abort.aborted) return
        await new Promise<void>((resolve) => {
            const onAbort = () => resolve()
            harness.activeLocalResolve = () => {
                opts.abort.removeEventListener('abort', onAbort)
                resolve()
            }
            opts.abort.addEventListener('abort', onAbort, { once: true })
        })
        harness.activeLocalResolve = null
    }
}))

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: { signal: AbortSignal; nextMessage: () => Promise<any> }) => {
        if (opts.signal.aborted) return
        await opts.nextMessage()
    }
}))

vi.mock('./utils/sessionScanner', () => ({
    createSessionScanner: async () => ({
        cleanup: async () => {},
        onNewSession: () => {}
    })
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

vi.mock('@/claude/utils/startHappyServer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/claude/utils/startHappyServer')>()
    return {
        ...actual,
        startHappyServer: async () => ({ url: 'http://127.0.0.1:3997', toolNames: [], stop: async () => {} }),
        toClaudeAllowedHapiMcpTools: (names: string[]) => names
    }
})

vi.mock('@/claude/utils/startHookServer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/claude/utils/startHookServer')>()
    return {
        ...actual,
        startHookServer: async (handlers: any) => {
            harness.hookHandlers = handlers
            harness.bumpRunnerSeq()
            return { port: 3997, token: 'test-token', stop: async () => {} }
        }
    }
})

vi.mock('@/modules/common/hooks/generateHookSettings', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/modules/common/hooks/generateHookSettings')>()
    return {
        ...actual,
        generateHookSettingsFile: () => '/tmp/hapi-local-switch-settle-hooks.json',
        cleanupHookSettingsFile: () => {}
    }
})

vi.mock('@/claude/sdk/metadataExtractor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/claude/sdk/metadataExtractor')>()
    return {
        ...actual,
        extractSDKMetadata: async () => ({ slash_commands: [], capabilities: undefined })
    }
})

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return {
        ...actual,
        execFileSync: () => '2.1.250\n'
    }
})

vi.mock('./sdk/utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./sdk/utils')>()
    return {
        ...actual,
        getDefaultClaudeCodePath: () => 'claude'
    }
})

describe('runClaude unknown rewind outcome before local mode', () => {
    const WORK_DIR = '/tmp/hapi-local-switch-settle-work'
    let configDir = ''
    let prevConfigDir: string | undefined
    let projectDir = ''

    function writeTranscriptLines(sessionId: string, lines: object[]) {
        mkdirSync(projectDir, { recursive: true })
        writeFileSync(
            join(projectDir, `${sessionId}.jsonl`),
            lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
        )
    }

    function writeUnprovenNativeTranscript(sessionId = 'native-a') {
        writeTranscriptLines(sessionId, [
            { type: 'user', uuid: 'uuid-1', message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] } },
            { type: 'assistant', uuid: 'as-1', parentUuid: 'uuid-1', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } },
            { type: 'user', uuid: 'uuid-2', parentUuid: 'as-1', message: { role: 'user', content: [{ type: 'text', text: 'second prompt' }] } },
            { type: 'assistant', uuid: 'as-2', parentUuid: 'uuid-2', message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] } }
        ])
    }

    function writeAppliedNativeTranscript(sessionId = 'native-a') {
        writeTranscriptLines(sessionId, [
            { type: 'user', uuid: 'uuid-1', message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] } },
            { type: 'assistant', uuid: 'as-1', parentUuid: 'uuid-1', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } },
            { type: 'user', uuid: 'uuid-3', parentUuid: 'as-1', message: { role: 'user', content: [{ type: 'text', text: 'post-rewind local prompt' }] } }
        ])
    }

    let exitSpy: ReturnType<typeof vi.spyOn> | null = null

    beforeAll(() => {
        prevConfigDir = process.env.CLAUDE_CONFIG_DIR
        configDir = mkdtempSync(join(tmpdir(), 'hapi-local-settle-test-'))
        process.env.CLAUDE_CONFIG_DIR = configDir
        projectDir = getProjectPath(WORK_DIR)
        mkdirSync(projectDir, { recursive: true })
        exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    })

    afterAll(() => {
        exitSpy?.mockRestore()
        if (prevConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR
        } else {
            process.env.CLAUDE_CONFIG_DIR = prevConfigDir
        }
        if (configDir) {
            rmSync(configDir, { recursive: true, force: true })
        }
    })

    beforeEach(() => {
        harness.rpcHandlers.clear()
        harness.localSpawns.length = 0
        harness.sessionEvents.length = 0
        harness.modeChanges.length = 0
        harness.hookHandlers = null
        harness.activeLocalResolve = null
        harness.runError = null
        harness.resetHub()
    })

    afterEach(async () => {
        harness.refreshImpl = null
        harness.activeLocalResolve?.()
        await harness.rpcHandlers.get(RPC_METHODS.KillSession)?.({})
        expect(harness.runError).toBeNull()
    })

    /**
     * The hub applies its transcript cut with the rewind RPC outcome, so the
     * committed intent carries `hubCutApplied`. The native branch is still
     * unapplied, so the boundary must still be re-armed on spawn.
     */
    async function startRemoteSessionWithUnprovenRewind(nativeSessionId = 'native-a') {
        writeUnprovenNativeTranscript(nativeSessionId)
        const baseMeta = {
            claudeSessionId: nativeSessionId,
            conversationHistoryEntryIds: {
                'local-1': 'uuid-1',
                'local-2': 'uuid-2'
            }
        }
        harness.localMetadata = structuredClone(baseMeta)
        harness.hubMetadata = structuredClone(baseMeta)

        const prevSeq = harness.runnerSeq
        const runPromise = runClaude({
            workingDirectory: WORK_DIR,
            claudeArgs: ['--resume', nativeSessionId],
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })

        await vi.waitFor(() => {
            expect(harness.runnerSeq).toBeGreaterThan(prevSeq)
            expect(harness.rpcHandlers.get(RPC_METHODS.RewindConversation)).toBeDefined()
            expect(harness.rpcHandlers.get(RPC_METHODS.Switch)).toBeDefined()
        }, { timeout: 10_000, interval: 20 })

        // Bind live native session id via SessionStart hook and seed unknown rewind outcome:
        // flushMetadata fails so local metadata rolls back, while hubMetadata committed claudeRewind.
        harness.hookHandlers!.onSessionHook(nativeSessionId, {
            hook_event_name: 'SessionStart',
            source: 'resume'
        })
        harness.flushResult = false
        const rewind = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!
        const rewindRes = await rewind({ messageLocalId: 'local-2' })
        expect(rewindRes).toEqual({
            success: false,
            outcome: 'rejected',
            error: 'Rewind intent could not be persisted'
        })
        expect(harness.localMetadata.claudeRewind).toBeUndefined()

        harness.hubMetadata = {
            ...structuredClone(harness.hubMetadata),
            claudeRewind: {
                targetLocalId: 'local-2',
                truncateFromLocalId: 'local-2',
                keepBoundary: 'as-1',
                droppedPrompts: ['uuid-2'],
                hubCutApplied: true
            }
        }
        harness.flushResult = true
        return { runPromise }
    }

    it('settles unknown rewind before switching to local, spawns with committed boundary, and proves against real transcript', { timeout: 20_000 }, async () => {
        await startRemoteSessionWithUnprovenRewind('native-a')

        await harness.rpcHandlers.get(RPC_METHODS.Switch)?.({})

        await vi.waitFor(() => {
            expect(harness.localSpawns).toHaveLength(1)
        })
        expect(harness.localSpawns[0]!.claudeArgs).toEqual(['--resume-session-at', 'as-1'])
        expect(harness.localMetadata.claudeRewind?.keepBoundary).toBe('as-1')

        // Real transcript evidence check: while native-a.jsonl still contains uuid-2,
        // UserPromptSubmit must NOT clear claudeRewind.
        harness.hookHandlers!.onSessionHook('native-a', { hook_event_name: 'UserPromptSubmit' })
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(harness.localMetadata.claudeRewind?.keepBoundary).toBe('as-1')

        // Once the real transcript re-parents onto as-1 (uuid-2 leaves the active chain),
        // UserPromptSubmit clears claudeRewind and the next local spawn drops --resume-session-at.
        writeAppliedNativeTranscript('native-a')
        harness.hookHandlers!.onSessionHook('native-a', { hook_event_name: 'UserPromptSubmit' })
        await vi.waitFor(() => {
            expect(harness.localMetadata.claudeRewind).toBeUndefined()
        })

        // Switch local -> remote -> local again to verify the cleared intent drops --resume-session-at.
        await harness.rpcHandlers.get(RPC_METHODS.Switch)?.({})
        await vi.waitFor(() => {
            expect(harness.modeChanges.at(-1)).toBe('remote')
        })
        await harness.rpcHandlers.get(RPC_METHODS.Switch)?.({})
        await vi.waitFor(() => {
            expect(harness.localSpawns).toHaveLength(2)
        })
        expect(harness.localSpawns[1]!.claudeArgs).toBeUndefined()
    })

    it('refuses to spawn local TUI when settlement fails and keeps session in remote mode until retry succeeds', { timeout: 20_000 }, async () => {
        await startRemoteSessionWithUnprovenRewind('native-a')
        harness.refreshResult = false

        await harness.rpcHandlers.get(RPC_METHODS.Switch)?.({})

        await vi.waitFor(() => {
            expect(harness.sessionEvents.some((event) =>
                typeof event?.message === 'string'
                && event.message.includes('Could not verify pending rewind state with hub; please retry')
            )).toBe(true)
            expect(harness.modeChanges.at(-1)).toBe('remote')
        })
        expect(harness.localSpawns).toHaveLength(0)

        // Recover hub connectivity and retry switch to local: now spawns with settled boundary.
        harness.refreshResult = true
        await harness.rpcHandlers.get(RPC_METHODS.Switch)?.({})

        await vi.waitFor(() => {
            expect(harness.localSpawns).toHaveLength(1)
        })
        expect(harness.localSpawns[0]!.claudeArgs).toEqual(['--resume-session-at', 'as-1'])
    })

    it('waits for an in-flight settlement before spawning local TUI', { timeout: 20_000 }, async () => {
        await startRemoteSessionWithUnprovenRewind('native-a')

        let resolveRefresh!: (ok: boolean) => void
        harness.refreshImpl = () => new Promise<boolean>((resolve) => {
            resolveRefresh = resolve
        })

        // Reconnect starts settlement in-flight before the user triggers switch to local.
        const reconnectPromise = harness.triggerReconnect()
        await vi.waitFor(() => {
            expect(harness.refreshCalls).toBe(1)
        })

        await harness.rpcHandlers.get(RPC_METHODS.Switch)?.({})
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(harness.localSpawns).toHaveLength(0)

        resolveRefresh(true)
        await reconnectPromise

        await vi.waitFor(() => {
            expect(harness.localSpawns).toHaveLength(1)
        })
        expect(harness.localSpawns[0]!.claudeArgs).toEqual(['--resume-session-at', 'as-1'])
    })

    it('holds the local spawn while rewind persistence is in flight and leaves history actions unblocked', { timeout: 20_000 }, async () => {
        writeUnprovenNativeTranscript('native-a')
        const baseMeta = {
            claudeSessionId: 'native-a',
            capabilities: { conversationHistory: { rewindToMessage: true } },
            conversationHistoryEntryIds: { 'local-1': 'uuid-1', 'local-2': 'uuid-2' }
        }
        harness.localMetadata = structuredClone(baseMeta)
        harness.hubMetadata = structuredClone(baseMeta)

        const prevSeq = harness.runnerSeq
        const runPromise = runClaude({
            workingDirectory: WORK_DIR,
            claudeArgs: ['--resume', 'native-a'],
            startedBy: 'runner',
            startingMode: 'remote'
        })
        runPromise.catch((error) => { harness.runError = error })
        await vi.waitFor(() => {
            expect(harness.runnerSeq).toBeGreaterThan(prevSeq)
            expect(harness.rpcHandlers.get(RPC_METHODS.RewindConversation)).toBeDefined()
            expect(harness.rpcHandlers.get(RPC_METHODS.Switch)).toBeDefined()
        }, { timeout: 10_000, interval: 20 })
        harness.hookHandlers!.onSessionHook('native-a', { hook_event_name: 'SessionStart', source: 'resume' })

        // The metadata write is delayed: the flush stays unresolved.
        let releaseFlush!: () => void
        harness.flushGate = new Promise<void>((resolve) => { releaseFlush = resolve })
        const rewindPromise = harness.rpcHandlers.get(RPC_METHODS.RewindConversation)!({ messageLocalId: 'local-2' })
        await new Promise((resolve) => setTimeout(resolve, 30))

        await harness.rpcHandlers.get(RPC_METHODS.Switch)?.({})
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(harness.localSpawns).toHaveLength(0)

        releaseFlush()
        await expect(rewindPromise).resolves.toEqual({ success: true, truncateFromLocalId: 'local-2' })
        await vi.waitFor(() => {
            expect(harness.localSpawns).toHaveLength(1)
        })
        expect(harness.localSpawns[0]!.claudeArgs).toEqual(['--resume-session-at', 'as-1'])

        // The local prompt proves the branch; the rewind must not stay armed.
        writeAppliedNativeTranscript('native-a')
        harness.hookHandlers!.onSessionHook('native-a', { hook_event_name: 'UserPromptSubmit' })
        await vi.waitFor(() => {
            expect(harness.localMetadata.claudeRewind).toBeUndefined()
        })
        await expect(harness.rpcHandlers.get(RPC_METHODS.ForkConversation)!({})).resolves.toMatchObject({
            nativeSessionId: 'native-a',
            forkSession: true
        })
    })

    it('awaits pre-launch settlement on initial local launch and refuses spawn when settlement fails', { timeout: 20_000 }, async () => {
        writeUnprovenNativeTranscript('native-init')
        let metadata: Record<string, any> = { claudeSessionId: 'native-init' }
        const clientStub: any = {
            rpcHandlerManager: { registerHandler: () => {} },
            getMetadata: () => metadata,
            updateMetadata: (mutator: any) => { metadata = mutator(metadata) },
            updateAgentState: () => {},
            sendSessionEvent: (event: any) => { harness.sessionEvents.push(event) },
            sendClaudeSessionMessage: () => {},
            keepAlive: () => {}
        }
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode))

        const failedSession = new Session({
            api: {} as any,
            client: clientStub,
            path: WORK_DIR,
            logPath: '/tmp/hapi-init-fail.log',
            sessionId: 'native-init',
            mcpServers: {},
            messageQueue: queue,
            onModeChange: () => {},
            mode: 'local',
            startedBy: 'terminal',
            startingMode: 'local',
            hookSettingsPath: '/tmp/hook.json',
            beforeLocalLaunch: async () => false
        } as any)

        harness.autoResolveNextLocal = true
        await expect(claudeLocalLauncher(failedSession)).resolves.toBe('exit')
        expect(harness.localSpawns).toHaveLength(0)
        expect(failedSession.localLaunchFailure?.exitReason).toBe('exit')
        expect(harness.sessionEvents.some((event) =>
            typeof event?.message === 'string'
            && event.message.includes('Could not verify pending rewind state with hub; please retry')
        )).toBe(true)

        const settledSession = new Session({
            api: {} as any,
            client: clientStub,
            path: WORK_DIR,
            logPath: '/tmp/hapi-init-ok.log',
            sessionId: 'native-init',
            mcpServers: {},
            messageQueue: queue,
            onModeChange: () => {},
            mode: 'local',
            startedBy: 'terminal',
            startingMode: 'local',
            hookSettingsPath: '/tmp/hook.json',
            beforeLocalLaunch: async () => {
                metadata = {
                    ...metadata,
                    claudeRewind: {
                        targetLocalId: 'local-2',
                        truncateFromLocalId: 'local-2',
                        keepBoundary: 'as-1',
                        droppedPrompts: ['uuid-2']
                    }
                }
                return true
            }
        } as any)

        const launchPromise = claudeLocalLauncher(settledSession)
        await vi.waitFor(() => {
            expect(harness.localSpawns).toHaveLength(1)
        })
        expect(harness.localSpawns[0]!.claudeArgs).toEqual(['--resume-session-at', 'as-1'])
        harness.activeLocalResolve?.()
        await expect(launchPromise).resolves.toBe('exit')
    })
})
