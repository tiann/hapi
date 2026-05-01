import { useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { Session } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { getSessionModelLabel } from '@/lib/sessionModelLabel'
import { useTranslation } from '@/lib/use-translation'

function getSessionTitle(session: Session): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}

function FilesIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
        </svg>
    )
}

function OutlineIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M8 6h13" />
            <path d="M8 12h13" />
            <path d="M8 18h13" />
            <path d="M3 6h.01" />
            <path d="M3 12h.01" />
            <path d="M3 18h.01" />
        </svg>
    )
}

function MoreVerticalIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={props.className}
        >
            <circle cx="12" cy="5" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="12" cy="19" r="2" />
        </svg>
    )
}

function FolderIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
        </svg>
    )
}


function EditorIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="m8 10 3 3-3 3" />
            <path d="M13 16h3" />
        </svg>
    )
}

function TerminalIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
    )
}

export function SessionHeader(props: {
    session: Session
    onBack: () => void
    onViewFiles?: () => void
    onOpenOutline?: () => void
    api: ApiClient | null
    onSessionDeleted?: () => void
    compactMode?: boolean
    pinIndex?: number
}) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { session, api, onSessionDeleted, compactMode, pinIndex } = props
    const title = useMemo(() => getSessionTitle(session), [session])
    const worktreeBranch = session.metadata?.worktree?.branch
    const modelLabel = getSessionModelLabel(session)
    const agentFlavor = session.metadata?.flavor ?? 'claude'
    const sessionStatus = session.thinking ? 'thinking' : !session.active ? 'archived' : 'active'
    const editorSearch = session.metadata?.machineId && session.metadata?.path
        ? { machine: session.metadata.machineId, project: session.metadata.path }
        : null

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

    // In Telegram, don't render header (Telegram provides its own)
    if (isTelegramApp()) {
        return null
    }

    if (compactMode) {
        return (
            <>
                <div className="db-pinned__compact-header">
                    <div className="db-pinned__compact-row1">
                        {pinIndex !== undefined && <span className="db-pinned__index-badge">{pinIndex}</span>}
                        <span className={`db-card__dot db-card__dot--${sessionStatus}`} />
                        <span className="db-pinned__compact-title">{title}</span>
                        <span className={`db-card__agent db-card__agent--${agentFlavor}`}>{agentFlavor}</span>
                        
                        <div className="db-pinned__compact-actions flex items-center gap-1 ml-auto">
                            {editorSearch ? (
                                <button
                                    type="button"
                                    className="db-pinned__compact-action"
                                    onClick={() => navigate({ to: '/editor', search: editorSearch })}
                                    title="Open in Editor"
                                    aria-label="Open in Editor"
                                >
                                    <EditorIcon className="w-4 h-4" />
                                </button>
                            ) : null}
                            <button type="button" className="db-pinned__compact-action" onClick={() => navigate({ search: (prev: any) => ({ ...prev, modal: 'files', modalSessionId: session.id }) } as any)} title="Files">
                                <FolderIcon className="w-4 h-4" />
                            </button>
                            <button type="button" className="db-pinned__compact-action" onClick={() => navigate({ search: (prev: any) => ({ ...prev, modal: 'terminal', modalSessionId: session.id }) } as any)} title="Terminal">
                                <TerminalIcon className="w-4 h-4" />
                            </button>
                            <button
                                type="button"
                                onClick={handleMenuToggle}
                                onPointerDown={(e) => e.stopPropagation()}
                                ref={menuAnchorRef}
                                className="db-pinned__compact-action"
                                title={t('session.more')}
                            >
                                <MoreVerticalIcon className="w-4 h-4" />
                            </button>
                            <button
                                type="button"
                                className="db-pinned__unpin-btn"
                                onClick={props.onBack}
                                title="Unpin this session"
                            >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="18" y1="6" x2="6" y2="18"></line>
                                    <line x1="6" y1="6" x2="18" y2="18"></line>
                                </svg>
                            </button>
                        </div>
                    </div>
                    {session.metadata?.path && (
                        <div className="db-pinned__compact-path" title={session.metadata.path}>
                            {session.metadata.path.split('/').filter(Boolean).slice(-2).join('/')}
                        </div>
                    )}
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

                <RenameSessionDialog isOpen={renameOpen} onClose={() => setRenameOpen(false)} currentName={title} onRename={renameSession} isPending={isPending} />
                <ConfirmDialog isOpen={archiveOpen} onClose={() => setArchiveOpen(false)} title={t('dialog.archive.title')} description={t('dialog.archive.description', { name: title })} confirmLabel={t('dialog.archive.confirm')} confirmingLabel={t('dialog.archive.confirming')} onConfirm={archiveSession} isPending={isPending} destructive />
                <ConfirmDialog isOpen={deleteOpen} onClose={() => setDeleteOpen(false)} title={t('dialog.delete.title')} description={t('dialog.delete.description', { name: title })} confirmLabel={t('dialog.delete.confirm')} confirmingLabel={t('dialog.delete.confirming')} onConfirm={handleDelete} isPending={isPending} destructive />
            </>
        )
    }

    return (
        <>
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 p-2">
                    {/* Back button */}
                    <button
                        type="button"
                        onClick={props.onBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
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
                        >
                            <polyline points="15 18 9 12 15 6" />
                        </svg>
                    </button>

                    {/* Session info - two lines: title and path */}
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">
                            {title}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--app-hint)]">
                            <span className="inline-flex items-center gap-1">
                                <span aria-hidden="true">❖</span>
                                {session.metadata?.flavor?.trim() || 'unknown'}
                            </span>
                            {modelLabel ? (
                                <span>
                                    {t(modelLabel.key)}: {modelLabel.value}
                                </span>
                            ) : null}
                            {worktreeBranch ? (
                                <span>{t('session.item.worktree')}: {worktreeBranch}</span>
                            ) : null}
                            {session.metadata?.path ? (
                                <span className="truncate font-mono opacity-70" title={session.metadata.path}>
                                    {session.metadata.path.split('/').filter(Boolean).slice(-2).join('/')}
                                </span>
                            ) : null}
                        </div>
                    </div>


                    {editorSearch ? (
                        <button
                            type="button"
                            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                            title="Open in Editor"
                            aria-label="Open in Editor"
                            onClick={() => navigate({ to: '/editor', search: editorSearch })}
                        >
                            <EditorIcon className="w-5 h-5" />
                        </button>
                    ) : null}

                    <button
                        type="button"
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        title={t('button.files')}
                        onClick={() => navigate({ search: (prev: any) => ({ ...prev, modal: 'files', modalSessionId: session.id }) } as any)}
                    >
                        <FolderIcon className="w-5 h-5" />
                    </button>
                    <button
                        type="button"
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        title={t('button.terminal')}
                        onClick={() => navigate({ search: (prev: any) => ({ ...prev, modal: 'terminal', modalSessionId: session.id }) } as any)}
                    >
                        <TerminalIcon className="w-5 h-5" />
                    </button>

                    {props.onOpenOutline ? (
                        <button
                            type="button"
                            onClick={props.onOpenOutline}
                            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                            title={t('session.outline.open')}
                            aria-label={t('session.outline.open')}
                        >
                            <OutlineIcon />
                        </button>
                    ) : null}

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
                onConfirm={handleDelete}
                isPending={isPending}
                destructive
            />
        </>
    )
}
