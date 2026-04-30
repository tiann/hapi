import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

    it('renders project root and lazy-loads children when expanded', () => {
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
        expect(screen.queryByText('README.md')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Toggle directory repo' }))

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

        fireEvent.click(screen.getByRole('button', { name: 'Toggle directory repo' }))
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

        fireEvent.click(screen.getByRole('button', { name: 'Toggle directory repo' }))
        expect(screen.getByTitle('modified')).toBeInTheDocument()

        fireEvent.contextMenu(screen.getByRole('button', { name: 'Open file README.md' }), {
            clientX: 12,
            clientY: 34
        })

        expect(onContextMenu).toHaveBeenCalledWith('/repo/README.md', 12, 34)
    })
})
