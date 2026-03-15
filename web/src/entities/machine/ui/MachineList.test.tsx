import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MachineList } from './MachineList'
import type { Machine } from '../model/types'

// Mock translation hook
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => {
            const translations: Record<string, string> = {
                'misc.online': 'online',
            }
            return translations[key] || key
        },
    }),
}))

describe('MachineList', () => {
    const mockMachines: Machine[] = [
        {
            id: 'machine-1',
            active: true,
            metadata: {
                host: 'localhost',
                platform: 'linux',
                happyCliVersion: '1.0.0',
                displayName: 'My Laptop',
            },
        },
        {
            id: 'machine-2',
            active: true,
            metadata: {
                host: 'remote-server',
                platform: 'darwin',
                happyCliVersion: '1.0.0',
            },
        },
    ]

    it('renders list of machines', () => {
        const onSelect = vi.fn()
        render(<MachineList machines={mockMachines} onSelect={onSelect} />)

        expect(screen.getAllByText(/My Laptop/i)[0]).toBeInTheDocument()
        expect(screen.getAllByText(/remote-server/i)[0]).toBeInTheDocument()
    })

    it('displays machine count', () => {
        const onSelect = vi.fn()
        render(<MachineList machines={mockMachines} onSelect={onSelect} />)

        expect(screen.getAllByText('2 online')[0]).toBeInTheDocument()
    })

    it('calls onSelect when machine is clicked', () => {
        const onSelect = vi.fn()
        const { container } = render(<MachineList machines={mockMachines} onSelect={onSelect} />)

        const machineCards = container.querySelectorAll('.cursor-pointer')
        machineCards[0]?.click()

        expect(onSelect).toHaveBeenCalledWith('machine-1')
    })

    it('renders empty list', () => {
        const onSelect = vi.fn()
        render(<MachineList machines={[]} onSelect={onSelect} />)

        expect(screen.getByText('0 online')).toBeInTheDocument()
    })

    it('displays machine without displayName using host', () => {
        const machines: Machine[] = [
            {
                id: 'machine-3',
                active: true,
                metadata: {
                    host: 'server-123',
                    platform: 'linux',
                    happyCliVersion: '1.0.0',
                },
            },
        ]

        const onSelect = vi.fn()
        render(<MachineList machines={machines} onSelect={onSelect} />)

        expect(screen.getAllByText(/server-123/i)[0]).toBeInTheDocument()
    })

    it('handles machine with null metadata', () => {
        const machines: Machine[] = [
            {
                id: 'machine-4',
                active: true,
                metadata: null,
            },
        ]

        const onSelect = vi.fn()
        const { container } = render(<MachineList machines={machines} onSelect={onSelect} />)

        // Should display machine ID prefix when no metadata (first 8 chars)
        expect(container.textContent).toContain('machine-')
    })
})
