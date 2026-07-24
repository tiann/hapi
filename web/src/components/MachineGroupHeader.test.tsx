import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
    it('renders a single-row machine tile with machine name and compact health', () => {
        const onToggle = vi.fn()
        render(
            <I18nProvider>
                <MachineGroupHeader
                    label="Teemo"
                    sessionCount={4}
                    collapsed={false}
                    onToggle={onToggle}
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

        const machineButton = screen.getByRole('button', { name: /Teemo/i })
        expect(machineButton.getAttribute('aria-expanded')).toBe('true')
        fireEvent.click(machineButton)
        expect(onToggle).toHaveBeenCalledTimes(1)
        expect(screen.queryByText('Windows')).toBeNull()
        expect(screen.getByText('(4)')).toBeTruthy()
        expect(screen.getByLabelText(/CPU 12 percent; RAM 88 percent/i)).toBeTruthy()

        const healthButton = screen.getByRole('button', { name: /CPU 12 percent; RAM 88 percent/i })
        fireEvent.click(healthButton)
        expect(healthButton.getAttribute('aria-expanded')).toBe('true')
        expect(onToggle).toHaveBeenCalledTimes(1)
    })

    it('keeps uptime in the health tooltip instead of replacing the machine name', () => {
        render(
            <I18nProvider>
                <MachineGroupHeader
                    label="proxmox"
                    sessionCount={2}
                    collapsed={false}
                    onToggle={() => {}}
                    machine={{
                        ...machine,
                        metadata: { ...machine.metadata!, host: 'proxmox', platform: 'linux' },
                    }}
                    healthPresentation={{
                        metrics: [
                            { id: 'cpu', shortLabel: 'CPU', percent: 12, tone: 'ok' },
                            { id: 'ram', shortLabel: 'RAM', percent: 40, tone: 'ok' },
                        ],
                        overallTone: 'ok',
                        status: 'healthy',
                        uptimeDetail: '1h 54m',
                    }}
                />
            </I18nProvider>
        )

        expect(screen.getByTitle('proxmox')).toBeTruthy()
        expect(screen.getByText('1h 54m')).toBeTruthy()
    })
})
