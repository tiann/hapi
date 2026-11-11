import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { Autocomplete } from './Autocomplete'

function suggestion(key: string): Suggestion {
    return {
        key,
        text: key,
        label: key,
    }
}

describe('Autocomplete', () => {
    let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined
    let scrollIntoView: ReturnType<typeof vi.fn>

    beforeEach(() => {
        originalScrollIntoView = HTMLElement.prototype.scrollIntoView
        scrollIntoView = vi.fn()
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            value: scrollIntoView,
        })
    })

    afterEach(() => {
        if (originalScrollIntoView) {
            Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
                configurable: true,
                value: originalScrollIntoView,
            })
        } else {
            delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
        }
        vi.restoreAllMocks()
    })

    it('lets selected rows reach both edges of the overlay', () => {
        const { container } = render(
            <Autocomplete
                suggestions={[suggestion('first'), suggestion('second')]}
                selectedIndex={1}
                onSelect={vi.fn()}
            />
        )

        const list = container.firstElementChild
        expect(list).not.toHaveClass('pt-1')
        expect(list).not.toHaveClass('pb-1')
        expect(screen.getByRole('button', { name: 'second' })).toHaveClass(
            'bg-[var(--app-button)]',
            'text-[var(--app-button-text)]'
        )
    })

    it('does not re-scroll when suggestions only change identity', () => {
        const { rerender } = render(
            <Autocomplete
                suggestions={[suggestion('first'), suggestion('second')]}
                selectedIndex={0}
                onSelect={vi.fn()}
            />
        )
        expect(scrollIntoView).toHaveBeenCalledTimes(1)

        scrollIntoView.mockClear()
        rerender(
            <Autocomplete
                suggestions={[suggestion('first'), suggestion('second')]}
                selectedIndex={0}
                onSelect={vi.fn()}
            />
        )

        expect(scrollIntoView).not.toHaveBeenCalled()
    })

    it('exposes the inactive group control and keeps the selected index', () => {
        const onSelect = vi.fn()
        render(<Autocomplete suggestions={[
            suggestion('active'),
            { key: 'toggle', text: '', label: 'Inactive sessions', action: { expanded: false, onSelect: vi.fn() } },
            suggestion('file'),
        ]} selectedIndex={1} onSelect={onSelect} />)
        const toggle = screen.getByRole('button', { name: 'Inactive sessions' })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        fireEvent.click(toggle)
        expect(onSelect).toHaveBeenCalledWith(1)
        expect(screen.getByRole('button', { name: 'file' })).toBeInTheDocument()
    })
})
