import type { AgentType, ClaudePermissionMode } from './types'
import { CLAUDE_PERMISSION_MODE_OPTIONS } from './types'
import { useTranslation } from '@/lib/use-translation'

export function PermissionModeSelector(props: {
    agent: AgentType
    permissionMode: ClaudePermissionMode
    isDisabled: boolean
    onPermissionModeChange: (value: ClaudePermissionMode) => void
}) {
    const { t } = useTranslation()

    if (props.agent !== 'claude') {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.permissionMode')}
            </label>
            <select
                value={props.permissionMode}
                onChange={(e) => props.onPermissionModeChange(e.target.value as ClaudePermissionMode)}
                disabled={props.isDisabled}
                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {CLAUDE_PERMISSION_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </div>
    )
}
