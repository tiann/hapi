import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useIsMutating, useQueryClient } from '@tanstack/react-query'
import type { Session } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { isTelegramApp } from '@/hooks/useTelegram'
import { sessionModelMutationKey, useSessionActions } from '@/hooks/mutations/useSessionActions'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { SessionExportDialog } from '@/components/SessionExportDialog'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useScratchlistCount } from '@/lib/use-scratchlist-count'
import { formatReopenError } from '@/lib/reopenError'
import { formatReasoningLabel, getReasoningEffortForFlavor } from '@/lib/codexStatusLabels'
import { getSessionModelLabel } from '@/lib/sessionModelLabel'
import { useTranslation } from '@/lib/use-translation'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { isFastServiceTier } from '@/components/AssistantChat/codexFastMode'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useToast } from '@/lib/toast-context'
import { queryKeys } from '@/lib/query-keys'
import { markCodexSessionsImported } from '@/lib/codexImportedSessions'
import { useMachines } from '@/hooks/queries/useMachines'
import { useMachineLabels } from '@/hooks/useMachineLabels'
import { formatAbsoluteDateTime, formatRelativeTime } from '@/lib/relativeTime'
import { useSessionHeaderMetadata } from '@/hooks/useSessionHeaderMetadata'
import { formatSessionHeaderTimestamp } from '@/lib/sessionHeaderTimestamp'
import { selectMobileSessionHeaderSecondary } from '@/lib/sessionHeaderMobileMetadata'
import { useMinuteTick } from '@/hooks/useMinuteTick'

/** Same preference order as session-list chips: display label → host → short id. */
export function resolveSessionHeaderMachineLabel(
    session: Session,
    labelsById: Record<string, string>
): string | null {
    const machineId = session.metadata?.machineId?.trim() || null
    if (machineId && labelsById[machineId]) {
        return labelsById[machineId]
    }
    const host = session.metadata?.host?.trim()
    if (host) {
        return host
    }
    if (machineId) {
        return machineId.slice(0, 8)
    }
    return null
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

function headerToggleClass(active: boolean): string {
    return `flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
        active
            ? 'bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-90'
            : 'text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]'
    }`
}

function TerminalIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
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

function ModelChangingStatus() {
    const { t } = useTranslation()
    return (
        <span data-testid="session-header-model-changing" className="inline-flex items-center gap-1" title={t('session.modelChange.pendingTooltip')}>
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-current border-r-transparent" />
            <span>{t('session.modelChange.pending')}</span>
        </span>
    )
}

export function SessionHeader(props: {
    session: Session
    serviceTier?: string | null
    onBack: () => void
    onToggleFiles?: () => void
    filesActive?: boolean
    onToggleOutline?: () => void
    outlineActive?: boolean
    onToggleTerminal?: () => void
    terminalActive?: boolean
    api: ApiClient | null
    canReopen?: boolean
    reopenDisabledReason?: string
    onSessionDeleted?: () => void
    onSessionReopened?: (newSessionId: string) => void
}) {
    const { t, locale } = useTranslation()
    const queryClient = useQueryClient()
    const { addToast } = useToast()
    const { session, api, onSessionDeleted, onSessionReopened } = props
    const title = useMemo(() => getSessionTitle(session), [session])
    const worktreeBranch = session.metadata?.worktree?.branch?.trim() || null
    const { preferences: headerMetadata } = useSessionHeaderMetadata()
    const modelLabel = getSessionModelLabel(session)
    const isModelChanging = useIsMutating({
        mutationKey: sessionModelMutationKey(session.id),
        exact: true,
    }) > 0
    const agentFlavor = session.metadata?.flavor ?? null
    const agentLabel = agentFlavor?.trim() || null
    const reasoningEffort = getReasoningEffortForFlavor(
        agentFlavor,
        session.modelReasoningEffort,
        session.effort
    )
    const reasoningLabel = reasoningEffort
        ? formatReasoningLabel(reasoningEffort, headerMetadata.showLabels)
        : null
    // Match expected Fast badge semantics (#1004): only explicit service tier, no effort/model heuristics.
    const showFastBadge = agentFlavor === 'codex' && isFastServiceTier(props.serviceTier ?? session.serviceTier)
    const createdAtLabel = headerMetadata.createdAt ? formatSessionHeaderTimestamp(session.createdAt, locale) : null
    const updatedAtLabel = headerMetadata.updatedAt ? formatSessionHeaderTimestamp(session.updatedAt, locale) : null
    const codexSessionId = session.metadata?.flavor === 'codex'
        ? session.metadata.codexSessionId?.trim() || null
        : null
    const piSessionId = session.metadata?.flavor === 'pi'
        ? session.metadata.piSessionId?.trim() || null
        : null
    const { machines } = useMachines(api, Boolean(api))
    const machineLabelsById = useMachineLabels(machines)
    const machineLabel = useMemo(
        () => resolveSessionHeaderMachineLabel(session, machineLabelsById),
        [session, machineLabelsById]
    )
    const lastActiveAt = session.activeAt || session.updatedAt || session.createdAt
    // Relative labels cross minute/hour boundaries without new patches; tick
    // once a minute so "just now" does not freeze forever on inactive sessions.
    const relativeTimeTick = useMinuteTick(headerMetadata.lastActive)
    const ageLabel = useMemo(
        () => (headerMetadata.lastActive && lastActiveAt > 0 ? formatRelativeTime(lastActiveAt, t) : null),
        [headerMetadata.lastActive, lastActiveAt, t, relativeTimeTick]
    )
    const ageAbsolute = ageLabel ? formatAbsoluteDateTime(lastActiveAt) : null
    const mobileSecondary = selectMobileSessionHeaderSecondary({
        model: headerMetadata.model && modelLabel !== null,
        reasoning: headerMetadata.reasoning && reasoningLabel !== null,
        machine: headerMetadata.machine && machineLabel !== null,
        lastActive: ageLabel !== null,
        updatedAt: updatedAtLabel !== null,
        createdAt: createdAtLabel !== null,
        worktree: headerMetadata.worktree && Boolean(worktreeBranch),
        fastMode: headerMetadata.fastMode && showFastBadge,
    })
    const showMobileMetadata = (headerMetadata.agent && agentLabel !== null) || mobileSecondary !== null

    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const menuId = useId()
    const menuAnchorRef = useRef<HTMLButtonElement | null>(null)
    const [renameOpen, setRenameOpen] = useState(false)
    const [exportOpen, setExportOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const [isSyncingCodex, setIsSyncingCodex] = useState(false)
    const [isSyncingPi, setIsSyncingPi] = useState(false)

    const { archiveSession, reopenSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        session.id,
        session.metadata?.flavor ?? null
    )
    const [reopenError, setReopenError] = useState<string | null>(null)
    // tiann/hapi#893: surface the scratchlist entry count in the
    // delete-confirm copy so the operator knows what cascades when they
    // confirm. Read-only hook reuses the cache filled by SessionChat -
    // no extra network when both components are mounted.
    const scratchlistCount = useScratchlistCount(session.id, api)

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

    const handleSyncPi = async () => {
        if (!api || !piSessionId || session.active || isSyncingPi) return

        setIsSyncingPi(true)
        try {
            const result = await api.importPiSessions({
                sessionIds: [piSessionId],
                cwd: typeof session.metadata?.path === 'string' ? session.metadata.path : undefined,
                machineId: typeof session.metadata?.machineId === 'string' ? session.metadata.machineId : undefined
            })
            const imported = result.results.find((item) => item.piSessionId === piSessionId)
            if (imported?.error) {
                const message = imported.error.code === 'transcript_diverged'
                    ? t('piImport.error.diverged')
                    : imported.error.code === 'session_active'
                        ? t('piImport.error.active')
                        : imported.error.message
                throw new Error(message)
            }
            if (!imported) throw new Error(result.error || t('piImport.failed.body'))

            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.session(session.id) }),
                queryClient.invalidateQueries({ queryKey: queryKeys.messages(session.id) }),
                queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            ])
            addToast({
                title: t('piImport.manual.success.title'),
                body: (imported.appended ?? 0) === 0
                    ? t('piImport.manual.success.noNewMessages')
                    : t('piImport.manual.success.body', { n: imported.appended ?? 0 }),
                sessionId: session.id,
                url: `/sessions/${session.id}`
            })
        } catch (error) {
            addToast({
                title: t('piImport.manual.failed.title'),
                body: error instanceof Error ? error.message : t('piImport.failed.body'),
                sessionId: session.id,
                url: `/sessions/${session.id}`
            })
        } finally {
            setIsSyncingPi(false)
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
                        {showMobileMetadata ? (
                            <div className="flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden text-xs text-[var(--app-hint)] sm:hidden">
                                {headerMetadata.agent && agentLabel ? (
                                    <span className="inline-flex shrink-0 items-center gap-1">
                                        <AgentFlavorIcon flavor={session.metadata?.flavor} className="h-3.5 w-3.5 shrink-0 -translate-y-px" />
                                        {agentLabel}
                                    </span>
                                ) : null}
                                {mobileSecondary === 'model' && modelLabel ? <span className="inline-flex truncate items-center gap-1.5">{headerMetadata.showLabels ? `${t(modelLabel.key)}: ` : ''}{modelLabel.value}{isModelChanging ? <ModelChangingStatus /> : null}</span> : null}
                                {mobileSecondary === 'reasoning' && reasoningLabel ? <span className="truncate">{reasoningLabel}</span> : null}
                                {mobileSecondary === 'machine' && machineLabel ? <span className="truncate">{headerMetadata.showLabels ? `${t('session.item.machine')}: ` : ''}{machineLabel}</span> : null}
                                {mobileSecondary === 'lastActive' && ageLabel ? <span className="truncate" title={ageAbsolute ?? undefined}>{ageLabel}</span> : null}
                                {mobileSecondary === 'updatedAt' && updatedAtLabel ? <span className="truncate">{headerMetadata.showLabels ? `${t('session.header.updatedAt')}: ` : ''}{updatedAtLabel}</span> : null}
                                {mobileSecondary === 'createdAt' && createdAtLabel ? <span className="truncate">{headerMetadata.showLabels ? `${t('session.header.createdAt')}: ` : ''}{createdAtLabel}</span> : null}
                                {mobileSecondary === 'worktree' && worktreeBranch ? <span className="truncate">{headerMetadata.showLabels ? `${t('session.item.worktree')}: ` : ''}{worktreeBranch}</span> : null}
                                {mobileSecondary === 'fastMode' ? <span className="truncate text-[#34C759]">fast</span> : null}
                            </div>
                        ) : null}
                        <div className="hidden flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--app-hint)] sm:flex">
                            {headerMetadata.agent && agentLabel ? (
                                <span className="inline-flex items-center gap-1">
                                    <AgentFlavorIcon flavor={session.metadata?.flavor} className="h-3.5 w-3.5 shrink-0 -translate-y-px" />
                                    {agentLabel}
                                </span>
                            ) : null}
                            {headerMetadata.machine && machineLabel ? (
                                <span data-testid="session-header-machine" className="max-w-[12rem] truncate" title={machineLabel}>
                                    {headerMetadata.showLabels ? `${t('session.item.machine')}: ` : ''}{machineLabel}
                                </span>
                            ) : null}
                            {ageLabel ? (
                                <span data-testid="session-header-age" title={ageAbsolute ?? undefined}>
                                    {ageLabel}
                                </span>
                            ) : null}
                            {headerMetadata.model && modelLabel ? (
                                <span className="inline-flex items-center gap-1.5">
                                    <span>{headerMetadata.showLabels ? `${t(modelLabel.key)}: ` : ''}{modelLabel.value}</span>
                                    {isModelChanging ? <ModelChangingStatus /> : null}
                                </span>
                            ) : null}
                            {headerMetadata.reasoning && reasoningLabel ? (
                                <span data-testid="session-header-reasoning">
                                    {reasoningLabel}
                                </span>
                            ) : null}
                            {headerMetadata.fastMode && showFastBadge ? (
                                <span data-testid="session-header-fast" className="text-[#34C759]">
                                    fast
                                </span>
                            ) : null}
                            {createdAtLabel ? <span>{headerMetadata.showLabels ? `${t('session.header.createdAt')}: ` : ''}{createdAtLabel}</span> : null}
                            {updatedAtLabel ? <span>{headerMetadata.showLabels ? `${t('session.header.updatedAt')}: ` : ''}{updatedAtLabel}</span> : null}
                            {headerMetadata.worktree && worktreeBranch ? (
                                <span>{headerMetadata.showLabels ? `${t('session.item.worktree')}: ` : ''}{worktreeBranch}</span>
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

                    {props.onToggleTerminal ? (
                        <button
                            type="button"
                            onClick={props.onToggleTerminal}
                            className={headerToggleClass(props.terminalActive ?? false)}
                            title="Terminal"
                            aria-label="Terminal"
                            aria-pressed={props.terminalActive ?? false}
                        >
                            <TerminalIcon />
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
                sessionId={session.id}
                sessionTitle={title}
                sessionActive={session.active}
                onRename={() => setRenameOpen(true)}
                onExport={() => setExportOpen(true)}
                onSyncCodex={api && codexSessionId ? handleSyncCodex : undefined}
                onSyncPi={api && piSessionId && !session.active ? handleSyncPi : undefined}
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
                    centerTitle
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
                centerTitle
            />

            <ConfirmDialog
                isOpen={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                title={t('dialog.delete.title')}
                description={
                    scratchlistCount > 0
                        ? `${t('dialog.delete.description', { name: title })} ${t(
                            scratchlistCount === 1
                                ? 'dialog.delete.scratchlist.one'
                                : 'dialog.delete.scratchlist.other',
                            { n: String(scratchlistCount) }
                        )}`
                        : t('dialog.delete.description', { name: title })
                }
                confirmLabel={t('dialog.delete.confirm')}
                confirmingLabel={t('dialog.delete.confirming')}
                onConfirm={handleDelete}
                isPending={isPending}
                destructive
                centerTitle
            />
        </>
    )
}
