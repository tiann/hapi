import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { BoardList } from './BoardList'

afterEach(() => cleanup())

function renderList(onAddBoard = vi.fn(() => Promise.resolve())) {
    return render(
        <I18nProvider>
            <BoardList
                boards={[]}
                selectedBoardId={null}
                onSelectBoard={vi.fn()}
                onAddBoard={onAddBoard}
                onRemoveBoard={vi.fn()}
                items={[]}
                statusOrder={[]}
                isLoading={false}
                error={null}
                selectedItemId={null}
                onSelectItem={vi.fn()}
                onRefresh={vi.fn()}
                isRefreshing={false}
                sessions={[]}
                onOpenSession={vi.fn()}
                newCardDialogOpen={false}
                onOpenNewCard={vi.fn()}
                onCloseNewCard={vi.fn()}
                issueTemplates={[]}
                issueTemplatesBlankAllowed={true}
                issueTemplatesGithubNewIssueUrl={null}
                isLoadingIssueTemplates={false}
                issueTemplatesError={null}
                onNewCardRepoChange={vi.fn()}
                onCreateCard={vi.fn()}
            />
        </I18nProvider>
    )
}

// Operator decision (hapi#238): a genuinely empty board list — no stored
// boards, no HAPI_BOARD_* env vars — must show a static explainer instead of
// the old "no items on this board" state, since there's no board id to even
// attempt a fetch for.
describe('BoardList with zero boards configured', () => {
    it('shows the no-boards explainer instead of the zero-items empty state', () => {
        renderList()

        expect(screen.getByText('No boards yet')).toBeInTheDocument()
        expect(screen.queryByText('Nothing on this board yet')).not.toBeInTheDocument()
    })

    it('offers an Add a board action that opens the add-board dialog, with no other action offered', () => {
        renderList()

        const buttons = screen.getAllByRole('button', { name: 'Add a board' })
        fireEvent.click(buttons[buttons.length - 1]!)
        expect(screen.getByRole('dialog')).toBeInTheDocument()

        // No install-wide "try an example" shortcut — the only project that
        // could back one is a specific operator's own board, not a public
        // demo every installer can open (hapi#235 discussion).
        expect(screen.queryByRole('button', { name: /example/i })).not.toBeInTheDocument()
    })
})
