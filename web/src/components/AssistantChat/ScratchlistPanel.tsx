import {
    type FormEvent as ReactFormEvent,
    type KeyboardEvent as ReactKeyboardEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import {
    addScratchlistEntry,
    deleteScratchlistEntry,
    moveScratchlistEntry,
    persistScratchlist,
    readScratchlist,
    SCRATCHLIST_MAX_ENTRIES,
    SCRATCHLIST_MAX_TEXT_LENGTH,
    shouldConfirmDelete,
    type ScratchlistEntry,
} from '@/lib/scratchlist'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { useTranslation } from '@/lib/use-translation'
import { formatAbsoluteDateTime, formatRelativeTime } from '@/lib/relativeTime'

const STORAGE_KEY_PREFIX = 'hapi.scratchlist-collapsed.v1.'

function readCollapsedPref(sessionId: string): boolean {
    if (typeof window === 'undefined') return true
    try {
        const raw = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${sessionId}`)
        return raw === null ? true : raw === '1'
    } catch {
        return true
    }
}

function writeCollapsedPref(sessionId: string, collapsed: boolean): void {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(
            `${STORAGE_KEY_PREFIX}${sessionId}`,
            collapsed ? '1' : '0'
        )
    } catch {
        // Non-fatal.
    }
}

function NoteIcon() {
    return (
        <svg
            className="h-[14px] w-[14px] shrink-0"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
        >
            <path
                d="M3.5 2.5h6L12.5 5.5v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
            />
            <path
                d="M9.5 2.5v3h3M5 8.5h6M5 11h4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
            />
        </svg>
    )
}

function ChevronIcon({ open }: { open: boolean }) {
    return (
        <svg
            className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
        >
            <path d="m4 3 4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function ArrowUpIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M8 12V4M8 4l3 3M8 4 5 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function ArrowDownIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M8 4v8M8 12l3-3M8 12 5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function PencilIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path
                d="M11.5 2.5a1.414 1.414 0 0 1 2 2L5 13H3v-2L11.5 2.5Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    )
}

function SendIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M2.5 8 13.5 3 11 13l-3-4-5.5-1Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="m11 13-3-4 5.5-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function TrashIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path
                d="M3.5 4.5h9M6 4.5V3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1.5M5 4.5l.5 8a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1l.5-8"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    )
}

function CopyIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <rect
                x="5" y="2" width="9" height="11" rx="1.5"
                stroke="currentColor" strokeWidth="1.4"
            />
            <rect
                x="2" y="5" width="9" height="11" rx="1.5"
                stroke="currentColor" strokeWidth="1.4"
            />
        </svg>
    )
}

function ClockIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 5v3l2 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

/**
 * Per-entry age indicator: clock icon with a tooltip showing
 * smart-relative time (e.g. "2m ago") and the absolute timestamp on a
 * second line, so an operator can tell at-a-glance how stale a note is.
 *
 * Renders nothing when no usable timestamp is available - this happens
 * for legacy localStorage entries that pre-date the v2 hub-sync work
 * (no `updatedAt` recorded) AND have no `createdAt` either, which is
 * vanishingly rare but still a guard against `NaN` titles.
 *
 * Falls back to `createdAt` when `updatedAt` is missing so newly-loaded
 * v1-only rows still get a useful tooltip during the migration window.
 */
function EntryAgeIndicator({
    entry,
}: {
    entry: ScratchlistEntry
}) {
    const { t } = useTranslation()
    const stamp = entry.updatedAt ?? entry.createdAt
    if (!Number.isFinite(stamp) || stamp <= 0) return null
    const relative = formatRelativeTime(stamp, t)
    if (!relative) return null
    const absolute = formatAbsoluteDateTime(stamp)
    const ariaLabel = t('scratchlist.entry.lastSavedAriaLabel', { time: relative })
    const title = absolute
        ? `${t('scratchlist.entry.lastSaved', { time: relative })}\n${absolute}`
        : t('scratchlist.entry.lastSaved', { time: relative })
    return (
        <span
            role="img"
            aria-label={ariaLabel}
            title={title}
            data-testid="scratchlist-entry-age"
            data-entry-age={relative}
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--app-hint)]"
        >
            <ClockIcon />
        </span>
    )
}

function ClipboardCheckIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path
                d="M3 8.5l3 3 7-7"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    )
}

/**
 * Tracks which entry was most-recently copied to the clipboard so the UI
 * can briefly swap the copy icon to a check + the tooltip to "Copied".
 * Auto-clears after `clearAfterMs` (default 1500ms). Pure state machine -
 * the caller wires `safeCopyToClipboard` separately so the hook stays
 * easy to test and free of jsdom clipboard quirks.
 */
const COPIED_FEEDBACK_MS = 1500
function useCopiedFeedback(clearAfterMs: number = COPIED_FEEDBACK_MS) {
    const [copiedEntryId, setCopiedEntryId] = useState<string | null>(null)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const signalCopied = useCallback((entryId: string) => {
        setCopiedEntryId(entryId)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopiedEntryId(null), clearAfterMs)
    }, [clearAfterMs])
    useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current)
    }, [])
    return { copiedEntryId, signalCopied }
}

/**
 * Inventory list with per-entry action buttons. Pure presentational - takes
 * entries + callbacks. Used by both the always-visible ScratchlistPanel
 * and the composer-controlled drawer below.
 */
function ScratchlistInventory({
    entries,
    busyEntryId,
    onPromoteToComposer,
    onPromoteToQueue,
    onDelete,
    onMove,
}: {
    entries: ScratchlistEntry[]
    busyEntryId: string | null
    onPromoteToComposer: (entry: ScratchlistEntry) => void
    onPromoteToQueue: (entry: ScratchlistEntry) => void
    onDelete: (entry: ScratchlistEntry) => void
    onMove: (entry: ScratchlistEntry, direction: 'up' | 'down') => void
}) {
    const { t } = useTranslation()
    const { copiedEntryId, signalCopied } = useCopiedFeedback()
    const handleCopy = useCallback(async (entry: ScratchlistEntry) => {
        try {
            await safeCopyToClipboard(entry.text)
            signalCopied(entry.id)
        } catch {
            // safeCopyToClipboard exhausted both the navigator.clipboard
            // path and the execCommand fallback; nothing useful left to do.
            // Silently no-op rather than throw at the click handler.
        }
    }, [signalCopied])
    if (entries.length === 0) {
        return (
            <p className="mt-2 text-[11px] text-[var(--app-hint)]">
                {t('scratchlist.emptyHint')}
            </p>
        )
    }
    return (
        <ul
            aria-label={t('scratchlist.listAriaLabel')}
            className="mt-2 flex max-h-64 flex-col gap-1.5 overflow-y-auto"
        >
            {entries.map((entry, index) => {
                const isFirst = index === 0
                const isLast = index === entries.length - 1
                const isBusy = busyEntryId === entry.id
                return (
                    <li
                        key={entry.id}
                        className="flex items-start gap-2 rounded-md bg-[var(--app-bg)] px-2 py-1.5 shadow-sm"
                        data-testid="scratchlist-entry"
                    >
                        <span className="flex-1 min-w-0 whitespace-pre-wrap break-words text-sm text-[var(--app-fg)] line-clamp-4">
                            {entry.text}
                        </span>
                        <div className="flex shrink-0 items-center gap-0.5 text-[var(--app-hint)]">
                            <EntryAgeIndicator entry={entry} />
                            <button
                                type="button"
                                aria-label={t('scratchlist.action.moveUp')}
                                title={t('scratchlist.action.moveUp')}
                                onClick={() => onMove(entry, 'up')}
                                disabled={isFirst || isBusy}
                                className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-30"
                            >
                                <ArrowUpIcon />
                            </button>
                            <button
                                type="button"
                                aria-label={t('scratchlist.action.moveDown')}
                                title={t('scratchlist.action.moveDown')}
                                onClick={() => onMove(entry, 'down')}
                                disabled={isLast || isBusy}
                                className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-30"
                            >
                                <ArrowDownIcon />
                            </button>
                            <button
                                type="button"
                                aria-label={t('scratchlist.action.promoteToComposer')}
                                title={t('scratchlist.action.promoteToComposer')}
                                onClick={() => onPromoteToComposer(entry)}
                                disabled={isBusy}
                                className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-30"
                            >
                                <PencilIcon />
                            </button>
                            <button
                                type="button"
                                aria-label={t('scratchlist.action.promoteToQueue')}
                                title={t('scratchlist.action.promoteToQueue')}
                                onClick={() => onPromoteToQueue(entry)}
                                disabled={isBusy}
                                className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-30"
                            >
                                <SendIcon />
                            </button>
                            <button
                                type="button"
                                aria-label={
                                    copiedEntryId === entry.id
                                        ? t('scratchlist.action.copied')
                                        : t('scratchlist.action.copy')
                                }
                                title={
                                    copiedEntryId === entry.id
                                        ? t('scratchlist.action.copied')
                                        : t('scratchlist.action.copy')
                                }
                                onClick={() => { void handleCopy(entry) }}
                                disabled={isBusy}
                                data-copied={copiedEntryId === entry.id ? '' : undefined}
                                className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-30 data-[copied]:text-[var(--app-badge-warning-text)]"
                            >
                                {copiedEntryId === entry.id ? <ClipboardCheckIcon /> : <CopyIcon />}
                            </button>
                            <button
                                type="button"
                                aria-label={t('scratchlist.action.delete')}
                                title={t('scratchlist.action.delete')}
                                onClick={() => onDelete(entry)}
                                disabled={isBusy}
                                className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-30"
                            >
                                <TrashIcon />
                            </button>
                        </div>
                    </li>
                )
            })}
        </ul>
    )
}

/**
 * Composer-controlled drawer. No own header / no own textarea: the composer
 * is the input source (composerSendsToScratchlist toggle in SessionChat).
 *
 * State is owned by the caller via useScratchlist(). The drawer is purely
 * presentational + behavior glue around the inventory list.
 */
export function ScratchlistDrawer({
    entries,
    onMove,
    onDelete,
    onPromoteToComposer,
    onPromoteToQueue,
}: {
    entries: ScratchlistEntry[]
    onMove: (id: string, direction: 'up' | 'down') => void
    onDelete: (id: string) => void
    onPromoteToComposer: (text: string) => void
    onPromoteToQueue: (text: string) => Promise<boolean>
}) {
    const { t } = useTranslation()
    const [busyEntryId, setBusyEntryId] = useState<string | null>(null)

    const summary = useMemo(() => {
        if (entries.length === 0) return t('scratchlist.empty')
        if (entries.length === 1) return t('scratchlist.count.one')
        return t('scratchlist.count.other', { n: entries.length })
    }, [entries.length, t])

    const handleDelete = useCallback((entry: ScratchlistEntry) => {
        if (shouldConfirmDelete(entry)) {
            const confirmed = typeof window !== 'undefined'
                ? window.confirm(t('scratchlist.confirmDelete'))
                : true
            if (!confirmed) return
        }
        onDelete(entry.id)
    }, [onDelete, t])

    const handleMove = useCallback((entry: ScratchlistEntry, direction: 'up' | 'down') => {
        onMove(entry.id, direction)
    }, [onMove])

    const handlePromoteToComposer = useCallback((entry: ScratchlistEntry) => {
        onPromoteToComposer(entry.text)
    }, [onPromoteToComposer])

    const handlePromoteToQueue = useCallback(async (entry: ScratchlistEntry) => {
        if (busyEntryId) return
        setBusyEntryId(entry.id)
        try {
            const accepted = await onPromoteToQueue(entry.text)
            if (accepted) onDelete(entry.id)
        } finally {
            setBusyEntryId(null)
        }
    }, [busyEntryId, onDelete, onPromoteToQueue])

    return (
        <div className="mx-auto w-full max-w-content mb-1">
            <div
                className="rounded-lg border border-[var(--app-badge-warning-border)] bg-[var(--app-chat-user-surface-bg)]"
                data-testid="scratchlist-drawer"
            >
                <div className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--app-fg)]">
                    <NoteIcon />
                    <span className="flex-1 truncate">
                        {t('scratchlist.title')}
                    </span>
                    <span
                        className="rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--app-hint)]"
                        aria-hidden="true"
                    >
                        {t('scratchlist.heldLabel')}
                    </span>
                    <span className="text-[var(--app-hint)] text-[11px] tabular-nums">
                        {summary}
                    </span>
                </div>

                <div className="px-3 pb-3">
                    <p className="text-[11px] text-[var(--app-hint)] mb-1">
                        {t('scratchlist.drawerHint')}
                    </p>
                    <ScratchlistInventory
                        entries={entries}
                        busyEntryId={busyEntryId}
                        onPromoteToComposer={handlePromoteToComposer}
                        onPromoteToQueue={handlePromoteToQueue}
                        onDelete={handleDelete}
                        onMove={handleMove}
                    />
                </div>
            </div>
        </div>
    )
}

/**
 * Per-session scratchlist (issue #11) -- the operator's "workbench".
 *
 * Distinct from the queue (`QueuedMessagesBar`):
 * - Queue = conveyor belt: messages auto-fire in order once the agent is idle.
 * - Scratchlist = workbench: notes / drafts / parking-lot ideas held until the
 *   operator explicitly promotes them (to the composer or into the queue).
 *
 * The "held -- not sent" pill plus a subtle amber border is the visual
 * signal that nothing here is being sent without an explicit action. The
 * panel surface mirrors the user-message chat surface so it stays calm in
 * the scroll; the strong amber destination signal lives on the composer
 * Send button (which only goes amber while scratchlist mode is routing).
 */
export function ScratchlistPanel({
    sessionId,
    onPromoteToComposer,
    onPromoteToQueue,
}: {
    sessionId: string
    /**
     * Copies the entry text into the composer for editing. Called with the
     * raw entry text. Implementation lives in SessionChat (it owns the
     * AssistantUI runtime that exposes setText).
     */
    onPromoteToComposer: (text: string) => void
    /**
     * Sends the entry into the existing send-queue (same path as a normal
     * composer send). Resolves true when the send was accepted, false when
     * pre-mutation guards rejected it -- matches the contract of
     * useSendMessage.sendMessage so the UI knows whether to remove the
     * scratchlist entry on success.
     */
    onPromoteToQueue: (text: string) => Promise<boolean>
}) {
    const { t } = useTranslation()
    const [entries, setEntries] = useState<ScratchlistEntry[]>(() => readScratchlist(sessionId))
    const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsedPref(sessionId))
    const [draft, setDraft] = useState<string>('')
    const [busyEntryId, setBusyEntryId] = useState<string | null>(null)
    const inputRef = useRef<HTMLTextAreaElement | null>(null)
    const { copiedEntryId, signalCopied } = useCopiedFeedback()
    const handleCopy = useCallback(async (entry: ScratchlistEntry) => {
        try {
            await safeCopyToClipboard(entry.text)
            signalCopied(entry.id)
        } catch {
            // see ScratchlistInventory.handleCopy for rationale
        }
    }, [signalCopied])

    // Re-hydrate when the session id changes (route navigation between sessions).
    useEffect(() => {
        setEntries(readScratchlist(sessionId))
        setCollapsed(readCollapsedPref(sessionId))
        setDraft('')
        setBusyEntryId(null)
    }, [sessionId])

    // Persist on every change. The storage layer swallows quota / serialization
    // errors so this won't throw.
    useEffect(() => {
        persistScratchlist(sessionId, entries)
    }, [sessionId, entries])

    // Global keyboard shortcut: Ctrl/Cmd + Shift + S focuses the add-input
    // and expands the panel. Suggested by the handoff doc; matches the
    // convention used by other composer-adjacent shortcuts (Ctrl/Cmd-m for
    // model cycling) so it shouldn't collide with browser defaults that the
    // app cares about.
    useEffect(() => {
        const onKeyDown = (e: globalThis.KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'S' || e.key === 's')) {
                e.preventDefault()
                setCollapsed(false)
                writeCollapsedPref(sessionId, false)
                queueMicrotask(() => inputRef.current?.focus())
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [sessionId])

    const toggleCollapsed = useCallback(() => {
        setCollapsed((prev) => {
            const next = !prev
            writeCollapsedPref(sessionId, next)
            return next
        })
    }, [sessionId])

    const handleAdd = useCallback((rawText: string) => {
        setEntries((prev) => addScratchlistEntry(prev, rawText).entries)
        setDraft('')
    }, [])

    const handleSubmit = useCallback((event: ReactFormEvent<HTMLFormElement>) => {
        event.preventDefault()
        handleAdd(draft)
    }, [draft, handleAdd])

    const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        // Plain Enter adds; Shift+Enter inserts a newline. Mirrors the
        // composer's default keyboard-send behavior so muscle memory carries
        // over and reduces accidental newlines in scratchlist titles.
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            handleAdd(draft)
        }
    }, [draft, handleAdd])

    const handleDelete = useCallback((entry: ScratchlistEntry) => {
        if (shouldConfirmDelete(entry)) {
            const confirmed = typeof window !== 'undefined'
                ? window.confirm(t('scratchlist.confirmDelete'))
                : true
            if (!confirmed) return
        }
        setEntries((prev) => deleteScratchlistEntry(prev, entry.id))
    }, [t])

    const handleMove = useCallback((entry: ScratchlistEntry, direction: 'up' | 'down') => {
        setEntries((prev) => moveScratchlistEntry(prev, entry.id, direction))
    }, [])

    const handlePromoteToComposer = useCallback((entry: ScratchlistEntry) => {
        onPromoteToComposer(entry.text)
        // Promote-to-composer is a copy, not a move: the entry stays in the
        // scratchlist so the operator can iterate. Promote-to-queue is the
        // destructive variant.
    }, [onPromoteToComposer])

    const handlePromoteToQueue = useCallback(async (entry: ScratchlistEntry) => {
        if (busyEntryId) return
        setBusyEntryId(entry.id)
        try {
            const accepted = await onPromoteToQueue(entry.text)
            if (accepted) {
                setEntries((prev) => deleteScratchlistEntry(prev, entry.id))
            }
        } finally {
            setBusyEntryId(null)
        }
    }, [busyEntryId, onPromoteToQueue])

    const summary = useMemo(() => {
        if (entries.length === 0) return t('scratchlist.empty')
        if (entries.length === 1) return t('scratchlist.count.one')
        return t('scratchlist.count.other', { n: entries.length })
    }, [entries.length, t])

    const hasReachedCap = entries.length >= SCRATCHLIST_MAX_ENTRIES

    return (
        <div className="mx-auto w-full max-w-content mb-1">
            <div
                className="rounded-lg border border-[var(--app-badge-warning-border)] bg-[var(--app-chat-user-surface-bg)]"
                data-testid="scratchlist-panel"
            >
                <button
                    type="button"
                    onClick={toggleCollapsed}
                    aria-expanded={!collapsed}
                    aria-controls={`scratchlist-body-${sessionId}`}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-[var(--app-fg)] hover:opacity-90"
                >
                    <ChevronIcon open={!collapsed} />
                    <NoteIcon />
                    <span className="flex-1 truncate">
                        {t('scratchlist.title')}
                    </span>
                    <span
                        className="rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--app-hint)]"
                        aria-hidden="true"
                    >
                        {t('scratchlist.heldLabel')}
                    </span>
                    <span className="text-[var(--app-hint)] text-[11px] tabular-nums">
                        {summary}
                    </span>
                </button>

                <div
                    id={`scratchlist-body-${sessionId}`}
                    className="collapsible-panel"
                    aria-hidden={collapsed}
                    {...(!collapsed ? { 'data-open': '' } : {})}
                >
                    {/*
                     * `inert` removes the inner controls from the focus and
                     * pointer-events tree (and the accessibility tree) while
                     * collapsed. CSS-only collapse left the textarea + buttons
                     * focusable under aria-hidden, which is the regression
                     * flagged by the upstream PR review (a11y violation:
                     * focusable descendants inside an aria-hidden subtree).
                     * Using inert preserves the grid-template-rows expand
                     * animation while keeping the collapsed body unreachable.
                     */}
                    <div className="collapsible-inner" inert={collapsed}>
                        <div className="px-3 pb-3">
                            <form onSubmit={handleSubmit} className="flex items-start gap-2">
                                <textarea
                                    ref={inputRef}
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    rows={1}
                                    maxLength={SCRATCHLIST_MAX_TEXT_LENGTH}
                                    placeholder={t('scratchlist.addPlaceholder')}
                                    aria-label={t('scratchlist.addAriaLabel')}
                                    disabled={hasReachedCap}
                                    className="flex-1 min-w-0 resize-none rounded-md bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50"
                                />
                                <button
                                    type="submit"
                                    disabled={hasReachedCap || draft.trim().length === 0}
                                    className="shrink-0 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-1.5 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                    {t('scratchlist.add')}
                                </button>
                            </form>
                            {hasReachedCap ? (
                                <p className="mt-1 text-[11px] text-[var(--app-hint)]">
                                    {t('scratchlist.atCap', { n: SCRATCHLIST_MAX_ENTRIES })}
                                </p>
                            ) : null}

                            {entries.length > 0 ? (
                                <ul
                                    aria-label={t('scratchlist.listAriaLabel')}
                                    className="mt-2 flex max-h-64 flex-col gap-1.5 overflow-y-auto"
                                >
                                    {entries.map((entry, index) => {
                                        const isFirst = index === 0
                                        const isLast = index === entries.length - 1
                                        const isBusy = busyEntryId === entry.id
                                        return (
                                            <li
                                                key={entry.id}
                                                className="flex items-start gap-2 rounded-md bg-[var(--app-bg)] px-2 py-1.5 shadow-sm"
                                                data-testid="scratchlist-entry"
                                            >
                                                <span className="flex-1 min-w-0 whitespace-pre-wrap break-words text-sm text-[var(--app-fg)] line-clamp-4">
                                                    {entry.text}
                                                </span>
                                                <div className="flex shrink-0 items-center gap-0.5 text-[var(--app-hint)]">
                                                    <EntryAgeIndicator entry={entry} />
                                                    <button
                                                        type="button"
                                                        aria-label={t('scratchlist.action.moveUp')}
                                                        title={t('scratchlist.action.moveUp')}
                                                        onClick={() => handleMove(entry, 'up')}
                                                        disabled={isFirst || isBusy}
                                                        className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-30"
                                                    >
                                                        <ArrowUpIcon />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        aria-label={t('scratchlist.action.moveDown')}
                                                        title={t('scratchlist.action.moveDown')}
                                                        onClick={() => handleMove(entry, 'down')}
                                                        disabled={isLast || isBusy}
                                                        className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-30"
                                                    >
                                                        <ArrowDownIcon />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        aria-label={t('scratchlist.action.promoteToComposer')}
                                                        title={t('scratchlist.action.promoteToComposer')}
                                                        onClick={() => handlePromoteToComposer(entry)}
                                                        disabled={isBusy}
                                                        className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-30"
                                                    >
                                                        <PencilIcon />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        aria-label={t('scratchlist.action.promoteToQueue')}
                                                        title={t('scratchlist.action.promoteToQueue')}
                                                        onClick={() => { void handlePromoteToQueue(entry) }}
                                                        disabled={isBusy}
                                                        className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-30"
                                                    >
                                                        <SendIcon />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        aria-label={
                                                            copiedEntryId === entry.id
                                                                ? t('scratchlist.action.copied')
                                                                : t('scratchlist.action.copy')
                                                        }
                                                        title={
                                                            copiedEntryId === entry.id
                                                                ? t('scratchlist.action.copied')
                                                                : t('scratchlist.action.copy')
                                                        }
                                                        onClick={() => { void handleCopy(entry) }}
                                                        disabled={isBusy}
                                                        data-copied={copiedEntryId === entry.id ? '' : undefined}
                                                        className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-30 data-[copied]:text-[var(--app-badge-warning-text)]"
                                                    >
                                                        {copiedEntryId === entry.id ? <ClipboardCheckIcon /> : <CopyIcon />}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        aria-label={t('scratchlist.action.delete')}
                                                        title={t('scratchlist.action.delete')}
                                                        onClick={() => handleDelete(entry)}
                                                        disabled={isBusy}
                                                        className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-30"
                                                    >
                                                        <TrashIcon />
                                                    </button>
                                                </div>
                                            </li>
                                        )
                                    })}
                                </ul>
                            ) : (
                                <p className="mt-2 text-[11px] text-[var(--app-hint)]">
                                    {t('scratchlist.emptyHint')}
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
