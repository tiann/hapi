import { afterEach, describe, expect, it, vi } from 'vitest'
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
]) {
    const queue = new MessageQueue2<KimiMode>((mode) => JSON.stringify(mode))
    queue.pushIsolateAndClear('first', modes[0])
    queue.push('second', modes[1])
    queue.close()

    const session = {
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

    it('requeues the hub-ACKed batch when a plain Stop lands during the queued model apply', async () => {
        const queue = new MessageQueue2<KimiMode>((mode) => JSON.stringify(mode))
        queue.push('first', { permissionMode: 'default', model: 'kimi-k3' })
        const session = {
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
            // The batch was dequeued and hub-ACKed; the Stop must preserve it
            // behind the in-flight teardown instead of dispatching a cancelled
            // turn.
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

    it('an idle switch teardown does not consume a newly arrived row', async () => {
        const queue = new MessageQueue2<KimiMode>((mode) => JSON.stringify(mode))
        const consumed = vi.fn()
        queue.onBatchConsumed = consumed
        const session = {
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
