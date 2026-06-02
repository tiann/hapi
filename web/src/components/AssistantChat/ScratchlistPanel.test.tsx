import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import {
    persistScratchlist,
    readScratchlist,
    type ScratchlistEntry,
} from '@/lib/scratchlist'
import { ScratchlistPanel } from './ScratchlistPanel'

const SID = 'session-test'

function renderPanel(props?: {
    onPromoteToComposer?: (text: string) => void
    onPromoteToQueue?: (text: string) => Promise<boolean>
    sessionId?: string
}) {
    const onPromoteToComposer = props?.onPromoteToComposer ?? vi.fn()
    const onPromoteToQueue = props?.onPromoteToQueue ?? vi.fn(async () => true)
    return {
        onPromoteToComposer,
        onPromoteToQueue,
        ...render(
            <I18nProvider>
                <ScratchlistPanel
                    sessionId={props?.sessionId ?? SID}
                    onPromoteToComposer={onPromoteToComposer}
                    onPromoteToQueue={onPromoteToQueue}
                />
            </I18nProvider>
        ),
    }
}

function makeEntry(overrides: Partial<ScratchlistEntry> & { id: string }): ScratchlistEntry {
    return {
        text: 'note',
        createdAt: 1000,
        ...overrides,
    }
}

function expandPanel(): void {
    fireEvent.click(screen.getByRole('button', { name: /Scratchlist/ }))
}

afterEach(() => {
    cleanup()
})

beforeEach(() => {
    localStorage.clear()
})

describe('ScratchlistPanel', () => {
    it('renders the held / not-sent label so users distinguish it from the queue', () => {
        renderPanel()
        // The held-label is rendered inside the toggle button as visual chrome
        // (aria-hidden) so use textContent rather than a name match.
        const toggle = screen.getByRole('button', { name: /Scratchlist/ })
        expect(toggle.textContent).toContain('held')
    })

    it('starts collapsed by default; clicking the header expands it', () => {
        renderPanel()
        const toggle = screen.getByRole('button', { name: /Scratchlist/ })
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
        expandPanel()
        expect(toggle.getAttribute('aria-expanded')).toBe('true')
    })

    it('marks the inner content `inert` while collapsed so hidden controls are not focusable', () => {
        // Regression guard: upstream PR review flagged that under the
        // CSS-only collapse the textarea + action buttons were still in
        // the focus / a11y tree. The fix is `inert` on the inner; this
        // test fails if anyone reverts that.
        const { container } = renderPanel()
        const inner = container.querySelector('.collapsible-inner')
        expect(inner).not.toBeNull()
        expect(inner!.hasAttribute('inert')).toBe(true)

        expandPanel()
        // jsdom doesn't always reflect the React `inert={false}` prop as
        // an attribute removal — accept either "absent" or empty string,
        // which both indicate non-inert per the HTML spec.
        const value = inner!.getAttribute('inert')
        expect(value === null || value === 'false' || value === '').toBe(true)
    })

    it('hydrates entries that were persisted before mount', () => {
        persistScratchlist(SID, [
            makeEntry({ id: 'persisted-1', text: 'persisted note' }),
        ])
        renderPanel()
        expandPanel()
        expect(screen.getByText('persisted note')).toBeTruthy()
    })

    it('adds a new entry via the add button and persists it', () => {
        renderPanel()
        expandPanel()
        const input = screen.getByLabelText('Add scratchlist entry') as HTMLTextAreaElement
        fireEvent.change(input, { target: { value: 'first thought' } })
        fireEvent.click(screen.getByRole('button', { name: 'Add' }))
        expect(screen.getByText('first thought')).toBeTruthy()
        const stored = readScratchlist(SID)
        expect(stored.map((e) => e.text)).toEqual(['first thought'])
    })

    it('adds a new entry on Enter; Shift+Enter does not add (preserves newline)', () => {
        renderPanel()
        expandPanel()
        const input = screen.getByLabelText('Add scratchlist entry') as HTMLTextAreaElement
        fireEvent.change(input, { target: { value: 'enter add' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(screen.getByText('enter add')).toBeTruthy()
        expect(readScratchlist(SID).map((e) => e.text)).toEqual(['enter add'])

        // Shift+Enter must not promote to a new entry (it falls through to
        // textarea default newline behavior); the stored list stays unchanged.
        fireEvent.change(input, { target: { value: 'with newline' } })
        fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
        expect(readScratchlist(SID).map((e) => e.text)).toEqual(['enter add'])
    })

    it('deletes an entry without a confirm prompt for short entries', () => {
        persistScratchlist(SID, [makeEntry({ id: 'a', text: 'short' })])
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
        renderPanel()
        expandPanel()
        fireEvent.click(screen.getByRole('button', { name: 'Delete entry' }))
        expect(confirmSpy).not.toHaveBeenCalled()
        expect(screen.queryByText('short')).toBeNull()
        expect(readScratchlist(SID)).toEqual([])
        confirmSpy.mockRestore()
    })

    it('asks for confirmation before deleting long entries (>100 chars)', () => {
        const longText = 'x'.repeat(150)
        persistScratchlist(SID, [makeEntry({ id: 'a', text: longText })])
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

        renderPanel()
        expandPanel()
        fireEvent.click(screen.getByRole('button', { name: 'Delete entry' }))

        expect(confirmSpy).toHaveBeenCalled()
        // Confirm rejected — entry stays.
        expect(readScratchlist(SID).map((e) => e.id)).toEqual(['a'])

        confirmSpy.mockReturnValue(true)
        fireEvent.click(screen.getByRole('button', { name: 'Delete entry' }))
        expect(readScratchlist(SID)).toEqual([])
        confirmSpy.mockRestore()
    })

    it('reorders entries via the up / down arrow buttons', () => {
        persistScratchlist(SID, [
            makeEntry({ id: 'top', text: 'top entry' }),
            makeEntry({ id: 'bot', text: 'bot entry' }),
        ])
        renderPanel()
        expandPanel()

        // First entry is at index 0 — its up-button should be disabled.
        const upButtons = screen.getAllByRole('button', { name: 'Move entry up' })
        const downButtons = screen.getAllByRole('button', { name: 'Move entry down' })
        expect(upButtons[0]?.hasAttribute('disabled')).toBe(true)
        expect(downButtons[downButtons.length - 1]?.hasAttribute('disabled')).toBe(true)

        // Move bottom row up -> swaps order.
        fireEvent.click(upButtons[1] as HTMLButtonElement)
        const stored = readScratchlist(SID)
        expect(stored.map((e) => e.id)).toEqual(['bot', 'top'])
    })

    it('promote-to-composer copies text via the callback and keeps the entry', () => {
        persistScratchlist(SID, [makeEntry({ id: 'a', text: 'compose me' })])
        const onPromoteToComposer = vi.fn()
        renderPanel({ onPromoteToComposer })
        expandPanel()
        fireEvent.click(screen.getByRole('button', { name: 'Copy into composer' }))
        expect(onPromoteToComposer).toHaveBeenCalledWith('compose me')
        // Entry remains: promote-to-composer is a copy, not a move.
        expect(readScratchlist(SID).map((e) => e.id)).toEqual(['a'])
    })

    it('promote-to-queue calls onSend and removes the entry on accepted send', async () => {
        persistScratchlist(SID, [makeEntry({ id: 'a', text: 'queue me' })])
        const onPromoteToQueue = vi.fn(async () => true)
        renderPanel({ onPromoteToQueue })
        expandPanel()
        fireEvent.click(screen.getByRole('button', { name: 'Send to queue' }))
        await waitFor(() => expect(onPromoteToQueue).toHaveBeenCalledWith('queue me'))
        await waitFor(() => expect(screen.queryByText('queue me')).toBeNull())
        expect(readScratchlist(SID)).toEqual([])
    })

    it('promote-to-queue keeps the entry when the send is rejected', async () => {
        persistScratchlist(SID, [makeEntry({ id: 'a', text: 'queue me' })])
        const onPromoteToQueue = vi.fn(async () => false)
        renderPanel({ onPromoteToQueue })
        expandPanel()
        fireEvent.click(screen.getByRole('button', { name: 'Send to queue' }))
        await waitFor(() => expect(onPromoteToQueue).toHaveBeenCalledWith('queue me'))
        // Entry remains because the queue rejected the promotion.
        expect(screen.getByText('queue me')).toBeTruthy()
        expect(readScratchlist(SID).map((e) => e.id)).toEqual(['a'])
    })

    it('persists collapse state across mounts for the same session', () => {
        const { unmount } = renderPanel()
        expandPanel()
        unmount()

        // Re-mount with the same session id; should remain expanded.
        const second = renderPanel()
        const toggle = second.getByRole('button', { name: /Scratchlist/ })
        expect(toggle.getAttribute('aria-expanded')).toBe('true')
    })

    it('isolates entries between sessions', () => {
        persistScratchlist('session-A', [makeEntry({ id: 'a1', text: 'A note' })])
        persistScratchlist('session-B', [makeEntry({ id: 'b1', text: 'B note' })])

        const a = renderPanel({ sessionId: 'session-A' })
        fireEvent.click(a.getByRole('button', { name: /Scratchlist/ }))
        expect(a.getByText('A note')).toBeTruthy()
        expect(a.queryByText('B note')).toBeNull()
        a.unmount()

        const b = renderPanel({ sessionId: 'session-B' })
        fireEvent.click(b.getByRole('button', { name: /Scratchlist/ }))
        expect(b.getByText('B note')).toBeTruthy()
        expect(b.queryByText('A note')).toBeNull()
    })
})
