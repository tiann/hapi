import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionChatView } from './SessionChatView'

const mockSession = {
    id: 'test-session-id',
    name: 'Test Session',
    active: true,
    metadata: { path: '/test/path', flavor: 'claude' },
}

const mockApi = {
    resumeSession: vi.fn(),
    getSession: vi.fn(),
}

// Mock dependencies
vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
    useParams: () => ({ sessionId: 'test-session-id' }),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: mockApi }),
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
    useSession: () => ({
        session: mockSession,
        refetch: vi.fn(),
    }),
}))

vi.mock('@/entities/message', () => ({
    useMessages: () => ({
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
    }),
    useSendMessage: () => ({
        sendMessage: vi.fn(),
        retryMessage: vi.fn(),
        isSending: false,
    }),
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

function renderWithProviders(ui: React.ReactElement) {
    const queryClient = new QueryClient({
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

describe('SessionChatView', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('renders the chat view', () => {
        renderWithProviders(<SessionChatView />)
        expect(screen.getByTestId('session-chat')).toBeInTheDocument()
    })
})
