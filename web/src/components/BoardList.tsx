import { useEffect, useMemo, useState } from 'react'
import type { BoardItem, BoardSummary, IssueTemplate } from '@/types/api'
import type { SessionSummary } from '@/types/api'
import { BoardSwitcherBar, BoardSwitcherMenu, type BoardFilterItem } from '@/components/BoardSwitcher'
import { AddBoardDialog } from '@/components/AddBoardDialog'
import { NewCardDialog } from '@/components/NewCardDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { LoadingState } from '@/components/LoadingState'
import { CloseIcon, ExternalLinkIcon, PlusIcon, RefreshIcon } from '@/components/icons'
import { SessionLinkedBadge } from '@/components/SessionLinkedBadge'
import { chipBaseClass, chipIdleClass } from '@/components/filterChipStyles'
import { getApiErrorMessage } from '@/lib/apiErrorMessage'
import { formatRelativeTime } from '@/lib/relativeTime'
import { findSessionLinkedToIssue } from '@/lib/externalRefs'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

// The null-status bucket's key is deliberately left unprefixed while every
// *named* status gets a `status:` prefix (statusKeyForName below) — a real
// project status option could itself be literally named `__no_status__`,
// and a bare string sentinel can't tell that apart from the genuine null
// bucket. Prefixing only the named side means a collision would require a
// named key to equal the unprefixed sentinel, which the "status:" prefix
// makes structurally impossible regardless of what any status is actually
// named (Codex review, hapi#238: this used to collide — duplicate React
// keys and a shared persisted collapse override between the two groups).
const NO_STATUS_KEY = '__no_status__'

function statusKeyForName(status: string): string {
    return `status:${status}`
}

// Manual collapse/expand overrides persist per board + status (hapi#238
// operator refinement) — collapsing "Complete" on one board must not leak
// into an unrelated status name on a different board. Only an explicit
// header click writes here; the state-derived default
// (isGroupClosedByDefault) is never persisted, so it keeps tracking live
// item state for any group the operator hasn't manually touched.
const COLLAPSE_STORAGE_PREFIX = 'hapi.boardGroupCollapsed.v2.'

function collapseStorageKey(boardId: string, statusKey: string): string {
    return `${COLLAPSE_STORAGE_PREFIX}${boardId}::${statusKey}`
}

function readCollapseOverride(boardId: string, statusKey: string): boolean | null {
    if (typeof window === 'undefined') return null
    try {
        const raw = window.localStorage.getItem(collapseStorageKey(boardId, statusKey))
        if (raw === '1') return true
        if (raw === '0') return false
        return null
    } catch {
        return null
    }
}

function writeCollapseOverride(boardId: string, statusKey: string, collapsed: boolean): void {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(collapseStorageKey(boardId, statusKey), collapsed ? '1' : '0')
    } catch {
        // localStorage may be unavailable (private mode, quota) — non-fatal,
        // worst case the override doesn't survive a reload.
    }
}

function ChevronIcon(props: { className?: string; collapsed?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`${props.className ?? ''} transition-transform duration-200 ${props.collapsed ? '-rotate-90' : ''}`}
        >
            <polyline points="6 9 12 15 18 9" />
        </svg>
    )
}

function SearchIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
    )
}

type StatusGroup = {
    // `null` means "no status assigned" — kept distinct from a string so a
    // board with a real status column literally named "noStatus" can't
    // collide with the missing-status bucket (same React key, mislabeled
    // group header).
    status: string | null
    items: BoardItem[]
}

// Whether a group should default to collapsed — derived from the items'
// own `state` (CLOSED/MERGED), not the status column's name. Universal
// across every board regardless of what its Status field is called (fixes,
// for free, a board whose "done" column is named something a configured
// `doneValues` list never anticipated — hapi#238 operator refinement:
// "done" doesn't need a config/UI at all once it's read from state instead
// of label-matching). A mixed group (some open, some closed items) defaults
// to expanded — only a group where every item is already resolved starts
// folded away.
function isGroupClosedByDefault(items: BoardItem[]): boolean {
    return items.length > 0 && items.every(item => item.state === 'CLOSED' || item.state === 'MERGED')
}

// Index-based, not semantic — status names are read verbatim from whatever
// board is configured (hapi#235 design doc), so we can't assume "In
// Progress"/"Todo" wording to pick a meaningful color. Cycling a fixed
// palette by group position gives each status a stable, distinct accent
// without hardcoding assumptions about any particular board's vocabulary.
const STATUS_DOT_PALETTE = ['bg-blue-500', 'bg-amber-500', 'bg-emerald-500', 'bg-purple-500', 'bg-rose-500']

function statusDotClass(colorIndex: number): string {
    return STATUS_DOT_PALETTE[colorIndex % STATUS_DOT_PALETTE.length]
}

// Client-side title filter over the items already loaded for the active
// board (operator ask) — titles only, not body/comments/other content, and
// deliberately no facets (assignee/label/status chips): a plain substring,
// case-insensitive match is the whole scope. Applied before grouping so
// status-group counts/collapse state reflect what's actually visible.
export function filterItemsByTitle(items: BoardItem[], query: string): BoardItem[] {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return items
    return items.filter(item => item.title.toLowerCase().includes(trimmed))
}

// Groups by the board's own status field (verbatim), in board-defined column
// order, with any "no status" items trailing the named groups (hapi#235
// design doc: "Grouping inside Boards mode: board status, not repo").
// Group membership is purely by status label — which group(s) default to
// collapsed is a separate, state-derived concern (isGroupClosedByDefault),
// not baked into this function.
export function groupItemsByStatus(items: BoardItem[], statusOrder: string[]): StatusGroup[] {
    const byStatus = new Map<string, BoardItem[]>()
    const noStatus: BoardItem[] = []

    for (const item of items) {
        if (!item.status) {
            noStatus.push(item)
            continue
        }
        const existing = byStatus.get(item.status)
        if (existing) {
            existing.push(item)
        } else {
            byStatus.set(item.status, [item])
        }
    }

    const orderedStatuses = statusOrder.filter(status => byStatus.has(status))
    for (const status of byStatus.keys()) {
        if (!orderedStatuses.includes(status)) {
            orderedStatuses.push(status)
        }
    }

    const groups: StatusGroup[] = orderedStatuses.map(status => ({
        status,
        items: byStatus.get(status) ?? []
    }))
    if (noStatus.length > 0) {
        groups.push({ status: null, items: noStatus })
    }

    return groups
}

// Genuinely nothing configured — no stored boards, no HAPI_BOARD_* env vars
// (hub's readEnvBoardConfig() returning null, hapi#238 operator decision). A
// static explainer, not an empty list rendered through the normal fetch
// path: there is no board id to fetch items for, so this can never surface a
// raw `gh api graphql failed` wall of text on a machine with no `gh` auth
// configured at all. Distinct from BoardList's other empty state (a board IS
// configured but happens to have zero items right now).
//
// No "try it with an example board" shortcut here (hapi#235 discussion,
// fork issue tracked separately): the only project that could back one is a
// specific operator's own GitHub Projects board, which isn't a demo anyone
// installing HAPI can actually open. An install-wide CTA must not point at
// one person's board — Add a board (the operator's own) is the only path.
function NoBoardsExplainer(props: { onAddBoard: () => void }) {
    const { t } = useTranslation()

    return (
        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <div className="text-sm font-medium text-[var(--app-fg)]">{t('boards.noBoardsConfigured.title')}</div>
            <div className="max-w-sm text-sm text-[var(--app-hint)]">{t('boards.noBoardsConfigured.body')}</div>
            <Button type="button" variant="default" onClick={props.onAddBoard}>
                {t('boards.addBoard.chipLabel')}
            </Button>
        </div>
    )
}

// Card, not a text row — operator feedback (hapi#235): the board list needs
// "some shape, some structure in time," comparable to GitHub's own board
// cards. Clicking the card body opens item detail in the right pane (a
// plain <button>, not a GitHub anchor — that moved to the explicit corner
// icon, see BoardList's own comment below for why they're siblings, not
// nested).
function BoardItemCard(props: {
    item: BoardItem
    muted: boolean
    selected: boolean
    onSelect: () => void
    linkedSessionId: string | null
    onOpenSession: (sessionId: string) => void
}) {
    const { t } = useTranslation()
    const { item, muted, selected } = props
    const repoLabel = item.repo ?? t('boards.noRepo')
    const updatedLabel = item.updatedAt ? formatRelativeTime(new Date(item.updatedAt).getTime(), t) : null
    const infoChipClass = cn(chipBaseClass, chipIdleClass, 'pointer-events-none h-6 px-2')

    return (
        <div
            className={cn(
                'relative mb-2 flex items-start gap-1 rounded-lg border p-3 transition-all',
                selected ? 'border-[var(--app-link)]' : 'border-[var(--app-border)]',
                // Persistent (not hover-only) accent wash on active cards —
                // operator feedback that a hover-only `/40` touch is invisible
                // in a static view. `--app-link-muted` now derives from a
                // custom accent (see useThemeColors.ts), so this reacts live
                // to Settings > Display > Theme Colors > accent. Done/muted
                // cards stay neutral, reinforcing the fold-fade treatment.
                muted ? 'bg-[var(--app-bg)] opacity-60' : 'bg-[var(--app-link-muted)] hover:shadow-sm'
            )}
        >
            <button
                type="button"
                onClick={props.onSelect}
                aria-current={selected || undefined}
                className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
            >
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {item.number !== null ? <span className={cn(infoChipClass, 'font-mono')}>#{item.number}</span> : null}
                    <span className={cn(infoChipClass, 'max-w-40 truncate')}>{repoLabel}</span>
                </div>
                <div className={cn('mt-2 line-clamp-2 text-sm', muted ? 'text-[var(--app-hint)]' : 'text-[var(--app-fg)]')}>
                    {item.title}
                </div>
                {item.labels.length > 0 || item.assignees.length > 0 ? (
                    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                        {item.labels.length > 0 ? (
                            <div className="flex min-w-0 flex-wrap gap-1">
                                {item.labels.slice(0, 4).map(label => (
                                    <span
                                        key={label.name}
                                        className="inline-flex max-w-24 items-center gap-1 truncate rounded-full border border-[var(--app-border)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)]"
                                    >
                                        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: `#${label.color}` }} />
                                        <span className="truncate">{label.name}</span>
                                    </span>
                                ))}
                            </div>
                        ) : null}
                        {item.assignees.length > 0 ? (
                            <div className="flex shrink-0 items-center -space-x-1.5">
                                {item.assignees.slice(0, 4).map(assignee => (
                                    <img
                                        key={assignee.login}
                                        src={assignee.avatarUrl}
                                        alt=""
                                        title={assignee.login}
                                        className="h-5 w-5 rounded-full border border-[var(--app-bg)]"
                                    />
                                ))}
                                {item.assignees.length > 4 ? (
                                    <span className="pl-2 text-[10px] text-[var(--app-hint)]">+{item.assignees.length - 4}</span>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                ) : null}
                {updatedLabel ? <div className="mt-2 text-xs text-[var(--app-hint)]">{updatedLabel}</div> : null}
            </button>

            <div className="flex shrink-0 flex-col items-end gap-1">
                {props.linkedSessionId ? (
                    // Visible on the card itself, not just in the detail pane
                    // (operator feedback, hapi#238: a card with a linked
                    // session showed no indication of that at the list
                    // level) — a sibling control, not nested inside the
                    // card-body button above, same "avoid nested focusable
                    // elements" pattern as the GitHub link icon below it.
                    // Same SessionLinkedBadge the detail pane's "Open session"
                    // uses, just the compact size (hapi#238 affordance audit).
                    <SessionLinkedBadge
                        size="sm"
                        onClick={() => props.onOpenSession(props.linkedSessionId!)}
                        title={t('boards.detail.openSession')}
                        ariaLabel={`${t('boards.detail.openSession')}: ${item.title}`}
                        label={t('boards.sessionLinked')}
                    />
                ) : null}
                {item.url ? (
                    <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={t('boards.openInGithub')}
                        aria-label={`${t('boards.openInGithub')}: ${item.title}`}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    >
                        <ExternalLinkIcon className="h-3.5 w-3.5" />
                    </a>
                ) : null}
            </div>
        </div>
    )
}

export function BoardList(props: {
    boards: BoardSummary[]
    selectedBoardId: string | null
    onSelectBoard: (id: string) => void
    onAddBoard: (url: string) => Promise<void>
    onRemoveBoard: (id: string) => Promise<void>
    items: BoardItem[]
    statusOrder: string[]
    isLoading: boolean
    error: string | null
    selectedItemId: string | null
    onSelectItem: (item: BoardItem) => void
    onRefresh: () => void
    isRefreshing: boolean
    sessions: SessionSummary[]
    onOpenSession: (sessionId: string) => void
    // "New card" dialog — data/callbacks owned by the parent (router.tsx),
    // same boundary useBoardAssignableUsers' assignee picker already keeps:
    // this component stays presentational, the parent owns the live query
    // (useIssueTemplates) keyed by dialog-open + repo-selection state it
    // tracks itself, not state threaded back out of this component.
    newCardDialogOpen: boolean
    onOpenNewCard: () => void
    onCloseNewCard: () => void
    issueTemplates: IssueTemplate[]
    issueTemplatesBlankAllowed: boolean
    issueTemplatesGithubNewIssueUrl: string | null
    isLoadingIssueTemplates: boolean
    issueTemplatesError: string | null
    onNewCardRepoChange: (repo: string | null) => void
    onCreateCard: (payload: { repo: string; title: string; body: string; labels: string[]; assignees: string[] }) => Promise<string>
}) {
    const { t } = useTranslation()
    // In-memory cache of explicit user toggles this session, keyed by
    // `${boardId}::${statusKey}` — authoritative once set, falling back to
    // localStorage (readCollapseOverride) for a key not yet touched this
    // session, and to the state-derived default (isGroupClosedByDefault)
    // when neither exists. Written on every toggle via writeCollapseOverride
    // so the choice survives a reload.
    const [collapsedOverrides, setCollapsedOverrides] = useState<Record<string, boolean>>({})
    const [addDialogOpen, setAddDialogOpen] = useState(false)
    const [removeTarget, setRemoveTarget] = useState<BoardFilterItem | null>(null)
    const [isRemoving, setIsRemoving] = useState(false)
    const boardId = props.selectedBoardId ?? ''
    // Picker convenience, not a restriction — a board has no single "the
    // repo" (a Projects-v2 project can span many repos on its host), so
    // "New card" always offers a free-text fallback too.
    const knownRepos = useMemo(() => {
        const seen = new Set<string>()
        for (const item of props.items) {
            if (item.repo) seen.add(item.repo)
        }
        return [...seen].sort()
    }, [props.items])
    // Resets on board switch (same self-correcting pattern as the assignee
    // picker's own search box) — a filter left over from a previous board
    // would otherwise read as "this board has no matching items" instead of
    // "you're still filtering by a term from the last one."
    const [titleFilter, setTitleFilter] = useState('')
    useEffect(() => {
        setTitleFilter('')
    }, [boardId])
    const boardFilterItems = useMemo(
        () => props.boards.map(board => ({ id: board.id, label: board.label })),
        [props.boards]
    )
    const filteredItems = useMemo(
        () => filterItemsByTitle(props.items, titleFilter),
        [props.items, titleFilter]
    )
    const groups = useMemo(
        () => groupItemsByStatus(filteredItems, props.statusOrder),
        [filteredItems, props.statusOrder]
    )
    // Color index only advances for real statuses — "no status" always gets
    // the same neutral dot rather than consuming a palette slot.
    const groupsWithDot = useMemo(() => {
        let colorIndex = -1
        return groups.map((group) => {
            const isNoStatus = group.status === null
            if (!isNoStatus) colorIndex += 1
            const statusKey = group.status === null ? NO_STATUS_KEY : statusKeyForName(group.status)
            const compositeKey = `${boardId}::${statusKey}`
            const isClosed = isGroupClosedByDefault(group.items)
            const collapsed = collapsedOverrides[compositeKey]
                ?? readCollapseOverride(boardId, statusKey)
                ?? isClosed
            return {
                group,
                key: statusKey,
                compositeKey,
                isNoStatus,
                isClosed,
                dotClass: isNoStatus ? 'bg-[var(--app-hint)]' : statusDotClass(colorIndex),
                collapsed
            }
        })
    }, [groups, collapsedOverrides])
    // Session lookup is per-item, not per-open-detail (operator feedback,
    // hapi#238: a card with a genuinely linked session showed no indication
    // of that at the list level — only the detail pane knew). Memoized on
    // items/sessions since findSessionLinkedToIssue scans every session's
    // externalRefs per call.
    const linkedSessionByItemId = useMemo(() => {
        const map = new Map<string, string | null>()
        for (const item of props.items) {
            map.set(item.id, findSessionLinkedToIssue(props.sessions, item.url)?.id ?? null)
        }
        return map
    }, [props.items, props.sessions])
    const toggleGroup = (compositeKey: string, statusKey: string, currentlyCollapsed: boolean) => {
        const next = !currentlyCollapsed
        writeCollapseOverride(boardId, statusKey, next)
        setCollapsedOverrides(prev => ({ ...prev, [compositeKey]: next }))
    }

    return (
        <div className="flex min-h-0 w-full flex-1 flex-col">
            <div className="mx-auto w-full max-w-content shrink-0">
                {boardFilterItems.length > 0 || !props.isLoading ? (
                    <>
                        <div className="flex items-center gap-1 px-2 py-1">
                            <div className="flex-1" />
                            <button
                                type="button"
                                onClick={props.onOpenNewCard}
                                disabled={!props.selectedBoardId}
                                aria-label={t('boards.newCard.openButton')}
                                title={t('boards.newCard.openButton')}
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
                            >
                                <PlusIcon className="h-4 w-4" />
                            </button>
                            <button
                                type="button"
                                onClick={props.onRefresh}
                                disabled={props.isRefreshing}
                                aria-label={t('boards.refresh')}
                                title={t('boards.refresh')}
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
                            >
                                <RefreshIcon className={cn('h-4 w-4', props.isRefreshing && 'animate-spin')} />
                            </button>
                            <BoardSwitcherMenu
                                boards={boardFilterItems}
                                value={props.selectedBoardId}
                                onChange={props.onSelectBoard}
                                onRemove={(id) => setRemoveTarget(boardFilterItems.find(b => b.id === id) ?? { id, label: id })}
                                onAddClick={() => setAddDialogOpen(true)}
                            />
                        </div>
                        <BoardSwitcherBar
                            boards={boardFilterItems}
                            value={props.selectedBoardId}
                            onChange={props.onSelectBoard}
                            onRemove={(id) => setRemoveTarget(boardFilterItems.find(b => b.id === id) ?? { id, label: id })}
                            onAddClick={() => setAddDialogOpen(true)}
                        />
                    </>
                ) : null}
            </div>

            <AddBoardDialog
                isOpen={addDialogOpen}
                onClose={() => setAddDialogOpen(false)}
                onAdd={props.onAddBoard}
            />

            <NewCardDialog
                isOpen={props.newCardDialogOpen}
                onClose={props.onCloseNewCard}
                knownRepos={knownRepos}
                templates={props.issueTemplates}
                blankAllowed={props.issueTemplatesBlankAllowed}
                githubNewIssueUrl={props.issueTemplatesGithubNewIssueUrl}
                isLoadingTemplates={props.isLoadingIssueTemplates}
                templatesError={props.issueTemplatesError}
                onRepoChange={props.onNewCardRepoChange}
                onSubmit={props.onCreateCard}
            />

            {removeTarget ? (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setRemoveTarget(null)}
                    title={t('boards.removeBoard.confirmTitle')}
                    description={t('boards.removeBoard.confirmDescription', { label: removeTarget.label })}
                    confirmLabel={t('boards.removeBoard.confirm')}
                    confirmingLabel={t('boards.removeBoard.removing')}
                    onConfirm={async () => {
                        setIsRemoving(true)
                        try {
                            await props.onRemoveBoard(removeTarget.id)
                        } catch (err) {
                            throw new Error(getApiErrorMessage(err, t('dialog.error.default')))
                        } finally {
                            setIsRemoving(false)
                        }
                    }}
                    isPending={isRemoving}
                    destructive
                />
            ) : null}

            <div data-testid="board-item-list" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {props.isLoading ? (
                    <div className="flex justify-center py-6">
                        <LoadingState label={t('boards.loading')} />
                    </div>
                ) : props.boards.length === 0 && props.error ? (
                    // A failed /todo-boards fetch (auth, settings-file, network)
                    // also surfaces as an empty boards array — must not be
                    // mistaken for "genuinely nothing configured" below, or a
                    // real failure reads as a successful empty state with no
                    // error shown at all (Codex review, hapi#238).
                    <div className="px-1 py-4 text-sm text-red-600">
                        {t('boards.error', { message: props.error })}
                    </div>
                ) : props.boards.length === 0 ? (
                    // Genuinely nothing configured (hapi#238 operator decision)
                    // — a static explainer, no items fetch attempted at all
                    // (there's no board id to fetch for), so this can never
                    // 502 with a raw `gh api graphql failed` wall of text on a
                    // machine with no `gh` auth configured. Distinct from the
                    // "boards.empty" state below, which is for a board that
                    // IS configured but happens to have zero items right now.
                    <NoBoardsExplainer onAddBoard={() => setAddDialogOpen(true)} />
                ) : props.error && props.items.length === 0 ? (
                    <div className="px-1 py-4 text-sm text-red-600">
                        {t('boards.error', { message: props.error })}
                    </div>
                ) : props.items.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
                        <div className="text-sm font-medium text-[var(--app-fg)]">{t('boards.empty.title')}</div>
                        <div className="max-w-sm text-sm text-[var(--app-hint)]">{t('boards.empty.body')}</div>
                        <Button type="button" variant="outline" onClick={() => setAddDialogOpen(true)}>
                            {t('boards.addBoard.chipLabel')}
                        </Button>
                    </div>
                ) : (
                    <>
                        {props.error ? (
                            <div className="mb-2 rounded-md border border-amber-600/40 bg-amber-600/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                                {t('boards.staleError', { message: props.error })}
                            </div>
                        ) : null}
                        <div className="relative mb-2">
                            <div className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[var(--app-hint)]">
                                <SearchIcon className="h-3.5 w-3.5" />
                            </div>
                            <input
                                type="search"
                                value={titleFilter}
                                onChange={(event) => setTitleFilter(event.target.value)}
                                placeholder={t('boards.filter.placeholder')}
                                aria-label={t('boards.filter.placeholder')}
                                className={cn(
                                    'w-full appearance-none rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] py-1.5 pl-8 pr-7 text-sm text-[var(--app-fg)] outline-none transition-colors placeholder:text-[var(--app-hint)] focus:border-[var(--app-link)] [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden'
                                )}
                            />
                            {titleFilter ? (
                                <button
                                    type="button"
                                    onClick={() => setTitleFilter('')}
                                    aria-label={t('boards.filter.clear')}
                                    title={t('boards.filter.clear')}
                                    className="absolute inset-y-0 right-1.5 flex items-center justify-center rounded-full p-1 text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                                >
                                    <CloseIcon className="h-3.5 w-3.5" />
                                </button>
                            ) : null}
                        </div>
                        {filteredItems.length === 0 ? (
                            <div className="px-1 py-4 text-center text-sm text-[var(--app-hint)]">
                                {t('boards.filter.noResults', { query: titleFilter })}
                            </div>
                        ) : groupsWithDot.map(({ group, key, compositeKey, isNoStatus, dotClass, collapsed }) => (
                            <div key={key} className="mb-3">
                                <button
                                    type="button"
                                    onClick={() => toggleGroup(compositeKey, key, collapsed)}
                                    aria-expanded={!collapsed}
                                    className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                                >
                                    <ChevronIcon className="h-3.5 w-3.5 shrink-0" collapsed={collapsed} />
                                    <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', dotClass)} />
                                    {isNoStatus ? t('boards.noStatus') : group.status} ({group.items.length})
                                </button>
                                {collapsed ? null : group.items.map((item) => (
                                    <BoardItemCard
                                        key={item.id}
                                        item={item}
                                        muted={item.state === 'CLOSED' || item.state === 'MERGED'}
                                        selected={props.selectedItemId === item.id}
                                        onSelect={() => props.onSelectItem(item)}
                                        linkedSessionId={linkedSessionByItemId.get(item.id) ?? null}
                                        onOpenSession={props.onOpenSession}
                                    />
                                ))}
                            </div>
                        ))}
                    </>
                )}
            </div>
        </div>
    )
}
