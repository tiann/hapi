import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionFilesPanel } from './SessionFilesPanel'

const useSessionDirectoryMock = vi.fn()

vi.mock('@/components/FileIcon', () => ({
    FileIcon: ({ fileName }: { fileName: string }) => <div data-testid="file-icon">{fileName}</div>
}))

vi.mock('@/hooks/queries/useSessionDirectory', () => ({
    useSessionDirectory: (api: any, sessionId: string, path: string, options: any) => useSessionDirectoryMock(api, sessionId, path, options)
}))

describe('SessionFilesPanel', () => {
    beforeEach(() => {
        useSessionDirectoryMock.mockImplementation((api, sessionId, path, options) => {
            if (!options?.enabled) {
                return { entries: [], error: null, isLoading: false }
            }

            if (path === '') {
                return {
                    entries: [
                        { name: 'src', type: 'directory' },
                        { name: 'README.md', type: 'file' }
                    ],
                    error: null,
                    isLoading: false
                }
            }

            if (path === 'src') {
                return {
                    entries: [
                        { name: 'index.ts', type: 'file' },
                        { name: 'utils.ts', type: 'file' }
                    ],
                    error: null,
                    isLoading: false
                }
            }

            return { entries: [], error: null, isLoading: false }
        })
    })

    it('renders root directory', () => {
        render(
            <SessionFilesPanel
                api={null}
                sessionId="session-1"
                rootLabel="Project Root"
                onOpenFile={vi.fn()}
            />
        )

        expect(screen.getByText('Project Root')).toBeInTheDocument()
    })

    it('shows files and directories when expanded', () => {
        render(
            <SessionFilesPanel
                api={null}
                sessionId="session-1"
                rootLabel="Project Root"
                onOpenFile={vi.fn()}
            />
        )

        const srcElements = screen.getAllByText('src')
        expect(srcElements.length).toBeGreaterThan(0)
        const readmeElements = screen.getAllByText('README.md')
        expect(readmeElements.length).toBeGreaterThan(0)
    })

    it('expands subdirectory when clicked', () => {
        const { container } = render(
            <SessionFilesPanel
                api={null}
                sessionId="session-1"
                rootLabel="Project Root"
                onOpenFile={vi.fn()}
            />
        )

        const buttons = container.querySelectorAll('button')
        const srcButton = Array.from(buttons).find(btn => {
            const text = btn.textContent || ''
            return text.includes('src') && !text.includes('Project')
        })
        expect(srcButton).toBeTruthy()

        fireEvent.click(srcButton as Element)

        expect(container.textContent).toContain('index.ts')
        expect(container.textContent).toContain('utils.ts')
    })

    it('calls onOpenFile when file is clicked', () => {
        const onOpenFile = vi.fn()
        const { container } = render(
            <SessionFilesPanel
                api={null}
                sessionId="session-1"
                rootLabel="Project Root"
                onOpenFile={onOpenFile}
            />
        )

        const buttons = container.querySelectorAll('button')
        const readmeButton = Array.from(buttons).find(btn => {
            const text = btn.textContent || ''
            return text.trim() === 'README.md' || text.includes('README.md')
        })
        expect(readmeButton).toBeTruthy()

        fireEvent.click(readmeButton as Element)

        expect(onOpenFile).toHaveBeenCalledWith('README.md')
    })

    it('collapses directory when clicked again', () => {
        const { container } = render(
            <SessionFilesPanel
                api={null}
                sessionId="session-1"
                rootLabel="Project Root"
                onOpenFile={vi.fn()}
            />
        )

        const buttons = container.querySelectorAll('button')
        const rootButton = Array.from(buttons).find(btn => btn.textContent?.includes('Project Root'))
        expect(rootButton).toBeTruthy()

        // Collapse
        fireEvent.click(rootButton as Element)
        expect(container.textContent).not.toContain('src')

        // Expand again
        fireEvent.click(rootButton as Element)
        expect(container.textContent).toContain('src')
    })

    it('shows loading state for subdirectory', () => {
        useSessionDirectoryMock.mockImplementation((api, sessionId, path, options) => {
            if (path === 'loading-dir' && options?.enabled) {
                return { entries: [], error: null, isLoading: true }
            }
            if (path === '') {
                return {
                    entries: [{ name: 'loading-dir', type: 'directory' }],
                    error: null,
                    isLoading: false
                }
            }
            return { entries: [], error: null, isLoading: false }
        })

        render(
            <SessionFilesPanel
                api={null}
                sessionId="session-1"
                rootLabel="Project Root"
                onOpenFile={vi.fn()}
            />
        )

        const loadingDirButton = screen.getByText('loading-dir').closest('button')
        fireEvent.click(loadingDirButton as Element)

        expect(screen.getByText('loading-dir')).toBeInTheDocument()
    })

    it('shows error state for subdirectory', () => {
        useSessionDirectoryMock.mockImplementation((api, sessionId, path, options) => {
            if (path === 'error-dir' && options?.enabled) {
                return { entries: [], error: 'Failed to load directory', isLoading: false }
            }
            if (path === '') {
                return {
                    entries: [{ name: 'error-dir', type: 'directory' }],
                    error: null,
                    isLoading: false
                }
            }
            return { entries: [], error: null, isLoading: false }
        })

        render(
            <SessionFilesPanel
                api={null}
                sessionId="session-1"
                rootLabel="Project Root"
                onOpenFile={vi.fn()}
            />
        )

        const errorDirButton = screen.getByText('error-dir').closest('button')
        fireEvent.click(errorDirButton as Element)

        expect(screen.getByText('Failed to load directory')).toBeInTheDocument()
    })
})
