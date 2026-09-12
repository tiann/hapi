import { getFlavorLabel } from '@hapi/protocol'
import type { AgentAvailabilityEntry } from '@hapi/protocol'
import type { AgentType } from './types'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { useTranslation } from '@/lib/use-translation'

export function AgentSelector(props: {
    agent: AgentType
    agents: readonly Pick<AgentAvailabilityEntry, 'agent' | 'available' | 'reason'>[]
    isDisabled: boolean
    onAgentChange: (value: AgentType) => void
}) {
    const { t } = useTranslation()

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.agent')}
            </label>
            <div className="flex flex-wrap gap-x-3 gap-y-2">
                {props.agents.map((entry) => {
                    const unavailableReason = entry.available
                        ? null
                        : entry.reason === 'invalid_configuration'
                            ? t('newSession.agentUnavailableReason.invalidConfiguration')
                            : t('newSession.agentUnavailableReason.notFound')
                    const label = getFlavorLabel(entry.agent)

                    return (
                        <label
                            key={entry.agent}
                            className={`flex items-center gap-1.5 ${entry.available ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'}`}
                            title={unavailableReason ?? undefined}
                        >
                            <input
                                type="radio"
                                name="agent"
                                value={entry.agent}
                                checked={props.agent === entry.agent}
                                onChange={() => props.onAgentChange(entry.agent as AgentType)}
                                disabled={props.isDisabled || !entry.available}
                                aria-label={unavailableReason ? `${label} (${unavailableReason})` : label}
                                className="accent-[var(--app-link)]"
                            />
                            <AgentFlavorIcon flavor={entry.agent} className="h-4 w-4 shrink-0" />
                            <span className="text-sm">{label}</span>
                            {unavailableReason ? (
                                <span className="text-xs text-[var(--app-hint)]">({unavailableReason})</span>
                            ) : null}
                        </label>
                    )
                })}
            </div>
        </div>
    )
}
