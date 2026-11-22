import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ApiError } from '@/api/client'
import { ForkPreviewDialog } from './ForkPreviewDialog'
import { I18nProvider } from '@/lib/i18n-context'
import type { ForkPreviewView } from '@/lib/forkPreview'

afterEach(cleanup)

const messageView: ForkPreviewView = {
    kind: 'message',
    keptTurns: [
        { role: 'user', text: 'first question' },
        { role: 'assistant', text: 'first answer' }
    ],
    boundaryText: 'second question',
    excludedTurns: [],
    prefixTruncated: false,
    excludedTruncated: false,
    excludedHidden: 0,
    counts: { kept: 2, excluded: 1 }
}

function toolOnlyRewindView(): ForkPreviewView {
    return {
        kind: 'rewind',
        keptTurns: [{ role: 'user', text: 'first question' }],
        boundaryText: 'second question',
        excludedTurns: [],
        prefixTruncated: false,
        excludedTruncated: true,
        excludedHidden: 3,
        counts: { kept: 1, excluded: 3 }
    }
}

function renderDialog(view: ForkPreviewView, onConfirm: () => Promise<void>) {
    return render(
        <I18nProvider>
            <ForkPreviewDialog isOpen view={view} onCancel={vi.fn()} onConfirm={onConfirm} />
        </I18nProvider>
    )
}

describe('ForkPreviewDialog error and footer handling', () => {
    it('shows the hub error text, not the raw HTTP envelope, when the confirm fails', async () => {
        const onConfirm = vi.fn(async () => {
            throw new ApiError('HTTP 409 Conflict: {"error":"Fork current is not supported for this session"}', 409,
                undefined, '{"error":"Fork current is not supported for this session"}')
        })
        renderDialog(messageView, onConfirm)

        fireEvent.click(screen.getByTestId('fork-preview-confirm'))
        const error = await screen.findByTestId('fork-preview-error')
        expect(error).toHaveTextContent('Fork current is not supported for this session')
        expect(error.textContent).not.toContain('HTTP 409')
    })

    it('clears a confirm error when the view refreshes', async () => {
        const onConfirm = vi.fn(async () => { throw new Error('Runner did not answer') })
        const view = renderDialog(messageView, onConfirm)
        fireEvent.click(screen.getByTestId('fork-preview-confirm'))
        await screen.findByTestId('fork-preview-error')

        // A background refresh (thinking edge) replaces the view; the stale
        // error must not linger under the new boundary.
        view.rerender(
            <I18nProvider>
                <ForkPreviewDialog isOpen view={toolOnlyRewindView()} onCancel={vi.fn()} onConfirm={onConfirm} />
            </I18nProvider>
        )
        expect(screen.queryByTestId('fork-preview-error')).toBeNull()
    })

    it('keeps the deleted-count footer for a rewind that only deletes non-text rows', () => {
        renderDialog(toolOnlyRewindView(), vi.fn(async () => {}))
        // excludedTurns compacts to [] for tool-only rows, but the deletion
        // summary (the truncated count) must still render.
        expect(screen.getByText(/and 3 more messages would be removed/)).toBeTruthy()
    })

    it('shows the fork boundary for a current preview that excludes the running turn', () => {
        // The CLI can cut a current-mode preview at the last completed turn
        // while a turn is running (before the hub saw thinking): the dialog
        // must mark the fork point instead of claiming a full conversation
        // copy that silently drops the running turn.
        const view: ForkPreviewView = {
            ...messageView,
            kind: 'current',
            boundaryText: 'running prompt',
            counts: { kept: 2, excluded: 1 }
        }
        renderDialog(view, vi.fn(async () => {}))

        expect(screen.getByTestId('fork-preview-boundary')).toBeTruthy()
        expect(screen.getByTestId('fork-preview-boundary-message')).toHaveTextContent('running prompt')
        expect(screen.getByText('Copies up to the last completed turn · The reply still running in the source is not included · The original session is unchanged')).toBeTruthy()
    })

    it('keeps the plain current-tail footer for a current preview without a cut', () => {
        const view: ForkPreviewView = {
            ...messageView,
            kind: 'current',
            boundaryText: null,
            counts: { kept: 2, excluded: 0 }
        }
        renderDialog(view, vi.fn(async () => {}))

        expect(screen.queryByTestId('fork-preview-boundary')).toBeNull()
        expect(screen.getByText('A copy of this conversation becomes a new session · The original session is unchanged')).toBeTruthy()
    })
})