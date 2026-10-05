import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { DshMode } from './types'

const harness = vi.hoisted(() => ({
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    newSessionConfig: null as unknown,
    prompts: [] as unknown[][],
    resumeError: null as Error | null,
    resumeSupported: true
}))

vi.mock('./utils/dshBackend', () => ({
    createDshBackend: vi.fn(() => {
        const backend = {
            initialize: vi.fn(async () => {}),
            supportsSessionResume: vi.fn(() => harness.resumeSupported),
            newSession: vi.fn(async (config: unknown) => {
                harness.newSessionConfig = config
                return 'dsh-session-1'
            }),
            resumeSession: vi.fn(async (config: { sessionId: string }) => {
                if (harness.resumeError) throw harness.resumeError
                return config.sessionId
            }),
            prompt: vi.fn(async (_sessionId: string, content: unknown[], onUpdate: (message: unknown) => void) => {
                harness.prompts.push(content)
                onUpdate({ type: 'text', text: 'answer' })
            }),
            cancelPrompt: vi.fn(async () => {}),
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

function createSession(sessionId: string | null = null) {
    const queue = new MessageQueue2<DshMode>((mode) => JSON.stringify(mode))
    queue.push('first', 'dsh')
    queue.close()

    return {
        path: '/tmp/dsh-test',
        logPath: '/tmp/dsh-test/hapi.log',
        client: { rpcHandlerManager: { registerHandler: vi.fn() } },
        queue,
        sessionId,
        getPermissionMode: () => 'default' as const,
        onThinkingChange: vi.fn(),
        onSessionFound: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
}

describe('DshRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.newSessionConfig = null
        harness.prompts = []
        harness.resumeError = null
        harness.resumeSupported = true
    })

    it('creates a fresh ACP session without MCP injection and forwards text prompts', async () => {
        const session = createSession()
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backend?.newSession).toHaveBeenCalledWith({
            cwd: '/tmp/dsh-test',
            mcpServers: []
        })
        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-session-1')
        expect(harness.prompts).toEqual([[{ type: 'text', text: 'first' }]])
        expect(session.sendAgentMessage).toHaveBeenCalledWith({
            type: 'message',
            message: 'answer'
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        expect(harness.backend?.disconnect).toHaveBeenCalled()
    })

    it('resumes an existing DSH ACP session instead of creating a new one', async () => {
        const session = createSession('dsh-existing-1')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.backend?.resumeSession).toHaveBeenCalledWith({
            sessionId: 'dsh-existing-1',
            cwd: '/tmp/dsh-test',
            mcpServers: []
        })
        expect(harness.backend?.newSession).not.toHaveBeenCalled()
        expect(session.onSessionFound).toHaveBeenCalledWith('dsh-existing-1')
    })

    it('falls back to a fresh DSH session when native resume fails', async () => {
        const session = createSession('dsh-existing-1')
        const launcher = new DshRemoteLauncher(session as never)
        harness.resumeError = new Error('method not found')

        await launcher.launch()

        expect(harness.backend?.resumeSession).toHaveBeenCalled()
        expect(harness.backend?.newSession).toHaveBeenCalledWith({ cwd: '/tmp/dsh-test', mcpServers: [] })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'DSH resume failed; starting a new session.'
        })
    })

    it('falls back without probing session/resume when the server does not advertise it', async () => {
        const session = createSession('dsh-existing-1')
        const launcher = new DshRemoteLauncher(session as never)
        harness.resumeSupported = false

        await launcher.launch()

        expect(harness.backend?.resumeSession).not.toHaveBeenCalled()
        expect(harness.backend?.newSession).toHaveBeenCalledWith({ cwd: '/tmp/dsh-test', mcpServers: [] })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'DSH resume failed; starting a new session.'
        })
    })
})
