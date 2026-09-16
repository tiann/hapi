import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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

    it('reveals unavailable Agents on demand with their reason', () => {
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

        expect(screen.queryByDisplayValue('codex')).not.toBeInTheDocument()
        const disclosure = screen.getByRole('button', { name: 'newSession.moreAgents' })
        expect(disclosure).toHaveAttribute('aria-expanded', 'false')

        fireEvent.click(disclosure)

        expect(screen.getByDisplayValue('codex')).toBeDisabled()
        expect(screen.getByTitle('newSession.agentUnavailableReason.invalidConfiguration')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'newSession.hideOtherAgents' })).toHaveAttribute('aria-expanded', 'true')

        fireEvent.click(screen.getByRole('button', { name: 'newSession.hideOtherAgents' }))
        expect(screen.queryByDisplayValue('codex')).not.toBeInTheDocument()
    })

    it('renders only the entries supplied by the machine availability state', () => {
        expect(renderedAgentValues(availableEntries().filter(({ agent }) => agent === 'claude' || agent === 'codex')))
            .toEqual(['claude', 'codex'])
    })
})
