import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionListSearch } from './SessionList'

function renderSearch(overrides: Partial<Parameters<typeof SessionListSearch>[0]> = {}) {
    return render(
        <I18nProvider>
            <SessionListSearch
                value=""
                onChange={vi.fn()}
                customStart=""
                customEnd=""
                sessionActivityDates={new Set()}
                onDateRangeChange={vi.fn()}
                expanded={true}
                onExpandedChange={vi.fn()}
                searchMode="metadata"
                onSearchModeChange={vi.fn()}
                {...overrides}
            />
        </I18nProvider>
    )
}

describe('SessionListSearch content scope', () => {
    it('flips to content scope in one tap without changing the default scope', () => {
        const onSearchModeChange = vi.fn()
        renderSearch({ onSearchModeChange })

        expect(screen.getByRole('searchbox').getAttribute('placeholder')).toContain('title/path')
        const scopeButton = screen.getByTestId('session-list-search-scope')
        expect(scopeButton).toHaveAttribute('data-search-scope', 'metadata')
        fireEvent.click(scopeButton)
        expect(onSearchModeChange).toHaveBeenCalledWith('content')
    })

    it('flips back to metadata scope from content scope', () => {
        const onSearchModeChange = vi.fn()
        renderSearch({ searchMode: 'content', onSearchModeChange })

        fireEvent.click(screen.getByTestId('session-list-search-scope'))
        expect(onSearchModeChange).toHaveBeenCalledWith('metadata')
    })

    it('names the real scopes instead of Default/Content chrome labels', () => {
        renderSearch()

        const scopeButton = screen.getByTestId('session-list-search-scope')
        // No chrome label text: the glyph plus tooltip carry the mode.
        expect(scopeButton).toHaveTextContent('')
        expect(scopeButton.getAttribute('title')).toBe(
            'Searching session details: title, summary, path, Agent, machine, ID. Switch to Message text'
        )
        expect(scopeButton.getAttribute('aria-label')).toBe(scopeButton.getAttribute('title'))

        renderSearch({ searchMode: 'content' })
        const contentScope = screen.getAllByTestId('session-list-search-scope')[1]!
        expect(contentScope.getAttribute('title')).toBe(
            'Searching message text inside sessions. Switch to Session details'
        )
    })

    it('gives the scope toggle the same hit target as the clear endcap', () => {
        renderSearch({ value: 'cache' })

        const scopeButton = screen.getByTestId('session-list-search-scope')
        const clearButton = screen.getByRole('button', { name: 'Clear search' })
        for (const size of ['min-h-[48px]', 'min-w-[48px]']) {
            expect(scopeButton.className).toContain(size)
            expect(clearButton.className).toContain(size)
        }
    })

    it('keeps the content-scope glyph on the collapsed applying chip', () => {
        renderSearch({ expanded: false, value: 'cache', searchMode: 'content' })

        expect(screen.getByText('cache')).toBeInTheDocument()
        const chip = document.querySelector('[data-toolbar-chrome][data-search-scope]')
        expect(chip).toHaveAttribute('data-search-scope', 'content')
    })

    it('leaves the idle collapsed button a plain magnifier with no query applied', () => {
        renderSearch({ expanded: false, value: '', searchMode: 'content' })

        // No scope is in effect yet, and this button is what opens search.
        expect(document.querySelector('[data-toolbar-chrome][data-search-scope]')).toBeNull()
    })

    it('uses the message-content placeholder after selecting content scope', () => {
        renderSearch({ searchMode: 'content' })

        expect(screen.getByRole('searchbox').getAttribute('placeholder')).toBe('Search message content')
    })
})
