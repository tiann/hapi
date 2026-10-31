import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { BoardList } from './BoardList'

afterEach(() => cleanup())

function renderList() {
    return render(
        <I18nProvider>
            <BoardList
                boards={[{ id: 'board-1', label: 'heavygee/6' }]}
                selectedBoardId="board-1"
                onSelectBoard={vi.fn()}
                onAddBoard={vi.fn()}
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

// Operator feedback (hapi#238): a zero-item board must explain what the
// feature is and offer an obvious way to add a real board — not read like a
// broken/404 state.
describe('BoardList empty state', () => {
    it('explains the feature and offers an Add a board action instead of a bare "no items" line', () => {
        renderList()

        expect(screen.getByText('Nothing on this board yet')).toBeInTheDocument()
        expect(screen.getByText(/GitHub Projects \(v2\) board/)).toBeInTheDocument()
        expect(screen.queryByText('No items on this board.')).not.toBeInTheDocument()
    })

    it('opens the add-board dialog from the empty-state action', () => {
        renderList()

        // Two "Add a board" controls exist (the switcher-bar icon chip, and
        // this empty state's own button) — the switcher-bar one renders
        // first in the DOM.
        const buttons = screen.getAllByRole('button', { name: 'Add a board' })
        fireEvent.click(buttons[buttons.length - 1]!)
        expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
})
