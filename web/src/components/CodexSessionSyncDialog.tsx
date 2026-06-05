import { useEffect, useMemo, useRef, useState } from 'react'
import type { CodexLocalSessionSummary } from '@/types/api'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

const ALL_WORKDIR_FILTER = '__all__'

function formatCodexSessionTime(value: number): string | null {
    if (!Number.isFinite(value)) return null
    return new Date(value).toLocaleString()
}

function getCodexSessionPreview(session: CodexLocalSessionSummary): string {
    if (session.lastUserMessage?.trim()) {
        return session.lastUserMessage.trim()
    }

    const parts = [session.originator, session.cliVersion].filter(Boolean)
    return parts.join(' · ')
}

function getCodexSessionCwd(session: CodexLocalSessionSummary): string | null {
    const cwd = session.cwd?.trim()
    return cwd ? cwd : null
}

export function CodexSessionSyncDialog(props: {
    isOpen: boolean
    onClose: () => void
    sessions: CodexLocalSessionSummary[]
    currentCodexSessionId: string | null
    onConfirm: (sessionIds: string[]) => Promise<void>
    onRestartCodexDesktop: () => Promise<void>
    isPending: boolean
    isRestartingCodexDesktop: boolean
    isLoading: boolean
}) {
    const { t } = useTranslation()
    const {
        isOpen,
        sessions,
        currentCodexSessionId,
        onConfirm,
        onRestartCodexDesktop,
        isPending,
        isRestartingCodexDesktop,
        isLoading,
        onClose
    } = props
    const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([])
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
            const cwd = getCodexSessionCwd(session)
            if (cwd) directories.add(cwd)
        }
        return Array.from(directories).sort((a, b) => a.localeCompare(b))
    }, [sessions])
    const filteredSessions = useMemo(() => {
        if (workdirFilter === ALL_WORKDIR_FILTER) return sessions
        return sessions.filter((session) => getCodexSessionCwd(session) === workdirFilter)
    }, [sessions, workdirFilter])

    useEffect(() => {
        if (isOpen && !wasOpenRef.current) {
            wasOpenRef.current = true
            setSelectedSessionIds([])
            setHasInitializedSelection(false)
            setWorkdirFilter(ALL_WORKDIR_FILTER)
            return
        }

        if (!isOpen && wasOpenRef.current) {
            wasOpenRef.current = false
            setSelectedSessionIds([])
            setHasInitializedSelection(false)
            setWorkdirFilter(ALL_WORKDIR_FILTER)
        }
    }, [isOpen])

    useEffect(() => {
        if (workdirFilter === ALL_WORKDIR_FILTER) return
        if (workdirOptions.includes(workdirFilter)) return
        setWorkdirFilter(ALL_WORKDIR_FILTER)
    }, [workdirFilter, workdirOptions])

    useEffect(() => {
        if (!isOpen || isLoading || hasInitializedSelection) return

        // 中文注释：弹窗打开后等本地 Codex 会话列表加载完成，再尝试默认勾选当前 Hapi 会话关联的 Codex thread，避免异步加载时默认值丢失。
        const defaultSelected = currentCodexSessionId && sessionIdSet.has(currentCodexSessionId)
            ? [currentCodexSessionId]
            : []
        setSelectedSessionIds(defaultSelected)
        setHasInitializedSelection(true)
    }, [currentCodexSessionId, hasInitializedSelection, isLoading, isOpen, sessionIdSet])

    const toggleSession = (sessionId: string) => {
        if (isPending || isLoading) return

        // 中文注释：列表项支持多选导入；再次点击同一行则取消勾选，便于快速调整导入批次。
        setSelectedSessionIds((current) => current.includes(sessionId)
            ? current.filter((id) => id !== sessionId)
            : [...current, sessionId])
    }

    const selectAll = () => {
        const visibleIds = filteredSessions.map((session) => session.id)
        setSelectedSessionIds((current) => Array.from(new Set([...current, ...visibleIds])))
    }

    const clearAll = () => {
        // 中文注释：全取消放在左侧，和底部“取消 / 导入”的左右语义保持一致。
        setSelectedSessionIds([])
    }

    const handleConfirm = async () => {
        if (selectedSessionIds.length === 0 || isPending || isLoading) return

        // 中文注释：确认按钮只提交用户在弹窗中勾选的 Codex thread，实际导入逻辑由父组件统一处理并给出 toast 提示。
        await onConfirm(selectedSessionIds)
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-xl">
                <div className="flex items-start justify-between gap-3">
                    <DialogHeader className="flex-1 text-left">
                        <DialogTitle>{t('codexSync.confirm.title')}</DialogTitle>
                        <DialogDescription className="mt-2">
                            {t('codexSync.confirm.description')}
                        </DialogDescription>
                    </DialogHeader>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void onRestartCodexDesktop()}
                        disabled={isRestartingCodexDesktop}
                        aria-label={t('codexSync.restart.tooltip')}
                        title={t('codexSync.restart.tooltip')}
                    >
                        {/* 中文注释：把容易被误解为“刷新页面”的 icon 改成明确文字按钮，直接说明这是重启 Codex 客户端。 */}
                        {isRestartingCodexDesktop ? t('codexSync.restart.confirming') : t('codexSync.restart.tooltip')}
                    </Button>
                </div>

                <div className="mt-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                        <div className="text-xs text-[var(--app-hint)]">
                            {t('codexSync.confirm.selectedCount', { n: selectedSessionIds.length })}
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={clearAll}
                                disabled={isPending || isLoading || selectedSessionIds.length === 0}
                            >
                                {t('codexSync.confirm.clearAll')}
                            </Button>
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={selectAll}
                                disabled={isPending || isLoading || filteredSessions.length === 0}
                            >
                                {t('codexSync.confirm.selectAll')}
                            </Button>
                        </div>
                    </div>

                    {sessions.length > 0 ? (
                        <label className="block min-w-0 text-xs text-[var(--app-hint)]">
                            <span className="mb-1 block">{t('codexSync.confirm.cwdFilter')}</span>
                            <select
                                className="h-8 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)] outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                                value={workdirFilter}
                                disabled={isPending || isLoading || workdirOptions.length === 0}
                                onChange={(event) => setWorkdirFilter(event.target.value)}
                            >
                                <option value={ALL_WORKDIR_FILTER}>
                                    {t('codexSync.confirm.cwdFilterAll')}
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
                                {t('codexSync.confirm.loading')}
                            </div>
                        ) : sessions.length === 0 ? (
                            <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                                {t('codexSync.confirm.empty')}
                            </div>
                        ) : filteredSessions.length === 0 ? (
                            <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                                {t('codexSync.confirm.emptyForWorkdir')}
                            </div>
                        ) : (
                            <div className="divide-y divide-[var(--app-border)]">
                                {filteredSessions.map((session) => {
                                    const checked = selectedSessionIdSet.has(session.id)
                                    const time = formatCodexSessionTime(session.modifiedAt)
                                    const preview = getCodexSessionPreview(session)
                                    const cwd = getCodexSessionCwd(session)
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
                                                    {session.id === currentCodexSessionId ? (
                                                        <span className="shrink-0 rounded-full bg-[var(--app-secondary-bg)] px-2 py-0.5 text-[10px] text-[var(--app-hint)]">
                                                            {t('codexSync.confirm.current')}
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
                                                        <span className="shrink-0">{t('codexSync.confirm.cwd')}</span>
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

                <div className="mt-4 flex justify-end gap-2">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        disabled={isPending || isRestartingCodexDesktop}
                    >
                        {t('button.cancel')}
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void handleConfirm()}
                        disabled={isPending || isLoading || selectedSessionIds.length === 0}
                    >
                        {isPending ? t('codexSync.confirm.confirming') : t('codexSync.confirm.confirm')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
