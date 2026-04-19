import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { getPermissionModeLabel, getPermissionModeTone, isPermissionModeAllowedForFlavor } from '@hapi/protocol'
import { useLongPress } from '@/hooks/useLongPress'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useSortToggle } from '@/hooks/useSortToggle'
import { SortIcon, PinIcon } from '@/components/icons/SortIcons'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { GroupActionMenu } from '@/components/GroupActionMenu'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import {
    getFlavorTextClass,
    META_DOT_SEPARATOR_CLASS,
    SESSION_ACTIVITY_BADGE,
    SESSION_PENDING_BADGE
} from '@/lib/agentFlavorUtils'
import { getSessionModelLabel } from '@/lib/sessionModelLabel'
import { useTranslation } from '@/lib/use-translation'
import { getFlavorTextClass, PERMISSION_TONE_TEXT } from '@/lib/agentFlavorUtils'

type SessionGroup = {
    key: string
    directory: string
    displayName: string
    machineId: string | null
    sessions: SessionSummary[]
    latestUpdatedAt: number
    hasActiveSession: boolean
}

function getGroupDisplayName(directory: string): string {
    if (directory === 'Other') return directory
    const parts = directory.split(/[\\/]+/).filter(Boolean)
    if (parts.length === 0) return directory
    if (parts.length === 1) return parts[0]
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

export const UNKNOWN_MACHINE_ID = '__unknown__'

export function groupSessionsByDirectory(sessions: SessionSummary[]): SessionGroup[] {
    const groups = new Map<string, { directory: string; machineId: string | null; sessions: SessionSummary[] }>()

    sessions.forEach(session => {
        const path = session.metadata?.worktree?.basePath ?? session.metadata?.path ?? 'Other'
        const machineId = session.metadata?.machineId ?? null
        const key = `${machineId ?? '__unknown__'}::${path}`
        if (!groups.has(key)) {
            groups.set(key, {
                directory: path,
                machineId,
                sessions: []
            })
        }
        groups.get(key)!.sessions.push(session)
    })

    return Array.from(groups.entries())
        .map(([key, group]) => {
            const sortedSessions = [...group.sessions].sort((a, b) => {
                const rankA = a.active ? (a.pendingRequestsCount > 0 ? 0 : 1) : 2
                const rankB = b.active ? (b.pendingRequestsCount > 0 ? 0 : 1) : 2
                if (rankA !== rankB) return rankA - rankB
                return b.updatedAt - a.updatedAt
            })
            const latestUpdatedAt = group.sessions.reduce(
                (max, s) => (s.updatedAt > max ? s.updatedAt : max),
                -Infinity
            )
            const hasActiveSession = group.sessions.some(s => s.active)
            const displayName = getGroupDisplayName(group.directory)

            return {
                key,
                directory: group.directory,
                displayName,
                machineId: group.machineId,
                sessions: sortedSessions,
                latestUpdatedAt,
                hasActiveSession
            }
        })
        .sort((a, b) => {
            if (a.hasActiveSession !== b.hasActiveSession) {
                return a.hasActiveSession ? -1 : 1
            }
            return b.latestUpdatedAt - a.latestUpdatedAt
        })
}

function PlusIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function ChevronIcon(props: { className?: string; collapsed?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`${props.className ?? ''} transition-transform duration-200 ${props.collapsed ? '' : 'rotate-90'}`}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function MachineIcon(props: { className?: string }) {
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
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
    )
}

function getSessionTitle(session: SessionSummary): string {
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

function getTodoProgress(session: SessionSummary): { completed: number; total: number } | null {
    if (!session.todoProgress) return null
    if (session.todoProgress.completed === session.todoProgress.total) return null
    return session.todoProgress
}

function getAgentLabel(session: SessionSummary): string {
    const flavor = session.metadata?.flavor?.trim()
    if (flavor) return flavor.toLowerCase()
    return 'unknown'
}

function formatRelativeTime(value: number, t: (key: string, params?: Record<string, string | number>) => string): string | null {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return null
    const delta = Date.now() - ms
    if (delta < 60_000) return t('session.time.justNow')
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return t('session.time.minutesAgo', { n: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('session.time.hoursAgo', { n: hours })
    const days = Math.floor(hours / 24)
    if (days < 7) return t('session.time.daysAgo', { n: days })
    return new Date(ms).toLocaleDateString()
}

function SessionItem(props: {
    session: SessionSummary
    onSelect: (sessionId: string) => void
    api: ApiClient | null
    selected?: boolean
    animateEnter?: boolean
}) {
    const { t } = useTranslation()
    const {
        session: s,
        onSelect,
        api,
        selected = false,
        animateEnter = false
    } = props
    const { haptic } = usePlatform()
    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const [renameOpen, setRenameOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)

    const { archiveSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        s.id,
        s.metadata?.flavor ?? null
    )

    const longPressHandlers = useLongPress({
        onLongPress: (point) => {
            haptic.impact('medium')
            setMenuAnchorPoint(point)
            setMenuOpen(true)
        },
        onClick: () => {
            if (!menuOpen) {
                onSelect(s.id)
            }
        },
        threshold: 500
    })

    const sessionName = getSessionTitle(s)
    const modelLabel = getSessionModelLabel(s)
    const agentLabel = getAgentLabel(s)
    const statusDotClass = s.active
        ? (s.thinking ? 'bg-[var(--app-badge-info-text)]' : 'bg-[var(--app-badge-success-text)]')
        : 'bg-[var(--app-hint)]'

    const flavor = s.metadata?.flavor?.trim() ?? null
    const flavorTextClass = getFlavorTextClass(flavor)

    const permMode = s.permissionMode
        && s.permissionMode !== 'default'
        && isPermissionModeAllowedForFlavor(s.permissionMode, flavor)
        ? s.permissionMode
        : null
    const permLabel = permMode ? getPermissionModeLabel(permMode).toLowerCase() : null
    const permTone = permMode ? getPermissionModeTone(permMode) : null
    const permTextClass = permTone ? PERMISSION_TONE_TEXT[permTone] : ''
    const todoProgress = getTodoProgress(s)
    const inactiveClass = s.active ? '' : 'opacity-[0.55]'
    const metadataItems = [
        <span key="flavor" className={getFlavorTextClass(s.metadata?.flavor)}>
            {agentLabel}
        </span>,
        modelLabel ? <span key="model">{modelLabel.value}</span> : null,
        s.metadata?.worktree?.branch ? <span key="worktree">{s.metadata.worktree.branch}</span> : null,
        todoProgress ? <span key="todo">{todoProgress.completed}/{todoProgress.total}</span> : null
    ].filter(Boolean) as ReactNode[]

    return (
        <>
            <button
                type="button"
                {...longPressHandlers}
                className={`session-list-item flex w-full flex-col gap-2 px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] select-none ${selected ? 'bg-[var(--app-secondary-bg)]' : ''} ${animateEnter ? 'animate-session-enter' : ''}`}
                style={{ WebkitTouchCallout: 'none' }}
                aria-current={selected ? 'page' : undefined}
            >
                <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2">
                        <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">
                            <span className={`h-2 w-2 rounded-full ${statusDotClass}`} />
                        </span>
                        <div className={`min-w-0 ${inactiveClass}`}>
                            <div className="truncate text-base font-medium">
                                {sessionName}
                            </div>
                        </div>
                    </div>
                    <div className="shrink-0 pt-0.5 text-xs text-[var(--app-hint)]">
                        {formatRelativeTime(s.updatedAt, t)}
                    </div>
                </div>
                {(metadataItems.length > 0 || s.thinking || s.pendingRequestsCount > 0) ? (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs text-[var(--app-hint)]">
                        <div className={`inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ${inactiveClass}`}>
                            {metadataItems.map((item, index) => (
                                <Fragment key={index}>
                                    {index > 0 ? (
                                        <span aria-hidden="true" className={META_DOT_SEPARATOR_CLASS}>·</span>
                                    ) : null}
                                    {item}
                                </Fragment>
                            ))}
                        </div>
                        {s.thinking ? (
                            <span className={SESSION_ACTIVITY_BADGE}>
                                {t('session.item.thinking')}
                            </span>
                        ) : null}
                        {s.pendingRequestsCount > 0 ? (
                            <span className={SESSION_PENDING_BADGE}>
                                {t('session.item.pending')} {s.pendingRequestsCount}
                            </span>
                        ) : null}
                    </div>
                ) : null}
            </button>

            <SessionActionMenu
                isOpen={menuOpen}
                onClose={() => setMenuOpen(false)}
                sessionActive={s.active}
                manualMode={manualMode}
                onMoveUp={onMoveUp}
                onMoveDown={onMoveDown}
                canMoveUp={canMoveUp}
                canMoveDown={canMoveDown}
                onRename={() => setRenameOpen(true)}
                onArchive={() => setArchiveOpen(true)}
                onDelete={() => setDeleteOpen(true)}
                anchorPoint={menuAnchorPoint}
            />

            <RenameSessionDialog
                isOpen={renameOpen}
                onClose={() => setRenameOpen(false)}
                currentName={sessionName}
                onRename={renameSession}
                isPending={isPending}
            />

            <ConfirmDialog
                isOpen={archiveOpen}
                onClose={() => setArchiveOpen(false)}
                title={t('dialog.archive.title')}
                description={t('dialog.archive.description', { name: sessionName })}
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
                description={t('dialog.delete.description', { name: sessionName })}
                confirmLabel={t('dialog.delete.confirm')}
                confirmingLabel={t('dialog.delete.confirming')}
                onConfirm={deleteSession}
                isPending={isPending}
                destructive
            />
        </>
    )
}

function GroupHeader(props: {
    group: SessionGroup
    isCollapsed: boolean
    machineLabel: string
    onToggle: () => void
}) {
    const { haptic } = usePlatform()
    const longPressHandlers = useLongPress({
        onLongPress: () => {
            haptic.impact('medium')
        },
        onClick: props.onToggle,
        threshold: 500
    })

    return (
        <button
            type="button"
            {...longPressHandlers}
            aria-expanded={!props.isCollapsed}
            className="sticky top-0 z-10 flex w-full flex-col gap-1 border-b border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
            style={{ WebkitTouchCallout: 'none' }}
        >
            <div className="flex min-w-0 w-full items-center gap-2">
                <ChevronIcon
                    className="h-4 w-4 shrink-0 text-[var(--app-hint)]"
                    collapsed={props.isCollapsed}
                />
                <span className="min-w-0 break-words text-sm font-semibold" title={props.group.directory}>
                    {props.group.displayName}
                </span>
                <span className="shrink-0 text-xs text-[var(--app-hint)]">
                    ({props.group.sessions.length})
                </span>
            </div>
            <div className="flex min-w-0 w-full flex-wrap items-center gap-2 pl-6 text-xs text-[var(--app-hint)]">
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-0.5">
                    <MachineIcon className="h-3 w-3 shrink-0" />
                    {props.machineLabel}
                </span>
                <span className="min-w-0 flex-1 truncate" title={props.group.directory}>
                    {props.group.directory}
                </span>
            </div>
        </button>
    )
}

export function SessionList(props: {
    sessions: SessionSummary[]
    onSelect: (sessionId: string) => void
    onNewSession: () => void
    onRefresh: () => void
    isLoading: boolean
    renderHeader?: boolean
    api: ApiClient | null
    machineLabelsById?: Record<string, string>
    selectedSessionId?: string | null
}) {
    const { t } = useTranslation()
    const {
        renderHeader = true,
        api,
        selectedSessionId,
        machineLabelsById = {}
    } = props
    const groups = useMemo(
        () => groupSessionsByDirectory(props.sessions),
        [props.sessions]
    )
    const displayGroups = groups
    const knownSessionIdsRef = useRef<Set<string>>(new Set(props.sessions.map(session => session.id)))
    const [collapseOverrides, setCollapseOverrides] = useState<Map<string, boolean>>(
        () => new Map()
    )
    const enteringSessionIds = useMemo(() => {
        const entering = new Set<string>()
        const nextKnownSessionIds = new Set(knownSessionIdsRef.current)
        props.sessions.forEach(session => {
            if (!nextKnownSessionIds.has(session.id)) {
                entering.add(session.id)
            }
            nextKnownSessionIds.add(session.id)
        })
        knownSessionIdsRef.current = nextKnownSessionIds
        return entering
    }, [props.sessions])

    const isGroupCollapsed = (group: SessionGroup): boolean => {
        const override = collapseOverrides.get(group.key)
        if (override !== undefined) return override
        const hasSelectedSession = selectedSessionId
            ? group.sessions.some(session => session.id === selectedSessionId)
            : false
        return !group.hasActiveSession && !hasSelectedSession
    }

    const closeGroupActionMenu = () => {
        setGroupMenuOpen(false)
    }

    const groupMenuIndex = groupMenuKey ? orderedGroups.findIndex((group) => group.key === groupMenuKey) : -1
    const canMoveGroupUp = groupMenuIndex > 0
    const canMoveGroupDown = groupMenuIndex >= 0 && groupMenuIndex < orderedGroups.length - 1

    const resolveMachineLabel = (machineId: string | null): string => {
        if (machineId && machineLabelsById[machineId]) {
            return machineLabelsById[machineId]
        }
        if (machineId) {
            return machineId.slice(0, 8)
        }
        return t('machine.unknown')
    }
    const isGroupCollapsed = (group: SessionGroup): boolean => {
        const override = collapseOverrides.get(group.key)
        if (override !== undefined) return override
        return !group.hasActiveSession
    }

    const toggleGroup = (groupKey: string, isCollapsed: boolean) => {
        setCollapseOverrides(prev => {
            const group = displayGroups.find(g =>
                g.sessions.some(s => s.id === selectedSessionId)
            )
            if (!group || !prev.has(group.key) || !prev.get(group.key)) return prev
            const next = new Map(prev)
            next.set(groupKey, !isCollapsed)
            return next
        })
    }, [selectedSessionId, displayGroups])

    useEffect(() => {
        setCollapseOverrides(prev => {
            if (prev.size === 0) return prev
            const next = new Map(prev)
            const knownGroups = new Set(displayGroups.map(group => group.key))
            let changed = false
            for (const groupKey of next.keys()) {
                if (!knownGroups.has(groupKey)) {
                    next.delete(groupKey)
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [displayGroups])

    return (
        <div className="mx-auto w-full max-w-content flex flex-col">
            {renderHeader ? (
                <div className="flex items-center justify-between px-3 py-1">
                    <div className="text-xs text-[var(--app-hint)]">
                        {t('sessions.count', { n: props.sessions.length, m: displayGroups.length })}
                    </div>
                    <button
                        type="button"
                        onClick={props.onNewSession}
                        className="session-list-new-button rounded-full p-1.5 text-[var(--app-link)] transition-colors"
                        title={t('sessions.new')}
                    >
                        <PlusIcon className="h-5 w-5" />
                    </button>
                </div>
            ) : null}

            <div className="flex flex-col">
                {displayGroups.map((group) => {
                    const isCollapsed = isGroupCollapsed(group)
                    const groupMachineLabel = resolveMachineLabel(group.machineId)
                    return (
                        <div key={group.key} className="mt-2 first:mt-0">
                            <GroupHeader
                                group={group}
                                isCollapsed={isCollapsed}
                                machineLabel={machineLabel}
                                onToggle={() => toggleGroup(group.key, isCollapsed)}
                            />
                            {!isCollapsed ? (
                                <div className="flex flex-col divide-y divide-[var(--app-divider)] border-b border-[var(--app-divider)] border-l border-l-[var(--app-divider)]">
                                    {group.sessions.map((s, index) => (
                                        <SessionItem
                                            key={s.id}
                                            session={s}
                                            onSelect={props.onSelect}
                                            api={api}
                                            selected={s.id === selectedSessionId}
                                            animateEnter={enteringSessionIds.has(s.id)}
                                        />
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    )
                })}
            </div>

        </div>
    )
}
