import { useId, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { GitStatusFiles, Session } from '@/types/api'
import { HostBadge } from '@/components/HostBadge'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { MoreVerticalIcon } from '@/components/SessionIcons'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/shared/ui'
import { cn } from '@/lib/utils'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useTranslation } from '@/lib/use-translation'

function GitBranchIcon(props: { className?: string }) {
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
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
    )
}

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

type GitSummary = Pick<GitStatusFiles, 'branch' | 'totalStaged' | 'totalUnstaged'>

type SessionHeaderView = 'chat' | 'terminal' | 'files'

type SessionHeaderProps = {
    session: Session
    onBack: () => void
    api: ApiClient | null
    onSessionDeleted?: () => void
    gitSummary?: GitSummary | null
    gitLoading?: boolean
    gitError?: boolean
    currentView: SessionHeaderView
    onSelectView: (view: SessionHeaderView) => void
}

function GitStatusBar(props: { gitSummary: GitSummary | null; isLoading: boolean; hasError: boolean }) {
    const { t } = useTranslation()

    if (props.isLoading) {
        return (
            <div className="flex items-center gap-1.5 text-xs text-[var(--app-hint)]" role="status">
                <GitBranchIcon className="text-[var(--app-hint)]" />
                <span>{t('session.git.loading')}</span>
            </div>
        )
    }

    if (props.hasError || !props.gitSummary) {
        return (
            <div className="flex items-center gap-1.5 text-xs text-[var(--app-hint)]">
                <GitBranchIcon className="text-[var(--app-hint)]" />
                <span>{t('session.git.unavailable')}</span>
            </div>
        )
    }

    const { branch, totalStaged, totalUnstaged } = props.gitSummary
    const branchLabel = branch ?? t('session.git.detached')

    return (
        <div className="flex items-center gap-1.5 text-xs text-[var(--app-hint)]">
            <GitBranchIcon className="text-[var(--app-hint)]" />
            <span className="font-semibold text-[var(--app-fg)]">{branchLabel}</span>
            <span aria-hidden="true">&middot;</span>
            <span>{t('session.git.staged', { n: totalStaged })}</span>
            <span aria-hidden="true">&middot;</span>
            <span>{t('session.git.unstaged', { n: totalUnstaged })}</span>
        </div>
    )
}

export function SessionHeader({
    session,
    onBack,
    api,
    onSessionDeleted,
    gitSummary,
    gitLoading = false,
    gitError = false,
    currentView,
    onSelectView,
}: SessionHeaderProps) {
    const { t } = useTranslation()
    const title = useMemo(() => getSessionTitle(session), [session])
    const worktreeBranch = session.metadata?.worktree?.branch
    const showGitStatus = Boolean(session.metadata?.path)

    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const menuId = useId()
    const menuAnchorRef = useRef<HTMLButtonElement | null>(null)
    const [renameOpen, setRenameOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)

    const { archiveSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        session.id,
        session.metadata?.flavor ?? null
    )

    const handleDelete = async () => {
        await deleteSession()
        onSessionDeleted?.()
    }

    const handleMenuToggle = () => {
        if (!menuOpen && menuAnchorRef.current) {
            const rect = menuAnchorRef.current.getBoundingClientRect()
            setMenuAnchorPoint({ x: rect.right, y: rect.bottom })
        }
        setMenuOpen((open) => !open)
    }

    const views: Array<{ key: SessionHeaderView; label: string }> = [
        { key: 'chat', label: t('session.view.chat') },
        { key: 'terminal', label: t('session.view.terminal') },
        ...(session.metadata?.path
            ? [{ key: 'files' as const, label: t('session.view.files') }]
            : []),
    ]

    return (
        <>
            <div className="border-b border-[var(--app-border)] bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto flex w-full max-w-content items-center gap-2 p-3">
                    <button
                        type="button"
                        onClick={onBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        aria-label={t('button.close')}
                    >
                        <BackIcon />
                    </button>

                    <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">{title}</div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--app-hint)]">
                            <HostBadge
                                host={session.metadata?.host}
                                platform={session.metadata?.os}
                                machineId={session.metadata?.machineId}
                                sessionId={session.id}
                            />
                            <span>
                                {session.metadata?.flavor?.trim() || t('misc.unknown')}
                            </span>
                            {worktreeBranch ? <span>{t('session.item.worktree')}: {worktreeBranch}</span> : null}
                        </div>
                        {showGitStatus ? (
                            <GitStatusBar
                                gitSummary={gitSummary ?? null}
                                isLoading={gitLoading}
                                hasError={gitError}
                            />
                        ) : null}
                    </div>

                    <button
                        type="button"
                        onClick={handleMenuToggle}
                        onPointerDown={(e) => e.stopPropagation()}
                        ref={menuAnchorRef}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        aria-controls={menuOpen ? menuId : undefined}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        title={t('session.more')}
                    >
                        <MoreVerticalIcon />
                    </button>
                </div>

                <div className="mx-auto w-full max-w-content" role="tablist" aria-label={t('session.view.label')}>
                    <div
                        className="grid"
                        style={{ gridTemplateColumns: `repeat(${views.length}, minmax(0, 1fr))` }}
                    >
                        {views.map((view) => {
                            const active = currentView === view.key
                            return (
                                <button
                                    key={view.key}
                                    type="button"
                                    role="tab"
                                    aria-selected={active}
                                    onClick={() => onSelectView(view.key)}
                                    className={cn(
                                        'relative py-3 text-center text-sm font-semibold transition-colors hover:bg-[var(--app-subtle-bg)]',
                                        active ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'
                                    )}
                                >
                                    {view.label}
                                    <span
                                        className={cn(
                                            'absolute bottom-0 left-1/2 h-0.5 w-10 -translate-x-1/2 rounded-full',
                                            active ? 'bg-[var(--app-link)]' : 'bg-transparent'
                                        )}
                                    />
                                </button>
                            )
                        })}
                    </div>
                </div>
            </div>

            <SessionActionMenu
                isOpen={menuOpen}
                onClose={() => setMenuOpen(false)}
                sessionActive={session.active}
                onRename={() => setRenameOpen(true)}
                onArchive={() => setArchiveOpen(true)}
                onDelete={() => setDeleteOpen(true)}
                anchorPoint={menuAnchorPoint}
                menuId={menuId}
            />

            <RenameSessionDialog
                isOpen={renameOpen}
                onClose={() => setRenameOpen(false)}
                currentName={title}
                onRename={renameSession}
                isPending={isPending}
            />

            <ConfirmDialog
                isOpen={archiveOpen}
                onClose={() => setArchiveOpen(false)}
                title={t('dialog.archive.title')}
                description={t('dialog.archive.description', { name: title })}
                confirmLabel={t('dialog.archive.confirm')}
                confirmingLabel={t('dialog.archive.confirming')}
                cancelLabel={t('button.cancel')}
                defaultErrorMessage={t('dialog.error.default')}
                onConfirm={archiveSession}
                isPending={isPending}
                destructive
            />

            <ConfirmDialog
                isOpen={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                title={t('dialog.delete.title')}
                description={t('dialog.delete.description', { name: title })}
                confirmLabel={t('dialog.delete.confirm')}
                confirmingLabel={t('dialog.delete.confirming')}
                cancelLabel={t('button.cancel')}
                defaultErrorMessage={t('dialog.error.default')}
                onConfirm={handleDelete}
                isPending={isPending}
                destructive
            />
        </>
    )
}
