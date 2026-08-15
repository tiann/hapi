import type { AgentType, CodexReasoningEffort } from './types'
import { CODEX_REASONING_EFFORT_OPTIONS } from './types'
import { useTranslation } from '@/lib/use-translation'
import { getCodexComposerReasoningEffortOptions } from '@/components/AssistantChat/codexReasoningEffortOptions'
import { SelectControl } from '@/components/ui/select-control'

export function ReasoningEffortSelector(props: {
    agent: AgentType
    value: CodexReasoningEffort
    availableOptions?: Array<{ value: string; name?: string }>
    isDisabled: boolean
    onChange: (value: CodexReasoningEffort) => void
}) {
    const { t } = useTranslation()

    if (props.agent !== 'codex' && props.agent !== 'dsh' && props.agent !== 'opencode') {
        return null
    }
    if (props.agent === 'dsh' && !props.availableOptions?.length) {
        return null
    }

    const options = (props.agent === 'codex' || props.agent === 'dsh') && props.availableOptions?.length
        ? getCodexComposerReasoningEffortOptions(null, props.agent, props.availableOptions).map((option) => ({
            value: option.value ?? 'default',
            label: option.label
        }))
        : CODEX_REASONING_EFFORT_OPTIONS.filter((option) => {
            if (props.agent === 'opencode') return option.value !== 'xhigh'
            if (props.agent === 'codex') return option.value !== 'max'
            return true
        })

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.reasoningEffort')}{' '}
                <span className="font-normal">({t('newSession.model.optional')})</span>
            </label>
            <SelectControl
                value={props.value}
                onChange={(e) => props.onChange(e.target.value as CodexReasoningEffort)}
                disabled={props.isDisabled}
                className="py-2 pl-3 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </SelectControl>
        </div>
    )
}
