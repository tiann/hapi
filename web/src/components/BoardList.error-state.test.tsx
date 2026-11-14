import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardItem } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { BoardList } from './BoardList'

afterEach(() => cleanup())

function makeItem(overrides: Partial<BoardItem> = {}): BoardItem {
    return {
        id: 'item-1',
        title: 'Fix the thing',
        url: 'https://github.com/acme/widgets/issues/1',
        number: 1,
        repo: 'acme/widgets',
        state: 'OPEN',
        status: 'Todo',
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

function renderList(items: BoardItem[], error: string | null, boards = [{ id: 'board-1', label: 'heavygee/6' }]) {
    return render(
        <I18nProvider>
            <BoardList
                boards={boards}
                selectedBoardId={boards[0]?.id ?? null}
                onSelectBoard={vi.fn()}
                onAddBoard={vi.fn()}
                onRemoveBoard={vi.fn()}
                items={items}
                statusOrder={['Todo']}
                isLoading={false}
                error={error}
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

// A refresh (manual or post-write auto-refetch) failing after an earlier
// successful load must not blank the board — React Query keeps the last-good
// `data` across a failed refetch, and the component must respect that rather
// than prioritizing the error state over already-loaded items (Codex review,
// hapi#238: originally reported against the since-removed 60s poll, but the
// same "any refetch failure hides cached items" behavior applies to manual
// refresh and write-triggered refetches too).
describe('BoardList error states', () => {
    it('shows the full error state only when there are no cached items', () => {
        renderList([], 'Failed to load board items')
        expect(screen.getByText('Failed to load board: Failed to load board items')).toBeInTheDocument()
    })

    it('keeps showing cached items with a non-blocking banner when a refetch fails', () => {
        renderList([makeItem()], 'Failed to load board items')
        expect(screen.getByText('Fix the thing')).toBeInTheDocument()
        expect(screen.getByText(/refresh failed: Failed to load board items/)).toBeInTheDocument()
        expect(screen.queryByText('Failed to load board: Failed to load board items')).not.toBeInTheDocument()
    })

    it('renders no error banner when there is no error', () => {
        renderList([makeItem()], null)
        expect(screen.queryByText(/refresh failed/)).not.toBeInTheDocument()
    })

    // Codex review (hapi#238): a failed /todo-boards fetch also surfaces as
    // an empty boards array — must show the real error, not be mistaken for
    // "genuinely nothing configured" and silently read as a successful
    // empty state.
    it('shows the board-load error instead of the no-boards explainer when the boards fetch itself fails', () => {
        renderList([], 'Failed to load boards', [])
        expect(screen.getByText('Failed to load board: Failed to load boards')).toBeInTheDocument()
        expect(screen.queryByText('No boards yet')).not.toBeInTheDocument()
    })
})
