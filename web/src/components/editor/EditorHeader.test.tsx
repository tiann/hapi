import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
                onBrowseProject={vi.fn()}
            />
        )

        expect(screen.getByText('⚡ HAPI Editor')).toBeInTheDocument()
        const machineSelect = screen.getByLabelText('Machine')
        expect(screen.getByRole('option', { name: '🖥 Dev Box' })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: '🖥 server-box' })).toBeInTheDocument()

        fireEvent.change(machineSelect, { target: { value: 'machine-2' } })

        expect(onSelectMachine).toHaveBeenCalledWith('machine-2')
    })

    it('renders a folder browser trigger for the selected project', () => {
        const onBrowseProject = vi.fn()
        const api = { listEditorProjects: vi.fn() } as unknown as ApiClient

        render(
            <EditorHeader
                api={api}
                machineId="machine-1"
                projectPath="/repo-a"
                onSelectMachine={vi.fn()}
                onSelectProject={vi.fn()}
                onBrowseProject={onBrowseProject}
            />
        )

        const browseButton = screen.getByRole('button', { name: 'Browse project folder' })
        expect(browseButton).toHaveTextContent('repo-a')
        expect(browseButton).toHaveTextContent('/repo-a')
        expect(api.listEditorProjects).not.toHaveBeenCalled()

        fireEvent.click(browseButton)

        expect(onBrowseProject).toHaveBeenCalled()
    })

    it('hides project browser when no machine is selected', () => {
        const api = { listEditorProjects: vi.fn() } as unknown as ApiClient

        render(
            <EditorHeader
                api={api}
                machineId={null}
                projectPath={null}
                onSelectMachine={vi.fn()}
                onSelectProject={vi.fn()}
                onBrowseProject={vi.fn()}
            />
        )

        expect(screen.queryByRole('button', { name: 'Browse project folder' })).not.toBeInTheDocument()
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
                onBrowseProject={vi.fn()}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: '← Agent Mode' }))

        expect(navigateMock).toHaveBeenCalledWith({ to: '/sessions' })
    })
})
