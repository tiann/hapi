import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { AgentState } from '@/types/api'
import { StatusBar } from './StatusBar'

const pending: AgentState = { requests: { request: { tool: 'Bash', arguments: { command: 'fixture' } } } }

function fixture(state: AgentState | null, onPendingRequestClick: (id: string) => void) {
    return <I18nProvider>
        <StatusBar active thinking={false} agentState={state} agentFlavor="claude" legacyTools={['Bash']}
            onPendingRequestClick={onPendingRequestClick} />
    </I18nProvider>
}

const detailsButton = () => screen.getByRole('button', { name: /^Agent context details:/ })

describe('Agent details during requests', () => {
    it('opens alongside the request action and keeps the dialog across request state changes', () => {
        const navigate = vi.fn()
        const view = render(fixture(null, navigate))
        fireEvent.click(detailsButton())
        expect(within(screen.getByRole('dialog')).getByText('Bash')).toBeVisible()
        view.rerender(fixture(pending, navigate))
        expect(screen.getByRole('dialog')).toBeVisible()
        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        fireEvent.click(screen.getByRole('button', { name: /^Approval required$/i }))
        expect(navigate).toHaveBeenCalledWith('request')
        fireEvent.click(detailsButton())
        expect(screen.getByRole('dialog')).toBeVisible()
    })
})
