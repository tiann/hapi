import type { MessageDeliveryMode } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import { SelectControl } from '@/components/ui/select-control'
import type { AgentType } from './types'

export function CodexPromptModeSelector(props: {
    agent: AgentType
    value: MessageDeliveryMode
    isDisabled: boolean
    onChange: (value: MessageDeliveryMode) => void
}) {
    const { t } = useTranslation()
    if (props.agent !== 'codex') return null

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label htmlFor="codex-prompt-mode" className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.codexPromptMode')}
            </label>
            <SelectControl
                id="codex-prompt-mode"
                value={props.value}
                onChange={(event) => props.onChange(event.target.value as MessageDeliveryMode)}
                disabled={props.isDisabled}
                className="py-2 pl-3 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                <option value="queue">{t('newSession.codexPromptMode.queue')}</option>
                <option value="steer">{t('newSession.codexPromptMode.steer')}</option>
            </SelectControl>
            <p className="text-xs text-[var(--app-hint)]">{t('newSession.codexPromptMode.description')}</p>
        </div>
    )
}
