import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { EditorFileTree } from './EditorFileTree'

const useProjectDirectoryMock = vi.fn()

vi.mock('@/hooks/queries/useProjectDirectory', () => ({
    useProjectDirectory: (...args: unknown[]) => useProjectDirectoryMock(...args)
}))

describe('EditorFileTree', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        useProjectDirectoryMock.mockImplementation((_api, _machineId, path) => {
            if (path === '/repo') {
                return {
                    entries: [
                        { name: 'src', type: 'directory' },
                        { name: 'README.md', type: 'file', gitStatus: 'modified' }
                    ],
                    isLoading: false,
                    error: null,
                    refetch: vi.fn()
                }
            }
            if (path === '/repo/src') {
                return {
                    entries: [
                        { name: 'App.tsx', type: 'file', gitStatus: 'added' }
                    ],
                    isLoading: false,
                    error: null,
                    refetch: vi.fn()
                }
            }
            return { entries: [], isLoading: false, error: null, refetch: vi.fn() }
        })
    })

    afterEach(() => {
        cleanup()
    })

    it('prompts for machine and project before browsing', () => {
        render(
            <EditorFileTree
                api={null}
                machineId={null}
                projectPath={null}
                onOpenFile={vi.fn()}
                onContextMenu={vi.fn()}
            />
        )

        expect(screen.getByText('Select a machine and project to browse files')).toBeInTheDocument()
        expect(useProjectDirectoryMock).not.toHaveBeenCalled()
    })

    it('renders project root expanded by default', () => {
        const api = {} as ApiClient
        render(
            <EditorFileTree
                api={api}
                machineId="machine-1"
                projectPath="/repo"
                onOpenFile={vi.fn()}
                onContextMenu={vi.fn()}
            />
        )

        expect(screen.getAllByText('repo').length).toBeGreaterThan(0)
        expect(screen.getByText('README.md')).toBeInTheDocument()
        expect(screen.getByText('src')).toBeInTheDocument()
        expect(useProjectDirectoryMock).toHaveBeenCalledWith(api, 'machine-1', '/repo')
    })

    it('opens files and nested directory files', () => {
        const onOpenFile = vi.fn()
        render(
            <EditorFileTree
                api={{} as ApiClient}
                machineId="machine-1"
                projectPath="/repo"
                onOpenFile={onOpenFile}
                onContextMenu={vi.fn()}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Open file README.md' }))
        expect(onOpenFile).toHaveBeenCalledWith('/repo/README.md')

        fireEvent.click(screen.getByRole('button', { name: 'Toggle directory src' }))
        fireEvent.click(screen.getByRole('button', { name: 'Open file App.tsx' }))
        expect(onOpenFile).toHaveBeenCalledWith('/repo/src/App.tsx')
    })

    it('shows git status dots and reports context menu coordinates', () => {
        const onContextMenu = vi.fn()
        render(
            <EditorFileTree
                api={{} as ApiClient}
                machineId="machine-1"
                projectPath="/repo"
                onOpenFile={vi.fn()}
                onContextMenu={onContextMenu}
            />
        )

        expect(screen.getByTitle('modified')).toBeInTheDocument()

        fireEvent.contextMenu(screen.getByRole('button', { name: 'Open file README.md' }), {
            clientX: 12,
            clientY: 34
        })

        expect(onContextMenu).toHaveBeenCalledWith('/repo/README.md', 12, 34)
    })

    it('creates a nested file from an inline input under a folder target', async () => {
        const onCreateFile = vi.fn(async () => ({ success: true, path: '/repo/src/components/Button.tsx' }))
        render(
            <EditorFileTree
                api={{} as ApiClient}
                machineId="machine-1"
                projectPath="/repo"
                newFileTargetPath="/repo/src"
                onOpenFile={vi.fn()}
                onContextMenu={vi.fn()}
                onCreateFile={onCreateFile}
                onCancelNewFile={vi.fn()}
            />
        )

        const input = screen.getByLabelText('New file name') as HTMLInputElement
        expect(screen.getByRole('button', { name: 'Toggle directory src' })).toBeInTheDocument()

        fireEvent.change(input, { target: { value: 'components/Button.tsx' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() => {
            expect(onCreateFile).toHaveBeenCalledWith('/repo/src', 'components/Button.tsx')
        })
    })

    it('creates a sibling file when the new-file target is a file', async () => {
        const onCreateFile = vi.fn(async () => ({ success: true, path: '/repo/CHANGELOG.md' }))
        render(
            <EditorFileTree
                api={{} as ApiClient}
                machineId="machine-1"
                projectPath="/repo"
                newFileTargetPath="/repo/README.md"
                onOpenFile={vi.fn()}
                onContextMenu={vi.fn()}
                onCreateFile={onCreateFile}
                onCancelNewFile={vi.fn()}
            />
        )

        const input = screen.getByLabelText('New file name') as HTMLInputElement
        fireEvent.change(input, { target: { value: 'CHANGELOG.md' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() => {
            expect(onCreateFile).toHaveBeenCalledWith('/repo', 'CHANGELOG.md')
        })
    })

    it('cancels inline new-file input on Escape and blur', () => {
        const onCancelNewFile = vi.fn()
        const { rerender } = render(
            <EditorFileTree
                api={{} as ApiClient}
                machineId="machine-1"
                projectPath="/repo"
                newFileTargetPath="/repo"
                onOpenFile={vi.fn()}
                onContextMenu={vi.fn()}
                onCreateFile={vi.fn()}
                onCancelNewFile={onCancelNewFile}
            />
        )

        fireEvent.keyDown(screen.getByLabelText('New file name'), { key: 'Escape' })
        expect(onCancelNewFile).toHaveBeenCalledTimes(1)

        rerender(
            <EditorFileTree
                api={{} as ApiClient}
                machineId="machine-1"
                projectPath="/repo"
                newFileTargetPath="/repo"
                onOpenFile={vi.fn()}
                onContextMenu={vi.fn()}
                onCreateFile={vi.fn()}
                onCancelNewFile={onCancelNewFile}
            />
        )
        fireEvent.blur(screen.getByLabelText('New file name'))
        expect(onCancelNewFile).toHaveBeenCalledTimes(2)
    })

    it('rejects absolute and parent-relative new file paths', async () => {
        const onCreateFile = vi.fn()
        render(
            <EditorFileTree
                api={{} as ApiClient}
                machineId="machine-1"
                projectPath="/repo"
                newFileTargetPath="/repo"
                onOpenFile={vi.fn()}
                onContextMenu={vi.fn()}
                onCreateFile={onCreateFile}
                onCancelNewFile={vi.fn()}
            />
        )

        const input = screen.getByLabelText('New file name') as HTMLInputElement
        fireEvent.change(input, { target: { value: '/tmp/evil.ts' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(await screen.findByText('Use a relative path inside this folder')).toBeInTheDocument()

        fireEvent.change(input, { target: { value: '../evil.ts' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(await screen.findByText('Parent directory segments are not allowed')).toBeInTheDocument()
        expect(onCreateFile).not.toHaveBeenCalled()
    })
})
