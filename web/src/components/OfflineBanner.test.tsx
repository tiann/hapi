import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OfflineBanner } from './OfflineBanner'

const useOnlineStatusMock = vi.fn(() => true)

vi.mock('@/hooks/useOnlineStatus', () => ({
    useOnlineStatus: () => useOnlineStatusMock()
}))

describe('OfflineBanner', () => {
    beforeEach(() => {
        useOnlineStatusMock.mockReturnValue(true)
    })

    it('shows when the browser and hub are offline', () => {
        useOnlineStatusMock.mockReturnValue(false)

        render(<OfflineBanner isHubConnected={false} isReconnecting={false} />)

        expect(screen.getByText(/currently offline/i)).toBeInTheDocument()
    })

    it('ignores navigator.onLine when the hub is connected', () => {
        useOnlineStatusMock.mockReturnValue(false)

        render(<OfflineBanner isHubConnected={true} isReconnecting={false} />)

        expect(screen.queryByText(/currently offline/i)).toBeNull()
    })

    it('defers to the reconnecting banner during an SSE outage', () => {
        useOnlineStatusMock.mockReturnValue(false)

        render(<OfflineBanner isHubConnected={false} isReconnecting={true} />)

        expect(screen.queryByText(/currently offline/i)).toBeNull()
    })
})
