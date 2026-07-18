import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { MachineSelector } from './MachineSelector'

function renderWithProviders(ui: React.ReactElement) {
    return render(
        <I18nProvider>
            {ui}
        </I18nProvider>
    )
}

describe('MachineSelector', () => {
    it('explains that known machines are offline when no online machine is selectable', () => {
        renderWithProviders(
            <MachineSelector
                machines={[]}
                knownMachinesCount={1}
                machineId={null}
                isDisabled={false}
                onChange={vi.fn()}
            />
        )

        expect(screen.getAllByText('No online machines')).toHaveLength(2)
        expect(screen.getByText('Known machines exist, but none are online. Start or restart HAPI Runner on your computer.')).toBeInTheDocument()
        expect(screen.getByText('hapi runner start')).toBeInTheDocument()
    })
})
