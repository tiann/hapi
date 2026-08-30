import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CompactSummaryCard } from './SystemMessage'

vi.mock('./MessageTimestamp', () => ({
    MessageTimestamp: () => <time data-testid="timestamp">12:00</time>
}))

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: ({ content }: { content: string }) => (
        <div data-testid="compact-summary-body">{content}</div>
    )
}))

describe('CompactSummaryCard', () => {
    it('renders the header with token delta collapsed by default', () => {
        render(<CompactSummaryCard delta="34,492 → 2,082 tokens" text="the summary body" />)

        expect(screen.getByText('Context compacted')).toBeTruthy()
        expect(screen.getByText(/34,492/)).toBeTruthy()
        expect(screen.queryByTestId('compact-summary-body')).toBeNull()
    })

    it('shows the summary body when expanded', () => {
        render(<CompactSummaryCard delta={null} text="the summary body" />)

        const toggle = screen.getByRole('button')
        expect(screen.queryByTestId('compact-summary-body')).toBeNull()

        fireEvent.click(toggle)
        expect(screen.getByTestId('compact-summary-body')).toHaveTextContent('the summary body')

        fireEvent.click(toggle)
        expect(screen.queryByTestId('compact-summary-body')).toBeNull()
    })

    it('reflects the expanded state on aria-expanded', () => {
        render(<CompactSummaryCard delta={null} text="" />)

        const toggle = screen.getByRole('button')
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
        fireEvent.click(toggle)
        expect(toggle.getAttribute('aria-expanded')).toBe('true')
    })
})
