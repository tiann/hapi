import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { EditorHeader } from './EditorHeader'

const navigateMock = vi.fn()
const useMachinesMock = vi.fn()

vi.mock('@tanstack/react-router', async () => {
    const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
    return {
        ...actual,
        useNavigate: () => navigateMock
    }
})

vi.mock('@/hooks/queries/useMachines', () => ({
    useMachines: (...args: unknown[]) => useMachinesMock(...args)
}))

function createMachine(id: string, metadata: Partial<NonNullable<Machine['metadata']>>): Machine {
    return {
        id,
        active: true,
        metadata: {
            host: 'host',
            platform: 'linux',
            happyCliVersion: '0.1.0',
            ...metadata
        },
        runnerState: null
    }
}

describe('EditorHeader', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        useMachinesMock.mockReturnValue({
            machines: [
                createMachine('machine-1', { displayName: 'Dev Box' }),
                createMachine('machine-2', { host: 'server-box' })
            ],
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })
    })

    afterEach(() => {
        cleanup()
    })

    it('renders machine choices and notifies when machine changes', () => {
        const onSelectMachine = vi.fn()
        const api = { listEditorProjects: vi.fn() } as unknown as ApiClient

        render(
            <EditorHeader
                api={api}
                machineId={null}
                projectPath={null}
                onSelectMachine={onSelectMachine}
                onSelectProject={vi.fn()}
            />
        )

        expect(screen.getByText('⚡ HAPI Editor')).toBeInTheDocument()
        const machineSelect = screen.getByLabelText('Machine')
        expect(screen.getByRole('option', { name: '🖥 Dev Box' })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: '🖥 server-box' })).toBeInTheDocument()

        fireEvent.change(machineSelect, { target: { value: 'machine-2' } })

        expect(onSelectMachine).toHaveBeenCalledWith('machine-2')
    })

    it('loads projects for the selected machine and notifies when project changes', async () => {
        const onSelectProject = vi.fn()
        const api = {
            listEditorProjects: vi.fn(async () => ({
                success: true,
                projects: [
                    { path: '/repo-a', name: 'repo-a', hasGit: true },
                    { path: '/repo-b', name: 'repo-b', hasGit: false }
                ]
            }))
        } as unknown as ApiClient

        render(
            <EditorHeader
                api={api}
                machineId="machine-1"
                projectPath="/repo-a"
                onSelectMachine={vi.fn()}
                onSelectProject={onSelectProject}
            />
        )

        await waitFor(() => {
            expect(screen.getByRole('option', { name: '📁 repo-a' })).toBeInTheDocument()
        })
        expect(screen.getByRole('option', { name: '📂 repo-b' })).toBeInTheDocument()
        expect(api.listEditorProjects).toHaveBeenCalledWith('machine-1')

        fireEvent.change(screen.getByLabelText('Project'), { target: { value: '/repo-b' } })

        expect(onSelectProject).toHaveBeenCalledWith('/repo-b')
    })

    it('clears projects when no machine is selected', () => {
        const api = { listEditorProjects: vi.fn() } as unknown as ApiClient

        render(
            <EditorHeader
                api={api}
                machineId={null}
                projectPath={null}
                onSelectMachine={vi.fn()}
                onSelectProject={vi.fn()}
            />
        )

        expect(screen.queryByLabelText('Project')).not.toBeInTheDocument()
        expect(api.listEditorProjects).not.toHaveBeenCalled()
    })

    it('navigates back to Agent Mode', () => {
        const api = { listEditorProjects: vi.fn() } as unknown as ApiClient

        render(
            <EditorHeader
                api={api}
                machineId={null}
                projectPath={null}
                onSelectMachine={vi.fn()}
                onSelectProject={vi.fn()}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: '← Agent Mode' }))

        expect(navigateMock).toHaveBeenCalledWith({ to: '/sessions' })
    })
})
