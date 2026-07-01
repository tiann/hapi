import { useId, useMemo, useRef, useState } from 'react'
import type { CodexSubscriptionLimits, CodexSubscriptionLimitWindow, Session } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useCodexSubscriptionLimits } from '@/hooks/queries/useCodexSubscriptionLimits'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { SessionExportDialog } from '@/components/SessionExportDialog'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { formatReopenError } from '@/lib/reopenError'
import { useTranslation } from '@/lib/use-translation'
import type { StatusBarProps } from '@/components/AssistantChat/StatusBar'

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

function getStatusDotClass(status?: StatusBarProps): string {
    if (!status) return 'hidden'
    const hasPermissions = status.agentState?.requests && Object.keys(status.agentState.requests).length > 0
    if (!status.active) return 'bg-[#999]'
    if (status.voiceStatus === 'connecting' || status.thinking || (status.backgroundTaskCount ?? 0) > 0) return 'bg-[#007AFF] animate-pulse'
    if (hasPermissions) return 'bg-[#FF9500] animate-pulse'
    return 'bg-[#34C759]'
}

function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, value))
}

function formatLimitDuration(window: CodexSubscriptionLimitWindow | null): string {
    const duration = window?.windowDurationMins
    if (!duration || duration <= 0) {
        return 'limit'
    }
    if (duration === 300) {
        return '5h'
    }
    if (duration >= 7 * 24 * 60) {
        const days = Math.round(duration / (24 * 60))
        return `${days}d`
    }
    if (duration >= 60) {
        const hours = duration / 60
        return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`
    }
    return `${duration}m`
}

function formatLimitWindow(window: CodexSubscriptionLimitWindow | null): string | null {
    if (!window) {
        return null
    }
    return `${formatLimitDuration(window)} ${Math.round(100 - clampPercent(window.usedPercent))}%`
}

function getRemainingPercent(window: CodexSubscriptionLimitWindow): number {
    return Math.round(100 - clampPercent(window.usedPercent))
}

function getLimitPercentClass(remainingPercent: number | null): string {
    if (remainingPercent === null) {
        return 'text-[var(--app-hint)]'
    }
    if (remainingPercent < 10) {
        return 'text-red-500'
    }
    if (remainingPercent < 30) {
        return 'text-orange-500'
    }
    return 'text-[var(--app-hint)]'
}

function getDisplayLimitWindows(limits: CodexSubscriptionLimits | null): CodexSubscriptionLimitWindow[] {
    const windows = [limits?.primary, limits?.secondary]
        .filter((window): window is CodexSubscriptionLimitWindow => Boolean(window))

    const fiveHourWindow = windows.find((window) => window.windowDurationMins === 300)
    const weeklyWindow = windows.find((window) => (window.windowDurationMins ?? 0) >= 7 * 24 * 60)
    if (fiveHourWindow || weeklyWindow) {
        return [fiveHourWindow, weeklyWindow]
            .filter((window): window is CodexSubscriptionLimitWindow => Boolean(window))
    }

    return windows.sort((a, b) => (a.windowDurationMins ?? Number.MAX_SAFE_INTEGER) - (b.windowDurationMins ?? Number.MAX_SAFE_INTEGER))
}

function formatResetAt(resetsAt: number | null): string | null {
    if (!resetsAt) {
        return null
    }
    const timestamp = resetsAt > 1_000_000_000_000 ? resetsAt : resetsAt * 1000
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) {
        return null
    }
    return date.toLocaleString()
}

function CodexSubscriptionLimitsBadge(props: {
    limits: CodexSubscriptionLimits | null
    isFetching: boolean
    error: string | null
}) {
    const windows = getDisplayLimitWindows(props.limits)
    const text = windows.length > 0
        ? windows.map(formatLimitWindow).filter(Boolean).join(' · ')
        : '5h -- · 7d --'
    const rows = windows.length > 0
        ? windows.map((window) => ({
            label: formatLimitDuration(window),
            remaining: getRemainingPercent(window)
        }))
        : [
            { label: '5h', remaining: null },
            { label: '7d', remaining: null }
        ]
    const resetDetails = windows
        .map((window) => {
            const resetAt = formatResetAt(window.resetsAt)
            const used = Math.round(clampPercent(window.usedPercent))
            const remaining = getRemainingPercent(window)
            const prefix = `${formatLimitDuration(window)}: ${remaining}% remaining, ${used}% used`
            return resetAt ? `${prefix}, resets ${resetAt}` : prefix
        })
        .filter(Boolean)
        .join('\n')
    const title = props.error
        ? `Codex limits unavailable: ${props.error}`
        : resetDetails || 'Codex subscription limits'

    return (
        <div
            className={[
                'flex shrink-0 flex-col items-end justify-center px-2 py-0.5 text-[11px] font-medium leading-3 tabular-nums',
                props.isFetching ? 'opacity-60' : ''
            ].filter(Boolean).join(' ')}
            title={title}
            aria-label={`Codex subscription limits: ${text}`}
        >
            {rows.map((row) => (
                <div key={row.label} className="flex items-center gap-1 text-[var(--app-hint)]">
                    <span>{row.label}</span>
                    <span className={getLimitPercentClass(row.remaining)}>
                        {row.remaining === null ? '--' : `${row.remaining}%`}
                    </span>
                </div>
            ))}
        </div>
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
    onSessionDeleted?: () => void
    onSessionReopened?: (newSessionId: string) => void
    status?: StatusBarProps
}) {
    const { t } = useTranslation()
    const { session, api, onSessionDeleted, onSessionReopened } = props
    const title = useMemo(() => getSessionTitle(session), [session])

    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const menuId = useId()
    const menuAnchorRef = useRef<HTMLButtonElement | null>(null)
    const [renameOpen, setRenameOpen] = useState(false)
    const [exportOpen, setExportOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)

    const { archiveSession, reopenSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        session.id,
        session.metadata?.flavor ?? null
    )
    const codexLimitsState = useCodexSubscriptionLimits({
        api,
        sessionId: session.id,
        model: session.model ?? null,
        enabled: session.active && session.metadata?.flavor === 'codex',
        thinking: props.status?.thinking ?? session.thinking
    })
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

                    <div className="flex min-w-0 flex-1 items-center gap-2">
                        {props.status ? (
                            <span
                                className={`h-2 w-2 shrink-0 rounded-full ${getStatusDotClass(props.status)}`}
                                aria-hidden="true"
                            />
                        ) : null}
                        <div className="truncate font-semibold">
                            {title}
                        </div>
                    </div>

                    {session.metadata?.flavor === 'codex' ? (
                        <CodexSubscriptionLimitsBadge
                            limits={codexLimitsState.limits}
                            isFetching={codexLimitsState.isFetching}
                            error={codexLimitsState.error}
                        />
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
                onArchive={() => setArchiveOpen(true)}
                onReopen={handleReopen}
                onDelete={() => setDeleteOpen(true)}
                onToggleFiles={props.onToggleFiles}
                filesActive={props.filesActive}
                onToggleOutline={props.onToggleOutline}
                outlineActive={props.outlineActive}
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
                session={session}
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
