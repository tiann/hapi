import type { AgentType } from './types'
import { useTranslation } from '@/lib/use-translation'
import type { AgentDescriptor } from '@hapi/protocol/plugins'

export function AgentSelector(props: {
    agent: AgentType
    agents: AgentDescriptor[]
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
                {props.agents.map((descriptor) => (
                    <label
                        key={descriptor.id}
                        className={`flex items-center gap-1.5 ${descriptor.available === false ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                        title={descriptor.unavailableReason ?? descriptor.description}
                    >
                        <input
                            type="radio"
                            name="agent"
                            value={descriptor.id}
                            checked={props.agent === descriptor.id}
                            onChange={() => props.onAgentChange(descriptor.id)}
                            disabled={props.isDisabled || descriptor.available === false}
                            className="accent-[var(--app-link)]"
                        />
                        <span className="text-sm">{descriptor.displayName}</span>
                    </label>
                ))}
            </div>
        </div>
    )
}
