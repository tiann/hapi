import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionSummary } from '@/types/api'

const navigateMock = vi.fn()
const useSessionsMock = vi.fn()
const tMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigateMock
}))

vi.mock('@/hooks/queries/useSessions', () => ({
    useSessions: (api: unknown) => useSessionsMock(api)
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: tMock
    })
}))

import { PendingPromptsBanner } from './PendingPromptsBanner'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    const { id, ...rest } = overrides
    return {
        id,
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: { path: '/repo' },
        todoProgress: null,
        pendingRequestsCount: 0,
        ...rest
    }
}

function mockSessions(sessions: SessionSummary[]) {
    useSessionsMock.mockReturnValue({
        sessions,
        isLoading: false,
        error: null,
        refetch: vi.fn()
    })
}

describe('PendingPromptsBanner component', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        tMock.mockImplementation((key: string, params?: Record<string, unknown>) => {
            if (key === 'pendingPrompts.message') {
                return `pending:${params?.n}:${params?.m}:${params?.name}`
            }
            if (key === 'pendingPrompts.open') {
                return 'Open'
            }
            return key
        })
    })

    afterEach(() => {
        cleanup()
    })

    it('renders when pending prompts exist', () => {
        mockSessions([
            makeSession({
                id: 'session-1',
                pendingRequestsCount: 2,
                updatedAt: 100,
                metadata: { path: '/repo', name: 'Session One' }
            }),
            makeSession({
                id: 'session-2',
                pendingRequestsCount: 1,
                updatedAt: 50,
                metadata: { path: '/repo', name: 'Session Two' }
            })
        ])

        render(<PendingPromptsBanner api={null} />)

        const message = screen.getByText('pending:3:2:Session One')
        const openButton = screen.getByRole('button', { name: 'Open' })

        expect(message).toBeInTheDocument()
        expect(message).toHaveClass('truncate')
        expect(openButton).toBeInTheDocument()
        expect(openButton.className).toContain('min-h-[44px]')
    })

    it('does not render when no pending prompts exist', () => {
        mockSessions([
            makeSession({ id: 'session-1', pendingRequestsCount: 0 }),
            makeSession({ id: 'session-2', pendingRequestsCount: 0 })
        ])

        const { container } = render(<PendingPromptsBanner api={null} />)

        expect(container.firstChild).toBeNull()
    })

    it('navigates to the primary pending session when open is clicked', () => {
        mockSessions([
            makeSession({
                id: 'target-session',
                pendingRequestsCount: 1,
                metadata: { path: '/repo', name: 'Target Session' }
            })
        ])

        render(<PendingPromptsBanner api={null} />)

        fireEvent.click(screen.getByRole('button', { name: 'Open' }))

        expect(navigateMock).toHaveBeenCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'target-session' }
        })
    })

    it('uses fixed overlay classes with lower z-index than system banners', () => {
        mockSessions([
            makeSession({
                id: 'session-1',
                pendingRequestsCount: 1,
                metadata: { path: '/repo', name: 'Session One' }
            })
        ])

        const { container } = render(<PendingPromptsBanner api={null} />)
        const banner = container.firstElementChild

        expect(banner).toHaveClass('fixed', 'top-0', 'left-0', 'right-0', 'z-40')
        expect(banner?.className).toContain('pt-[env(safe-area-inset-top)]')
    })

    it('applies slide-down animation class on mount', () => {
        mockSessions([
            makeSession({
                id: 'session-1',
                pendingRequestsCount: 1,
                metadata: { path: '/repo', name: 'Session One' }
            })
        ])

        const { container } = render(<PendingPromptsBanner api={null} />)
        const banner = container.firstElementChild

        expect(banner).toHaveClass('animate-slide-down')
    })
})
