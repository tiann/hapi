import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionDetailPage } from '@/pages/session-detail'

const navigateMock = vi.fn()

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: null,
    }),
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => vi.fn(),
}))

vi.mock('@tanstack/react-router', async () => {
    const actual = await import('@tanstack/react-router')
    return {
        ...actual,
        Outlet: () => <div data-testid="route-outlet" />,
        useNavigate: () => navigateMock,
        useLocation: ({ select }: { select: (location: { pathname: string }) => string }) => select({ pathname: '/sessions/session-1/files' }),
        useParams: () => ({ sessionId: 'session-1' }),
    }
})

vi.mock('@/entities/session', () => ({
    useSession: () => ({
        session: {
            id: 'session-1',
            active: true,
            metadata: { path: '/tmp/project', flavor: 'claude' },
            agentState: {},
            permissionMode: 'ask',
            modelMode: 'default',
            thinking: false,
            teamState: null,
        },
        refetch: vi.fn(),
    }),
    SessionHeader: (props: { onSessionDeleted?: () => void }) => (
        <button type="button" onClick={props.onSessionDeleted}>
            delete session
        </button>
    ),
}))

vi.mock('@/entities/git', () => ({
    useGitStatusFiles: () => ({
        status: null,
        error: null,
        isLoading: false,
        refetch: vi.fn(async () => ({})),
    }),
}))

vi.mock('@/components/LoadingState', () => ({
    LoadingState: ({ label }: { label: string }) => <div>{label}</div>,
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

describe('SessionDetailPage', () => {
    it('navigates to session list after deleting from child route', () => {
        renderWithProviders(<SessionDetailPage />)

        expect(screen.getByRole('button', { name: 'delete session' })).toBeInTheDocument()
        expect(screen.getByTestId('route-outlet')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'delete session' }))

        expect(navigateMock).toHaveBeenCalledWith({ to: '/sessions' })
    })
})

