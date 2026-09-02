import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import {
    persistScratchlist,
    readScratchlist,
    type ScratchlistEntry,
} from '@/lib/scratchlist'
import { ScratchlistDrawer, ScratchlistPanel } from './ScratchlistPanel'

const SID = 'session-test'

function renderPanel(props?: {
    sessionId?: string
}) {
    return {
        ...render(
            <I18nProvider>
                <ScratchlistPanel
                    sessionId={props?.sessionId ?? SID}
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

function firePointerEvent(
    element: Element,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    init: Record<string, number>,
): void {
    const event = new Event(type, { bubbles: true, cancelable: true })
    for (const [key, value] of Object.entries(init)) {
        Object.defineProperty(event, key, { configurable: true, value })
    }
    fireEvent(element, event)
}

function fireTouchEvent(
    element: Element,
    type: 'touchstart' | 'touchmove' | 'touchend',
    touches: Array<{ identifier: number; clientX: number; clientY: number }>,
    changedTouches = touches,
): void {
    const init = { touches, changedTouches }
    if (type === 'touchstart') {
        fireEvent.touchStart(element, init)
    } else if (type === 'touchmove') {
        fireEvent.touchMove(element, init)
    } else {
        fireEvent.touchEnd(element, init)
    }
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

    it('uses the chat user surface for the panel background and keeps a subtle amber border (regression guard for #812)', () => {
        // The amber chrome was too loud as an always-visible scroll element
        // (#812). The fix swaps the warning *fill* for the chat-user-surface
        // tone but keeps the warning *border* as a soft accent so the panel
        // still reads as a different destination from a normal user message.
        // The strong amber destination signal lives on the composer Send
        // button, not here. See PR 827 (swear01) for the styling note this
        // test guards.
        renderPanel()
        const panel = screen.getByTestId('scratchlist-panel')
        expect(panel.className).toContain('bg-[var(--app-chat-user-surface-bg)]')
        expect(panel.className).not.toContain('bg-[var(--app-badge-warning-bg)]')
        expect(panel.className).toContain('border-[var(--app-badge-warning-border)]')
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

        // Shift+Enter must not add a new entry (it falls through to
        // textarea default newline behavior); the stored list stays unchanged.
        fireEvent.change(input, { target: { value: 'with newline' } })
        fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
        expect(readScratchlist(SID).map((e) => e.text)).toEqual(['enter add'])
    })

    it('requires confirmation before deleting an entry', () => {
        persistScratchlist(SID, [makeEntry({ id: 'a', text: 'short' })])
        renderPanel()
        expandPanel()
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete entry' }))
        const dialog = screen.getByRole('dialog', { name: 'Delete draft?' })
        expect(within(dialog).getByText('Delete this draft? This action cannot be undone.')).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: 'Delete' })).toHaveClass('bg-red-600')
        expect(screen.getByText('short')).toBeInTheDocument()
        expect(readScratchlist(SID)).toHaveLength(1)

        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
        expect(screen.getByText('short')).toBeInTheDocument()
        expect(readScratchlist(SID)).toHaveLength(1)

        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete entry' }))
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete draft?' })).getByRole('button', { name: 'Delete' }))
        expect(readScratchlist(SID)).toEqual([])
    })

    it('edits an entry by clicking its text block and removes the old row action buttons', async () => {
        persistScratchlist(SID, [makeEntry({ id: 'a', text: 'before' })])
        renderPanel()
        expandPanel()

        expect(screen.queryByRole('button', { name: 'Move entry up' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Move entry down' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Copy into composer' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Send to queue' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Delete entry' })).toBeNull()
        expect(screen.queryByTestId('scratchlist-entry-age')).toBeNull()
        expect(screen.getByRole('button', { name: 'More actions' }).parentElement?.className).toContain('items-center')

        fireEvent.click(screen.getByTestId('scratchlist-entry-text'))
        const editor = screen.getByRole('textbox', { name: 'Edit scratchlist entry' })
        expect(editor.className).toContain('bg-transparent')
        expect(editor.className).not.toContain('border-[var(--app-link)]')
        expect(editor.className).toContain('overflow-hidden')
        expect(editor.className).not.toContain('overflow-y-auto')
        expect(editor).toHaveAttribute('rows', '1')
        expect(editor).toHaveFocus()
        expect((editor as HTMLTextAreaElement).selectionStart).toBe('before'.length)
        expect((editor as HTMLTextAreaElement).selectionEnd).toBe('before'.length)
        fireEvent.change(editor, { target: { value: 'after' } })
        fireEvent.keyDown(editor, { key: 'Enter' })

        await waitFor(() => expect(readScratchlist(SID).map((entry) => entry.text)).toEqual(['after']))
        expect(screen.getByTestId('scratchlist-entry-text')).toHaveTextContent('after')
    })

    it('keeps a multiline editor in sync with its content height without a scrollbar', () => {
        persistScratchlist(SID, [makeEntry({ id: 'a', text: 'first line\nsecond line' })])
        renderPanel()
        expandPanel()

        fireEvent.click(screen.getByTestId('scratchlist-entry-text'))
        const editor = screen.getByRole('textbox', { name: 'Edit scratchlist entry' }) as HTMLTextAreaElement
        Object.defineProperty(editor, 'scrollHeight', { configurable: true, value: 48 })
        fireEvent.change(editor, { target: { value: 'first line\nsecond line\nthird line' } })

        expect(editor.style.height).toBe('48px')
        expect(editor.className).toContain('overflow-hidden')
    })

    it('applies the pointer hover surface to the whole entry block', () => {
        persistScratchlist(SID, [makeEntry({ id: 'a', text: 'hover me' })])
        renderPanel()
        expandPanel()

        const row = screen.getByTestId('scratchlist-entry')
        const text = screen.getByTestId('scratchlist-entry-text')
        expect(row.className).toContain('hover:bg-[var(--app-subtle-bg)]')
        expect(text.className).not.toContain('hover:bg-[var(--app-subtle-bg)]')
    })

    it('reorders entries after a long press and drag', () => {
        vi.useFakeTimers()
        persistScratchlist(SID, [
            makeEntry({ id: 'top', text: 'top entry' }),
            makeEntry({ id: 'middle', text: 'middle entry' }),
            makeEntry({ id: 'bot', text: 'bot entry' }),
        ])
        try {
            renderPanel()
            expandPanel()

            const rows = screen.getAllByTestId('scratchlist-entry')
            const destination = rows[2]!
            const originalElementFromPoint = document.elementFromPoint
            const elementFromPoint = vi.fn().mockReturnValue(destination)
            Object.defineProperty(document, 'elementFromPoint', {
                configurable: true,
                value: elementFromPoint,
            })

            try {
                firePointerEvent(rows[0]!, 'pointerdown', {
                    button: 0,
                    pointerId: 1,
                    clientX: 10,
                    clientY: 10,
                })
                act(() => {
                    vi.advanceTimersByTime(450)
                })
                expect(rows[0]).toHaveAttribute('data-dragging', '')
                firePointerEvent(rows[0]!, 'pointermove', {
                    pointerId: 1,
                    clientX: 10,
                    clientY: 100,
                })
                firePointerEvent(rows[0]!, 'pointerup', { pointerId: 1, clientX: 10, clientY: 100 })

                expect(readScratchlist(SID).map((entry) => entry.id)).toEqual(['middle', 'bot', 'top'])
            } finally {
                Object.defineProperty(document, 'elementFromPoint', {
                    configurable: true,
                    value: originalElementFromPoint,
                })
            }
        } finally {
            vi.useRealTimers()
        }
    })

    it('reorders entries after a touch long press and drag', () => {
        vi.useFakeTimers()
        persistScratchlist(SID, [
            makeEntry({ id: 'top', text: 'top entry' }),
            makeEntry({ id: 'middle', text: 'middle entry' }),
            makeEntry({ id: 'bot', text: 'bot entry' }),
        ])
        try {
            renderPanel()
            expandPanel()

            const rows = screen.getAllByTestId('scratchlist-entry')
            const destination = rows[2]!
            const originalElementFromPoint = document.elementFromPoint
            Object.defineProperty(document, 'elementFromPoint', {
                configurable: true,
                value: vi.fn().mockReturnValue(destination),
            })

            try {
                fireTouchEvent(rows[0]!, 'touchstart', [
                    { identifier: 1, clientX: 10, clientY: 10 },
                ])
                act(() => {
                    vi.advanceTimersByTime(450)
                })
                expect(rows[0]).toHaveAttribute('data-dragging', '')
                fireEvent.contextMenu(rows[0]!, { clientX: 10, clientY: 100 })
                expect(screen.queryByTestId('scratchlist-action-menu')).toBeNull()
                fireTouchEvent(rows[0]!, 'touchmove', [
                    { identifier: 1, clientX: 10, clientY: 100 },
                ])
                fireTouchEvent(rows[0]!, 'touchend', [], [
                    { identifier: 1, clientX: 10, clientY: 100 },
                ])

                expect(readScratchlist(SID).map((entry) => entry.id)).toEqual(['middle', 'bot', 'top'])
            } finally {
                Object.defineProperty(document, 'elementFromPoint', {
                    configurable: true,
                    value: originalElementFromPoint,
                })
            }
        } finally {
            vi.useRealTimers()
        }
    })

    it('keeps editing on Escape without changing the entry', () => {
        persistScratchlist(SID, [makeEntry({ id: 'a', text: 'keep me' })])
        renderPanel()
        expandPanel()

        fireEvent.click(screen.getByTestId('scratchlist-entry-text'))
        const editor = screen.getByRole('textbox', { name: 'Edit scratchlist entry' })
        fireEvent.change(editor, { target: { value: 'discard me' } })
        fireEvent.keyDown(editor, { key: 'Escape' })

        expect(readScratchlist(SID).map((entry) => entry.text)).toEqual(['keep me'])
        expect(screen.getByTestId('scratchlist-entry-text')).toHaveTextContent('keep me')
    })

    it('copy button writes the entry text to clipboard and closes the action menu', async () => {
        // Clipboard API isn't implemented in jsdom; install a mock that
        // captures the writeText call. (web/src/lib/clipboard.ts already
        // tries navigator.clipboard first, then falls back to execCommand.)
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })

        persistScratchlist(SID, [makeEntry({ id: 'a', text: 'copy me' })])
        renderPanel()
        expandPanel()

        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        const copyBtn = screen.getByRole('menuitem', { name: 'Copy text' })
        fireEvent.click(copyBtn)

        await waitFor(() => expect(writeText).toHaveBeenCalledWith('copy me'))

        // Copy follows the same close-after-action behavior as the other menu items.
        await waitFor(() => expect(screen.queryByTestId('scratchlist-action-menu')).toBeNull())
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'More actions' }))
                .toHaveAttribute('data-scratchlist-copy-success', ''),
        )
        // Entry is preserved — copy is non-destructive.
        expect(readScratchlist(SID).map((e) => e.id)).toEqual(['a'])
    })

    it('clipboard write failure still closes the action menu without false success', async () => {
        // Force navigator.clipboard.writeText to reject AND make the
        // execCommand fallback fail too, so safeCopyToClipboard throws.
        const writeText = vi.fn().mockRejectedValue(new Error('denied'))
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })
        // jsdom doesn't implement document.execCommand. Define a stub
        // that returns false so safeCopyToClipboard's fallback path
        // also fails (covering the "everything failed" branch).
        Object.defineProperty(document, 'execCommand', {
            value: () => false,
            configurable: true,
            writable: true,
        })

        persistScratchlist(SID, [makeEntry({ id: 'a', text: 'try copy' })])
        renderPanel()
        expandPanel()

        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy text' }))

        await waitFor(() => expect(writeText).toHaveBeenCalled())
        // The menu closes immediately, with no success feedback shown.
        expect(screen.queryByTestId('scratchlist-action-menu')).toBeNull()
        expect(screen.getByRole('button', { name: 'More actions' }))
            .not.toHaveAttribute('data-scratchlist-copy-success')
    })

    it('opens the compact action menu from a PC context menu and dispatches send and schedule actions', async () => {
        const { ScratchlistDrawer } = await import('./ScratchlistPanel')
        const entry = makeEntry({ id: 'menu-entry', text: 'send this note' })
        const onSend = vi.fn().mockResolvedValue(true)
        const onSchedule = vi.fn().mockResolvedValue(true)

        render(
            <I18nProvider>
                <ScratchlistDrawer
                    entries={[entry]}
                    sessionId={SID}
                    api={{} as never}
                    onUpdate={vi.fn()}
                    onReorder={vi.fn()}
                    onDelete={vi.fn()}
                    onSend={onSend}
                    onSchedule={onSchedule}
                />
            </I18nProvider>,
        )

        const row = screen.getByTestId('scratchlist-entry')
        fireEvent.contextMenu(row, { clientX: 120, clientY: 80 })
        expect(screen.getByRole('menu')).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: 'Send now' })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: 'Schedule send' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('menuitem', { name: 'Send now' }))
        await waitFor(() => expect(onSend).toHaveBeenCalledWith(entry))
        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

        fireEvent.contextMenu(row, { clientX: 120, clientY: 80 })
        fireEvent.click(screen.getByRole('menuitem', { name: 'Schedule send' }))
        expect(screen.getByRole('dialog', { name: 'Schedule send' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: '+5m' }))

        await waitFor(() => expect(onSchedule).toHaveBeenCalledWith(
            entry,
            { type: 'preset', preset: '+5m' },
        ))
    })

    it('allows scheduling entries that contain attachments', async () => {
        const { ScratchlistDrawer } = await import('./ScratchlistPanel')
        const entry = makeEntry({
            id: 'attachment-menu-entry',
            text: 'send with an image',
            attachments: [{
                id: 'attachment-1',
                filename: 'photo.png',
                mimeType: 'image/png',
                size: 4,
                path: 'hapi-hub:scratchlist/default/session-test/attachment-1.png',
            }],
        })

        render(
            <I18nProvider>
                <ScratchlistDrawer
                    entries={[entry]}
                    sessionId={SID}
                    api={{} as never}
                    onUpdate={vi.fn()}
                    onReorder={vi.fn()}
                    onDelete={vi.fn()}
                    onSend={vi.fn().mockResolvedValue(true)}
                    onSchedule={vi.fn().mockResolvedValue(true)}
                />
            </I18nProvider>,
        )

        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        expect(screen.getByRole('menuitem', { name: 'Send now' })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: 'Schedule send' })).toBeInTheDocument()
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

describe('ScratchlistDrawer disabled operations', () => {
    it('allows clearing text while keeping an attachment on the draft', async () => {
        const { ScratchlistDrawer } = await import('./ScratchlistPanel')
        const entry = makeEntry({
            id: 'clear-text-with-attachment',
            text: 'remove this text',
            attachments: [{
                id: 'clear-text-attachment',
                filename: 'photo.png',
                mimeType: 'image/png',
                size: 4,
                path: 'hapi-hub:scratchlist/default/session-test/clear-text-attachment.png',
                previewUrl: 'data:image/png;base64,cGhvdG8=',
            }],
        })
        const onUpdate = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawer
                    entries={[entry]}
                    sessionId={SID}
                    api={{} as never}
                    onUpdate={onUpdate}
                    onReorder={vi.fn()}
                    onDelete={vi.fn()}
                />
            </I18nProvider>,
        )

        fireEvent.click(screen.getByTestId('scratchlist-entry-text'))
        const editor = screen.getByRole('textbox', { name: 'Edit scratchlist entry' })
        fireEvent.change(editor, { target: { value: '' } })
        fireEvent.blur(editor)

        expect(onUpdate).toHaveBeenCalledWith(entry.id, '')
        expect(onUpdate).not.toHaveBeenCalledWith(entry.id, 'remove this text')
    })

    it('requires confirmation before removing one attachment', async () => {
        const { ScratchlistDrawer } = await import('./ScratchlistPanel')
        const attachment = {
            id: 'partial-remove-1',
            filename: 'photo.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-hub:scratchlist/default/session-test/partial-remove-1.png',
            previewUrl: 'data:image/png;base64,cGhvdG8=',
        }
        const entry = makeEntry({
            id: 'partial-remove-entry',
            text: 'keep this text',
            attachments: [attachment],
        })
        const onUpdate = vi.fn()
        const onDelete = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawer
                    entries={[entry]}
                    sessionId={SID}
                    api={{} as never}
                    onUpdate={onUpdate}
                    onReorder={vi.fn()}
                    onDelete={onDelete}
                />
            </I18nProvider>,
        )

        fireEvent.click(screen.getByRole('button', { name: 'Remove attachment photo.png' }))
        const dialog = screen.getByRole('dialog', { name: 'Delete attachment?' })
        expect(onUpdate).not.toHaveBeenCalled()
        expect(onDelete).not.toHaveBeenCalled()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
        expect(onUpdate).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Remove attachment photo.png' }))
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete attachment?' })).getByRole('button', { name: 'Delete' }))
        await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('partial-remove-entry', 'keep this text', []))
        expect(onDelete).not.toHaveBeenCalled()
    })

    it('uses the latest row when an attachment confirmation stays open across an update', async () => {
        const attachment = {
            id: 'stale-remove-1',
            filename: 'photo.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-hub:scratchlist/default/session-test/stale-remove-1.png',
            previewUrl: 'data:image/png;base64,cGhvdG8=',
        }
        const newerAttachment = {
            id: 'stale-remove-2',
            filename: 'new-photo.png',
            mimeType: 'image/png',
            size: 5,
            path: 'hapi-hub:scratchlist/default/session-test/stale-remove-2.png',
            previewUrl: 'data:image/png;base64,bmV3LXBob3Rv',
        }
        const initialEntry = makeEntry({
            id: 'stale-remove-entry',
            text: 'original text',
            attachments: [attachment],
        })
        const currentEntry = makeEntry({
            ...initialEntry,
            text: 'newer text from another device',
            updatedAt: 2000,
            attachments: [attachment, newerAttachment],
        })
        const onUpdate = vi.fn().mockResolvedValue(undefined)
        const onDelete = vi.fn()

        const rendered = render(
            <I18nProvider>
                <ScratchlistDrawer
                    entries={[initialEntry]}
                    sessionId={SID}
                    api={{} as never}
                    onUpdate={onUpdate}
                    onReorder={vi.fn()}
                    onDelete={onDelete}
                />
            </I18nProvider>,
        )

        fireEvent.click(screen.getByRole('button', { name: 'Remove attachment photo.png' }))
        rendered.rerender(
            <I18nProvider>
                <ScratchlistDrawer
                    entries={[currentEntry]}
                    sessionId={SID}
                    api={{} as never}
                    onUpdate={onUpdate}
                    onReorder={vi.fn()}
                    onDelete={onDelete}
                />
            </I18nProvider>,
        )

        fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete attachment?' })).getByRole('button', { name: 'Delete' }))
        await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(
            'stale-remove-entry',
            'newer text from another device',
            [newerAttachment],
        ))
        expect(onDelete).not.toHaveBeenCalled()
    })

    it('keeps the attachment confirmation open when its update fails', async () => {
        const attachment = {
            id: 'failed-update-1',
            filename: 'photo.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-hub:scratchlist/default/session-test/failed-update-1.png',
            previewUrl: 'data:image/png;base64,cGhvdG8=',
        }
        const onUpdate = vi.fn().mockRejectedValue(new Error('update failed'))

        render(
            <I18nProvider>
                <ScratchlistDrawer
                    entries={[makeEntry({ id: 'failed-update-entry', text: 'keep this text', attachments: [attachment] })]}
                    sessionId={SID}
                    api={{} as never}
                    onUpdate={onUpdate}
                    onReorder={vi.fn()}
                    onDelete={vi.fn()}
                />
            </I18nProvider>,
        )

        fireEvent.click(screen.getByRole('button', { name: 'Remove attachment photo.png' }))
        const dialog = screen.getByRole('dialog', { name: 'Delete attachment?' })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

        await waitFor(() => expect(within(dialog).getByText('update failed')).toBeInTheDocument())
        expect(screen.getByRole('dialog', { name: 'Delete attachment?' })).toBeInTheDocument()
    })

    it('keeps the draft confirmation open when deletion fails', async () => {
        const onDelete = vi.fn().mockRejectedValue(new Error('delete failed'))

        render(
            <I18nProvider>
                <ScratchlistDrawer
                    entries={[makeEntry({ id: 'failed-delete-entry', text: 'delete me' })]}
                    sessionId={SID}
                    api={{} as never}
                    onUpdate={vi.fn()}
                    onReorder={vi.fn()}
                    onDelete={onDelete}
                />
            </I18nProvider>,
        )

        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete entry' }))
        const dialog = screen.getByRole('dialog', { name: 'Delete draft?' })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

        await waitFor(() => expect(within(dialog).getByText('delete failed')).toBeInTheDocument())
        expect(screen.getByRole('dialog', { name: 'Delete draft?' })).toBeInTheDocument()
    })

    it('renders non-image attachment-only rows with a filename and remove affordance', () => {
        const attachment = {
            id: 'document-1',
            filename: 'brief.pdf',
            mimeType: 'application/pdf',
            size: 4,
            path: 'hapi-hub:scratchlist/default/session-test/document-1.pdf',
        }
        const onDelete = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawer
                    entries={[makeEntry({ id: 'document-entry', text: '', attachments: [attachment] })]}
                    sessionId={SID}
                    api={{} as never}
                    onUpdate={vi.fn()}
                    onReorder={vi.fn()}
                    onDelete={onDelete}
                />
            </I18nProvider>,
        )

        expect(screen.getByTestId('scratchlist-attachment-files')).toBeInTheDocument()
        expect(screen.getByText('brief.pdf')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Remove attachment brief.pdf' }))
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete attachment?' })).getByRole('button', { name: 'Delete' }))
        expect(onDelete).toHaveBeenCalledWith('document-entry')
    })

    it('renders composer-style image chips with a filename, remove button, and fullscreen preview', async () => {
        const { ScratchlistDrawer } = await import('./ScratchlistPanel')
        const attachment = {
            id: 'photo-1',
            filename: 'photo.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-hub:scratchlist/default/session-test/photo-1.png',
        }
        const fetchScratchlistAttachmentBlob = vi.fn().mockResolvedValue(new Blob(['data'], { type: 'image/png' }))
        const api = { fetchScratchlistAttachmentBlob } as never
        const onUpdate = vi.fn()
        const onDelete = vi.fn()
        const originalCreateObjectURL = URL.createObjectURL
        const originalRevokeObjectURL = URL.revokeObjectURL
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn().mockReturnValue('blob:photo-1'),
        })
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: vi.fn(),
        })

        try {
            const rendered = render(
                <I18nProvider>
                    <ScratchlistDrawer
                        entries={[makeEntry({ id: 'entry-1', text: '', attachments: [attachment] })]}
                        sessionId={SID}
                        api={api}
                        onUpdate={onUpdate}
                        onReorder={vi.fn()}
                        onDelete={onDelete}
                    />
                </I18nProvider>,
            )

            await waitFor(() => expect(screen.getByTestId('scratchlist-attachment-thumb')).toBeInTheDocument())
            const thumb = screen.getByTestId('scratchlist-attachment-thumb')
            expect(thumb.className).toContain('h-16')
            expect(thumb.className).toContain('w-24')
            const thumbnails = screen.getByTestId('scratchlist-attachment-thumbs')
            expect(thumbnails.className).toContain('mt-0.5')
            expect(thumbnails.className).toContain('mb-1')
            expect(thumbnails.className).not.toContain('my-1')
            expect(screen.getByRole('img', { name: 'photo.png' })).toHaveAttribute('src', 'blob:photo-1')
            expect(screen.getAllByText('photo.png')).not.toHaveLength(0)
            expect(screen.queryByText('(attachment)')).toBeNull()
            expect(fetchScratchlistAttachmentBlob).toHaveBeenCalledTimes(1)

            fetchScratchlistAttachmentBlob.mockClear()
            rendered.rerender(
                <I18nProvider>
                    <ScratchlistDrawer
                        entries={[makeEntry({ id: 'entry-1', text: '', attachments: [{ ...attachment }] })]}
                        sessionId={SID}
                        api={api}
                        onUpdate={onUpdate}
                        onReorder={vi.fn()}
                        onDelete={onDelete}
                    />
                </I18nProvider>,
            )
            await act(async () => {
                await Promise.resolve()
            })
            expect(fetchScratchlistAttachmentBlob).not.toHaveBeenCalled()
            expect(screen.getByRole('img', { name: 'photo.png' })).toHaveAttribute('src', 'blob:photo-1')

            fireEvent.click(screen.getByTitle('Click to zoom'))
            expect(screen.getByRole('dialog', { name: 'photo.png' })).toBeInTheDocument()

            fireEvent.click(screen.getByRole('button', { name: 'Remove attachment photo.png' }))
            expect(screen.getByRole('dialog', { name: 'Delete attachment?' })).toBeInTheDocument()
            fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete attachment?' })).getByRole('button', { name: 'Delete' }))
            expect(onDelete).toHaveBeenCalledWith('entry-1')
            rendered.unmount()
        } finally {
            cleanup()
            Object.defineProperty(URL, 'createObjectURL', {
                configurable: true,
                value: originalCreateObjectURL,
            })
            Object.defineProperty(URL, 'revokeObjectURL', {
                configurable: true,
                value: originalRevokeObjectURL,
            })
        }
    })

    it('reuses a loaded thumbnail after reopening and uses the composer preview directly', async () => {
        const fetchScratchlistAttachmentBlob = vi.fn().mockResolvedValue(new Blob(['data'], { type: 'image/png' }))
        const api = { fetchScratchlistAttachmentBlob } as never
        const attachment = {
            id: 'photo-reopen',
            filename: 'reopen.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-hub:scratchlist/default/session-test/photo-reopen.png',
        }
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo-reopen')

        try {
            const first = render(
                <I18nProvider>
                    <ScratchlistDrawer
                        entries={[makeEntry({ id: 'entry-reopen', text: '', attachments: [attachment] })]}
                        sessionId={SID}
                        api={api}
                        onUpdate={vi.fn()}
                        onReorder={vi.fn()}
                        onDelete={vi.fn()}
                    />
                </I18nProvider>,
            )
            await waitFor(() => expect(screen.getByRole('img', { name: 'reopen.png' })).toHaveAttribute('src', 'blob:photo-reopen'))
            expect(fetchScratchlistAttachmentBlob).toHaveBeenCalledTimes(1)
            first.unmount()

            fetchScratchlistAttachmentBlob.mockClear()
            render(
                <I18nProvider>
                    <ScratchlistDrawer
                        entries={[makeEntry({ id: 'entry-reopen', text: '', attachments: [{ ...attachment }] })]}
                        sessionId={SID}
                        api={api}
                        onUpdate={vi.fn()}
                        onReorder={vi.fn()}
                        onDelete={vi.fn()}
                    />
                </I18nProvider>,
            )
            expect(screen.getByRole('img', { name: 'reopen.png' })).toHaveAttribute('src', 'blob:photo-reopen')
            expect(fetchScratchlistAttachmentBlob).not.toHaveBeenCalled()
            cleanup()

            const composerPreview = 'data:image/png;base64,Y29tcG9zZXI='
            render(
                <I18nProvider>
                    <ScratchlistDrawer
                        entries={[makeEntry({
                            id: 'entry-composer-preview',
                            text: '',
                            attachments: [{ ...attachment, id: 'photo-composer-preview', previewUrl: composerPreview }],
                        })]}
                        sessionId={SID}
                        api={api}
                        onUpdate={vi.fn()}
                        onReorder={vi.fn()}
                        onDelete={vi.fn()}
                    />
                </I18nProvider>,
            )
            expect(screen.getByRole('img', { name: 'reopen.png' })).toHaveAttribute('src', composerPreview)
            expect(fetchScratchlistAttachmentBlob).not.toHaveBeenCalled()
        } finally {
            cleanup()
            createObjectURL.mockRestore()
        }
    })

    it('keeps wrapped text inside an attachment row while the row grows with its content', async () => {
        const { ScratchlistDrawer } = await import('./ScratchlistPanel')
        const attachment = {
            id: 'photo-multiline',
            filename: 'multiline.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-hub:scratchlist/default/session-test/photo-multiline.png',
        }
        const api = {
            fetchScratchlistAttachmentBlob: vi.fn().mockResolvedValue(new Blob(['data'], { type: 'image/png' })),
        } as never
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo-multiline')

        try {
            render(
                <I18nProvider>
                    <ScratchlistDrawer
                        entries={[makeEntry({
                            id: 'entry-multiline',
                            text: '第一行很长的草稿内容\n第二行很长的草稿内容\n第三行很长的草稿内容',
                            attachments: [attachment],
                        })]}
                        sessionId={SID}
                        api={api}
                        onUpdate={vi.fn()}
                        onReorder={vi.fn()}
                        onDelete={vi.fn()}
                    />
                </I18nProvider>,
            )

            await waitFor(() => expect(screen.getByTestId('scratchlist-attachment-thumb')).toBeInTheDocument())
            expect(screen.getByRole('list').className).toContain('min-h-0')
            expect(screen.getByTestId('scratchlist-entry').className).toContain('shrink-0')
            const content = screen.getByTestId('scratchlist-entry-content')
            const text = screen.getByTestId('scratchlist-entry-text')
            expect(content.className).toContain('flex-1')
            expect(content.className).not.toContain('overflow-hidden')
            expect(text.className).toContain('line-clamp-4')
            expect(text.className).not.toContain('items-center')
            expect(text.className).not.toContain('flex')
        } finally {
            cleanup()
            createObjectURL.mockRestore()
        }
    })

    it('shows the drawer instructions from a clickable help question mark', async () => {
        const { ScratchlistDrawer } = await import('./ScratchlistPanel')

        render(
            <I18nProvider>
                <ScratchlistDrawer
                    entries={[]}
                    sessionId={SID}
                    api={{} as never}
                    onUpdate={vi.fn()}
                    onReorder={vi.fn()}
                    onDelete={vi.fn()}
                />
            </I18nProvider>,
        )

        const help = screen.getByRole('button', { name: 'Show scratchlist usage tips' })
        const tooltip = screen.getByRole('tooltip', { hidden: true })
        expect(screen.queryByText('held — not sent')).toBeNull()
        expect(help).toHaveAttribute('aria-expanded', 'false')
        expect(tooltip).toHaveTextContent('Use the composer below to add a draft.')

        fireEvent.click(help)
        expect(help).toHaveAttribute('aria-expanded', 'true')
        expect(tooltip.className).toContain('visible')

        fireEvent.click(help)
        expect(help).toHaveAttribute('aria-expanded', 'false')
    })

    it('shows the draft count beside the help question mark with matching header styling', () => {
        const entry = makeEntry({ id: 'count-entry' })
        const renderDrawer = (entries: ScratchlistEntry[]) => (
            <I18nProvider>
                <ScratchlistDrawer
                    entries={entries}
                    sessionId={SID}
                    api={{} as never}
                    onUpdate={vi.fn()}
                    onReorder={vi.fn()}
                    onDelete={vi.fn()}
                />
            </I18nProvider>
        )

        const { rerender } = render(renderDrawer([]))
        const drawer = screen.getByTestId('scratchlist-drawer')
        expect(screen.queryByTestId('scratchlist-count')).toBeNull()
        const helpIcon = drawer.querySelector('[aria-label="Show scratchlist usage tips"] svg')
        expect(helpIcon?.getAttribute('class')).toContain('h-[0.8125rem]')
        expect(helpIcon?.getAttribute('class')).toContain('max-sm:-top-[0.0625rem]')
        expect(drawer.querySelector('[aria-label="Show scratchlist usage tips"]'))
            .not.toBeNull()

        rerender(renderDrawer([entry]))
        const oneCount = screen.getByTestId('scratchlist-count')
        expect(oneCount).toHaveTextContent('1 item')
        expect(oneCount.className).toContain('mr-[0.09375rem]')

        rerender(renderDrawer([entry, makeEntry({ id: 'count-entry-2' })]))
        expect(screen.getByTestId('scratchlist-count')).toHaveTextContent('2 items')
    })

    it('disables editing, dragging, and deletion while the parent send is pending', async () => {
        const { ScratchlistDrawer } = await import('./ScratchlistPanel')
        const entry = makeEntry({ id: 'pending-entry', text: 'held message' })
        const onUpdate = vi.fn()
        const onReorder = vi.fn()
        const onDelete = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawer
                    entries={[entry]}
                    sessionId={SID}
                    api={{} as never}
                    disabled
                    onUpdate={onUpdate}
                    onReorder={onReorder}
                    onDelete={onDelete}
                />
            </I18nProvider>,
        )

        const mutationButtons = [
            screen.getByTestId('scratchlist-entry-text'),
        ]
        for (const button of mutationButtons) {
            expect(button).toBeDisabled()
            fireEvent.click(button)
        }
        // Copy is read-only and remains available while a chat send is pending.
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        expect(screen.getByRole('menuitem', { name: 'Copy text' })).not.toBeDisabled()
        const deleteButton = screen.getByRole('menuitem', { name: 'Delete entry' })
        expect(deleteButton).toBeDisabled()
        fireEvent.click(deleteButton)

        await Promise.resolve()
        expect(onUpdate).not.toHaveBeenCalled()
        expect(onReorder).not.toHaveBeenCalled()
        expect(onDelete).not.toHaveBeenCalled()
    })
})
