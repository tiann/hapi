import type { AgentType, CodexPermissionMode } from './types'
import { useTranslation } from '@/lib/use-translation'

export function PermissionModeSelector(props: {
    agent: AgentType
    value: CodexPermissionMode
    isDisabled: boolean
    onChange: (value: CodexPermissionMode) => void
}) {
    const { t } = useTranslation()

    if (props.agent !== 'codex') {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.permissionMode')}
            </label>
            <select
                aria-label={t('newSession.permissionMode')}
                value={props.value}
                onChange={(e) => props.onChange(e.target.value as CodexPermissionMode)}
                disabled={props.isDisabled}
                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                <option value="default">{t('newSession.permissionMode.default')}</option>
                <option value="read-only">{t('newSession.permissionMode.readOnly')}</option>
                <option value="safe-yolo">{t('newSession.permissionMode.safeYolo')}</option>
                <option value="yolo">{t('newSession.permissionMode.yolo')}</option>
            </select>
        </div>
    )
}
