import type { AgentType, CodexReasoningEffort } from './types'
import { CODEX_REASONING_EFFORT_OPTIONS } from './types'
import { useTranslation } from '@/lib/use-translation'

export function ReasoningEffortSelector(props: {
    agent: AgentType
    value: CodexReasoningEffort
    isDisabled: boolean
    options?: Array<{ value: CodexReasoningEffort; label: string }>
    onChange: (value: CodexReasoningEffort) => void
}) {
    const { t } = useTranslation()

    if (props.agent !== 'codex' && props.agent !== 'opencode') {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.reasoningEffort')}{' '}
                <span className="font-normal">({t('newSession.model.optional')})</span>
            </label>
            <select
                value={props.value}
                onChange={(e) => props.onChange(e.target.value as CodexReasoningEffort)}
                disabled={props.isDisabled}
                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {(props.options ?? CODEX_REASONING_EFFORT_OPTIONS.filter((option) =>
                    props.agent === 'opencode'
                        ? option.value !== 'xhigh' && option.value !== 'ultra'
                        : option.value !== 'max' && option.value !== 'ultra'
                )).map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </div>
    )
}
