import type { AgentType } from './types'
import { DSH_PRESET_OPTIONS } from './types'
import { SelectControl } from '@/components/ui/select-control'

export function DshPresetSelector(props: {
    agent: AgentType
    value: string
    isDisabled: boolean
    onChange: (value: string) => void
}) {
    if (props.agent !== 'dsh') {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">Preset</label>
            <SelectControl
                value={props.value}
                onChange={(e) => props.onChange(e.target.value)}
                disabled={props.isDisabled}
                className="py-2 pl-3 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {DSH_PRESET_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </SelectControl>
        </div>
    )
}
