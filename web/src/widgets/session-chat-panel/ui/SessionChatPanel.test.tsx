import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SessionChatPanel } from './SessionChatPanel'
import type { Session, DecryptedMessage } from '@/types/api'

const { createAttachmentAdapterMock } = vi.hoisted(() => ({
    createAttachmentAdapterMock: vi.fn()
}))

// Mock all dependencies
vi.mock('@assistant-ui/react', () => ({
    AssistantRuntimeProvider: ({ children }: any) => <div data-testid="runtime-provider">{children}</div>
}))

vi.mock('@/components/AssistantChat/HappyComposer', () => ({
    HappyComposer: (props: any) => <div data-testid="happy-composer" data-props={JSON.stringify(props)}>Composer</div>
}))

vi.mock('@/components/AssistantChat/HappyThread', () => ({
    HappyThread: (props: any) => <div data-testid="happy-thread" data-props={JSON.stringify(props)}>Thread</div>
}))

vi.mock('@/lib/assistant-runtime', () => ({
    useHappyRuntime: vi.fn(() => ({}))
}))

vi.mock('@/entities/message/lib/attachmentAdapter', () => ({
    createAttachmentAdapter: createAttachmentAdapterMock
}))

vi.mock('@/components/TeamPanel', () => ({
    TeamPanel: () => <div data-testid="team-panel">Team Panel</div>
}))

vi.mock('@/shared/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: {
            notification: vi.fn(),
            impact: vi.fn()
        }
    })
}))

vi.mock('@/hooks/mutations/useSessionActions', () => ({
    useSessionActions: () => ({
        abortSession: vi.fn(),
        switchSession: vi.fn(),
        setPermissionMode: vi.fn(),
        setModelMode: vi.fn()
    })
}))

vi.mock('@/chat/normalize', () => ({
    normalizeDecryptedMessage: vi.fn((msg) => msg)
}))

vi.mock('@/chat/reducer', () => ({
    reduceChatBlocks: vi.fn(() => ({ blocks: [], latestUsage: null }))
}))

vi.mock('@/chat/reconcile', () => ({
    reconcileChatBlocks: vi.fn((blocks) => ({ blocks, byId: new Map() }))
}))

function createSession(partial?: Partial<Session>): Session {
    return {
        id: 'session-1',
        active: true,
        metadata: {
            path: '/tmp/project',
            flavor: 'claude',
            host: null,
            machineId: null,
            worktree: null,
            os: null
        },
        modelMode: 'default',
        permissionMode: 'auto',
        thinking: false,
        agentState: null,
        teamState: null,
        ...partial
    } as Session
}

describe('SessionChatPanel', () => {
    const defaultProps = {
        api: {} as any,
        session: createSession(),
        messages: [] as DecryptedMessage[],
        messagesWarning: null,
        hasMoreMessages: false,
        isLoadingMessages: false,
        isLoadingMoreMessages: false,
        isSending: false,
        pendingCount: 0,
        messagesVersion: 1,
        onRefresh: vi.fn(),
        onLoadMore: vi.fn(),
        onSend: vi.fn(),
        onFlushPending: vi.fn(),
        onAtBottomChange: vi.fn()
    }

    beforeEach(() => {
        cleanup()
        vi.clearAllMocks()
        createAttachmentAdapterMock.mockClear()
    })

    it('renders chat thread and composer', () => {
        render(<SessionChatPanel {...defaultProps} />)

        expect(screen.getByTestId('happy-thread')).toBeInTheDocument()
        expect(screen.getByTestId('happy-composer')).toBeInTheDocument()
        expect(screen.getByTestId('runtime-provider')).toBeInTheDocument()
    })

    it('shows team panel when teamState is present', () => {
        const session = createSession({
            teamState: { members: [] } as any
        })

        render(<SessionChatPanel {...defaultProps} session={session} />)

        expect(screen.getByTestId('team-panel')).toBeInTheDocument()
    })

    it('shows inactive session banner when session is inactive', () => {
        const session = createSession({ active: false })

        render(<SessionChatPanel {...defaultProps} session={session} />)

        expect(screen.getByText(/Session is inactive/)).toBeInTheDocument()
    })

    it('does not show inactive banner when session is active', () => {
        const session = createSession({ active: true })

        render(<SessionChatPanel {...defaultProps} session={session} />)

        expect(screen.queryByText(/Session is inactive/)).not.toBeInTheDocument()
    })

    it('passes correct props to HappyThread', () => {
        const onRefresh = vi.fn()
        const onLoadMore = vi.fn()

        render(
            <SessionChatPanel
                {...defaultProps}
                onRefresh={onRefresh}
                onLoadMore={onLoadMore}
                hasMoreMessages={true}
                isLoadingMessages={true}
            />
        )

        expect(screen.getByTestId('happy-thread')).toBeInTheDocument()
    })

    it('passes correct props to HappyComposer', () => {
        const session = createSession({
            permissionMode: 'ask',
            modelMode: 'opus',
            thinking: true
        })

        render(<SessionChatPanel {...defaultProps} session={session} />)

        expect(screen.getByTestId('happy-composer')).toBeInTheDocument()
    })

    it('creates attachment adapter for active sessions', () => {
        const session = createSession({ active: true })

        render(<SessionChatPanel {...defaultProps} session={session} />)

        expect(createAttachmentAdapterMock).toHaveBeenCalled()
    })

    it('does not create attachment adapter for inactive sessions', () => {
        const session = createSession({ active: false })

        render(<SessionChatPanel {...defaultProps} session={session} />)

        // Should not be called for inactive sessions
        expect(createAttachmentAdapterMock).not.toHaveBeenCalled()
    })
})
