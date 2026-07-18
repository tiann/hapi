import { getPermissionModeOptionsForFlavor } from '@hapi/protocol'
import type { PermissionMode } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import type { AgentType } from './types'

export function PermissionModeSelector(props: {
    agent: AgentType
    mode: PermissionMode
    isDisabled: boolean
    allowedModes?: readonly PermissionMode[]
    onChange: (mode: PermissionMode) => void
}) {
    const { t } = useTranslation()
    if (props.agent !== 'agy' && props.agent !== 'grok' && props.agent !== 'hermes-moa') {
        return null
    }

    const options = getPermissionModeOptionsForFlavor(props.agent)
        .filter((option) => props.allowedModes === undefined || props.allowedModes.includes(option.mode))

    if (options.length === 0) {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]" htmlFor="new-session-permission-mode">
                {t('newSession.permissionMode')}
            </label>
            <select
                id="new-session-permission-mode"
                value={props.mode}
                onChange={(event) => props.onChange(event.target.value as PermissionMode)}
                disabled={props.isDisabled}
                className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)] disabled:opacity-50"
            >
                {options.map((option) => (
                    <option key={option.mode} value={option.mode}>
                        {option.label}
                    </option>
                ))}
            </select>
            <span className="text-xs text-[var(--app-hint)]">
                {t('newSession.permissionMode.desc')}
            </span>
        </div>
    )
}
