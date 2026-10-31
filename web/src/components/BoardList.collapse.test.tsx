import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardItem } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { BoardList } from './BoardList'

beforeEach(() => localStorage.clear())
afterEach(() => cleanup())

function makeItem(overrides: Partial<BoardItem> = {}): BoardItem {
    return {
        id: overrides.id ?? 'item-1',
        title: overrides.title ?? 'Fix the thing',
        url: null,
        number: null,
        repo: null,
        state: overrides.state ?? 'OPEN',
        status: overrides.status ?? 'Todo',
        updatedAt: null,
        body: null,
        isPullRequest: false,
        createdAt: null,
        closedAt: null,
        author: null,
        assignees: [],
        labels: [],
        milestone: null,
        customFields: [],
        ...overrides
    }
}

function renderList(items: BoardItem[], statusOrder: string[], boardId = 'board-1') {
    return render(
        <I18nProvider>
            <BoardList
                boards={[{ id: boardId, label: 'heavygee/6' }]}
                selectedBoardId={boardId}
                onSelectBoard={vi.fn()}
                onAddBoard={vi.fn()}
                onRemoveBoard={vi.fn()}
                items={items}
                statusOrder={statusOrder}
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

// Operator ask (hapi#238): every status-group header should be collapsible
// the same way — click the header to hide/show its cards — not just a single
// special-cased "done" section underneath a separate button. Refinement:
// "done" (and so the default collapse) is derived from item.state
// (CLOSED/MERGED), not a configured doneValues list matched against the
// status label — universal across any board regardless of what its Status
// column is named.
describe('BoardList per-group collapse', () => {
    it('every open-item group starts expanded, showing its cards', () => {
        renderList([
            makeItem({ id: 'a', status: 'Todo', title: 'Todo card', state: 'OPEN' }),
            makeItem({ id: 'b', status: 'In Progress', title: 'In-progress card', state: 'OPEN' })
        ], ['Todo', 'In Progress'])
        expect(screen.getByText('Todo card')).toBeInTheDocument()
        expect(screen.getByText('In-progress card')).toBeInTheDocument()
    })

    it('a group whose items are all CLOSED starts collapsed, by its real status name — no doneValues config needed', () => {
        renderList([makeItem({ id: 'a', status: 'Complete', title: 'Closed card', state: 'CLOSED' })], ['Todo', 'Complete'])
        expect(screen.getByText('Complete (1)')).toBeInTheDocument()
        expect(screen.queryByText('Closed card')).not.toBeInTheDocument()
    })

    it('a group whose items are all MERGED also starts collapsed', () => {
        renderList([makeItem({ id: 'a', status: 'Shipped', title: 'Merged PR', state: 'MERGED', isPullRequest: true })], ['Todo', 'Shipped'])
        expect(screen.getByText('Shipped (1)')).toBeInTheDocument()
        expect(screen.queryByText('Merged PR')).not.toBeInTheDocument()
    })

    it('a group with a mix of open and closed items defaults to expanded', () => {
        renderList([
            makeItem({ id: 'a', status: 'Mixed', title: 'Open one', state: 'OPEN' }),
            makeItem({ id: 'b', status: 'Mixed', title: 'Closed one', state: 'CLOSED' })
        ], ['Mixed'])
        expect(screen.getByText('Open one')).toBeInTheDocument()
        expect(screen.getByText('Closed one')).toBeInTheDocument()
    })

    it('clicking a closed-by-default group header expands it', () => {
        renderList([makeItem({ id: 'a', status: 'Complete', title: 'Closed card', state: 'CLOSED' })], ['Todo', 'Complete'])
        fireEvent.click(screen.getByText('Complete (1)'))
        expect(screen.getByText('Closed card')).toBeInTheDocument()
    })

    it('clicking an open group header collapses it', () => {
        renderList([makeItem({ id: 'a', status: 'Todo', title: 'Todo card', state: 'OPEN' })], ['Todo'])
        expect(screen.getByText('Todo card')).toBeInTheDocument()
        fireEvent.click(screen.getByText('Todo (1)'))
        expect(screen.queryByText('Todo card')).not.toBeInTheDocument()
    })

    it('gives a board with multiple all-closed statuses its own collapsible group per status, not one merged pile', () => {
        renderList([
            makeItem({ id: 'a', status: 'Done', title: 'Done card', state: 'CLOSED' }),
            makeItem({ id: 'b', status: 'Archived', title: 'Archived card', state: 'CLOSED' })
        ], ['Todo', 'Done', 'Archived'])
        expect(screen.getByText('Done (1)')).toBeInTheDocument()
        expect(screen.getByText('Archived (1)')).toBeInTheDocument()
        fireEvent.click(screen.getByText('Done (1)'))
        expect(screen.getByText('Done card')).toBeInTheDocument()
        expect(screen.queryByText('Archived card')).not.toBeInTheDocument()
    })

    it('toggling one group does not affect another group\'s collapse state', () => {
        renderList([
            makeItem({ id: 'a', status: 'Todo', title: 'Todo card', state: 'OPEN' }),
            makeItem({ id: 'b', status: 'In Progress', title: 'In-progress card', state: 'OPEN' })
        ], ['Todo', 'In Progress'])
        fireEvent.click(screen.getByText('Todo (1)'))
        expect(screen.queryByText('Todo card')).not.toBeInTheDocument()
        expect(screen.getByText('In-progress card')).toBeInTheDocument()
    })

    it('persists a manual toggle across remounts (survives a reload)', () => {
        const { unmount } = renderList([makeItem({ id: 'a', status: 'Todo', title: 'Todo card', state: 'OPEN' })], ['Todo'])
        fireEvent.click(screen.getByText('Todo (1)'))
        expect(screen.queryByText('Todo card')).not.toBeInTheDocument()
        unmount()

        renderList([makeItem({ id: 'a', status: 'Todo', title: 'Todo card', state: 'OPEN' })], ['Todo'])
        expect(screen.queryByText('Todo card')).not.toBeInTheDocument()
    })

    it('does not leak a collapse override from one board onto a same-named status on another board', () => {
        const { unmount } = renderList([makeItem({ id: 'a', status: 'Todo', title: 'Todo card', state: 'OPEN' })], ['Todo'], 'board-1')
        fireEvent.click(screen.getByText('Todo (1)'))
        expect(screen.queryByText('Todo card')).not.toBeInTheDocument()
        unmount()

        renderList([makeItem({ id: 'b', status: 'Todo', title: 'Other board card', state: 'OPEN' })], ['Todo'], 'board-2')
        expect(screen.getByText('Other board card')).toBeInTheDocument()
    })

    it('does not collide when a real status is literally named like the no-status sentinel (Codex review)', () => {
        // Regression: the no-status bucket's key used to be a bare string
        // sentinel ('__no_status__'), identical to what a real project
        // status option named that way would produce — duplicate React
        // keys, and toggling either group's header collapsed both.
        renderList([
            makeItem({ id: 'a', status: '__no_status__', title: 'Named-status card', state: 'OPEN' }),
            { ...makeItem({ id: 'b', title: 'Truly unassigned card', state: 'OPEN' }), status: null }
        ], ['__no_status__'])

        expect(screen.getByText('__no_status__ (1)')).toBeInTheDocument()
        expect(screen.getByText('No status (1)')).toBeInTheDocument()

        fireEvent.click(screen.getByText('__no_status__ (1)'))
        expect(screen.queryByText('Named-status card')).not.toBeInTheDocument()
        expect(screen.getByText('Truly unassigned card')).toBeInTheDocument()
    })

    it('a manual expand overrides the state-derived collapsed-by-default and persists', () => {
        const { unmount } = renderList([makeItem({ id: 'a', status: 'Complete', title: 'Closed card', state: 'CLOSED' })], ['Todo', 'Complete'])
        fireEvent.click(screen.getByText('Complete (1)'))
        expect(screen.getByText('Closed card')).toBeInTheDocument()
        unmount()

        renderList([makeItem({ id: 'a', status: 'Complete', title: 'Closed card', state: 'CLOSED' })], ['Todo', 'Complete'])
        expect(screen.getByText('Closed card')).toBeInTheDocument()
    })
})
