import type { AgentType, ClaudeEffort } from './types'
import { CLAUDE_EFFORT_OPTIONS } from './types'
import { useTranslation } from '@/lib/use-translation'
import { CLAUDE_EFFORT_LABELS, getCcApiAutoEffortLabel, getCcApiModelEffortPresets, getClaudeDeepSeekModelEffortPresets } from '@hapi/protocol'

export function ClaudeEffortSelector(props: {
    agent: AgentType
    model: string
    effort: ClaudeEffort
    isDisabled: boolean
    allowedEfforts?: readonly string[]
    onEffortChange: (value: ClaudeEffort) => void
}) {
    const { t } = useTranslation()

    if (props.agent !== 'claude' && props.agent !== 'claude-deepseek' && props.agent !== 'claude-ark' && props.agent !== 'cc-api' && props.agent !== 'grok') {
        return null
    }

    const configuredEffortOptions = props.agent === 'grok'
        ? [
            { value: 'auto' as const, label: 'Auto' },
            { value: 'low' as const, label: 'Low' },
            { value: 'medium' as const, label: 'Medium' },
            { value: 'high' as const, label: 'High' },
        ]
        : props.agent === 'claude-deepseek'
        ? [
            { value: 'auto' as const, label: 'Auto (Claude Code default: Max)' },
            ...getClaudeDeepSeekModelEffortPresets(props.model).map((effort) => ({
                value: effort,
                label: CLAUDE_EFFORT_LABELS[effort],
            })),
        ]
        : props.agent === 'cc-api'
        ? [
            { value: 'auto' as const, label: getCcApiAutoEffortLabel(props.model) },
            ...getCcApiModelEffortPresets(props.model).map((effort) => ({
                value: effort,
                label: CLAUDE_EFFORT_LABELS[effort],
            })),
        ]
        : CLAUDE_EFFORT_OPTIONS
    const effortOptions = props.allowedEfforts === undefined
        ? configuredEffortOptions
        : configuredEffortOptions.filter((option) => props.allowedEfforts?.includes(option.value))

    if (effortOptions.length === 0) {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.effort')}{' '}
                <span className="font-normal">({t('newSession.model.optional')})</span>
            </label>
            <select
                value={props.effort}
                onChange={(e) => props.onEffortChange(e.target.value as ClaudeEffort)}
                disabled={props.isDisabled}
                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {effortOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </div>
    )
}
