import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NewSessionPage } from './NewSessionPage'

// Mock dependencies
vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: {} }),
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => vi.fn(),
}))

vi.mock('@/entities/machine', () => ({
    useMachines: () => ({
        machines: [
            { id: 'machine-1', name: 'Machine 1' },
            { id: 'machine-2', name: 'Machine 2' },
        ],
        isLoading: false,
        error: null,
    }),
}))

vi.mock('@/entities/session', () => ({
    NewSession: ({ machines, isLoading }: { machines: unknown[]; isLoading: boolean }) => (
        <div data-testid="new-session">
            {isLoading ? 'Loading machines...' : `${machines.length} machines available`}
        </div>
    ),
}))

vi.mock('@/lib/query-keys', () => ({
    queryKeys: {
        sessions: ['sessions'],
    },
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

describe('NewSessionPage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('renders the page', () => {
        renderWithProviders(<NewSessionPage />)
        expect(screen.getByTestId('new-session')).toBeInTheDocument()
    })

    it('displays page title', () => {
        renderWithProviders(<NewSessionPage />)
        expect(screen.getAllByText('newSession.title')[0]).toBeInTheDocument()
    })

    it('renders back button', () => {
        renderWithProviders(<NewSessionPage />)
        const backButtons = screen.getAllByRole('button')
        expect(backButtons.length).toBeGreaterThan(0)
    })

    it('passes machines to NewSession component', () => {
        renderWithProviders(<NewSessionPage />)
        expect(screen.getAllByText('2 machines available')[0]).toBeInTheDocument()
    })
})
