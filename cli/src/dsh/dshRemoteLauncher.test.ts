import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { DshMode } from './types'

const harness = vi.hoisted(() => ({
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    newSessionConfig: null as unknown,
    prompts: [] as unknown[][],
    transportClosedHandler: null as ((error: Error) => void) | null,
    promptFailure: null as Error | null
}))

vi.mock('./utils/dshBackend', () => ({
    createDshBackend: vi.fn(() => {
        const backend = {
            initialize: vi.fn(async () => {}),
            newSession: vi.fn(async (config: unknown) => {
                harness.newSessionConfig = config
                return 'dsh-session-1'
            }),
            prompt: vi.fn(async (_sessionId: string, content: unknown[], onUpdate: (message: unknown) => void) => {
                harness.prompts.push(content)
                if (harness.promptFailure) {
                    harness.transportClosedHandler?.(harness.promptFailure)
                    throw harness.promptFailure
                }
                onUpdate({ type: 'text', text: 'answer' })
            }),
            cancelPrompt: vi.fn(async () => {}),
            onStderrError: vi.fn(),
            onTransportClosed: vi.fn((handler: (error: Error) => void) => {
                harness.transportClosedHandler = handler
            }),
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

function createSession(withInitialMessage = true) {
    const queue = new MessageQueue2<DshMode>((mode) => JSON.stringify(mode))
    if (withInitialMessage) {
        queue.push('first', 'dsh')
        queue.close()
    }

    return {
        path: '/tmp/dsh-test',
        logPath: '/tmp/dsh-test/hapi.log',
        client: { rpcHandlerManager: { registerHandler: vi.fn() } },
        queue,
        sessionId: null as string | null,
        getPermissionMode: () => 'default' as const,
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
}

describe('DshRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.newSessionConfig = null
        harness.prompts = []
        harness.transportClosedHandler = null
        harness.promptFailure = null
    })

    it('creates a fresh ACP session without MCP injection and forwards text prompts', async () => {
        const session = createSession()
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

    it('ends the DSH launcher when the ACP transport closes while idle', async () => {
        const session = createSession(false)
        const launcher = new DshRemoteLauncher(session as never)
        const launchPromise = launcher.launch()

        await vi.waitFor(() => expect(harness.transportClosedHandler).not.toBeNull())
        harness.transportClosedHandler!(new Error('ACP process exited (code=1, signal=null)'))

        await expect(launchPromise).rejects.toThrow('ACP process exited')
        expect(harness.backend?.disconnect).toHaveBeenCalled()
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'DSH ACP process stopped: ACP process exited (code=1, signal=null)'
        })
        expect(session.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'ready' })
        expect(harness.prompts).toEqual([])
    })

    it('does not swallow a prompt failure caused by an ACP transport close', async () => {
        const session = createSession()
        harness.promptFailure = new Error('ACP transport closed')
        const launcher = new DshRemoteLauncher(session as never)

        await expect(launcher.launch()).rejects.toThrow('ACP transport closed')
        expect(harness.backend?.disconnect).toHaveBeenCalled()
        expect(session.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'ready' })
    })
})
