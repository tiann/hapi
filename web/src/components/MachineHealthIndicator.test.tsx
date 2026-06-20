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
                        loadDetail: '2.4/8'
                    }}
                />
            </I18nProvider>
        )

        expect(screen.getByText('CPU')).toBeTruthy()
        expect(screen.getByText('RAM')).toBeTruthy()
        expect(screen.getByLabelText(/CPU 72/i)).toBeTruthy()
    })
})
