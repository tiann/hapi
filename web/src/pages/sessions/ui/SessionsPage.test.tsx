import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionsPage } from './SessionsPage'

// Mock dependencies
vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: '/sessions' }),
    useMatchRoute: () => vi.fn(() => null),
    Outlet: () => <div data-testid="outlet">Outlet</div>,
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: {} }),
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string, params?: Record<string, unknown>) => {
            if (key === 'sessions.count') {
                return `${params?.n} sessions in ${params?.m} projects`
            }
            return key
        },
    }),
}))

vi.mock('@/entities/session', () => ({
    useSessions: () => ({
        sessions: [
            { id: 'session-1', metadata: { path: '/project1' } },
            { id: 'session-2', metadata: { path: '/project2' } },
        ],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
    }),
    SessionList: ({ sessions, isLoading }: { sessions: unknown[]; isLoading: boolean }) => (
        <div data-testid="session-list">
            {isLoading ? 'Loading...' : `${sessions.length} sessions`}
        </div>
    ),
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

describe('SessionsPage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('renders the page', () => {
        renderWithProviders(<SessionsPage />)
        expect(screen.getByTestId('session-list')).toBeInTheDocument()
    })

    it('displays session count', () => {
        renderWithProviders(<SessionsPage />)
        expect(screen.getAllByText(/2 sessions in 2 projects/)[0]).toBeInTheDocument()
    })

    it('renders settings button', () => {
        renderWithProviders(<SessionsPage />)
        const settingsButtons = screen.getAllByTitle('settings.title')
        expect(settingsButtons.length).toBeGreaterThan(0)
    })

    it('renders new session button', () => {
        renderWithProviders(<SessionsPage />)
        const newButtons = screen.getAllByTitle('sessions.new')
        expect(newButtons.length).toBeGreaterThan(0)
    })

    it('renders outlet for nested routes', () => {
        renderWithProviders(<SessionsPage />)
        const outlets = screen.getAllByTestId('outlet')
        expect(outlets.length).toBeGreaterThan(0)
    })
})
