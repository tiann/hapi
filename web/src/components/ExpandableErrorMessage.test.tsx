import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ExpandableErrorMessage } from './ExpandableErrorMessage'

const props = {
    expandLabel: 'Show full error',
    collapseLabel: 'Collapse error',
}

describe('ExpandableErrorMessage', () => {
    it.each([
        ['emoji', '😀'],
        ['combining-mark sequence', 'e\u0301'],
        ['ZWJ sequence', '👩‍💻'],
    ])('counts %s as one grapheme', (_, grapheme) => {
        const withinLimit = grapheme.repeat(160)
        const overLimit = `${withinLimit}TAIL`

        const { rerender } = render(<ExpandableErrorMessage {...props} message={withinLimit} />)
        expect(screen.queryByRole('button')).not.toBeInTheDocument()

        rerender(<ExpandableErrorMessage {...props} message={overLimit} />)
        const toggle = screen.getByRole('button', { name: /Show full error/ })
        expect(toggle).toHaveTextContent('…')
        expect(toggle).not.toHaveTextContent('TAIL')

        fireEvent.click(toggle)
        expect(toggle).toHaveTextContent(overLimit)

        const replacement = `${withinLimit}SECOND ERROR TAIL`
        rerender(<ExpandableErrorMessage {...props} message={replacement} />)
        const replacementToggle = screen.getByRole('button', { name: /Show full error/ })
        expect(replacementToggle).toHaveAttribute('aria-expanded', 'false')
        expect(replacementToggle).not.toHaveTextContent('SECOND ERROR TAIL')

        rerender(<ExpandableErrorMessage {...props} message={overLimit} />)
        const recurringToggle = screen.getByRole('button', { name: /Show full error/ })
        expect(recurringToggle).toHaveAttribute('aria-expanded', 'false')
    })

    it('uses the code-point fallback when Intl.Segmenter is unavailable', () => {
        const originalIntl = Intl
        vi.stubGlobal('Intl', Object.create(originalIntl, {
            Segmenter: { configurable: true, value: undefined },
        }))

        try {
            render(<ExpandableErrorMessage {...props} message={'😀'.repeat(161)} />)
            const toggle = screen.getByRole('button', { name: /Show full error/ })
            expect(toggle).toHaveAttribute('aria-expanded', 'false')
            expect(toggle).toHaveTextContent('…')
        } finally {
            vi.unstubAllGlobals()
        }
    })
})
