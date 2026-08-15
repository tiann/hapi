import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { ReasonixMode } from './types'

const harness = vi.hoisted(() => ({
    nativeMode: 'normal' as 'normal' | 'plan' | 'goal',
    nativeApproval: 'ask' as 'ask' | 'auto' | 'yolo',
    emitConfigSnapshot: false,
    failSetMode: false,
    setModes: [] as string[],
    setConfigOptions: [] as Array<{ optionId: string; value: string }>,
    modeUpdateListener: null as null | ((update: { sessionId: string; modeId: string }) => void),
    prompts: 0,
    configUpdateListener: null as null | ((update: {
        sessionId: string
        options: Array<{
            id: string
            category?: string
            currentValue?: string
            options: Array<{ value: string }>
        }>
    }) => void)
}))

vi.mock('./utils/reasonixBackend', () => ({
    createReasonixBackend: vi.fn(() => {
        const configOptions = [
            {
                id: 'model',
                category: 'model',
                currentValue: 'deepseek/deepseek-v4-flash',
                options: [{ value: 'deepseek/deepseek-v4-flash' }]
            },
            {
                id: 'effort',
                category: 'thought_level',
                currentValue: 'high',
                options: [{ value: 'auto' }, { value: 'high' }]
            },
            {
                id: 'tool_approval',
                currentValue: harness.nativeApproval,
                options: [{ value: 'ask' }, { value: 'auto' }, { value: 'yolo' }]
            }
        ]
        return {
            initialize: vi.fn(async () => {}),
            newSession: vi.fn(async () => 'reasonix-native'),
            loadSession: vi.fn(async ({ sessionId }: { sessionId: string }) => sessionId),
            resumeSession: vi.fn(async ({ sessionId }: { sessionId: string }) => sessionId),
            getSessionConfigOptions: vi.fn(() => configOptions),
            getSessionModelsMetadata: vi.fn(() => null),
            getSessionModeMetadata: vi.fn(() => ({ currentModeId: harness.nativeMode })),
            setSessionConfigOptionsUpdateListener: vi.fn((listener) => {
                harness.configUpdateListener = listener
            }),
            setSessionModeUpdateListener: vi.fn((listener) => {
                harness.modeUpdateListener = listener
            }),
            setSessionInfoUpdateListener: vi.fn(),
            setAgentActivityListener: vi.fn(),
            onStderrError: vi.fn(),
            setMode: vi.fn(async (_sessionId: string, modeId: string) => {
                harness.setModes.push(modeId)
                harness.modeUpdateListener?.({ sessionId: 'reasonix-native', modeId })
                if (harness.failSetMode) throw new Error('set_mode rejected')
            }),
            setConfigOption: vi.fn(async (_sessionId: string, optionId: string, value: string) => {
                harness.setConfigOptions.push({ optionId, value })
            }),
            setModel: vi.fn(async () => {}),
            prompt: vi.fn(async () => {
                harness.prompts += 1
                if (harness.emitConfigSnapshot) {
                    harness.configUpdateListener?.({
                        sessionId: 'reasonix-native',
                        options: [
                            {
                                id: 'tool_approval',
                                currentValue: harness.nativeApproval,
                                options: [{ value: 'ask' }, { value: 'auto' }, { value: 'yolo' }]
                            }
                        ]
                    })
                }
            }),
            refreshSessionInfo: vi.fn(async () => {}),
            cancelPrompt: vi.fn(async () => {}),
            respondToPermission: vi.fn(async () => {}),
            disconnect: vi.fn(async () => {})
        }
    })
}))

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({ server: { stop: () => {} }, mcpServers: {} })
}))
vi.mock('@/modules/common/remote/RemoteLauncherBase', () => ({
    RemoteLauncherBase: class {
        protected shouldExit = false
        protected exitReason: 'switch' | 'exit' | null = null
        protected messageBuffer = { addMessage: vi.fn(), clear: vi.fn() }

        protected async start(): Promise<'switch' | 'exit'> {
            try {
                await (this as unknown as { runMainLoop(): Promise<void> }).runMainLoop()
            } finally {
                await (this as unknown as { cleanup(): Promise<void> }).cleanup()
            }
            return this.exitReason ?? 'exit'
        }

        protected setupAbortHandlers(): void {}
        protected clearAbortHandlers(): void {}

        protected async requestExit(
            reason: 'switch' | 'exit',
            handler: () => void | Promise<void>
        ): Promise<void> {
            this.exitReason = reason
            this.shouldExit = true
            await handler()
        }
    }
}))
vi.mock('./utils/permissionHandler', () => ({
    ReasonixPermissionHandler: class {
        async cancelAll(): Promise<void> {}
    }
}))
vi.mock('@/ui/ink/ReasonixDisplay', () => ({ ReasonixDisplay: () => null }))
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))

import { reasonixRemoteLauncher } from './reasonixRemoteLauncher'

function createSession(options: {
    queued?: boolean
    permissionMode?: ReasonixMode['permissionMode']
    sessionId?: string | null
    flushMetadataResult?: boolean
    metadata?: Record<string, unknown>
} = {}) {
    const queue = new MessageQueue2<ReasonixMode>((mode) => JSON.stringify(mode))
    if (options.queued !== false) queue.push('hello', {})
    queue.close()
    let permissionMode = options.permissionMode ?? 'default'
    const rpcHandlers = new Map<string, () => unknown>()
    const session = {
        path: '/tmp/reasonix-test',
        logPath: '/tmp/reasonix-test/hapi.log',
        client: {
            rpcHandlerManager: {
                registerHandler(method: string, handler: () => unknown) {
                    rpcHandlers.set(method, handler)
                }
            },
            flushMetadata: vi.fn(async () => options.flushMetadataResult ?? true),
            getMetadata: vi.fn(() => options.metadata ?? {}),
            updateMetadata: vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
                updater({})
            }),
            emitSessionReady: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        },
        queue,
        sessionId: options.sessionId === undefined ? 'reasonix-native' : options.sessionId,
        thinking: false,
        getPermissionMode: () => permissionMode,
        onSessionFound: vi.fn((id: string) => { session.sessionId = id }),
        setPermissionMode: vi.fn((mode: ReasonixMode['permissionMode']) => {
            if (mode) permissionMode = mode
        }),
        setModel: vi.fn(),
        setEffort: vi.fn(),
        onThinkingChange(thinking: boolean) { session.thinking = thinking },
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
    return session
}

describe('reasonixRemoteLauncher', () => {
    afterEach(() => {
        harness.nativeMode = 'normal'
        harness.nativeApproval = 'ask'
        harness.emitConfigSnapshot = false
        harness.failSetMode = false
        harness.setModes = []
        harness.setConfigOptions = []
        harness.prompts = 0
        harness.configUpdateListener = null
        harness.modeUpdateListener = null
    })

    it('preserves native permission state on resume when HAPI has no override', async () => {
        harness.nativeMode = 'plan'
        harness.nativeApproval = 'yolo'
        const session = createSession()

        await reasonixRemoteLauncher(session as never, { resuming: true })

        expect(harness.setModes).toEqual([])
        expect(harness.setConfigOptions).toEqual([])
        expect(harness.prompts).toBe(1)
        expect(session.setPermissionMode).toHaveBeenCalledWith('plan')
    })

    it('publishes the native default approval on a fresh session without an override', async () => {
        harness.nativeApproval = 'auto'
        const session = createSession()

        await reasonixRemoteLauncher(session as never, { resuming: false })

        expect(session.setPermissionMode).toHaveBeenCalledWith('auto')
    })

    it('marks the native transcript persisted after the first successful prompt', async () => {
        const session = createSession({ sessionId: null })

        await reasonixRemoteLauncher(session as never, { resuming: false })

        expect(session.client.updateMetadata).toHaveBeenCalledWith(expect.any(Function))
        expect(session.client.flushMetadata).toHaveBeenCalled()
        const update = session.client.updateMetadata.mock.calls[0]?.[0]
        expect(update?.({})).toEqual({ reasonixTranscriptPersisted: true })
    })

    it('records a successful native resume as persisted before readiness', async () => {
        const session = createSession({
            queued: false,
            sessionId: 'reasonix-native',
            metadata: {}
        })

        await reasonixRemoteLauncher(session as never, { resuming: true })

        expect(session.onSessionFound).toHaveBeenCalledWith('reasonix-native', {
            reasonixTranscriptPersisted: true
        })
        expect(session.client.flushMetadata).toHaveBeenCalledTimes(1)
        expect(session.client.emitSessionReady).toHaveBeenCalledOnce()
    })

    it('fails closed before readiness when a fresh session identity is not persisted', async () => {
        const session = createSession({
            sessionId: null,
            flushMetadataResult: false
        })

        await expect(reasonixRemoteLauncher(session as never, { resuming: false }))
            .rejects.toThrow('refusing to start without durable session identity')

        expect(session.client.flushMetadata).toHaveBeenCalledTimes(1)
        expect(session.client.emitSessionReady).not.toHaveBeenCalled()
        expect(harness.prompts).toBe(0)
    })

    it('overrides native goal and yolo state when HAPI explicitly requests default', async () => {
        harness.nativeMode = 'goal'
        harness.nativeApproval = 'yolo'
        const session = createSession({ permissionMode: 'default' })

        await reasonixRemoteLauncher(session as never, {
            resuming: true,
            permissionModeExplicit: true
        })

        expect(harness.setModes).toEqual(['normal'])
        expect(harness.setConfigOptions).toContainEqual({ optionId: 'tool_approval', value: 'ask' })
        expect(session.setPermissionMode).toHaveBeenCalledWith('default')
    })

    it('clears stale model and effort when a full config snapshot removes the options', async () => {
        harness.emitConfigSnapshot = true
        const discovered: Array<{ model: string | null; effort: string | null }> = []
        const session = createSession()

        await reasonixRemoteLauncher(session as never, {
            resuming: true,
            onConfigDiscovered: (config) => discovered.push(config)
        })

        expect(session.setModel).toHaveBeenLastCalledWith(null)
        expect(session.setEffort).toHaveBeenLastCalledWith(null)
        expect(discovered).toContainEqual({
            model: null,
            effort: null
        })
    })

    it('fails startup when an explicit permission mode is rejected', async () => {
        harness.nativeMode = 'plan'
        harness.nativeApproval = 'yolo'
        harness.failSetMode = true
        const session = createSession({ queued: false, permissionMode: 'default' })

        await expect(reasonixRemoteLauncher(session as never, {
            resuming: true,
            permissionModeExplicit: true
        })).rejects.toThrow('Reasonix rejected permission mode default')
    })

    it('rejects an unsupported model reset without mutating ACP config', async () => {
        const session = createSession({ queued: false })
        let applyConfig: ((config: { model?: string | null }) => Promise<unknown>) | undefined

        await reasonixRemoteLauncher(session as never, {
            resuming: true,
            onConfigApplyReady: (apply) => {
                applyConfig = apply
            }
        })

        await expect(applyConfig?.({ model: null }))
            .rejects.toThrow('Reasonix does not advertise a default model reset')
        expect(harness.setConfigOptions).toEqual([])
    })
})
