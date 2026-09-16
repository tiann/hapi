import { useState } from 'react'
import { getFlavorLabel } from '@hapi/protocol'
import type { AgentAvailabilityEntry } from '@hapi/protocol'
import type { AgentType } from './types'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { useTranslation } from '@/lib/use-translation'

function ChevronIcon(props: { expanded: boolean }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-3.5 w-3.5 transition-transform ${props.expanded ? 'rotate-180' : ''}`}
            aria-hidden="true"
        >
            <path d="m6 9 6 6 6-6" />
        </svg>
    )
}

export function AgentSelector(props: {
    agent: AgentType
    agents: readonly Pick<AgentAvailabilityEntry, 'agent' | 'available' | 'reason'>[]
    isDisabled: boolean
    onAgentChange: (value: AgentType) => void
}) {
    const { t } = useTranslation()
    const [showUnavailableAgents, setShowUnavailableAgents] = useState(false)
    const unavailableAgents = props.agents.filter((entry) => !entry.available)
    const visibleAgents = props.agents.filter((entry) => entry.available || showUnavailableAgents)

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.agent')}
            </label>
            <div className="flex flex-wrap gap-x-3 gap-y-2">
                {visibleAgents.map((entry) => {
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
                {unavailableAgents.length > 0 ? (
                    <button
                        type="button"
                        aria-expanded={showUnavailableAgents}
                        onClick={() => setShowUnavailableAgents((expanded) => !expanded)}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-link)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                    >
                        <ChevronIcon expanded={showUnavailableAgents} />
                        {showUnavailableAgents
                            ? t('newSession.hideOtherAgents')
                            : t('newSession.moreAgents')}
                    </button>
                ) : null}
            </div>
        </div>
    )
}
