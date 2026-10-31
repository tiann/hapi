import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardItem, SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { BoardList } from './BoardList'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    }
}

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

function renderList(items: BoardItem[], overrides: { onRefresh?: () => void; isRefreshing?: boolean; sessions?: SessionSummary[]; onOpenSession?: (sessionId: string) => void } = {}) {
    return render(
        <I18nProvider>
            <BoardList
                boards={[{ id: 'board-1', label: 'heavygee/6' }]}
                selectedBoardId="board-1"
                onSelectBoard={vi.fn()}
                onAddBoard={vi.fn()}
                onRemoveBoard={vi.fn()}
                items={items}
                statusOrder={['Todo']}
                isLoading={false}
                error={null}
                selectedItemId={null}
                onSelectItem={vi.fn()}
                onRefresh={overrides.onRefresh ?? vi.fn()}
                isRefreshing={overrides.isRefreshing ?? false}
                sessions={overrides.sessions ?? []}
                onOpenSession={overrides.onOpenSession ?? vi.fn()}
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

// Operator feedback (hapi#238): "the whole reason to bring these cards here
// is to not have to go to GitHub" — cards must show assignees and labels at
// a glance, not just title/repo/number.
describe('BoardList card content', () => {
    it('shows label chips on a card', () => {
        renderList([makeItem({ labels: [{ name: 'bug', color: 'ff0000' }, { name: 'urgent', color: '00ff00' }] })])
        expect(screen.getByText('bug')).toBeInTheDocument()
        expect(screen.getByText('urgent')).toBeInTheDocument()
    })

    it('shows assignee avatars, capped with a +N overflow indicator', () => {
        renderList([makeItem({
            assignees: [
                { login: 'a', avatarUrl: 'https://example.com/a.png' },
                { login: 'b', avatarUrl: 'https://example.com/b.png' },
                { login: 'c', avatarUrl: 'https://example.com/c.png' },
                { login: 'd', avatarUrl: 'https://example.com/d.png' },
                { login: 'e', avatarUrl: 'https://example.com/e.png' }
            ]
        })])
        expect(screen.getByTitle('a')).toBeInTheDocument()
        expect(screen.getByTitle('d')).toBeInTheDocument()
        expect(screen.queryByTitle('e')).not.toBeInTheDocument()
        expect(screen.getByText('+1')).toBeInTheDocument()
    })

    it('renders no label/assignee row when the item has neither', () => {
        renderList([makeItem()])
        expect(screen.queryByText('bug')).not.toBeInTheDocument()
    })

    it('calls onRefresh from the list-view refresh button', () => {
        const onRefresh = vi.fn()
        renderList([makeItem()], { onRefresh })
        screen.getByRole('button', { name: 'Refresh' }).click()
        expect(onRefresh).toHaveBeenCalledTimes(1)
    })
})

// Operator feedback (hapi#238): a card with a genuinely linked session showed
// no indication of that at the list level — only the detail pane knew. The
// badge must be visible on the collapsed card and clickable straight to the
// session, as a sibling control (not nested in the card's own select button).
describe('BoardList session-linked badge', () => {
    it('shows a session badge on a card whose issue has a linked session', () => {
        const session = makeSession({
            id: 'session-99',
            metadata: { path: '/tmp', externalRefs: [{ kind: 'github_issue', url: 'https://github.com/acme/widgets/issues/1', repo: 'acme/widgets', number: 1, linkedAt: 1 }] }
        })
        renderList([makeItem()], { sessions: [session] })
        expect(screen.getByText('Session')).toBeInTheDocument()
    })

    it('shows no badge when no session is linked to the item', () => {
        renderList([makeItem()], { sessions: [] })
        expect(screen.queryByText('Session')).not.toBeInTheDocument()
    })

    it('clicking the badge opens the linked session without selecting the card', () => {
        const session = makeSession({
            id: 'session-99',
            metadata: { path: '/tmp', externalRefs: [{ kind: 'github_issue', url: 'https://github.com/acme/widgets/issues/1', repo: 'acme/widgets', number: 1, linkedAt: 1 }] }
        })
        const onOpenSession = vi.fn()
        renderList([makeItem()], { sessions: [session], onOpenSession })

        fireEvent.click(screen.getByText('Session'))
        expect(onOpenSession).toHaveBeenCalledWith('session-99')
    })
})
