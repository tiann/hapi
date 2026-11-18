import * as shutdown from '@/modules/common/remote/settleAcpLauncherShutdown'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKimiBackend } from './utils/kimiBackend'
import { expectAcpKill } from '@/test/expectAcpKill'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { KimiMode } from './types'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'

const harness = vi.hoisted(() => ({
    prompts: [] as unknown[][],
    configCalls: [] as unknown[][],
    backends: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
    deferSetModel: null as null | Promise<void>,
    thinking: 'on'
}))

vi.mock('./utils/kimiBackend', () => ({
    createKimiBackend: vi.fn(() => {
        const backend = {
            initialize: vi.fn(async () => {}),
            newSession: vi.fn(async () => 'kimi-session-1'),
            loadSession: vi.fn(async () => 'kimi-session-1'),
            // Mimics config_option_update: a new model reports its own level.
            setModel: vi.fn(async (_sessionId: string, model: string) => {
                if (model === 'kimi-k3') harness.thinking = 'medium'
                if (model === 'kimi-k3' && harness.deferSetModel) await harness.deferSetModel
            }),
            getThoughtLevelConfigOption: vi.fn(() => ({ id: 'thinking', currentValue: harness.thinking, options: [] })),
            setConfigOption: vi.fn(async (...args: unknown[]) => {
                harness.configCalls.push(args)
                harness.thinking = args[2] as string
            }),
            prompt: vi.fn(async (_sessionId: string, content: unknown[]) => {
                harness.prompts.push(content)
            }),
            cancelPrompt: vi.fn(async () => {}),
            respondToPermission: vi.fn(async () => {}),
            onStderrError: vi.fn(),
            setSessionInfoUpdateListener: vi.fn(),
            refreshSessionInfo: vi.fn(async () => {}),
            onPermissionRequest: vi.fn(),
            disconnect: vi.fn(async () => {})
        }
        harness.backends.push(backend)
        return backend
    })
}))

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: { stop: () => {} },
        mcpServers: {}
    })
}))

vi.mock('./utils/permissionHandler', () => ({
    KimiPermissionHandler: class {
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('@/ui/ink/KimiDisplay', () => ({ KimiDisplay: () => null }))
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))

import { kimiRemoteLauncher } from './kimiRemoteLauncher'

function createSession(modes: KimiMode[] = [
    { permissionMode: 'default', model: 'kimi-k2' },
    { permissionMode: 'default', model: 'kimi-k2' }
], keepQueueOpen = false) {
    const queue = new MessageQueue2<KimiMode>((mode) => JSON.stringify(mode))
    if (!keepQueueOpen) {
        queue.pushIsolateAndClear('first', modes[0])
        queue.push('second', modes[1])
        queue.close()
    }

    const session = {
        setKillHandler: vi.fn(),
        path: '/tmp/kimi-test',
        logPath: '/tmp/kimi-test/test.log',
        client: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            sendAgentMessage: vi.fn(),
            getMetadata: vi.fn(() => null),
            updateMetadata: vi.fn(),
            sendSessionEvent: vi.fn()
        },
        queue,
        sessionId: null as string | null,
        getPermissionMode: () => 'default' as const,
        onSessionFound(id: string) { session.sessionId = id },
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        setEffort: vi.fn(),
        pushKeepAlive: vi.fn()
    }
    return session
}

describe('kimiRemoteLauncher skill lookup instruction', () => {
    afterEach(() => {
        harness.prompts = []
        harness.configCalls = []
        harness.thinking = 'on'
    })

    it.each(['initialize', 'loadSession'] as const)('disconnects during a stalled %s', async (phase) => {
        const session = createSession(undefined, true)
        session.sessionId = 'resume-me'
        const blocked = Promise.withResolvers<never>()
        void blocked.promise.catch(() => undefined)
        const entered = vi.fn()
        const disconnect = vi.fn(async () => { blocked.reject(new Error('stopped during startup')) })
        const create = vi.mocked(createKimiBackend)
        const factory = create.getMockImplementation()!
        create.mockImplementationOnce((...args) => {
            const backend = factory(...args)
            vi.mocked(backend[phase]).mockImplementation(async () => {
                entered()
                return blocked.promise
            })
            vi.mocked(backend.disconnect).mockImplementation(disconnect)
            return backend
        })
        const running = kimiRemoteLauncher(session as never, { model: 'kimi-k2' })
        const failure = running.catch(() => undefined)
        try {
            await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
            const killing = (session.setKillHandler.mock.calls[0][0] as () => Promise<void>)()
            void killing.catch(() => undefined)
            await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce(), { timeout: 350 })
            await expect(killing).resolves.toBeUndefined()
            await expect(running).resolves.toBe('exit')
        } finally {
            blocked.reject(new Error('test cleanup'))
            session.queue.close()
            await failure
        }
    })

    it.each(['rejects', 'hangs'] as const)('settles kill when disconnect %s', async (outcome) => {
        const session = createSession(undefined, true)
        const waiting = vi.spyOn(session.queue, 'waitForMessagesAndGetAsString')
        const running = kimiRemoteLauncher(session as never, { model: 'kimi-k2' })
        const failure = running.catch(() => undefined)
        const disconnect = Promise.withResolvers<void>()
        try {
            await vi.waitFor(() => expect(waiting).toHaveBeenCalled())
            const backend = harness.backends.at(-1)!
            backend.disconnect.mockReturnValue(disconnect.promise)
            const kill = session.setKillHandler.mock.calls[0][0] as () => Promise<void>
            vi.useFakeTimers()
            const settled = vi.fn()
            const killing = kill().then(settled)
            void killing.catch(() => undefined)
            if (outcome === 'rejects') disconnect.reject(new Error('disconnect failed'))
            await vi.advanceTimersByTimeAsync(5_000)
            expect(settled).toHaveBeenCalledOnce()
            expect(backend.disconnect).toHaveBeenCalledOnce()
        } finally {
            vi.useRealTimers()
            disconnect.resolve()
            session.queue.close()
            await failure
        }
    })

    it('ends an active prompt and wins over a pending switch to local', async () => {
        const session = createSession(undefined, true)
        const waiting = vi.spyOn(session.queue, 'waitForMessagesAndGetAsString')
        const running = kimiRemoteLauncher(session as never, { model: 'kimi-k2' })
        const prompt = Promise.withResolvers<void>()
        const settle = vi.spyOn(shutdown, 'settleAcpLauncherShutdown')
        const switching = Promise.withResolvers<void>()
        try {
            await vi.waitFor(() => expect(waiting).toHaveBeenCalled())
            const backend = harness.backends.at(-1)!
            backend.prompt.mockReturnValue(prompt.promise)
            backend.cancelPrompt.mockReturnValueOnce(switching.promise)
            backend.disconnect.mockImplementation(async () => { prompt.reject(new Error('ACP transport closed')) })
            session.queue.push('active', { permissionMode: 'default', model: 'kimi-k2' })
            await vi.waitFor(() => expect(backend.prompt).toHaveBeenCalledOnce())
            const switchToLocal = session.client.rpcHandlerManager.registerHandler.mock.calls
                .find(([method]) => method === RPC_METHODS.Switch)![1] as () => Promise<void>
            const switched = switchToLocal()
            const kill = session.setKillHandler.mock.calls[0][0] as () => Promise<void>
            await kill()
            switching.resolve()
            await switched
            // Check the base loop result before launch() applies its final shutdown guard.
            await expect(settle.mock.calls[0][0].running).resolves.toBe('exit')
            await expect(running).resolves.toBe('exit')
            expect(session.sendSessionEvent).not.toHaveBeenCalledWith({
                type: 'message',
                message: expect.stringContaining('prompt failed')
            })
        } finally {
            settle.mockRestore()
            switching.resolve()
            prompt.resolve()
            session.queue.close()
            await running
        }
    })

    it('waits for one backend disconnect when killed', async () => {
        const session = createSession(undefined, true)
        const setKillHandler = vi.spyOn(session, 'setKillHandler')
        const waitForMessage = vi.spyOn(session.queue, 'waitForMessagesAndGetAsString')
        const running = kimiRemoteLauncher(session as never, { model: 'kimi-k2' })
        try {
            await vi.waitFor(() => expect(waitForMessage).toHaveBeenCalled())
            expect(setKillHandler).toHaveBeenCalled()
            const backend = harness.backends.at(-1)!
            await expectAcpKill(setKillHandler.mock.calls[0][0] as () => Promise<void>, vi.mocked(backend.disconnect), running)
        } finally {
            session.queue.close()
            await running
        }
    })

    it('requeues the hub-ACKed batch when a plain Stop lands during the queued model apply', async () => {
        const queue = new MessageQueue2<KimiMode>((mode) => JSON.stringify(mode))
        queue.push('first', { permissionMode: 'default', model: 'kimi-k3' })
        const session = {
            setKillHandler: vi.fn(),
            path: '/tmp/kimi-test',
            logPath: '/tmp/kimi-test/test.log',
            client: {
                rpcHandlerManager: { registerHandler: vi.fn() },
                sendAgentMessage: vi.fn(),
                getMetadata: vi.fn(() => null),
                updateMetadata: vi.fn(),
                sendSessionEvent: vi.fn()
            },
            queue,
            sessionId: null as string | null,
            getPermissionMode: () => 'default' as const,
            onSessionFound(id: string) { session.sessionId = id },
            onThinkingChange: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            setEffort: vi.fn(),
            pushKeepAlive: vi.fn()
        }
        let releaseModel!: () => void
        harness.deferSetModel = new Promise<void>(resolve => { releaseModel = resolve })
        const launchPromise = kimiRemoteLauncher(session as never, { model: 'kimi-k2' })
        let releaseCancel: (() => void) | undefined
        try {
            await vi.waitFor(() => {
                const backend = harness.backends.at(-1)!;
                expect((backend.setModel as ReturnType<typeof vi.fn>).mock.calls
                    .some((call: unknown[]) => call[1] === 'kimi-k3')).toBe(true);
            })
            const backend = harness.backends.at(-1)!
            backend.cancelPrompt.mockImplementationOnce(() => new Promise<void>(resolve => { releaseCancel = resolve }))
            const abort = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>)
                .mock.calls.find((call: unknown[]) => call[0] === RPC_METHODS.Abort)![1] as () => Promise<unknown>
            const stop = abort()
            await vi.waitFor(() => expect(releaseCancel).toBeTypeOf('function'))
            releaseModel()
            await new Promise<void>(resolve => setImmediate(resolve))
            await new Promise<void>(resolve => setImmediate(resolve))
            // The batch was dequeued but never hub-ACKed (the ACK is
            // deferred to the dispatch commit); the Stop must preserve it
            // behind the in-flight teardown instead of dispatching a
            // cancelled turn.
            expect(harness.prompts).toHaveLength(0)
            releaseCancel?.()
            await stop
            await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
            queue.close()
            await launchPromise
        } finally {
            releaseModel?.()
            releaseCancel?.()
            queue.close()
            await launchPromise.catch(() => {})
        }
    })

    it('captures the switched model effort baseline when a plain Stop bails during the queued model apply', async () => {
        // Round-7 Minor 4: the abort bail-out used to precede the baseline
        // capture, so the requeued batch never took the NEW model's baseline.
        const queue = new MessageQueue2<KimiMode>((mode) => JSON.stringify(mode))
        queue.push('first', { permissionMode: 'default', model: 'kimi-k3' })
        const session = {
            setKillHandler: vi.fn(),
            path: '/tmp/kimi-test',
            logPath: '/tmp/kimi-test/test.log',
            client: {
                rpcHandlerManager: { registerHandler: vi.fn() },
                sendAgentMessage: vi.fn(),
                getMetadata: vi.fn(() => null),
                updateMetadata: vi.fn(),
                sendSessionEvent: vi.fn()
            },
            queue,
            sessionId: null as string | null,
            getPermissionMode: () => 'default' as const,
            onSessionFound(id: string) { session.sessionId = id },
            onThinkingChange: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            setEffort: vi.fn(),
            pushKeepAlive: vi.fn()
        }
        let releaseModel!: () => void
        harness.deferSetModel = new Promise<void>(resolve => { releaseModel = resolve })
        // Pin THIS launcher's backend by index: earlier tests leave backends
        // (with kimi-k3 setModel calls) in the shared harness, which would
        // satisfy the waitFor before this launcher registers its handlers.
        const backendsBefore = harness.backends.length
        const launchPromise = kimiRemoteLauncher(session as never, { model: 'kimi-k2' })
        let releaseCancel: (() => void) | undefined
        try {
            await vi.waitFor(() => {
                const backend = harness.backends.at(backendsBefore)!;
                expect((backend.setModel as ReturnType<typeof vi.fn>).mock.calls
                    .some((call: unknown[]) => call[1] === 'kimi-k3')).toBe(true);
            })
            const backend = harness.backends.at(backendsBefore)!
            const tlc = backend.getThoughtLevelConfigOption as ReturnType<typeof vi.fn>
            const baselineCalls = tlc.mock.calls.length
            backend.cancelPrompt.mockImplementationOnce(() => new Promise<void>(resolve => { releaseCancel = resolve }))
            const abort = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>)
                .mock.calls.find((call: unknown[]) => call[0] === RPC_METHODS.Abort)![1] as () => Promise<unknown>
            const stop = abort()
            await vi.waitFor(() => expect(releaseCancel).toBeTypeOf('function'))
            releaseModel()
            // The bail requeues the batch, but the switched model's baseline
            // must be captured before the bail (pre-fix the retry sees the
            // model as already applied and never re-reads the level).
            for (let i = 0; i < 20 && tlc.mock.calls.length === baselineCalls; i += 1) {
                await new Promise<void>(resolve => setTimeout(resolve, 50))
            }
            expect(tlc.mock.calls.length).toBe(baselineCalls + 1)
            releaseCancel?.()
            await stop
            await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
            queue.close()
            await launchPromise
        } finally {
            releaseModel?.()
            releaseCancel?.()
            queue.close()
            await launchPromise.catch(() => {})
        }
    })

    it('an idle switch teardown does not consume a newly arrived row', async () => {
        const queue = new MessageQueue2<KimiMode>((mode) => JSON.stringify(mode))
        const consumed = vi.fn()
        queue.onBatchConsumed = consumed
        const session = {
            setKillHandler: vi.fn(),
            path: '/tmp/kimi-test',
            logPath: '/tmp/kimi-test/test.log',
            client: {
                rpcHandlerManager: { registerHandler: vi.fn() },
                sendAgentMessage: vi.fn(),
                getMetadata: vi.fn(() => null),
                updateMetadata: vi.fn(),
                sendSessionEvent: vi.fn()
            },
            queue,
            sessionId: null as string | null,
            getPermissionMode: () => 'default' as const,
            onSessionFound(id: string) { session.sessionId = id },
            onThinkingChange: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            setEffort: vi.fn(),
            pushKeepAlive: vi.fn()
        }
        const launchPromise = kimiRemoteLauncher(session as never, { model: 'kimi-k2' })
        let releaseCancel: (() => void) | undefined
        try {
            // Wait until the loop is parked: the Switch handler is registered
            // immediately before the drain loop starts.
            await vi.waitFor(() => {
                expect((session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>)
                    .mock.calls.some((call: unknown[]) => call[0] === RPC_METHODS.Switch)).toBe(true)
            })
            const switchHandler = (session.client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>)
                .mock.calls.find((call: unknown[]) => call[0] === RPC_METHODS.Switch)![1] as () => Promise<unknown>
            const backend = harness.backends.at(-1)!
            backend.cancelPrompt.mockImplementationOnce(() => new Promise<void>(resolve => { releaseCancel = resolve }))
            const switchPromise = switchHandler()
            await vi.waitFor(() => expect(releaseCancel).toBeTypeOf('function'))
            queue.push('late', { permissionMode: 'default', model: 'kimi-k3' }, 'late')
            await new Promise<void>(resolve => setImmediate(resolve))
            await new Promise<void>(resolve => setImmediate(resolve))
            // Pre-fix the dequeue signal stayed live during the teardown: the
            // row was dequeued+ACKed and its model applied on the closing
            // backend. The teardown must abort the signal at entry instead.
            expect(consumed).not.toHaveBeenCalled()
            expect((backend.setModel as ReturnType<typeof vi.fn>).mock.calls
                .some((call: unknown[]) => call[1] === 'kimi-k3')).toBe(false)
            releaseCancel?.()
            await switchPromise
            expect(queue.pendingLocalIds()).toEqual([])
            queue.close()
            await launchPromise
        } finally {
            releaseCancel?.()
            queue.close()
            await launchPromise.catch(() => {})
        }
    })

    it('does not prepend skill_lookup instructions onto user turns', async () => {
        await kimiRemoteLauncher(createSession() as never, { model: 'kimi-k2' })

        expect(harness.prompts).toHaveLength(2)
        expect(JSON.stringify(harness.prompts[0])).toContain('first')
        expect(JSON.stringify(harness.prompts[0])).not.toContain('skill_lookup')
        expect(JSON.stringify(harness.prompts[0])).not.toContain('$name')
        expect(JSON.stringify(harness.prompts[1])).not.toContain('skill_lookup')
    })

    it('applies the queued effort and resets to the agent default', async () => {
        await kimiRemoteLauncher(createSession([
            { permissionMode: 'default', model: 'kimi-k2', effort: 'high' },
            { permissionMode: 'default', model: 'kimi-k2', effort: null }
        ]) as never, { model: 'kimi-k2' })

        expect(harness.configCalls).toEqual([
            ['kimi-session-1', 'thinking', 'high'],
            ['kimi-session-1', 'thinking', 'on']
        ])
    })

    it('re-applies the selected effort after a model switch changes the agent level', async () => {
        await kimiRemoteLauncher(createSession([
            { permissionMode: 'default', model: 'kimi-k2', effort: 'high' },
            { permissionMode: 'default', model: 'kimi-k3', effort: 'high' }
        ]) as never, { model: 'kimi-k2' })

        expect(harness.configCalls).toEqual([
            ['kimi-session-1', 'thinking', 'high'],
            ['kimi-session-1', 'thinking', 'high']
        ])
    })
})
