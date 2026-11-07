import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { ScratchlistEntry } from '@/lib/scratchlist'
import type { ApiClient } from '@/api/client'
import { ScratchlistDrawerHost } from './SessionChat'

const mockApi = {} as ApiClient
const mockSessionId = 'sess-test'

function makeEntry(overrides: Partial<ScratchlistEntry> & { id: string }): ScratchlistEntry {
    return { text: 'note', createdAt: 1000, ...overrides }
}

afterEach(() => {
    cleanup()
})

function renderHost(options?: {
    entry?: ScratchlistEntry
    onUpdate?: (id: string, text: string) => Promise<void>
    onReorder?: (id: string, targetIndex: number) => void
    onDelete?: (id: string) => Promise<void>
}) {
    const onUpdate = options?.onUpdate ?? vi.fn(async () => undefined)
    const onReorder = options?.onReorder ?? vi.fn()
    const onDelete = options?.onDelete ?? vi.fn(async () => undefined)
    render(
        <I18nProvider>
            <ScratchlistDrawerHost
                sessionId={mockSessionId}
                api={mockApi}
                entries={[options?.entry ?? makeEntry({ id: 'e1', text: 'before' })]}
                onUpdate={onUpdate}
                onReorder={onReorder}
                onDelete={onDelete}
            />
        </I18nProvider>,
    )
    return { onUpdate, onReorder, onDelete }
}

describe('ScratchlistDrawerHost', () => {
    it('wires clicking the text block into the hub-backed update callback', async () => {
        const { onUpdate } = renderHost()

        expect(screen.queryByRole('button', { name: 'Move entry up' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Copy into composer' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Send to queue' })).toBeNull()

        fireEvent.click(screen.getByTestId('scratchlist-entry-text'))
        const editor = screen.getByRole('textbox', { name: 'Edit scratchlist entry' })
        fireEvent.change(editor, { target: { value: 'after' } })
        fireEvent.keyDown(editor, { key: 'Enter' })

        await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('e1', 'after'))
    })
})

describe('ScratchlistDrawer copy-to-clipboard action', () => {
    it('writes the entry text, closes the menu, and briefly shows a checkmark', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })

        const { onDelete } = renderHost({ entry: makeEntry({ id: 'e1', text: 'copy this' }) })

        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy text' }))

        await waitFor(() => expect(writeText).toHaveBeenCalledWith('copy this'))
        expect(screen.queryByRole('menuitem', { name: 'Copy text' })).toBeNull()
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'More actions' }))
                .toHaveAttribute('data-scratchlist-copy-success', '')
        )
        expect(onDelete).not.toHaveBeenCalled()
    })
})
