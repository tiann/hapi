import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SystemStatus } from './SystemStatus'

const useOnlineStatusMock = vi.fn(() => true)

vi.mock('@/shared/hooks/useOnlineStatus', () => ({
    useOnlineStatus: () => useOnlineStatusMock()
}))

vi.mock('@/components/Spinner', () => ({
    Spinner: ({ label }: { label: string | null }) => <div data-testid="spinner">{label}</div>
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => {
            const map: Record<string, string> = {
                'offline.message': 'You are offline',
                'reconnecting.message': 'Reconnecting',
                'reconnecting.reason.heartbeatTimeout': 'Heartbeat timeout',
                'reconnecting.reason.closed': 'Connection closed',
                'reconnecting.reason.error': 'Connection error',
                'syncing.title': 'Syncing'
            }
            return map[key] ?? key
        }
    })
}))

describe('SystemStatus', () => {
    beforeEach(() => {
        useOnlineStatusMock.mockReturnValue(true)
        vi.clearAllMocks()
    })

    it('renders nothing when all states are normal', () => {
        const { container } = render(
            <SystemStatus
                isReconnecting={false}
                reconnectReason={null}
                isSyncing={false}
            />
        )

        expect(container.firstChild).toBeNull()
    })

    it('shows offline banner when offline', () => {
        useOnlineStatusMock.mockReturnValue(false)

        render(
            <SystemStatus
                isReconnecting={false}
                reconnectReason={null}
                isSyncing={false}
            />
        )

        expect(screen.getByText('You are offline')).toBeInTheDocument()
    })

    it('shows reconnecting banner with reason', () => {
        useOnlineStatusMock.mockReturnValue(true)

        render(
            <SystemStatus
                isReconnecting={true}
                reconnectReason="heartbeat-timeout"
                isSyncing={false}
            />
        )

        expect(screen.getByText('Reconnecting')).toBeInTheDocument()
        expect(screen.getByText('(Heartbeat timeout)')).toBeInTheDocument()
    })

    it('shows reconnecting banner without reason', () => {
        useOnlineStatusMock.mockReturnValue(true)

        const { container } = render(
            <SystemStatus
                isReconnecting={true}
                reconnectReason={null}
                isSyncing={false}
            />
        )

        const reconnectingElements = screen.getAllByText('Reconnecting')
        expect(reconnectingElements.length).toBeGreaterThan(0)
        expect(container.textContent).not.toContain('(')
    })

    it('shows syncing banner', () => {
        useOnlineStatusMock.mockReturnValue(true)

        render(
            <SystemStatus
                isReconnecting={false}
                reconnectReason={null}
                isSyncing={true}
            />
        )

        expect(screen.getByText('Syncing')).toBeInTheDocument()
        expect(screen.getByTestId('spinner')).toBeInTheDocument()
    })

    it('prioritizes offline over reconnecting', () => {
        useOnlineStatusMock.mockReturnValue(false)

        const { container } = render(
            <SystemStatus
                isReconnecting={true}
                reconnectReason="error"
                isSyncing={false}
            />
        )

        const offlineElements = screen.getAllByText('You are offline')
        expect(offlineElements.length).toBeGreaterThan(0)
        expect(container.textContent).not.toContain('Reconnecting')
    })

    it('prioritizes reconnecting over syncing', () => {
        useOnlineStatusMock.mockReturnValue(true)

        const { container } = render(
            <SystemStatus
                isReconnecting={true}
                reconnectReason="closed"
                isSyncing={true}
            />
        )

        const reconnectingElements = screen.getAllByText('Reconnecting')
        expect(reconnectingElements.length).toBeGreaterThan(0)
        expect(container.textContent).not.toContain('Syncing')
    })
})
