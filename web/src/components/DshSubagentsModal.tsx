import { useEffect, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'

type SubagentEntry = {
    id: string
    kind: string
    mode?: string
    label?: string
    activity?: 'running' | 'inactive'
    hasChildren?: boolean
}

/**
 * DeepSeek Harness subagent status modal, opened from the session header
 * button. Lists direct children with their live activity and lets the user
 * refresh; per-child transcripts come from the DSH subagent RPC surface.
 */
export function DshSubagentsModal({ api, sessionId, onClose }: {
    api: ApiClient
    sessionId: string
    onClose: () => void
}) {
    const { t } = useTranslation()
    const [entries, setEntries] = useState<SubagentEntry[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)

    const load = () => {
        setLoading(true)
        setError(null)
        void api.dshAction<{ entries: SubagentEntry[]; parentAvailable: boolean }>(
            sessionId,
            { type: 'subagent', action: 'list' }
        ).then((response) => {
            setEntries(response.result.entries.filter((entry) => entry.kind === 'child'))
        }).catch((e: unknown) => {
            setError(e instanceof Error ? e.message : String(e))
        }).finally(() => {
            setLoading(false)
        })
    }

    useEffect(() => {
        load()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId])

    const running = entries?.filter((entry) => entry.activity === 'running').length ?? 0

    return (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
            <div
                className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-card-bg)] p-4"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">{t('dsh.subagents')}</h3>
                    <div className="flex items-center gap-2">
                        {entries ? (
                            <span className="text-xs text-[var(--app-hint)]">
                                {running > 0
                                    ? t('dsh.subagentRunningCount', { count: running })
                                    : t('dsh.noSubagents')}
                            </span>
                        ) : null}
                        <button
                            type="button"
                            onClick={load}
                            disabled={loading}
                            className="panel-btn text-xs disabled:opacity-50"
                        >
                            {loading ? t('dsh.loading') : t('dsh.refresh')}
                        </button>
                        <button type="button" onClick={onClose} className="panel-btn text-xs">
                            ✕
                        </button>
                    </div>
                </div>

                {error ? <div className="mb-2 text-xs text-red-500">{error}</div> : null}

                {entries === null && !error ? (
                    <div className="py-6 text-center text-xs text-[var(--app-hint)]">{t('dsh.loading')}</div>
                ) : entries && entries.length === 0 ? (
                    <div className="py-6 text-center text-xs text-[var(--app-hint)]">{t('dsh.noSubagents')}</div>
                ) : (
                    <div className="flex flex-col gap-1.5">
                        {entries?.map((entry) => (
                            <div
                                key={entry.id}
                                className="flex items-center justify-between gap-2 rounded-md border border-[var(--app-border)] px-2.5 py-2 text-xs"
                            >
                                <div className="min-w-0">
                                    <div className="truncate font-medium">{entry.label ?? entry.id}</div>
                                    <div className="truncate text-[10px] text-[var(--app-hint)]">
                                        {entry.id}
                                        {entry.mode ? ` · ${entry.mode}` : ''}
                                        {entry.hasChildren ? ` · ${t('dsh.subagentHasChildren')}` : ''}
                                    </div>
                                </div>
                                <span className={`shrink-0 ${entry.activity === 'running' ? 'text-green-600 dark:text-green-400' : 'text-[var(--app-hint)]'}`}>
                                    {entry.activity === 'running' ? t('dsh.subagentRunning') : t('dsh.subagentIdle')}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
