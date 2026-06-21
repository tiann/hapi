import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Machine } from '@/types/api'
import { MachineGroupHeader } from './MachineGroupHeader'
import { I18nProvider } from '@/lib/i18n-context'

const machine: Machine = {
    id: 'Teemo',
    namespace: 'default',
    seq: 1,
    createdAt: 0,
    updatedAt: 0,
    active: true,
    activeAt: 0,
    metadata: {
        host: 'Teemo',
        platform: 'win32',
        happyCliVersion: '0.20.2',
    },
    metadataVersion: 1,
    runnerState: null,
    runnerStateVersion: 0,
}

describe('MachineGroupHeader', () => {
    it('renders a bordered machine card with os label and inline health', () => {
        render(
            <I18nProvider>
                <MachineGroupHeader
                    label="Teemo"
                    sessionCount={4}
                    collapsed={false}
                    onToggle={() => {}}
                    machine={machine}
                    healthPresentation={{
                        metrics: [
                            { id: 'cpu', shortLabel: 'CPU', percent: 12, tone: 'ok' },
                            { id: 'ram', shortLabel: 'RAM', percent: 88, tone: 'warn' },
                        ],
                        overallTone: 'warn',
                        status: 'elevated',
                    }}
                />
            </I18nProvider>
        )

        expect(screen.getByRole('button', { name: /Teemo/i })).toBeTruthy()
        expect(screen.getByText('Windows')).toBeTruthy()
        expect(screen.getByText('4 sessions')).toBeTruthy()
        expect(screen.getByLabelText(/CPU 12 percent; RAM 88 percent/i)).toBeTruthy()
    })
})
