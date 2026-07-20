import { useId, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { SessionExportDialog } from '@/components/SessionExportDialog'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { formatReopenError } from '@/lib/reopenError'
import { formatCodexReasoningLabel, shouldShowCodexReasoningLabel } from '@/lib/codexStatusLabels'
import { getSessionModelLabel } from '@/lib/sessionModelLabel'
import { useTranslation } from '@/lib/use-translation'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { isFastServiceTier } from '@/components/AssistantChat/codexFastMode'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useToast } from '@/lib/toast-context'
import { queryKeys } from '@/lib/query-keys'
import { markCodexSessionsImported } from '@/lib/codexImportedSessions'

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

function headerToggleClass(active: boolean): string {
    return `flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
        active
            ? 'bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-90'
            : 'text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]'
    }`
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

export function SessionHeader(props: {
    session: Session
    onBack: () => void
    onToggleFiles?: () => void
    filesActive?: boolean
    onToggleOutline?: () => void
    outlineActive?: boolean
    api: ApiClient | null
    canReopen?: boolean
    reopenDisabledReason?: string
    onSessionDeleted?: () => void
    onSessionReopened?: (newSessionId: string) => void
}) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const { addToast } = useToast()
    const { session, api, onSessionDeleted, onSessionReopened } = props
    const title = useMemo(() => getSessionTitle(session), [session])
    const worktreeBranch = session.metadata?.worktree?.branch
    const modelLabel = getSessionModelLabel(session)
    const agentFlavor = session.metadata?.flavor ?? null
    const reasoningLabel = shouldShowCodexReasoningLabel(agentFlavor)
        ? formatCodexReasoningLabel(session.modelReasoningEffort)
        : null
    // Match expected Fast badge semantics (#1004): only explicit service tier, no effort/model heuristics.
    const showFastBadge = agentFlavor === 'codex' && isFastServiceTier(session.serviceTier)
    const codexSessionId = session.metadata?.flavor === 'codex'
        ? session.metadata.codexSessionId?.trim() || null
        : null

    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const menuId = useId()
    const menuAnchorRef = useRef<HTMLButtonElement | null>(null)
    const [renameOpen, setRenameOpen] = useState(false)
    const [exportOpen, setExportOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const [isSyncingCodex, setIsSyncingCodex] = useState(false)

    const { archiveSession, reopenSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        session.id,
        session.metadata?.flavor ?? null
    )
    const [reopenError, setReopenError] = useState<string | null>(null)

    const handleDelete = async () => {
        await deleteSession()
        onSessionDeleted?.()
    }

    const handleReopen = async () => {
        setReopenError(null)
        try {
            const result = await reopenSession()
            if (result.sessionId && result.sessionId !== session.id) {
                onSessionReopened?.(result.sessionId)
            }
        } catch (error) {
            setReopenError(formatReopenError(error))
        }
    }

    const handleSyncCodex = async () => {
        if (!api || !codexSessionId || isSyncingCodex) return

        setIsSyncingCodex(true)
        try {
            // 中文注释：手动同步必须携带当前会话归属机器和目录；多台 runner 在线时后端不能靠猜。
            const result = await api.syncCodexSession({
                sessionIds: [codexSessionId],
                cwd: typeof session.metadata?.path === 'string' ? session.metadata.path : undefined,
                machineId: typeof session.metadata?.machineId === 'string' ? session.metadata.machineId : undefined
            })
            if (!result.success) {
                throw new Error(result.error || t('codexSync.failed.body'))
            }

            markCodexSessionsImported([codexSessionId])
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.session(session.id) }),
                queryClient.invalidateQueries({ queryKey: queryKeys.messages(session.id) }),
                queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            ])
            addToast({
                title: t('codexSync.manual.success.title'),
                body: (result.syncedCount ?? 1) === 0
                    ? t('codexSync.manual.success.noNewMessages')
                    : t('codexSync.manual.success.body', { n: result.syncedCount ?? 1 }),
                sessionId: session.id,
                url: `/sessions/${session.id}`
            })
        } catch (error) {
            addToast({
                title: t('codexSync.manual.failed.title'),
                body: error instanceof Error ? error.message : t('codexSync.failed.body'),
                sessionId: session.id,
                url: `/sessions/${session.id}`
            })
        } finally {
            setIsSyncingCodex(false)
        }
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

    return (
        <>
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 p-3">
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
                                <AgentFlavorIcon flavor={session.metadata?.flavor} className="h-3.5 w-3.5 shrink-0" />
                                {session.metadata?.flavor?.trim() || 'unknown'}
                            </span>
                            {modelLabel ? (
                                <span>
                                    {t(modelLabel.key)}: {modelLabel.value}
                                </span>
                            ) : null}
                            {reasoningLabel ? (
                                <span data-testid="session-header-reasoning" className="hidden sm:inline">
                                    {reasoningLabel}
                                </span>
                            ) : null}
                            {showFastBadge ? (
                                <span data-testid="session-header-fast" className="text-[#34C759]">
                                    fast
                                </span>
                            ) : null}
                            {worktreeBranch ? (
                                <span>{t('session.item.worktree')}: {worktreeBranch}</span>
                            ) : null}
                        </div>
                    </div>

                    {props.onToggleFiles ? (
                        <button
                            type="button"
                            onClick={props.onToggleFiles}
                            className={headerToggleClass(props.filesActive ?? false)}
                            title={props.filesActive ? t('session.view.returnToChat') : t('session.title')}
                            aria-label={props.filesActive ? t('session.view.returnToChat') : t('session.title')}
                            aria-pressed={props.filesActive ?? false}
                        >
                            <FilesIcon />
                        </button>
                    ) : null}

                    {props.onToggleOutline ? (
                        <button
                            type="button"
                            onClick={props.onToggleOutline}
                            className={headerToggleClass(props.outlineActive ?? false)}
                            title={props.outlineActive ? t('session.outline.close') : t('session.outline.open')}
                            aria-label={props.outlineActive ? t('session.outline.close') : t('session.outline.open')}
                            aria-pressed={props.outlineActive ?? false}
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
                onExport={() => setExportOpen(true)}
                onSyncCodex={api && codexSessionId ? handleSyncCodex : undefined}
                onArchive={() => setArchiveOpen(true)}
                onReopen={props.canReopen === false ? undefined : handleReopen}
                reopenDisabledReason={props.reopenDisabledReason}
                onDelete={() => setDeleteOpen(true)}
                anchorPoint={menuAnchorPoint}
                menuId={menuId}
            />

            {reopenError ? (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setReopenError(null)}
                    title={t('dialog.reopen.errorTitle')}
                    description={reopenError}
                    confirmLabel={t('dialog.reopen.dismiss')}
                    confirmingLabel={t('dialog.reopen.dismiss')}
                    onConfirm={async () => setReopenError(null)}
                    isPending={false}
                />
            ) : null}

            <RenameSessionDialog
                isOpen={renameOpen}
                onClose={() => setRenameOpen(false)}
                currentName={title}
                onRename={renameSession}
                isPending={isPending}
            />

            <SessionExportDialog
                isOpen={exportOpen}
                onClose={() => setExportOpen(false)}
                sessionId={session.id}
                api={api}
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
