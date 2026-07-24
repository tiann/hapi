import type { AgentType } from './types'
import { MODEL_OPTIONS } from './types'
import { useTranslation } from '@/lib/use-translation'
import type { GroupedModelOption } from '@/lib/provider-models'

export function ModelSelector(props: {
    agent: AgentType
    model: string
    label?: string
    options?: GroupedModelOption[]
    isDisabled: boolean
    isLoading?: boolean
    error?: string | null
    onModelChange: (value: string) => void
}) {
    const { t } = useTranslation()
    const options: GroupedModelOption[] = props.options ?? MODEL_OPTIONS[props.agent]
    if (options.length === 0) {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {props.label ?? t('newSession.model')}{' '}
                {!props.label ? (
                    <span className="font-normal">({t('newSession.model.optional')})</span>
                ) : null}
            </label>
            <select
                value={props.model}
                onChange={(e) => props.onModelChange(e.target.value)}
                disabled={props.isDisabled || props.isLoading}
                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {Object.entries(Object.groupBy(options, (option) => option.group ?? ''))
                    .map(([group, grouped]) => group ? (
                        <optgroup key={group} label={group}>
                            {grouped?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </optgroup>
                    ) : grouped?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>))}
            </select>
            {props.error ? (
                <div className="text-xs text-red-600">
                    {props.error}
                </div>
            ) : null}
        </div>
    )
}
