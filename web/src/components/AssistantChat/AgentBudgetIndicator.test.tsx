import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AgentBudgetState } from '@hapi/protocol/types'
import { AgentBudgetIndicator } from './AgentBudgetIndicator'

const sampleState: AgentBudgetState = {
    operationalAxisId: 'context',
    axes: [
        {
            id: 'context',
            label: 'Context Window',
            pressure: 20,
            valueText: '20%'
        }
    ],
    effective: 'green',
    effectiveReason: 'All budgets well below caps'
}

describe('AgentBudgetIndicator', () => {
    it('does not reopen the popover after usage becomes unavailable then returns', () => {
        const { rerender } = render(<AgentBudgetIndicator state={sampleState} popoverTitle="Codex Usage" />)
        fireEvent.click(screen.getByRole('button', { name: 'All budgets well below caps' }))
        expect(screen.getByText('Codex Usage')).toBeTruthy()

        rerender(<AgentBudgetIndicator state={null} popoverTitle="Codex Usage" />)
        expect(screen.queryByRole('button')).toBeNull()
        expect(screen.queryByText('Codex Usage')).toBeNull()

        rerender(<AgentBudgetIndicator state={sampleState} popoverTitle="Codex Usage" />)
        expect(screen.getByRole('button', { name: 'All budgets well below caps' })).toBeTruthy()
        expect(screen.queryByText('Codex Usage')).toBeNull()
    })
})
