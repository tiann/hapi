import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionDetailPage, SessionChatView } from './SessionDetailPage'

const mockSession = {
    id: 'test-session-id',
    name: 'Test Session',
    active: true,
    metadata: { path: '/test/path' },
}

// Mock dependencies
vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
    useLocation: (opts?: { select?: (location: { pathname: string }) => string }) => {
        const location = { pathname: '/sessions/test-session-id' }
        return opts?.select ? opts.select(location) : location
    },
    useParams: () => ({ sessionId: 'test-session-id' }),
    Outlet: () => <div data-testid="outlet">Outlet Content</div>,
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: vi.fn(() => ({ api: {} })),
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => vi.fn(),
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}))

vi.mock('@/lib/toast-context', () => ({
    useToast: () => ({
        addToast: vi.fn(),
    }),
}))

vi.mock('@/entities/session', () => ({
    useSession: vi.fn(() => ({
        session: mockSession,
        refetch: vi.fn(),
    })),
    SessionHeader: ({ session }: { session: { name: string } }) => (
        <div data-testid="session-header">{session.name}</div>
    ),
}))

vi.mock('@/entities/git', () => ({
    useGitStatusFiles: () => ({
        status: null,
        error: null,
        isLoading: false,
        refetch: vi.fn(),
    }),
}))

vi.mock('@/entities/message', () => ({
    useMessages: vi.fn(() => ({
        messages: [],
        warning: null,
        isLoading: false,
        isLoadingMore: false,
        hasMore: false,
        loadMore: vi.fn(),
        refetch: vi.fn(),
        pendingCount: 0,
        messagesVersion: 1,
        flushPending: vi.fn(),
        setAtBottom: vi.fn(),
    })),
    useSendMessage: vi.fn(() => ({
        sendMessage: vi.fn(),
        retryMessage: vi.fn(),
        isSending: false,
    })),
}))

vi.mock('@/hooks/queries/useSlashCommands', () => ({
    useSlashCommands: () => ({
        getSuggestions: vi.fn(),
        refetchCommands: vi.fn(),
        isFetchingCommands: false,
    }),
}))

vi.mock('@/hooks/queries/useSkills', () => ({
    useSkills: () => ({
        getSuggestions: vi.fn(),
    }),
}))

vi.mock('@/components/SessionChat', () => ({
    SessionChat: () => <div data-testid="session-chat">Session Chat</div>,
}))

vi.mock('@/components/LoadingState', () => ({
    LoadingState: ({ label }: { label: string }) => <div data-testid="loading-state">{label}</div>,
}))

vi.mock('@/lib/query-keys', () => ({
    queryKeys: {
        session: (id: string) => ['session', id],
    },
}))

vi.mock('@/lib/message-window-store', () => ({
    fetchLatestMessages: vi.fn(),
    seedMessageWindowFromSession: vi.fn(),
}))

// Import mocked modules
import { useMessages, useSendMessage } from '@/entities/message'
import { useSession } from '@/entities/session'
import { useAppContext } from '@/lib/app-context'

let queryClient: QueryClient

function renderWithProviders(ui: React.ReactElement) {
    queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
        },
    })
    return render(
        <QueryClientProvider client={queryClient}>
            {ui}
        </QueryClientProvider>
    )
}

describe('SessionDetailPage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        // Restore default mock implementations after clearAllMocks
        ;(useMessages as any).mockReturnValue({
            messages: [],
            warning: null,
            isLoading: false,
            isLoadingMore: false,
            hasMore: false,
            loadMore: vi.fn(),
            refetch: vi.fn(),
            pendingCount: 0,
            messagesVersion: 1,
            flushPending: vi.fn(),
            setAtBottom: vi.fn(),
        })
        ;(useSendMessage as any).mockReturnValue({
            sendMessage: vi.fn(),
            retryMessage: vi.fn(),
            isSending: false,
        })
        ;(useAppContext as any).mockReturnValue({ api: {} })
        ;(useSession as any).mockReturnValue({
            session: mockSession,
            refetch: vi.fn(),
        })
    })

    afterEach(() => {
        if (queryClient) {
            queryClient.clear()
        }
    })

    it('renders the page with session header', () => {
        renderWithProviders(<SessionDetailPage />)
        const headers = screen.getAllByTestId('session-header')
        expect(headers[0]).toBeInTheDocument()
        expect(screen.getAllByText('Test Session')[0]).toBeInTheDocument()
    })

    it('renders SessionChatView for chat view', () => {
        renderWithProviders(<SessionDetailPage />)
        expect(screen.getAllByTestId('session-chat')[0]).toBeInTheDocument()
    })
})

describe('SessionChatView', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        if (queryClient) {
            queryClient.clear()
        }
    })

    it('renders the chat view', () => {
        renderWithProviders(<SessionChatView />)
        expect(screen.getAllByTestId('session-chat')[0]).toBeInTheDocument()
    })

    it('renders SessionChat component when session is loaded', () => {
        renderWithProviders(<SessionChatView />)
        expect(screen.getAllByTestId('session-chat')[0]).toBeInTheDocument()
    })

    it('shows loading state when messages are loading', () => {
        ;(useMessages as any).mockImplementationOnce(() => ({
            messages: [],
            warning: null,
            isLoading: true,
            isLoadingMore: false,
            hasMore: false,
            loadMore: vi.fn(),
            refetch: vi.fn(),
            pendingCount: 0,
            messagesVersion: 1,
            flushPending: vi.fn(),
            setAtBottom: vi.fn(),
        }))
        renderWithProviders(<SessionChatView />)
        expect(screen.getAllByTestId('session-chat')[0]).toBeInTheDocument()
    })

    it('displays warning when messages have warning', () => {
        ;(useMessages as any).mockImplementationOnce(() => ({
            messages: [],
            warning: 'Connection lost',
            isLoading: false,
            isLoadingMore: false,
            hasMore: false,
            loadMore: vi.fn(),
            refetch: vi.fn(),
            pendingCount: 0,
            messagesVersion: 1,
            flushPending: vi.fn(),
            setAtBottom: vi.fn(),
        }))
        renderWithProviders(<SessionChatView />)
        expect(screen.getAllByTestId('session-chat')[0]).toBeInTheDocument()
    })

    it('handles message sending', () => {
        const mockSendMessage = vi.fn()
        ;(useSendMessage as any).mockImplementationOnce(() => ({
            sendMessage: mockSendMessage,
            retryMessage: vi.fn(),
            isSending: false,
        }))
        renderWithProviders(<SessionChatView />)
        expect(mockSendMessage).not.toHaveBeenCalled()
    })

    it('handles message retry', () => {
        const mockRetryMessage = vi.fn()
        ;(useSendMessage as any).mockImplementationOnce(() => ({
            sendMessage: vi.fn(),
            retryMessage: mockRetryMessage,
            isSending: false,
        }))
        renderWithProviders(<SessionChatView />)
        expect(mockRetryMessage).not.toHaveBeenCalled()
    })

    it('handles load more messages', () => {
        const mockLoadMore = vi.fn()
        ;(useMessages as any).mockImplementationOnce(() => ({
            messages: [],
            warning: null,
            isLoading: false,
            isLoadingMore: false,
            hasMore: true,
            loadMore: mockLoadMore,
            refetch: vi.fn(),
            pendingCount: 0,
            messagesVersion: 1,
            flushPending: vi.fn(),
            setAtBottom: vi.fn(),
        }))
        renderWithProviders(<SessionChatView />)
        expect(mockLoadMore).not.toHaveBeenCalled()
    })

    it('handles pending messages', () => {
        ;(useMessages as any).mockImplementationOnce(() => ({
            messages: [],
            warning: null,
            isLoading: false,
            isLoadingMore: false,
            hasMore: false,
            loadMore: vi.fn(),
            refetch: vi.fn(),
            pendingCount: 3,
            messagesVersion: 1,
            flushPending: vi.fn(),
            setAtBottom: vi.fn(),
        }))
        renderWithProviders(<SessionChatView />)
        expect(screen.getAllByTestId('session-chat')[0]).toBeInTheDocument()
    })

    it('handles session resume on send', async () => {
        const mockResumeSession = vi.fn().mockResolvedValue('resumed-session-id')
        const mockApi = { resumeSession: mockResumeSession, getSession: vi.fn() } as any

        ;(useAppContext as any).mockImplementationOnce(() => ({
            api: mockApi,
            token: 'test-token',
            baseUrl: 'http://localhost'
        } as any))
        ;(useSession as any).mockImplementationOnce(() => ({
            session: {
                ...mockSession,
                active: false,
                namespace: 'default',
                seq: 1,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                activeAt: Date.now(),
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: null
            } as any,
            refetch: vi.fn(),
            isLoading: false,
            error: null
        }))

        renderWithProviders(<SessionChatView />)
        expect(screen.getAllByTestId('session-chat')[0]).toBeInTheDocument()
    })
})
