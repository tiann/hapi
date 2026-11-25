import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CompactSummaryCard, formatTokenDelta } from './SystemMessage'

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
        render(<CompactSummaryCard delta={null} text="summary" />)

        const toggle = screen.getByRole('button')
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
        fireEvent.click(toggle)
        expect(toggle.getAttribute('aria-expanded')).toBe('true')
    })
})

describe('compaction facts and empty outcomes', () => {
    it.each(['', '  \n '])('uses the ordinary status-line style when no information is available (%j)', text => {
        const { container } = render(<CompactSummaryCard delta={null} text={text} />)
        expect(screen.getByText('Context compacted')).toBeTruthy()
        expect(screen.getByTestId('timestamp')).toBeTruthy()
        expect(screen.queryByRole('button')).toBeNull()
        expect(container.querySelector('.border')).toBeNull()
        expect(container.querySelector('.opacity-80')).not.toBeNull()
    })
    it('shows token information without an empty disclosure', () => {
        render(<CompactSummaryCard delta="~18,335 tokens after (estimated)" text="" />)
        expect(screen.getByText(/18,335/)).toBeTruthy()
        expect(screen.queryByRole('button')).toBeNull()
        expect(screen.queryByTestId('compact-summary-body')).toBeNull()
    })
    it.each([
        [{ tokensBefore: 437396, tokensAfter: 18396 }, '437,396 → 18,396 tokens'],
        [{ tokensBefore: 437396, estimatedTokensAfter: 18396 }, '437,396 → ~18,396 tokens (estimated after)'],
        [{ tokensAfter: 18396 }, '18,396 tokens after'],
        [{ estimatedTokensAfter: 18335 }, '~18,335 tokens after (estimated)'],
        [{ tokensBefore: 0 }, '0 tokens before'],
        [{ tokensAfter: 0 }, '0 tokens after'],
        [{ estimatedTokensAfter: 0 }, '~0 tokens after (estimated)'],
        [{ tokensBefore: 100 }, '100 tokens before'],
        [{ tokensAfter: 2, estimatedTokensAfter: 99 }, '2 tokens after'],
        [{ tokensAfter: -1, estimatedTokensAfter: 3 }, '~3 tokens after (estimated)'],
        [{ tokensBefore: -1, tokensAfter: Infinity, estimatedTokensAfter: 1.5 }, null],
        [{ tokensBefore: NaN, tokensAfter: Number.MAX_SAFE_INTEGER + 1 }, null],
        [{}, null]
    ])('labels only available valid facts (%j)', (facts, expected) => {
        expect(formatTokenDelta({ type: 'compact-summary', summary: '', ...facts })).toBe(expected)
    })
})
