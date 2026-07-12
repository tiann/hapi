import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

const ALL_WORKDIR_FILTER = '__all__'

// 中文注释：导入弹窗共用的本地会话最小形态；codex / claude 的 LocalSessionSummary 都满足该结构。
export type ImportSessionSummary = {
    id: string
    title: string
    lastUserMessage?: string | null
    cwd?: string | null
    modifiedAt: number
    originator?: string | null
    cliVersion?: string | null
}

// 中文注释：把弹窗用到的所有文案集中成一组 key，让 codex / claude 各自传入自己的 i18n key，组件本身不感知 flavor。
export type SessionImportPickerLabels = {
    selectedCount: string
    selectAll: string
    clearAll: string
    cwdFilter: string
    cwdFilterAll: string
    cwd: string
    current: string
    loading: string
    empty: string
    emptyForWorkdir: string
}

function formatSessionTime(value: number): string | null {
    if (!Number.isFinite(value)) return null
    return new Date(value).toLocaleString()
}

function getSessionPreview(session: ImportSessionSummary): string {
    if (session.lastUserMessage?.trim()) {
        return session.lastUserMessage.trim()
    }

    const parts = [session.originator, session.cliVersion].filter(Boolean)
    return parts.join(' · ')
}

function getSessionCwd(session: ImportSessionSummary): string | null {
    const cwd = session.cwd?.trim()
    return cwd ? cwd : null
}

/**
 * Shared transcript-import session picker (checkbox list + workdir filter +
 * select/clear all). Codex and Claude import dialogs both render this so the
 * row/filter/selection logic lives in a single place (task R8).
 */
export function SessionImportPicker(props: {
    isOpen: boolean
    sessions: ImportSessionSummary[]
    currentSessionId: string | null
    selectedSessionIds: string[]
    onSelectionChange: (sessionIds: string[]) => void
    isPending: boolean
    isLoading: boolean
    labels: SessionImportPickerLabels
}) {
    const { t } = useTranslation()
    const {
        isOpen,
        sessions,
        currentSessionId,
        selectedSessionIds,
        onSelectionChange,
        isPending,
        isLoading,
        labels
    } = props
    const [hasInitializedSelection, setHasInitializedSelection] = useState(false)
    const [workdirFilter, setWorkdirFilter] = useState(ALL_WORKDIR_FILTER)
    const wasOpenRef = useRef(false)

    const sessionIdSet = useMemo(
        () => new Set(sessions.map((session) => session.id)),
        [sessions]
    )
    const selectedSessionIdSet = useMemo(
        () => new Set(selectedSessionIds),
        [selectedSessionIds]
    )
    const workdirOptions = useMemo(() => {
        const directories = new Set<string>()
        for (const session of sessions) {
            const cwd = getSessionCwd(session)
            if (cwd) directories.add(cwd)
        }
        return Array.from(directories).sort((a, b) => a.localeCompare(b))
    }, [sessions])
    const filteredSessions = useMemo(() => {
        if (workdirFilter === ALL_WORKDIR_FILTER) return sessions
        return sessions.filter((session) => getSessionCwd(session) === workdirFilter)
    }, [sessions, workdirFilter])

    useEffect(() => {
        if (isOpen && !wasOpenRef.current) {
            wasOpenRef.current = true
            onSelectionChange([])
            setHasInitializedSelection(false)
            setWorkdirFilter(ALL_WORKDIR_FILTER)
            return
        }

        if (!isOpen && wasOpenRef.current) {
            wasOpenRef.current = false
            onSelectionChange([])
            setHasInitializedSelection(false)
            setWorkdirFilter(ALL_WORKDIR_FILTER)
        }
        // 中文注释：仅在弹窗开/关切换时重置；onSelectionChange 故意不入依赖以避免父组件每次渲染触发重置。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen])

    useEffect(() => {
        if (workdirFilter === ALL_WORKDIR_FILTER) return
        if (workdirOptions.includes(workdirFilter)) return
        setWorkdirFilter(ALL_WORKDIR_FILTER)
    }, [workdirFilter, workdirOptions])

    useEffect(() => {
        if (!isOpen || isLoading || hasInitializedSelection) return

        // 中文注释：弹窗打开后等本地会话列表加载完成，再尝试默认勾选当前 Hapi 会话关联的 thread，避免异步加载时默认值丢失。
        const defaultSelected = currentSessionId && sessionIdSet.has(currentSessionId)
            ? [currentSessionId]
            : []
        onSelectionChange(defaultSelected)
        setHasInitializedSelection(true)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentSessionId, hasInitializedSelection, isLoading, isOpen, sessionIdSet])

    const toggleSession = (sessionId: string) => {
        if (isPending || isLoading) return

        // 中文注释：列表项支持多选导入；再次点击同一行则取消勾选，便于快速调整导入批次。
        onSelectionChange(selectedSessionIds.includes(sessionId)
            ? selectedSessionIds.filter((id) => id !== sessionId)
            : [...selectedSessionIds, sessionId])
    }

    const selectAll = () => {
        onSelectionChange(filteredSessions.map((session) => session.id))
    }

    const clearAll = () => {
        // 中文注释：全取消放在左侧，和底部“取消 / 导入”的左右语义保持一致。
        onSelectionChange([])
    }

    return (
        <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-[var(--app-hint)]">
                    {t(labels.selectedCount, { n: selectedSessionIds.length })}
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={clearAll}
                        disabled={isPending || isLoading || selectedSessionIds.length === 0}
                    >
                        {t(labels.clearAll)}
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={selectAll}
                        disabled={isPending || isLoading || filteredSessions.length === 0}
                    >
                        {t(labels.selectAll)}
                    </Button>
                </div>
            </div>

            {sessions.length > 0 ? (
                <label className="block min-w-0 text-xs text-[var(--app-hint)]">
                    <span className="mb-1 block">{t(labels.cwdFilter)}</span>
                    <select
                        className="h-8 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)] outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                        value={workdirFilter}
                        disabled={isPending || isLoading || workdirOptions.length === 0}
                        onChange={(event) => setWorkdirFilter(event.target.value)}
                    >
                        <option value={ALL_WORKDIR_FILTER}>
                            {t(labels.cwdFilterAll)}
                        </option>
                        {workdirOptions.map((directory) => (
                            <option key={directory} value={directory}>
                                {directory}
                            </option>
                        ))}
                    </select>
                </label>
            ) : null}

            <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]">
                {isLoading ? (
                    <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t(labels.loading)}
                    </div>
                ) : sessions.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t(labels.empty)}
                    </div>
                ) : filteredSessions.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t(labels.emptyForWorkdir)}
                    </div>
                ) : (
                    <div className="divide-y divide-[var(--app-border)]">
                        {filteredSessions.map((session) => {
                            const checked = selectedSessionIdSet.has(session.id)
                            const time = formatSessionTime(session.modifiedAt)
                            const preview = getSessionPreview(session)
                            const cwd = getSessionCwd(session)
                            return (
                                <label
                                    key={session.id}
                                    className="flex cursor-pointer items-start gap-3 px-3 py-2 transition-colors hover:bg-[var(--app-subtle-bg)]"
                                >
                                    <input
                                        type="checkbox"
                                        className="mt-1 h-4 w-4 accent-[var(--app-link)]"
                                        checked={checked}
                                        disabled={isPending || isLoading}
                                        onChange={() => toggleSession(session.id)}
                                    />
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <div className="truncate text-sm font-medium text-[var(--app-fg)]">
                                                {session.title}
                                            </div>
                                            {session.id === currentSessionId ? (
                                                <span className="shrink-0 rounded-full bg-[var(--app-secondary-bg)] px-2 py-0.5 text-[10px] text-[var(--app-hint)]">
                                                    {t(labels.current)}
                                                </span>
                                            ) : null}
                                        </div>
                                        {preview ? (
                                            <div className="mt-0.5 truncate text-xs text-[var(--app-hint)]">
                                                {preview}
                                            </div>
                                        ) : null}
                                        {cwd ? (
                                            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-[var(--app-hint)]">
                                                <span className="shrink-0">{t(labels.cwd)}</span>
                                                <span className="min-w-0 truncate font-mono" title={cwd}>{cwd}</span>
                                            </div>
                                        ) : null}
                                        {time ? (
                                            <div className="mt-0.5 text-[11px] text-[var(--app-hint)]">
                                                {time}
                                            </div>
                                        ) : null}
                                    </div>
                                </label>
                            )
                        })}
                    </div>
                )}
            </div>
        </div>
    )
}
