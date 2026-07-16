import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReconnectingBanner } from './ReconnectingBanner'

describe('ReconnectingBanner', () => {
    it('shows whenever the hub SSE connection is reconnecting', () => {
        render(<ReconnectingBanner isReconnecting reason="error" />)

        expect(screen.getByText(/reconnecting/i)).toBeInTheDocument()
    })

    it('stays hidden while connected', () => {
        render(<ReconnectingBanner isReconnecting={false} />)

        expect(screen.queryByText(/reconnecting/i)).toBeNull()
    })
})
