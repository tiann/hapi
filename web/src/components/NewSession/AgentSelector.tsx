import type { AgentType } from './types'
import { useTranslation } from '@/lib/use-translation'
import type { ProviderReadinessMap } from '@hapi/protocol'
import { formatProviderIssue, getProviderState } from './providerAvailability'

export const AGENT_OPTIONS: { value: AgentType; label: string }[] = [
    { value: 'claude', label: 'Claude' },
    { value: 'claude-deepseek', label: 'CC-deepseek' },
    { value: 'claude-ark', label: 'CC-ark' },
    { value: 'cc-api', label: 'CC-api' },
    { value: 'codex', label: 'Codex' },
    { value: 'cursor', label: 'Cursor' },
    { value: 'agy', label: 'Antigravity agy' },
    { value: 'grok', label: 'Grok' },
    { value: 'opencode', label: 'Opencode' },
    { value: 'hermes-moa', label: 'Hermes MoA' },
]

export function AgentSelector(props: {
    agent: AgentType
    isDisabled: boolean
    providerReadiness?: ProviderReadinessMap | null
    now?: number
    onAgentChange: (value: AgentType) => void
}) {
    const { t } = useTranslation()
    const now = props.now ?? Date.now()

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.agent')}
            </label>
            <div className="flex flex-wrap gap-x-3 gap-y-2">
                {AGENT_OPTIONS.map((option) => {
                    const state = getProviderState(props.providerReadiness, option.value, now)
                    const disabled = props.isDisabled || !state.ready
                    const reason = state.issue
                        ? formatProviderIssue(state.issue, option.label, t)
                        : null
                    return (
                        <label
                            key={option.value}
                            className={`flex min-w-0 items-start gap-1.5 ${disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}
                            title={reason ?? undefined}
                        >
                            <input
                                type="radio"
                                name="agent"
                                value={option.value}
                                checked={props.agent === option.value}
                                onChange={() => props.onAgentChange(option.value)}
                                disabled={disabled}
                                className="mt-0.5 accent-[var(--app-link)]"
                            />
                            <span className="flex min-w-0 flex-col text-sm">
                                <span className="flex items-center gap-1">
                                    <span>{option.label}</span>
                                    {state.experimental ? (
                                        <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-800">
                                            {t('newSession.provider.experimental')}
                                        </span>
                                    ) : null}
                                </span>
                                {reason ? (
                                    <span className="max-w-64 text-[11px] leading-4 text-[var(--app-hint)]">
                                        {reason}
                                    </span>
                                ) : null}
                            </span>
                        </label>
                    )
                })}
            </div>
        </div>
    )
}
