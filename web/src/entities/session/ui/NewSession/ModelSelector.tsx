import type { AgentType } from './types'
import { MODEL_OPTIONS } from './types'
import { useTranslation } from '@/lib/use-translation'

export function ModelSelector(props: {
    agent: AgentType
    model: string
    isDisabled: boolean
    onModelChange: (value: string) => void
}) {
    const { t } = useTranslation()
    const options = MODEL_OPTIONS[props.agent]
    if (options.length === 0) {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.model')}{' '}
                <span className="font-normal">({t('newSession.model.optional')})</span>
            </label>
            <select
                value={props.model}
                onChange={(e) => props.onModelChange(e.target.value)}
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
