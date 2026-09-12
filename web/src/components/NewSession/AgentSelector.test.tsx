import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CREATABLE_AGENT_FLAVORS } from '@hapi/protocol'
import type { AgentAvailabilityEntry } from '@hapi/protocol'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

import { AgentSelector } from './AgentSelector'
import type { AgentType } from './types'

function availableEntries(): AgentAvailabilityEntry[] {
    return CREATABLE_AGENT_FLAVORS.map((agent) => ({ agent, available: true }))
}

function renderedAgentValues(agents: readonly AgentAvailabilityEntry[] = availableEntries()): string[] {
    const { container } = render(
        <AgentSelector
            agent={'claude' as AgentType}
            agents={agents}
            isDisabled={false}
            onAgentChange={() => {}}
        />
    )
    return Array.from(container.querySelectorAll('input[type="radio"]'))
        .map((el) => (el as HTMLInputElement).value)
}

describe('AgentSelector', () => {
    it('does not offer the sunset Gemini CLI as a new-session agent', () => {
        expect(renderedAgentValues()).not.toContain('gemini')
    })

    it('offers exactly the creatable agent flavors', () => {
        expect(renderedAgentValues()).toEqual([...CREATABLE_AGENT_FLAVORS])
    })

    it('renders unavailable Agents as disabled with their reason', () => {
        render(
            <AgentSelector
                agent={'claude' as AgentType}
                agents={[
                    { agent: 'claude', available: true },
                    { agent: 'codex', available: false, reason: 'invalid_configuration' },
                ]}
                isDisabled={false}
                onAgentChange={() => {}}
            />
        )

        expect(screen.getByDisplayValue('codex')).toBeDisabled()
        expect(screen.getByTitle('newSession.agentUnavailableReason.invalidConfiguration')).toBeInTheDocument()
    })

    it('renders only the entries supplied by the machine availability state', () => {
        expect(renderedAgentValues(availableEntries().filter(({ agent }) => agent === 'claude' || agent === 'codex')))
            .toEqual(['claude', 'codex'])
    })
})
