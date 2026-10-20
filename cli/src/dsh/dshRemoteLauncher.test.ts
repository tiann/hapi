import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { DshMode } from './types'

const harness = vi.hoisted(() => ({
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    newSessionConfig: null as unknown,
    newSessionCalls: [] as unknown[],
    promptSessionIds: [] as string[],
    prompts: [] as unknown[][],
    supportsResume: false,
    resumeCalls: [] as unknown[],
    resumeError: null as Error | null
}))

vi.mock('./utils/dshBackend', () => ({
    createDshBackend: vi.fn(() => {
        const backend = {
            initialize: vi.fn(async () => {}),
            newSession: vi.fn(async (config: unknown) => {
                harness.newSessionConfig = config
                harness.newSessionCalls.push(config)
                return `dsh-session-${harness.newSessionCalls.length}`
            }),
            prompt: vi.fn(async (sessionId: string, content: unknown[], onUpdate: (message: unknown) => void) => {
                harness.promptSessionIds.push(sessionId)
                harness.prompts.push(content)
                onUpdate({ type: 'text', text: 'answer' })
            }),
            cancelPrompt: vi.fn(async () => {}),
            supportsSessionResume: vi.fn(() => harness.supportsResume),
            resumeSession: vi.fn(async (config: unknown) => {
                harness.resumeCalls.push(config)
                if (harness.resumeError) throw harness.resumeError
                return (config as { sessionId: string }).sessionId
            }),
            onStderrError: vi.fn(),
            onPermissionRequest: vi.fn(),
            disconnect: vi.fn(async () => {})
        }
        harness.backend = backend
        return backend
    })
}))

vi.mock('@/modules/common/permission/AcpPermissionHandler', () => ({
    AcpPermissionHandler: class {
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { DshRemoteLauncher } from './dshRemoteLauncher'

function createQueue() {
    const queue = new MessageQueue2<DshMode>((mode) => JSON.stringify(mode))
    return queue
}

function createSession(queue = createQueue(), sessionId: string | null = null) {
    const session = {
        path: '/tmp/dsh-test',
        logPath: '/tmp/dsh-test/hapi.log',
        client: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateMetadata: vi.fn((fn: (metadata: unknown) => unknown) => fn({})),
            flushMetadata: vi.fn(async () => true)
        },
        queue,
        sessionId,
        // Mirrors AgentSessionBase.onSessionFound: re-pin the id and write
        // dshSessionId metadata through the client.
        onSessionFound: vi.fn((id: string) => {
            session.sessionId = id
            session.client.updateMetadata((metadata: unknown) => ({ ...(metadata as Record<string, unknown>), dshSessionId: id }))
        }),
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
    return session
}

describe('DshRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.newSessionConfig = null
        harness.newSessionCalls = []
        harness.promptSessionIds = []
        harness.prompts = []
        harness.supportsResume = false
        harness.resumeCalls = []
        harness.resumeError = null
    })

    it('creates a fresh ACP session without MCP injection and forwards text prompts', async () => {
        const queue = createQueue()
        queue.push('first', 'dsh')
        queue.close()
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backend?.newSession).toHaveBeenCalledWith({
            cwd: '/tmp/dsh-test',
            mcpServers: []
        })
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
        expect(session.sendAgentMessage).toHaveBeenCalledWith({
            type: 'message',
            message: 'answer'
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        expect(harness.backend?.disconnect).toHaveBeenCalled()
    })

    it('resumes the stored ACP session instead of creating a fresh one', async () => {
        harness.supportsResume = true
        const queue = createQueue()
        queue.push('hello again', 'dsh')
        queue.close()
        const session = createSession(queue, 'dsh-stored-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.resumeCalls).toEqual([{
            sessionId: 'dsh-stored-1',
            cwd: '/tmp/dsh-test',
            mcpServers: []
        }])
        expect(harness.newSessionCalls).toHaveLength(0)
        expect(harness.promptSessionIds).toEqual(['dsh-stored-1'])
        // Resumed id unchanged → still re-pinned: the write is an idempotent
        // metadata merge that self-heals rows whose earlier pin was lost.
        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-stored-1')
        expect(session.client.flushMetadata).toHaveBeenCalled()
    })

    it('persists the native id when an explicit resume opens a fresh HAPI row', async () => {
        // `hapi dsh --resume <id>` without --existing-session-id starts from a
        // new row whose metadata has no dshSessionId; the launcher must pin
        // the id even though the resume returns exactly the requested one.
        harness.supportsResume = true
        const queue = createQueue()
        queue.push('continue', 'dsh')
        queue.close()
        const session = createSession(queue, 'dsh-explicit-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.resumeCalls).toHaveLength(1)
        expect(harness.promptSessionIds).toEqual(['dsh-explicit-1'])
        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-explicit-1')
        expect(session.client.flushMetadata).toHaveBeenCalled()
    })

    it('falls back to a fresh session when resume fails and re-pins metadata', async () => {
        harness.supportsResume = true
        harness.resumeError = new Error('session not found on disk')
        const queue = createQueue()
        queue.push('hello', 'dsh')
        queue.close()
        const session = createSession(queue, 'dsh-stale-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.resumeCalls).toHaveLength(1)
        expect(harness.newSessionCalls).toHaveLength(1)
        expect(harness.promptSessionIds).toEqual(['dsh-session-1'])
        // The fresh id must replace the stale one in metadata.
        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-session-1')
        expect(session.client.flushMetadata).toHaveBeenCalled()
        expect(session.sessionId).toBe('dsh-session-1')
    })

    it('pins dshSessionId metadata for a fresh session before the main loop', async () => {
        const queue = createQueue()
        queue.push('first', 'dsh')
        queue.close()
        const session = createSession(queue)
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-session-1')
        expect(session.client.updateMetadata).toHaveBeenCalledWith(expect.any(Function))
        expect(session.client.flushMetadata).toHaveBeenCalled()
        expect(session.sessionId).toBe('dsh-session-1')
    })
})
