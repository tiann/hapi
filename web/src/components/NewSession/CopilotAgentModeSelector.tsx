import { getCopilotAgentModeOptions, type CopilotAgentMode } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import type { AgentType } from './types'

export function CopilotAgentModeSelector(props: {
    agent: AgentType
    value: CopilotAgentMode
    isDisabled: boolean
    onChange: (value: CopilotAgentMode) => void
}) {
    const { t } = useTranslation()

    if (props.agent !== 'copilot') {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.copilotAgentMode')}
            </label>
            <select
                value={props.value}
                onChange={(event) => props.onChange(event.target.value as CopilotAgentMode)}
                disabled={props.isDisabled}
                className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {getCopilotAgentModeOptions().map((option) => (
                    <option key={option.mode} value={option.mode}>
                        {option.label}
                    </option>
                ))}
            </select>
        </div>
    )
}
