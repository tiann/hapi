import type { AgentType, CodexReasoningEffort } from './types'
import { getCodexReasoningEffortOptionsForModel } from './types'
import { useTranslation } from '@/lib/use-translation'

export function ReasoningEffortSelector(props: {
    agent: AgentType
    model: string
    value: CodexReasoningEffort
    isDisabled: boolean
    allowedEfforts?: readonly string[]
    onChange: (value: CodexReasoningEffort) => void
}) {
    const { t } = useTranslation()
    const configuredOptions = getCodexReasoningEffortOptionsForModel(props.model)
    const options = props.allowedEfforts === undefined
        ? configuredOptions
        : configuredOptions.filter((option) => props.allowedEfforts?.includes(option.value))

    if (props.agent !== 'codex' || options.length === 0) {
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
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </div>
    )
}
