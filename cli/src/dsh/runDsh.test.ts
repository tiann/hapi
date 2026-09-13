import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    bootstrapArgs: [] as Array<Record<string, unknown>>,
    session: {
        onUserMessage: vi.fn(),
        onCancelQueuedMessage: vi.fn(),
        rpcHandlerManager: {
            registerHandler: vi.fn()
        }
    },
    queue: {
        items: [] as Array<{ message: string; mode: string; localId?: string }>,
        push(message: string, mode: string, localId?: string) {
            this.items.push({ message, mode, localId })
        },
        cancelByLocalId: vi.fn()
    }
}))

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: vi.fn(async (options: Record<string, unknown>) => {
        harness.bootstrapArgs.push(options)
        return { api: {}, session: harness.session, sessionInfo: {} }
    }),
    bootstrapExistingSession: vi.fn(async (options: Record<string, unknown>) => {
        harness.bootstrapArgs.push(options)
        return { api: {}, session: harness.session, sessionInfo: {} }
    })
}))

vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn()
}))

vi.mock('@/agent/runnerLifecycle', () => ({
    createRunnerLifecycle: vi.fn(() => ({
        registerProcessHandlers: vi.fn(),
        cleanupAndExit: vi.fn(async () => {}),
        markCrash: vi.fn(),
        setSessionEndReason: vi.fn()
    })),
    setControlledByUser: vi.fn()
}))

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        getLogPath: vi.fn(() => '/tmp/hapi.log')
    }
}))

const formatUserMessageForAgent = vi.hoisted(() =>
    vi.fn((text: string, _attachments?: unknown, meta?: unknown) => {
        if (meta && typeof meta === 'object' && (meta as { sentFrom?: string }).sentFrom === 'peer') {
            return `From: /sessions/peer-sender\n\n${text}`
        }
        return text
    })
)

vi.mock('@/utils/attachmentFormatter', () => ({
    formatUserMessageForAgent
}))

vi.mock('./session', () => ({
    DshSession: vi.fn(function DshSession(this: { start: ReturnType<typeof vi.fn> }, _opts: unknown) {
        this.start = vi.fn(async () => {})
    })
}))

vi.mock('./dshRemoteLauncher', () => ({
    DshRemoteLauncher: vi.fn(function DshRemoteLauncher(this: { launch: ReturnType<typeof vi.fn> }, _session: unknown) {
        this.launch = vi.fn(async () => {})
    })
}))

vi.mock('@/utils/MessageQueue2', () => ({
    MessageQueue2: vi.fn(function MessageQueue2(this: typeof harness.queue) {
        Object.assign(this, harness.queue)
        harness.queue.items = []
    })
}))

describe('runDsh peer delivery', () => {
    beforeEach(() => {
        harness.bootstrapArgs.length = 0
        harness.queue.items = []
        harness.session.onUserMessage.mockReset()
        formatUserMessageForAgent.mockClear()
    })

    it('formats peer deliveries with formatUserMessageForAgent (#1203)', async () => {
        const { runDsh } = await import('./runDsh')
        const runPromise = runDsh({ workingDirectory: '/tmp/project' })
        await new Promise((resolve) => setTimeout(resolve, 0))

        const userMessageHandler = harness.session.onUserMessage.mock.calls[0]?.[0] as
            | ((msg: { content: { text: string; attachments?: unknown[] }; meta?: { sentFrom?: string } }, localId?: string) => void)
            | undefined
        expect(userMessageHandler).toBeTypeOf('function')

        userMessageHandler!({
            content: { text: '/compact steal context' },
            meta: { sentFrom: 'peer' },
        }, 'peer-compact')

        expect(formatUserMessageForAgent).toHaveBeenCalledWith(
            '/compact steal context',
            undefined,
            { sentFrom: 'peer' }
        )

        await runPromise.catch(() => {})
    })
})
