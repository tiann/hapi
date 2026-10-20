import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { DshMode } from './types'

const harness = vi.hoisted(() => ({
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    newSessionConfig: null as unknown,
    prompts: [] as unknown[][],
    permissionGetMode: null as (() => string | undefined) | null
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
        constructor(
            _client: unknown,
            _backend: unknown,
            getPermissionMode: () => string | undefined
        ) {
            harness.permissionGetMode = getPermissionMode
        }
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { DshRemoteLauncher } from './dshRemoteLauncher'

function createSession(permissionMode?: string) {
    const queue = new MessageQueue2<DshMode>((mode) => JSON.stringify(mode))
    queue.push('first', 'dsh')
    queue.close()

    return {
        path: '/tmp/dsh-test',
        logPath: '/tmp/dsh-test/hapi.log',
        client: { rpcHandlerManager: { registerHandler: vi.fn() } },
        queue,
        sessionId: null as string | null,
        getPermissionMode: () => permissionMode,
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
        harness.permissionGetMode = null
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

    it('wires the session permission mode into the ACP permission bridge', async () => {
        // The bridge must consult the live session mode on every permission
        // request — without this wiring, yolo cannot auto-approve and every
        // request escalates to a permission card.
        const session = createSession('yolo')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.permissionGetMode).not.toBeNull()
        expect(harness.permissionGetMode?.()).toBe('yolo')
    })

    it('observes runtime mode changes made after launch (SetSessionConfig wiring)', async () => {
        // The mode picker applies changes via SetSessionConfig →
        // session.setPermissionMode; the bridge must read through to the
        // session on each permission request, not a launch-time copy.
        const session = createSession('default')
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()
        session.getPermissionMode = () => 'yolo'

        expect(harness.permissionGetMode?.()).toBe('yolo')
    })

    it('reports an unset permission mode to the bridge (card escalation)', async () => {
        const session = createSession(undefined)
        const launcher = new DshRemoteLauncher(session as never)

        await launcher.launch()

        expect(harness.permissionGetMode?.()).toBeUndefined()
    })
})
