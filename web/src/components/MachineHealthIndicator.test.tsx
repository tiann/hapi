import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MachineHealthIndicator } from './MachineHealthIndicator'
import { I18nProvider } from '@/lib/i18n-context'

describe('MachineHealthIndicator', () => {
    it('renders labeled cpu and ram meter bars', () => {
        render(
            <I18nProvider>
                <MachineHealthIndicator
                    presentation={{
                        metrics: [
                            { id: 'cpu', shortLabel: 'CPU', percent: 72, tone: 'ok' },
                            { id: 'ram', shortLabel: 'RAM', percent: 81, tone: 'warn' }
                        ],
                        overallTone: 'warn',
                        status: 'elevated',
                        loadDetail: '2.4/8',
                        cpuCount: 6,
                    }}
                />
            </I18nProvider>
        )

        expect(screen.getByText('CPU')).toBeTruthy()
        expect(screen.getByText('RAM')).toBeTruthy()
        expect(screen.getByText('CPU across all 6 cores')).toBeTruthy()
        expect(screen.getByLabelText(/CPU 72/i)).toBeTruthy()
    })

    it('renders inline percent labels', () => {
        render(
            <I18nProvider>
                <MachineHealthIndicator
                    layout="inline"
                    presentation={{
                        metrics: [
                            { id: 'cpu', shortLabel: 'CPU', percent: 34, tone: 'ok' },
                            { id: 'ram', shortLabel: 'RAM', percent: 56, tone: 'warn' }
                        ],
                        overallTone: 'warn',
                        status: 'elevated',
                    }}
                />
            </I18nProvider>
        )

        expect(screen.getByLabelText(/CPU 34 percent; RAM 56 percent/i)).toBeTruthy()
    })
})
