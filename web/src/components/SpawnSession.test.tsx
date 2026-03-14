import React from 'react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SpawnSession } from './SpawnSession'
import type { Machine } from '@/types/api'
import type { ApiClient } from '@/api/client'

// Clean up after each test
afterEach(() => {
    cleanup()
})

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: {
            notification: vi.fn(),
        },
    }),
}))

vi.mock('@/hooks/mutations/useSpawnSession', () => ({
    useSpawnSession: () => ({
        spawnSession: vi.fn(),
        isPending: false,
        error: null,
    }),
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => {
            const map: Record<string, string> = {
                'spawn.title': 'Create Session',
                'spawn.directory': 'Directory',
                'spawn.cancel': 'Cancel',
                'spawn.create': 'Create',
                'spawn.creating': 'Creating...',
                'misc.machine': 'Machine',
                'newSession.placeholder': 'Enter directory path',
            }
            return map[key] || key
        },
    }),
}))

vi.mock('@/components/ui/button', () => ({
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

vi.mock('@/components/ui/card', () => ({
    Card: ({ children }: any) => <div>{children}</div>,
    CardContent: ({ children }: any) => <div>{children}</div>,
    CardDescription: ({ children }: any) => <div>{children}</div>,
    CardHeader: ({ children }: any) => <div>{children}</div>,
    CardTitle: ({ children }: any) => <h2>{children}</h2>,
}))

vi.mock('@/components/ui/input', () => ({
    Input: (props: any) => <input {...props} />,
}))

vi.mock('@/components/ui/label', () => ({
    Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}))

vi.mock('@/components/ui/radio-group', () => ({
    RadioGroup: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    RadioGroupItem: (props: any) => <input type="radio" {...props} />,
}))

vi.mock('@/components/HostBadge', () => ({
    HostBadge: () => null,
}))

vi.mock('@/utils/formatRunnerSpawnError', () => ({
    formatRunnerSpawnError: () => null,
}))

describe('SpawnSession', () => {
    const mockApi = {} as ApiClient
    const mockOnSuccess = vi.fn()
    const mockOnCancel = vi.fn()

    it('should use homeDir as default directory when machine has homeDir', () => {
        const machineWithHomeDir: Machine = {
            id: 'test-machine',
            active: true,
            metadata: {
                host: 'localhost',
                platform: 'linux',
                happyCliVersion: '1.0.0',
                homeDir: '/home/testuser',
            },
            runnerState: null,
        }

        render(
            <SpawnSession
                api={mockApi}
                machineId="test-machine"
                machine={machineWithHomeDir}
                onSuccess={mockOnSuccess}
                onCancel={mockOnCancel}
            />
        )

        const input = screen.getByPlaceholderText('Enter directory path') as HTMLInputElement
        expect(input.value).toBe('/home/testuser')
    })

    it('should use empty string as default directory when machine has no homeDir', () => {
        const machineWithoutHomeDir: Machine = {
            id: 'test-machine',
            active: true,
            metadata: {
                host: 'localhost',
                platform: 'linux',
                happyCliVersion: '1.0.0',
            },
            runnerState: null,
        }

        render(
            <SpawnSession
                api={mockApi}
                machineId="test-machine"
                machine={machineWithoutHomeDir}
                onSuccess={mockOnSuccess}
                onCancel={mockOnCancel}
            />
        )

        const input = screen.getByPlaceholderText('Enter directory path') as HTMLInputElement
        expect(input.value).toBe('')
    })

    it('should use empty string as default directory when machine is null', () => {
        render(
            <SpawnSession
                api={mockApi}
                machineId="test-machine"
                machine={null}
                onSuccess={mockOnSuccess}
                onCancel={mockOnCancel}
            />
        )

        const input = screen.getByPlaceholderText('Enter directory path') as HTMLInputElement
        expect(input.value).toBe('')
    })
})
