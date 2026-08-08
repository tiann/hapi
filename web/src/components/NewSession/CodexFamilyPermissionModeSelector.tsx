import { getPermissionModeOptionsForFlavor, type PermissionMode } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import { usesCodexFamilyPermissionModes } from '@/lib/codexFamilyPermissionAgents'
import { SelectControl } from '@/components/ui/select-control'
import type { AgentType } from './types'

export function CodexFamilyPermissionModeSelector(props: {
    agent: AgentType
    value: PermissionMode
    isDisabled: boolean
    onChange: (value: PermissionMode) => void
}) {
    const { t } = useTranslation()

    if (!usesCodexFamilyPermissionModes(props.agent)) {
        return null
    }

    const options = getPermissionModeOptionsForFlavor(props.agent)

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('misc.permissionMode')}
            </label>
            <SelectControl
                value={props.value}
                onChange={(event) => props.onChange(event.target.value as PermissionMode)}
                disabled={props.isDisabled}
                className="py-2 pl-3 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {options.map((option) => (
                    <option key={option.mode} value={option.mode}>
                        {option.label}
                    </option>
                ))}
            </SelectControl>
        </div>
    )
}
