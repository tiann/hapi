import type { CodexSessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

function formatDate(timestamp: number): string {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return '-'
    }
    return new Date(timestamp).toLocaleDateString()
}

export function CodexSessionSelector(props: {
    enabled: boolean
    includeOld: boolean
    sessions: CodexSessionSummary[]
    selectedSessionId: string
    isLoading: boolean
    isDisabled?: boolean
    error?: string | null
    onToggleIncludeOld: (value: boolean) => void
    onSelectSession: (sessionId: string) => void
}) {
    const { t } = useTranslation()

    if (!props.enabled) {
        return null
    }

    const options = [{ id: '', label: t('newSession.codexSession.newSession') }]
    for (const session of props.sessions) {
        const date = formatDate(session.updatedAt)
        const location = session.path ? ` · ${session.path}` : ''
        options.push({
            id: session.id,
            label: `${session.title} (${date})${location}`
        })
    }

    return (
        <div className="p-3 space-y-2">
            <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[var(--app-fg)]" htmlFor="codex-session-select">
                    {t('newSession.codexSession.label')}
                </label>
                <label className="inline-flex items-center gap-2 text-xs text-[var(--app-fg-muted)]">
                    <input
                        type="checkbox"
                        checked={props.includeOld}
                        disabled={props.isDisabled}
                        onChange={(event) => props.onToggleIncludeOld(event.target.checked)}
                    />
                    {t('newSession.codexSession.showOld')}
                </label>
            </div>
            <select
                id="codex-session-select"
                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm"
                value={props.selectedSessionId}
                disabled={props.isDisabled || props.isLoading || Boolean(props.error)}
                onChange={(event) => props.onSelectSession(event.target.value)}
            >
                {options.map((option) => (
                    <option key={option.id || 'new'} value={option.id}>{option.label}</option>
                ))}
            </select>
            {props.isLoading ? <div className="text-xs text-[var(--app-fg-muted)]">{t('newSession.codexSession.loading')}</div> : null}
            {props.error ? <div className="text-xs text-red-600">{props.error}</div> : null}
        </div>
    )
}
