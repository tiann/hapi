import type { OpencodeAgentSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

export function OpencodeAgentSelector(props: {
    value: string | null | undefined
    availableAgents: OpencodeAgentSummary[]
    isDisabled: boolean
    onChange: (value: string) => void
}) {
    const { t } = useTranslation()
    const availableAgents = props.availableAgents ?? []

    if (availableAgents.length === 0) {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.opencodeAgent')}
            </label>
            <select
                value={props.value ?? ''}
                onChange={(event) => props.onChange(event.target.value)}
                disabled={props.isDisabled}
                className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {availableAgents.map((option) => (
                    <option key={option.agentId} value={option.agentId}>
                        {option.name ?? option.agentId}
                    </option>
                ))}
            </select>
        </div>
    )
}
