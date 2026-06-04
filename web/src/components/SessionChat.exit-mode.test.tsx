import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { ScratchlistEntry } from '@/lib/scratchlist'

/**
 * Regression test for upstream review on PR #798 (HAPI Bot follow-up
 * after b256fe5):
 *
 *   > Found one major issue: promoting a scratchlist item to the
 *   > composer keeps scratchlist mode enabled, so the next send re-adds
 *   > it to the scratchlist instead of sending to chat.
 *
 * The fix is for ScratchlistDrawerHost to call `onExitScratchlistMode`
 * whenever it promotes an entry to the composer (since promoting means
 * "I want to send this for real now"). This test mocks the assistant-ui
 * runtime hook and asserts both the setText call AND the exit-mode call
 * fire when the operator clicks promote-to-composer.
 *
 * Promote-to-queue does NOT exit the mode - the queue path bypasses the
 * scratchlist-mode wrapper entirely, and the operator may still want to
 * capture related notes.
 */

const setText = vi.fn()
vi.mock('@assistant-ui/react', () => ({
    useAssistantApi: () => ({
        composer: () => ({ setText }),
    }),
}))

import { ScratchlistDrawerHost } from './SessionChat'

function makeEntry(overrides: Partial<ScratchlistEntry> & { id: string }): ScratchlistEntry {
    return { text: 'note', createdAt: 1000, ...overrides }
}

afterEach(() => {
    cleanup()
    setText.mockReset()
})

describe('ScratchlistDrawerHost.onPromoteToComposer', () => {
    it('exits scratchlist mode AND sets composer text when an entry is promoted to composer', () => {
        const onExitScratchlistMode = vi.fn()
        const onSend = vi.fn(async () => true)
        const onMove = vi.fn()
        const onDelete = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    entries={[makeEntry({ id: 'e1', text: 'queued thought' })]}
                    onMove={onMove}
                    onDelete={onDelete}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                />
            </I18nProvider>,
        )

        // The drawer renders a "promote to composer" button per entry.
        // Match by aria-label so we do not depend on icon/glyph copy.
        const promoteButtons = screen.getAllByRole('button', { name: /composer|edit/i })
        expect(promoteButtons.length).toBeGreaterThan(0)
        fireEvent.click(promoteButtons[0]!)

        expect(setText).toHaveBeenCalledWith('queued thought')
        expect(onExitScratchlistMode).toHaveBeenCalledTimes(1)
        // Promote-to-composer must NOT call onSend (that's promote-to-queue).
        expect(onSend).not.toHaveBeenCalled()
    })

    it('does NOT exit scratchlist mode when an entry is promoted to queue', async () => {
        const onExitScratchlistMode = vi.fn()
        const onSend = vi.fn(async () => true)
        const onMove = vi.fn()
        const onDelete = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    entries={[makeEntry({ id: 'e1', text: 'send-to-queue text' })]}
                    onMove={onMove}
                    onDelete={onDelete}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                />
            </I18nProvider>,
        )

        const queueButtons = screen.getAllByRole('button', { name: /queue|send/i })
        expect(queueButtons.length).toBeGreaterThan(0)
        fireEvent.click(queueButtons[0]!)

        // Allow the async onSend to settle
        await Promise.resolve()
        await Promise.resolve()

        expect(onSend).toHaveBeenCalledWith('send-to-queue text')
        expect(onExitScratchlistMode).not.toHaveBeenCalled()
        expect(setText).not.toHaveBeenCalled()
    })
})
