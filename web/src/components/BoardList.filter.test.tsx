import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardItem } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { BoardList, filterItemsByTitle } from './BoardList'

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

function renderList(items: BoardItem[], statusOrder: string[], overrides: Partial<Parameters<typeof BoardList>[0]> = {}) {
    return render(
        <I18nProvider>
            <BoardList
                boards={[{ id: 'board-1', label: 'heavygee/6' }]}
                selectedBoardId="board-1"
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
                {...overrides}
            />
        </I18nProvider>
    )
}

describe('filterItemsByTitle', () => {
    const items = [
        makeItem({ id: 'a', title: 'Fix the login bug' }),
        makeItem({ id: 'b', title: 'Write release notes' }),
        makeItem({ id: 'c', title: 'LOGIN page redesign' })
    ]

    it('returns every item for an empty or whitespace-only query', () => {
        expect(filterItemsByTitle(items, '')).toEqual(items)
        expect(filterItemsByTitle(items, '   ')).toEqual(items)
    })

    it('matches titles case-insensitively by substring', () => {
        expect(filterItemsByTitle(items, 'login').map(i => i.id)).toEqual(['a', 'c'])
    })

    it('matches nothing for a term no title contains', () => {
        expect(filterItemsByTitle(items, 'nonexistent')).toEqual([])
    })

    it('ignores body content — title-only, not a full-text search', () => {
        const withBody = [makeItem({ id: 'd', title: 'Unrelated title', body: 'mentions login deep in the body' })]
        expect(filterItemsByTitle(withBody, 'login')).toEqual([])
    })
})

describe('BoardList title filter (operator ask)', () => {
    it('shows every card with no filter applied', () => {
        renderList([
            makeItem({ id: 'a', title: 'Fix the login bug' }),
            makeItem({ id: 'b', title: 'Write release notes' })
        ], ['Todo'])
        expect(screen.getByText('Fix the login bug')).toBeInTheDocument()
        expect(screen.getByText('Write release notes')).toBeInTheDocument()
    })

    it('filters cards down to titles matching the typed query', () => {
        renderList([
            makeItem({ id: 'a', title: 'Fix the login bug' }),
            makeItem({ id: 'b', title: 'Write release notes' })
        ], ['Todo'])

        fireEvent.change(screen.getByPlaceholderText('Filter by title…'), { target: { value: 'login' } })

        expect(screen.getByText('Fix the login bug')).toBeInTheDocument()
        expect(screen.queryByText('Write release notes')).not.toBeInTheDocument()
    })

    it('shows a no-results message when the filter matches nothing, keeping the search box visible', () => {
        renderList([makeItem({ id: 'a', title: 'Fix the login bug' })], ['Todo'])

        const input = screen.getByPlaceholderText('Filter by title…')
        fireEvent.change(input, { target: { value: 'zzz-no-match' } })

        expect(screen.getByText('No items match "zzz-no-match"')).toBeInTheDocument()
        expect(screen.getByPlaceholderText('Filter by title…')).toBeInTheDocument()
    })

    it('clears the filter via the clear button, restoring the full board', () => {
        renderList([
            makeItem({ id: 'a', title: 'Fix the login bug' }),
            makeItem({ id: 'b', title: 'Write release notes' })
        ], ['Todo'])

        const input = screen.getByPlaceholderText('Filter by title…')
        fireEvent.change(input, { target: { value: 'login' } })
        expect(screen.queryByText('Write release notes')).not.toBeInTheDocument()

        fireEvent.click(screen.getByLabelText('Clear filter'))

        expect(screen.getByText('Write release notes')).toBeInTheDocument()
        expect((screen.getByPlaceholderText('Filter by title…') as HTMLInputElement).value).toBe('')
    })

    it('resets the filter when the selected board changes', () => {
        const { rerender } = renderList([
            makeItem({ id: 'a', title: 'Fix the login bug' })
        ], ['Todo'])

        fireEvent.change(screen.getByPlaceholderText('Filter by title…'), { target: { value: 'login' } })
        expect((screen.getByPlaceholderText('Filter by title…') as HTMLInputElement).value).toBe('login')

        rerender(
            <I18nProvider>
                <BoardList
                    boards={[{ id: 'board-2', label: 'other/board' }]}
                    selectedBoardId="board-2"
                    onSelectBoard={vi.fn()}
                    onAddBoard={vi.fn()}
                    onRemoveBoard={vi.fn()}
                    items={[makeItem({ id: 'z', title: 'Something else entirely' })]}
                    statusOrder={['Todo']}
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

        expect((screen.getByPlaceholderText('Filter by title…') as HTMLInputElement).value).toBe('')
        expect(screen.getByText('Something else entirely')).toBeInTheDocument()
    })
})
