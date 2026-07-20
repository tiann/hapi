import { fireEvent, render, screen } from '@testing-library/react'
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

        expect(screen.getAllByText('CPU')).toHaveLength(2)
        expect(screen.getAllByText('RAM')).toHaveLength(2)
        expect(screen.getByLabelText('Updated every ~20s from the runner on this machine')).toBeTruthy()
        const healthButton = screen.getByRole('button', { name: /CPU 72/i })

        fireEvent.click(healthButton)
        expect(healthButton.getAttribute('aria-expanded')).toBe('true')

        fireEvent.click(healthButton)
        expect(healthButton.getAttribute('aria-expanded')).toBe('false')

        fireEvent.click(healthButton)
        fireEvent.pointerDown(document.body)
        expect(healthButton.getAttribute('aria-expanded')).toBe('false')

        fireEvent.click(healthButton)
        fireEvent.keyDown(healthButton, { key: 'Escape' })
        expect(healthButton.getAttribute('aria-expanded')).toBe('false')

        const helpButton = screen.getByRole('button', { name: 'Updated every ~20s from the runner on this machine' })
        fireEvent.click(helpButton)
        expect(helpButton.getAttribute('aria-expanded')).toBe('true')
        fireEvent.click(helpButton)
        expect(helpButton.getAttribute('aria-expanded')).toBe('false')
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
