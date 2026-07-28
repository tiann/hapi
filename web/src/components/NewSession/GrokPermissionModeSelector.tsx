import {
    getPermissionModeOptionsForFlavor,
    type GrokPermissionMode
} from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import type { AgentType } from './types'

export function GrokPermissionModeSelector(props: {
    agent: AgentType
    value: GrokPermissionMode
    autoPermissionModeSupported: boolean | null
    isDisabled: boolean
    onChange: (value: GrokPermissionMode) => void
}) {
    const { t } = useTranslation()

    if (props.agent !== 'grok') return null

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('misc.permissionMode')}
            </label>
            <select
                value={props.value}
                onChange={(event) => props.onChange(event.target.value as GrokPermissionMode)}
                disabled={props.isDisabled}
                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {getPermissionModeOptionsForFlavor('grok').map((option) => {
                    const unavailable = option.mode === 'auto'
                        && props.autoPermissionModeSupported === false
                    return (
                        <option key={option.mode} value={option.mode} disabled={unavailable}>
                            {option.label}{unavailable ? ` (${t('newSession.grokAutoUnavailable')})` : ''}
                        </option>
                    )
                })}
            </select>
            {props.autoPermissionModeSupported === false ? (
                <span className="text-xs text-[var(--app-hint)]">
                    {t('newSession.grokAutoUnavailableDesc')}
                </span>
            ) : null}
        </div>
    )
}
