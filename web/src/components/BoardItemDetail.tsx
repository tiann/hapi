import { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from 'react'
import * as Popover from '@radix-ui/react-popover'
import type { BoardAssignableUser, BoardItem, BoardItemComment } from '@/types/api'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { defaultComponents } from '@/components/assistant-ui/markdown-text'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { SessionLinkedBadge } from '@/components/SessionLinkedBadge'
import { Spinner } from '@/components/Spinner'
import { CheckIcon, CloseIcon, ExternalLinkIcon, PlusCircleIcon, PlusIcon, RefreshIcon } from '@/components/icons'
import { chipBaseClass, chipIdleClass } from '@/components/filterChipStyles'
import { getApiErrorMessage } from '@/lib/apiErrorMessage'
import { formatAbsoluteDateTime, formatRelativeTime } from '@/lib/relativeTime'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

function BackIcon() {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
        </svg>
    )
}

// GitHub resolves an absolute-path link or image src (`/owner/repo/blob/...`)
// against its own domain — our standalone renderer has no `chat` context to
// tell it that, so a link falls into `classifyNoSchemeHref`'s workspace-file/
// inert classification and an image's `src` is forwarded completely
// unresolved, so the browser requests it from the HAPI origin instead and it
// renders broken (review finding, hapi#238/#2147).
//
// Operates on the parsed anchor's/image's own `href`/`src` prop, not on the
// raw markdown text: an earlier version did a text-level regex rewrite
// before handing the markdown to the renderer, which also corrupted any
// code sample that happened to contain the same-looking literal text inside
// inline code or a fenced block (review finding, hapi#238/#2147 —
// independently confirmed by both forks' bots) — `code`/`inlineCode` are
// separate mdast node types from `link`/`image`, so a component override
// here never sees their contents at all. Scoped to leading-`/` destinations
// only (what GitHub itself resolves domain-relatively) — a bare relative
// destination with no leading slash is ambiguous outside a real file tree
// and GitHub doesn't special-case it either. Delegates to the same default
// components for everything else so real external links/images, custom-
// scheme confirmation, etc. keep behaving exactly as they already do.
function useGithubRelativeMarkdownComponents(referenceUrl: string | null) {
    return useMemo(() => {
        const DefaultAnchor = defaultComponents.a!
        const DefaultImage = defaultComponents.img!
        let host: string | null = null
        try {
            host = referenceUrl ? new URL(referenceUrl).host : null
        } catch {
            host = null
        }
        if (!host) return { a: DefaultAnchor, img: DefaultImage }
        const resolve = (value: string) => (/^\/(?!\/)/.test(value) ? `https://${host}${value}` : null)
        return {
            a: function GithubRelativeAnchor(props: ComponentPropsWithoutRef<'a'>) {
                const resolved = typeof props.href === 'string' ? resolve(props.href) : null
                if (resolved) {
                    const { href, ...rest } = props
                    return <a {...rest} href={resolved} target="_blank" rel="noopener noreferrer" />
                }
                return <DefaultAnchor {...props} />
            },
            img: function GithubRelativeImage(props: ComponentPropsWithoutRef<'img'>) {
                const resolved = typeof props.src === 'string' ? resolve(props.src) : null
                if (resolved) {
                    const { src, ...rest } = props
                    return <DefaultImage {...rest} src={resolved} />
                }
                return <DefaultImage {...props} />
            }
        }
    }, [referenceUrl])
}

function toEpochMs(iso: string | null): number | null {
    if (!iso) return null
    const ms = new Date(iso).getTime()
    return Number.isFinite(ms) ? ms : null
}

function TimestampRow(props: { label: string; iso: string | null; t: (key: string, params?: Record<string, string | number>) => string }) {
    const ms = toEpochMs(props.iso)
    if (ms === null) return null
    const relative = formatRelativeTime(ms, props.t)
    return (
        <div className="flex items-center gap-1.5 text-xs text-[var(--app-hint)]">
            <span>{props.label}:</span>
            <span title={formatAbsoluteDateTime(ms) ?? undefined}>{relative}</span>
        </div>
    )
}

function formatAuthorAssociation(association: string): string | null {
    if (association === 'NONE' || association === '') return null
    return association
        .toLowerCase()
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join('-')
}

function CommentRow(props: { comment: BoardItemComment; t: (key: string, params?: Record<string, string | number>) => string }) {
    const { comment, t } = props
    const ms = toEpochMs(comment.createdAt)
    const association = formatAuthorAssociation(comment.authorAssociation)
    const markdownComponents = useGithubRelativeMarkdownComponents(comment.url)
    return (
        <div className="rounded-md border border-[var(--app-border)] p-3">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--app-hint)]">
                {comment.author ? (
                    <img src={comment.author.avatarUrl} alt="" className="h-5 w-5 rounded-full" />
                ) : null}
                <span className="font-medium text-[var(--app-fg)]">{comment.author?.login ?? t('boards.detail.deletedAuthor')}</span>
                {association ? (
                    <span className="rounded-full border border-[var(--app-border)] px-1.5 py-0.5 text-[10px]">{association}</span>
                ) : null}
                {ms !== null ? (
                    <a
                        href={comment.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={formatAbsoluteDateTime(ms) ?? undefined}
                        className="ml-auto shrink-0 hover:text-[var(--app-fg)] hover:underline"
                    >
                        {formatRelativeTime(ms, t)}
                    </a>
                ) : null}
            </div>
            <div className="mt-2">
                <MarkdownRenderer standalone content={comment.body} components={markdownComponents} />
            </div>
        </div>
    )
}

// Debounce (not a per-keystroke fetch) matching the input to the hub's
// GraphQL `query` filter, which only applies server-side when the caller
// actually passes a non-empty search term — so typing just narrows the same
// 50-row page rather than firing a request per character.
const ASSIGNABLE_USERS_SEARCH_DEBOUNCE_MS = 300

// Click-to-toggle checklist, not a multi-select-then-confirm form (design-
// consult review, hapi#238) — matches GitHub's own assignee picker and
// avoids tracking a separate draft-vs-committed selection state. Each row
// fires a single add-or-remove call immediately; `isPending` disables the
// whole list during that one in-flight request rather than per-row, since a
// second toggle before the first settles would race against it anyway.
// Assignable users are fetched on open (`onOpenChange`), not eagerly on
// every render — one GraphQL call per visible card would be wasteful for
// data nobody may ever open the picker to see. A search box (Codex review:
// a 50-row page with no pagination or search left every assignable user
// past the first page permanently unreachable from this picker) forwards
// the hub's own server-side `assignableUsers(query:)` filter instead of
// paginating client-side.
function AssigneePicker(props: {
    currentLogins: ReadonlySet<string>
    users: BoardAssignableUser[]
    isLoadingUsers: boolean
    usersError: string | null
    isPending: boolean
    onOpenChange: (open: boolean) => void
    onSearchChange: (search: string) => void
    onToggle: (login: string, currentlyAssigned: boolean) => void
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    const [open, setOpen] = useState(false)
    const [searchInput, setSearchInput] = useState('')

    useEffect(() => {
        const timer = setTimeout(() => props.onSearchChange(searchInput), ASSIGNABLE_USERS_SEARCH_DEBOUNCE_MS)
        return () => clearTimeout(timer)
    }, [searchInput]) // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <Popover.Root
            open={open}
            onOpenChange={(next) => {
                setOpen(next)
                props.onOpenChange(next)
                if (!next) setSearchInput('')
            }}
        >
            <Popover.Trigger asChild>
                <button
                    type="button"
                    aria-label={props.t('boards.detail.addAssignee')}
                    title={props.t('boards.detail.addAssignee')}
                    className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                >
                    <PlusIcon className="h-3 w-3" />
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    collisionPadding={8}
                    className="z-50 flex max-h-64 w-56 flex-col rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg"
                >
                    <input
                        type="text"
                        value={searchInput}
                        onChange={(event) => setSearchInput(event.target.value)}
                        placeholder={props.t('boards.detail.searchAssignees')}
                        aria-label={props.t('boards.detail.searchAssignees')}
                        className="mb-1 shrink-0 rounded-sm border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-1 text-xs text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    />
                    <div className="min-h-0 flex-1 overflow-y-auto">
                    {props.isLoadingUsers ? (
                        <div className="flex justify-center p-2"><Spinner size="sm" /></div>
                    ) : props.usersError ? (
                        <div className="p-2 text-xs text-red-600">{props.usersError}</div>
                    ) : props.users.length === 0 ? (
                        <div className="p-2 text-xs text-[var(--app-hint)]">{props.t('boards.detail.noAssignableUsers')}</div>
                    ) : (
                        <ul>
                            {props.users.map(user => {
                                const isAssigned = props.currentLogins.has(user.login)
                                return (
                                    <li key={user.login}>
                                        <button
                                            type="button"
                                            disabled={props.isPending}
                                            onClick={() => props.onToggle(user.login, isAssigned)}
                                            className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                                        >
                                            <img src={user.avatarUrl} alt="" className="h-4 w-4 shrink-0 rounded-full" />
                                            {/* Always includes the login, not just the display name (Codex
                                                review, hapi#238): two assignable users can share the same
                                                non-null name, making name-only rows indistinguishable. */}
                                            <span className="min-w-0 flex-1 truncate">
                                                {user.name ? `${user.name} (@${user.login})` : `@${user.login}`}
                                            </span>
                                            {isAssigned ? <CheckIcon className="h-3.5 w-3.5 shrink-0 text-[var(--app-link)]" /> : null}
                                        </button>
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}

// Right-pane detail for a board card click (hapi#235) — same slot session
// detail occupies today. "Spawn session" reuses the existing new-session
// flow entirely (NewSession's initialDirectory/initialMachineId props for
// the folder picker) — resolving a directory and building the briefing
// message both happen in the parent (router.tsx), this component just
// triggers it. The parent delivers the briefing as a real message right
// after creation (same mechanism spawn_peer uses, not a composer draft) and
// also passes the item's issue URL through so the new session is
// auto-linked (metadata.externalRefs), surfacing as an IssueRefChip on the
// resulting session row/detail.
//
// Write actions (close/reopen/comment/status) all require item.url — draft
// issues (no linked Issue/PR) have nothing for `gh issue`/`gh project
// item-edit` to target, so the whole write-actions section is gated on it
// (operator decision, hapi#238: "the whole reason to bring these cards here
// is to not have to go to GitHub" — but that's only possible for items that
// actually link to something on GitHub).
export function BoardItemDetail(props: {
    item: BoardItem
    statusOrder: string[]
    onBack: () => void
    onSpawn: () => void
    /** Session id already linked to this item's issue, if any — offers "Open session" instead of another spawn. */
    linkedSessionId: string | null
    onOpenLinkedSession: (sessionId: string) => void
    onRefresh: () => void
    isRefreshing: boolean
    onClose: () => Promise<void>
    onReopen: () => void
    onComment: (body: string) => Promise<void>
    comments: BoardItemComment[]
    isLoadingComments: boolean
    commentsError: string | null
    onSetStatus: (status: string | null) => void
    assignableUsers: BoardAssignableUser[]
    isLoadingAssignableUsers: boolean
    assignableUsersError: string | null
    onAssigneePickerOpenChange: (open: boolean) => void
    onAssignableUsersSearchChange: (search: string) => void
    onSetAssignees: (addLogins: string[], removeLogins: string[]) => void
    isClosing: boolean
    isReopening: boolean
    isCommenting: boolean
    isSettingStatus: boolean
    isSettingAssignees: boolean
}) {
    const { t } = useTranslation()
    const { item, linkedSessionId } = props
    const repoLabel = item.repo ?? t('boards.noRepo')
    const updatedLabel = item.updatedAt ? formatRelativeTime(new Date(item.updatedAt).getTime(), t) : null
    const chipClass = cn(chipBaseClass, chipIdleClass, 'pointer-events-none h-6 px-2')
    const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
    const [commentDraft, setCommentDraft] = useState('')
    const canWrite = item.url !== null
    const bodyMarkdownComponents = useGithubRelativeMarkdownComponents(item.url)
    const isClosed = item.state === 'CLOSED' || item.state === 'MERGED'

    const handleSendComment = async () => {
        const body = commentDraft.trim()
        if (!body) return
        try {
            await props.onComment(body)
            setCommentDraft('')
        } catch {
            // Failure is already surfaced as a toast by the caller — keep the
            // draft intact so the user's typed comment isn't lost.
        }
    }

    return (
        <div data-testid="board-item-detail" className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <div className="flex shrink-0 items-start gap-2 border-b border-[var(--app-border)] p-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
                <button
                    type="button"
                    onClick={props.onBack}
                    aria-label={t('boards.detail.back')}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] split:hidden"
                >
                    <BackIcon />
                </button>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                        {item.status ? <span className={chipClass}>{item.status}</span> : null}
                        {item.number !== null ? <span className={cn(chipClass, 'font-mono')}>#{item.number}</span> : null}
                        <span className={cn(chipClass, 'max-w-48 truncate')}>{repoLabel}</span>
                        {updatedLabel ? <span className="text-xs text-[var(--app-hint)]">{updatedLabel}</span> : null}
                    </div>
                    <h2 className="mt-2 text-base font-semibold text-[var(--app-fg)]">{item.title}</h2>
                </div>
                <button
                    type="button"
                    onClick={props.onRefresh}
                    disabled={props.isRefreshing}
                    aria-label={t('boards.detail.refresh')}
                    title={t('boards.detail.refresh')}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
                >
                    <RefreshIcon className={cn('h-4 w-4', props.isRefreshing && 'animate-spin')} />
                </button>
            </div>

            <div data-testid="board-item-detail-body" className="min-h-0 flex-1 overflow-y-auto p-4">
                {/* One unified wrapping flow, not a stack of separately-forced
                    full-width sections — short items (a single assignee, a
                    label, a date) sit side by side on a wide pane and only
                    drop to their own line when the container genuinely runs
                    out of width, instead of each piling up vertically
                    regardless of how little space its content needs
                    (operator feedback, live on a real board: "make better
                    use of available horizontal space"). */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--app-border)] pb-4 text-xs text-[var(--app-hint)]">
                    {item.author ? (
                        <span className="inline-flex items-center gap-1.5">
                            <img src={item.author.avatarUrl} alt="" className="h-4 w-4 rounded-full" />
                            {t('boards.detail.openedBy', { login: item.author.login })}
                        </span>
                    ) : null}
                    {item.assignees.length > 0 || canWrite ? (
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                            {t('boards.detail.assignees')}:
                            {item.assignees.map(assignee => (
                                <span
                                    key={assignee.login}
                                    className="inline-flex items-center gap-1 rounded-full border border-[var(--app-border)] py-0.5 pl-1 pr-1.5"
                                >
                                    <img src={assignee.avatarUrl} alt="" className="h-4 w-4 rounded-full" />
                                    {assignee.login}
                                    {canWrite ? (
                                        <button
                                            type="button"
                                            disabled={props.isSettingAssignees}
                                            onClick={() => props.onSetAssignees([], [assignee.login])}
                                            aria-label={t('boards.detail.removeAssignee', { login: assignee.login })}
                                            title={t('boards.detail.removeAssignee', { login: assignee.login })}
                                            className="text-[var(--app-hint)] hover:text-[var(--app-fg)] disabled:opacity-50"
                                        >
                                            <CloseIcon className="h-3 w-3" />
                                        </button>
                                    ) : null}
                                </span>
                            ))}
                            {canWrite ? (
                                <AssigneePicker
                                    currentLogins={new Set(item.assignees.map(a => a.login))}
                                    users={props.assignableUsers}
                                    isLoadingUsers={props.isLoadingAssignableUsers}
                                    usersError={props.assignableUsersError}
                                    isPending={props.isSettingAssignees}
                                    onOpenChange={props.onAssigneePickerOpenChange}
                                    onSearchChange={props.onAssignableUsersSearchChange}
                                    onToggle={(login, currentlyAssigned) => {
                                        if (currentlyAssigned) {
                                            props.onSetAssignees([], [login])
                                        } else {
                                            props.onSetAssignees([login], [])
                                        }
                                    }}
                                    t={t}
                                />
                            ) : null}
                            {props.isSettingAssignees ? <Spinner size="sm" label={t('boards.detail.changingAssignees')} /> : null}
                        </span>
                    ) : null}
                    {item.labels.map(label => (
                        <span
                            key={label.name}
                            className="inline-flex items-center gap-1 rounded-full border border-[var(--app-border)] px-1.5 py-0.5 text-[10px]"
                        >
                            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: `#${label.color}` }} />
                            {label.name}
                        </span>
                    ))}
                    {item.milestone ? (
                        <span>
                            {t('boards.detail.milestone')}: {item.milestone.title}
                            {item.milestone.dueOn ? ` (${t('boards.detail.dueOn', { date: item.milestone.dueOn })})` : ''}
                        </span>
                    ) : null}
                    <TimestampRow label={t('boards.detail.created')} iso={item.createdAt} t={t} />
                    <TimestampRow label={t('boards.detail.updated')} iso={item.updatedAt} t={t} />
                    <TimestampRow label={t('boards.detail.closed')} iso={item.closedAt} t={t} />
                    {item.customFields.map(field => (
                        <span
                            key={field.name}
                            className="inline-flex items-center gap-1 rounded-full border border-[var(--app-border)] px-1.5 py-0.5 text-[10px]"
                        >
                            <span className="font-medium text-[var(--app-fg)]">{field.name}</span>: {field.value}
                        </span>
                    ))}
                    {canWrite ? (
                        <label className="inline-flex items-center gap-1.5">
                            {t('boards.detail.status')}:
                            <select
                                value={item.status ?? ''}
                                disabled={props.isSettingStatus}
                                onChange={(event) => {
                                    const next = event.target.value
                                    if (next === (item.status ?? '')) return
                                    // A project can legitimately move a card back to the
                                    // unassigned/no-status bucket (`gh project item-edit
                                    // --clear`) — the no-status option used to only appear
                                    // for an already-unassigned item, so that transition
                                    // could never be performed from HAPI once a status was
                                    // set (Codex review, hapi#238).
                                    props.onSetStatus(next || null)
                                }}
                                className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-fg)]"
                            >
                                <option value="">{t('boards.noStatus')}</option>
                                {props.statusOrder.map(status => (
                                    <option key={status} value={status}>{status}</option>
                                ))}
                            </select>
                            {props.isSettingStatus ? <Spinner size="sm" label={t('boards.detail.statusChanging')} /> : null}
                        </label>
                    ) : null}
                </div>

                <div className="pt-4">
                    {item.body ? (
                        <MarkdownRenderer standalone content={item.body} components={bodyMarkdownComponents} />
                    ) : (
                        <p className="text-sm text-[var(--app-hint)]">{t('boards.detail.noBody')}</p>
                    )}
                </div>

                {canWrite ? (
                    <div className="mt-4 border-t border-[var(--app-border)] pt-4">
                        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                            {t('boards.detail.comments')}
                        </h3>
                        {props.isLoadingComments ? (
                            <Spinner size="sm" label={t('boards.detail.loadingComments')} />
                        ) : props.commentsError ? (
                            <p className="text-sm text-red-600">{t('boards.detail.commentsLoadFailed', { message: props.commentsError })}</p>
                        ) : props.comments.length === 0 ? (
                            <p className="text-sm text-[var(--app-hint)]">{t('boards.detail.noComments')}</p>
                        ) : (
                            <div className="flex flex-col gap-3">
                                {props.comments.map(comment => (
                                    <CommentRow key={comment.id} comment={comment} t={t} />
                                ))}
                            </div>
                        )}
                    </div>
                ) : null}

                {canWrite ? (
                    <div className="mt-4 border-t border-[var(--app-border)] pt-4">
                        <label htmlFor="board-item-comment" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                            {t('boards.detail.comment')}
                        </label>
                        <textarea
                            id="board-item-comment"
                            value={commentDraft}
                            onChange={(event) => setCommentDraft(event.target.value)}
                            disabled={props.isCommenting}
                            placeholder={t('boards.detail.commentPlaceholder')}
                            rows={3}
                            className="w-full resize-none rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        />
                        <div className="mt-1.5 flex justify-end">
                            <Button
                                type="button"
                                className="gap-2"
                                aria-busy={props.isCommenting}
                                disabled={props.isCommenting || !commentDraft.trim()}
                                onClick={handleSendComment}
                            >
                                {props.isCommenting ? (
                                    <>
                                        <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                                        {t('boards.detail.commenting')}
                                    </>
                                ) : t('boards.detail.sendComment')}
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>

            {/* Navigation (view something, no state change here) stays light —
                outline buttons, or the shared SessionLinkedBadge for "Open
                session" so it reads as the same affordance as the card's own
                badge. Mutating actions (Spawn, Reopen, Close, and the
                comment-submit/status-select above) get the filled/primary
                treatment instead, so consequence is visually distinguishable
                from mere navigation (operator affordance audit, hapi#238). */}
            <div data-testid="board-item-detail-actions" className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--app-border)] p-3">
                {item.url ? (
                    <Button asChild variant="outline">
                        <a href={item.url} target="_blank" rel="noopener noreferrer">
                            <ExternalLinkIcon className="h-4 w-4" />
                            {t('boards.detail.openInGithub')}
                        </a>
                    </Button>
                ) : null}
                {linkedSessionId ? (
                    <SessionLinkedBadge
                        size="md"
                        onClick={() => props.onOpenLinkedSession(linkedSessionId)}
                        title={t('boards.detail.openSession')}
                        ariaLabel={t('boards.detail.openSession')}
                        label={t('boards.detail.openSession')}
                    />
                ) : (
                    <Button
                        type="button"
                        onClick={props.onSpawn}
                    >
                        <PlusCircleIcon className="h-4 w-4" />
                        {t('boards.detail.spawnSession')}
                    </Button>
                )}
                {/* A merged PR can't be reopened via `gh pr reopen` (GitHub rejects it) and is
                    already terminally closed, so neither action applies — unlike a plain closed
                    issue/PR, which `gh ... reopen` handles fine. */}
                {canWrite && item.state !== 'MERGED' ? (
                    isClosed ? (
                        <Button type="button" className="gap-2" aria-busy={props.isReopening} disabled={props.isReopening} onClick={props.onReopen}>
                            {props.isReopening ? (
                                <>
                                    <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                                    {t('boards.detail.reopening')}
                                </>
                            ) : t('boards.detail.reopen')}
                        </Button>
                    ) : (
                        <Button type="button" className="gap-2" aria-busy={props.isClosing} disabled={props.isClosing} onClick={() => setCloseConfirmOpen(true)}>
                            {props.isClosing ? (
                                <>
                                    <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                                    {t('boards.detail.closing')}
                                </>
                            ) : t('boards.detail.close')}
                        </Button>
                    )
                ) : null}
            </div>

            <ConfirmDialog
                isOpen={closeConfirmOpen}
                onClose={() => setCloseConfirmOpen(false)}
                title={t('boards.detail.closeConfirmTitle')}
                description={t('boards.detail.closeConfirmDescription', { title: item.title })}
                confirmLabel={t('boards.detail.close')}
                confirmingLabel={t('boards.detail.closing')}
                onConfirm={async () => {
                    try {
                        await props.onClose()
                    } catch (err) {
                        throw new Error(getApiErrorMessage(err, t('dialog.error.default')))
                    }
                }}
                isPending={props.isClosing}
                destructive
            />
        </div>
    )
}
