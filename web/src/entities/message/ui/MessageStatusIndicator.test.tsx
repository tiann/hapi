import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageStatusIndicator } from './MessageStatusIndicator'

describe('MessageStatusIndicator', () => {
    it('renders nothing for sending status', () => {
        const { container } = render(<MessageStatusIndicator status="sending" />)
        expect(container.firstChild).toBeNull()
    })

    it('renders nothing for sent status', () => {
        const { container } = render(<MessageStatusIndicator status="sent" />)
        expect(container.firstChild).toBeNull()
    })

    it('renders error icon for failed status', () => {
        const { container } = render(<MessageStatusIndicator status="failed" />)
        expect(container.firstChild).not.toBeNull()
        expect(container.querySelector('svg')).toBeInTheDocument()
    })

    it('renders retry button when onRetry is provided', () => {
        const onRetry = () => {}
        render(<MessageStatusIndicator status="failed" onRetry={onRetry} />)
        expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    })

    it('renders nothing for undefined status', () => {
        const { container } = render(<MessageStatusIndicator status={undefined} />)
        expect(container.firstChild).toBeNull()
    })
})
