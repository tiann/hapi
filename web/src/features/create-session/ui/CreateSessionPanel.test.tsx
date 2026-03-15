import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { CreateSessionPanel } from './CreateSessionPanel'

vi.mock('@/entities/machine', () => ({
    useMachines: vi.fn()
}))

vi.mock('@/entities/session', () => ({
    useSpawnSession: vi.fn()
}))

vi.mock('@/entities/session/ui', () => ({
    NewSession: ({ machines, isLoading, onSuccess }: {
        machines: unknown[]
        isLoading: boolean
        onSuccess: (id: string) => void
    }) => (
        <div data-testid="new-session">
            <div>Machines: {machines.length}</div>
            <div>Loading: {isLoading ? 'yes' : 'no'}</div>
            <button onClick={() => onSuccess('test-session-id')}>Create</button>
        </div>
    )
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key
    })
}))

import { useMachines } from '@/entities/machine'
import { useSpawnSession } from '@/entities/session'

describe('CreateSessionPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        cleanup()
    })

    it('renders error message when api is null', () => {
        vi.mocked(useMachines).mockReturnValue({
            machines: [],
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })

        vi.mocked(useSpawnSession).mockReturnValue({
            spawnSession: vi.fn(),
            isPending: false,
            error: null
        })

        render(
            <CreateSessionPanel
                api={null}
                onCreate={vi.fn()}
            />
        )

        expect(screen.getByText('error.apiUnavailable')).toBeInTheDocument()
    })

    it('renders NewSession component when api is available', () => {
        const mockApi = {} as any

        vi.mocked(useMachines).mockReturnValue({
            machines: [{ id: 'machine-1', name: 'Test Machine' }],
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })

        vi.mocked(useSpawnSession).mockReturnValue({
            spawnSession: vi.fn(),
            isPending: false,
            error: null
        })

        render(
            <CreateSessionPanel
                api={mockApi}
                onCreate={vi.fn()}
            />
        )

        expect(screen.getByTestId('new-session')).toBeInTheDocument()
    })

    it('passes machines to NewSession component', () => {
        const mockApi = {} as any
        const mockMachines = [
            { id: 'machine-1', name: 'Machine 1' },
            { id: 'machine-2', name: 'Machine 2' }
        ]

        vi.mocked(useMachines).mockReturnValue({
            machines: mockMachines,
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })

        vi.mocked(useSpawnSession).mockReturnValue({
            spawnSession: vi.fn(),
            isPending: false,
            error: null
        })

        render(
            <CreateSessionPanel
                api={mockApi}
                onCreate={vi.fn()}
            />
        )

        expect(screen.getByText('Machines: 2')).toBeInTheDocument()
    })

    it('passes loading state to NewSession component', () => {
        const mockApi = {} as any

        vi.mocked(useMachines).mockReturnValue({
            machines: [],
            isLoading: true,
            error: null,
            refetch: vi.fn()
        })

        vi.mocked(useSpawnSession).mockReturnValue({
            spawnSession: vi.fn(),
            isPending: false,
            error: null
        })

        render(
            <CreateSessionPanel
                api={mockApi}
                onCreate={vi.fn()}
            />
        )

        expect(screen.getByText('Loading: yes')).toBeInTheDocument()
    })

    it('calls useMachines with autoRefresh true', () => {
        const mockApi = {} as any
        const useMachinesMock = vi.mocked(useMachines)

        useMachinesMock.mockReturnValue({
            machines: [],
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })

        vi.mocked(useSpawnSession).mockReturnValue({
            spawnSession: vi.fn(),
            isPending: false,
            error: null
        })

        render(
            <CreateSessionPanel
                api={mockApi}
                onCreate={vi.fn()}
            />
        )

        expect(useMachinesMock).toHaveBeenCalledWith(mockApi, true)
    })

    it('calls useSpawnSession with api', () => {
        const mockApi = {} as any
        const useSpawnSessionMock = vi.mocked(useSpawnSession)

        vi.mocked(useMachines).mockReturnValue({
            machines: [],
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })

        useSpawnSessionMock.mockReturnValue({
            spawnSession: vi.fn(),
            isPending: false,
            error: null
        })

        render(
            <CreateSessionPanel
                api={mockApi}
                onCreate={vi.fn()}
            />
        )

        expect(useSpawnSessionMock).toHaveBeenCalledWith(mockApi)
    })
})
