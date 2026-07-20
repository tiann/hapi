import type { AgentType, LaunchEffort } from './types'
import { CLAUDE_EFFORT_OPTIONS, GROK_EFFORT_OPTIONS } from './types'
import { useTranslation } from '@/lib/use-translation'

export function LaunchEffortSelector(props: {
    agent: AgentType
    effort: LaunchEffort
    isDisabled: boolean
    onEffortChange: (value: LaunchEffort) => void
    grokOptions?: Array<{ value: string; label: string }>
}) {
    const { t } = useTranslation()

    if (props.agent !== 'claude' && props.agent !== 'grok') {
        return null
    }

    const options = props.agent === 'grok'
        ? (props.grokOptions ?? GROK_EFFORT_OPTIONS)
        : CLAUDE_EFFORT_OPTIONS

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.effort')}{' '}
                <span className="font-normal">({t('newSession.model.optional')})</span>
            </label>
            <select
                value={props.effort}
                onChange={(e) => props.onEffortChange(e.target.value)}
                disabled={props.isDisabled}
                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </div>
    )
}
