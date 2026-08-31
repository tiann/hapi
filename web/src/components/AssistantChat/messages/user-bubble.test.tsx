import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'

vi.mock('@/components/LazyRainbowText', () => ({
    LazyRainbowText: ({ text, inline, preserveSingleLineBreaks }: { text: string; inline?: boolean; preserveSingleLineBreaks?: boolean }) => (
        <span
            data-testid="lazy-rainbow-text"
            data-inline={inline ? 'true' : 'false'}
            data-preserve-single-line-breaks={preserveSingleLineBreaks ? 'true' : 'false'}
        >
            {text}
        </span>
    )
}))

import { UserBubbleContent, extractLeadingDirectives, formatDirectiveLabel, getUserBubbleClassName } from '@/components/AssistantChat/messages/user-bubble'

describe('extractLeadingDirectives', () => {
    it('extracts leading skill and command directives', () => {
        expect(extractLeadingDirectives('$deep-interview /model keep going')).toEqual({
            directives: ['$deep-interview', '/model'],
            body: 'keep going'
        })
    })

    it('leaves ordinary text untouched', () => {
        expect(extractLeadingDirectives('plain message')).toEqual({
            directives: [],
            body: 'plain message'
        })
    })

    it('does not treat absolute paths as slash directives', () => {
        expect(extractLeadingDirectives('/Users/bytedance/project')).toEqual({
            directives: [],
            body: '/Users/bytedance/project'
        })
    })
})

describe('UserBubbleContent', () => {
    it('renders directive chips inline with the remaining single-line message body', () => {
        render(<UserBubbleContent text="$ralplan polish the user bubble" />)

        expect(screen.getByText('ralplan')).toBeInTheDocument()
        expect(screen.getByText('polish the user bubble')).toBeInTheDocument()
        expect(screen.getByTitle('$ralplan')).toBeInTheDocument()
        expect(screen.getByTestId('lazy-rainbow-text')).toHaveAttribute('data-inline', 'true')
    })

    it('asks LazyRainbowText to preserve single newlines in sent prompt bodies', () => {
        const { container } = render(<UserBubbleContent text={'Line one\nLine two\nLine three'} />)
        const lazyText = container.querySelector('[data-testid="lazy-rainbow-text"]')

        expect(lazyText).toHaveAttribute('data-preserve-single-line-breaks', 'true')
    })

    it('preserves original directive casing in chip labels', () => {
        expect(formatDirectiveLabel('$DeEp-INTERVIEW')).toBe('DeEp INTERVIEW')
    })

    it('collapses user messages after 15 lines and expands on demand', () => {
        const text = Array.from({ length: 16 }, (_, index) => `line ${index + 1}`).join('\n')
        render(
            <I18nProvider>
                <UserBubbleContent text={text} />
            </I18nProvider>
        )

        expect(screen.getByText(/line 15/)).toBeInTheDocument()
        expect(screen.queryByText(/line 16/)).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Expand full message' }))
        expect(screen.getByText(/line 16/)).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Collapse message' }))
        expect(screen.queryByText(/line 16/)).not.toBeInTheDocument()
    })

    it('uses the shadowless queued bubble styling', () => {
        const className = getUserBubbleClassName('queued')
        expect(className).toContain('shadow-none')
        expect(className).toContain('opacity-60')
    })
})
