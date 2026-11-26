import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { ToastContainer } from '@/components/ToastContainer'
import { DEFAULT_DIRECTORY_SORT } from '@/lib/directory-sort'
import { DirectoryTree } from '@/components/SessionFiles/DirectoryTree'

const mocks = vi.hoisted(() => ({
    entries: [
        { name: 'README.md', type: 'file' as const, size: 12, modified: 1_784_175_060_000 },
        { name: 'src', type: 'directory' as const },
    ] as Array<{ name: string; type: 'file' | 'directory'; size?: number; modified?: number }>,
}))

vi.mock('@/hooks/queries/useSessionDirectory', () => ({
    useSessionDirectory: () => ({
        entries: mocks.entries,
        error: null,
        isLoading: false,
        refetch: vi.fn(),
    }),
}))

function renderTree(handlers: {
    onOpenFile?: () => void
    onRequestFileMenu?: (path: string, point: { x: number; y: number }) => void
    api?: unknown
    onAddToComposer?: (path: string) => void
} = {}) {
    const onOpenFile = handlers.onOpenFile ?? vi.fn()
    const onRequestFileMenu = handlers.onRequestFileMenu ?? vi.fn()
    const queryClient = new QueryClient()

    render(
        <QueryClientProvider client={queryClient}>
        <I18nProvider>
            <ToastProvider>
                <DirectoryTree
                    api={(handlers.api ?? {}) as never}
                    sessionId="session-1"
                    rootLabel="project"
                    onOpenFile={onOpenFile}
                    onRequestFileMenu={onRequestFileMenu}
                    onAddToComposer={handlers.onAddToComposer}
                    sort={DEFAULT_DIRECTORY_SORT}
                />
                <ToastContainer />
            </ToastProvider>
        </I18nProvider>
        </QueryClientProvider>
    )

    return { onOpenFile, onRequestFileMenu, queryClient }
}

/** The file name button (a directory row's download button also mentions the name in its aria-label). */
function fileRow(): HTMLButtonElement {
    return screen.getByText('README.md').closest('button') as HTMLButtonElement
}

beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
})

afterEach(() => cleanup())

describe('DirectoryTree file context menu', () => {
    it('requests the menu on right-click with the entry path and pointer', () => {
        const { onRequestFileMenu } = renderTree()

        fireEvent.contextMenu(fileRow(), { clientX: 321, clientY: 123 })

        expect(onRequestFileMenu).toHaveBeenCalledWith('README.md', { x: 321, y: 123 })
    })

    it('requests the menu on touch long-press and does not open the file on release', () => {
        vi.useFakeTimers()
        try {
            const { onOpenFile, onRequestFileMenu } = renderTree()

            fireEvent.touchStart(fileRow(), { touches: [{ clientX: 44, clientY: 55 }] })
            act(() => {
                vi.advanceTimersByTime(600)
            })

            expect(onRequestFileMenu).toHaveBeenCalledWith('README.md', { x: 44, y: 55 })
            expect(onOpenFile).not.toHaveBeenCalled()

            fireEvent.touchEnd(fileRow(), { changedTouches: [{ clientX: 44, clientY: 55 }] })
            expect(onOpenFile).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('DirectoryTree upload and delete', () => {
    it('asks before deleting a file and calls the runner delete on confirm', async () => {
        const deleteWorkspacePath = vi.fn(async () => ({ success: true }))
        renderTree({ api: { deleteWorkspacePath } })

        fireEvent.click(screen.getByRole('button', { name: 'Delete README.md' }))
        expect(deleteWorkspacePath).not.toHaveBeenCalled()
        expect(await screen.findByText('Delete file?')).toBeTruthy()

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        await waitFor(() => expect(deleteWorkspacePath).toHaveBeenCalledWith('session-1', { path: 'README.md', kind: 'file' }))
    })

    it('sends the confirmed folder kind and refreshes the parent when the entry has changed', async () => {
        const deleteWorkspacePath = vi.fn().mockResolvedValue({
            success: false, code: 'kind_mismatch', error: 'Entry is no longer a directory.',
        })
        const { queryClient } = renderTree({ api: { deleteWorkspacePath } })
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
        fireEvent.click(screen.getByRole('button', { name: 'Delete src' }))
        expect(await screen.findByText('Delete folder?')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

        expect(await screen.findByText('Entry is no longer a directory.')).toBeTruthy()
        expect(deleteWorkspacePath).toHaveBeenCalledWith('session-1', { path: 'src', kind: 'directory' })
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session-directory', 'session-1', ''] })
    })

    it('does not delete when the confirmation is cancelled', async () => {
        const deleteWorkspacePath = vi.fn(async () => ({ success: true }))
        renderTree({ api: { deleteWorkspacePath } })

        fireEvent.click(screen.getByRole('button', { name: 'Delete src' }))
        expect(await screen.findByText('Delete folder?')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

        await waitFor(() => expect(screen.queryByText('Delete folder?')).toBeNull())
        expect(deleteWorkspacePath).not.toHaveBeenCalled()
    })

    it('offers upload on folders (including the root) but delete only below the root', () => {
        renderTree()
        expect(screen.getByRole('button', { name: 'Upload files to project' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Upload files to src' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Delete project' })).toBeNull()
    })

    it('uploads into the clicked folder and asks before replacing an existing file', async () => {
        const uploadWorkspaceFileChunk = vi.fn()
            .mockResolvedValueOnce({ success: false, code: 'exists', error: 'exists' })
            .mockResolvedValueOnce({ success: true, size: 5, path: 'src/a.txt' })
        renderTree({ api: { uploadWorkspaceFileChunk } })

        fireEvent.click(screen.getByRole('button', { name: 'Upload files to src' }))
        const input = screen.getByTestId('workspace-upload-input') as HTMLInputElement
        fireEvent.change(input, { target: { files: [new File(['hello'], 'a.txt')] } })

        expect(await screen.findByText('Replace existing file?')).toBeTruthy()
        expect(uploadWorkspaceFileChunk).toHaveBeenCalledTimes(1)
        expect(uploadWorkspaceFileChunk.mock.calls[0][1]).toMatchObject({ dir: 'src', name: 'a.txt', overwrite: false, final: true })

        fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
        await waitFor(() => expect(uploadWorkspaceFileChunk).toHaveBeenCalledTimes(2))
        expect(uploadWorkspaceFileChunk.mock.calls[1][1]).toMatchObject({ dir: 'src', name: 'a.txt', overwrite: true })
    })
})

describe('DirectoryTree upload and delete serialization', () => {
    it('keeps delete unavailable while an upload batch is running', async () => {
        let finishChunk: (value: unknown) => void = () => {}
        const uploadWorkspaceFileChunk = vi.fn(() => new Promise((resolve) => { finishChunk = resolve }))
        const deleteWorkspacePath = vi.fn(async () => ({ success: true }))
        renderTree({ api: { uploadWorkspaceFileChunk, deleteWorkspacePath } })

        fireEvent.click(screen.getByRole('button', { name: 'Upload files to src' }))
        fireEvent.change(screen.getByTestId('workspace-upload-input'), { target: { files: [new File(['hello'], 'a.txt')] } })
        await waitFor(() => expect(uploadWorkspaceFileChunk).toHaveBeenCalledTimes(1))

        // The mocked listing repeats for every folder, so the expanded `src` shows the same rows.
        const deleteButtons = () => [
            ...screen.getAllByRole('button', { name: 'Delete README.md' }),
            ...screen.getAllByRole('button', { name: 'Delete src' }),
        ] as HTMLButtonElement[]
        expect(deleteButtons().every((button) => button.disabled)).toBe(true)
        fireEvent.click(deleteButtons()[0]!)
        expect(screen.queryByText('Delete file?')).toBeNull()

        finishChunk({ success: true, size: 5, path: 'src/a.txt' })
        await waitFor(() => expect(deleteButtons().every((button) => !button.disabled)).toBe(true))
        expect(deleteWorkspacePath).not.toHaveBeenCalled()
    })
})

describe('DirectoryTree upload after leaving the tree', () => {
    it('settles a pending replace prompt and reports the skipped files when the tree unmounts', async () => {
        const uploadWorkspaceFileChunk = vi.fn().mockResolvedValue({ success: false, code: 'exists', error: 'exists' })
        const queryClient = new QueryClient()
        const view = (showTree: boolean) => (
            <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <ToastProvider>
                    {showTree ? (
                        <DirectoryTree
                            api={{ uploadWorkspaceFileChunk } as never}
                            sessionId="session-1"
                            rootLabel="project"
                            onOpenFile={vi.fn()}
                            sort={DEFAULT_DIRECTORY_SORT}
                        />
                    ) : null}
                    <ToastContainer />
                </ToastProvider>
            </I18nProvider>
            </QueryClientProvider>
        )
        const { rerender } = render(view(true))

        fireEvent.click(screen.getByRole('button', { name: 'Upload files to src' }))
        fireEvent.change(screen.getByTestId('workspace-upload-input'), {
            target: { files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')] },
        })
        expect(await screen.findByText('Replace existing file?')).toBeTruthy()

        rerender(view(false))

        expect(await screen.findByText('Upload stopped')).toBeTruthy()
        expect(screen.getByText(/a\.txt, b\.txt/)).toBeTruthy()
        expect(uploadWorkspaceFileChunk).toHaveBeenCalledTimes(1)
    })
})

describe('DirectoryTree add to composer', () => {
    it('adds files by path and folders with a trailing slash, but not the root', () => {
        const onAddToComposer = vi.fn()
        renderTree({ onAddToComposer })

        fireEvent.click(screen.getByRole('button', { name: 'Add README.md to composer' }))
        fireEvent.click(screen.getByRole('button', { name: 'Add src to composer' }))

        expect(onAddToComposer.mock.calls).toEqual([['README.md'], ['src/']])
        expect(screen.queryByRole('button', { name: 'Add project to composer' })).toBeNull()
    })
})

describe('DirectoryTree upload progress', () => {
    function deferred<T>() {
        let resolve!: (value: T) => void
        const promise = new Promise<T>((r) => { resolve = r })
        return { promise, resolve }
    }

    it('shows the file in its folder with a progress bar, then confirms success', async () => {
        const firstChunk = deferred<{ success: boolean; size?: number }>()
        const uploadWorkspaceFileChunk = vi.fn()
            .mockImplementationOnce(() => firstChunk.promise)
            .mockResolvedValueOnce({ success: true, size: 1_500_000, path: 'src/big.bin' })
        renderTree({ api: { uploadWorkspaceFileChunk } })

        fireEvent.click(screen.getByRole('button', { name: 'Upload files to project' }))
        const input = screen.getByTestId('workspace-upload-input') as HTMLInputElement
        fireEvent.change(input, { target: { files: [new File([new Uint8Array(1_500_000)], 'big.bin')] } })

        const row = await screen.findByTestId('pending-upload-row')
        expect(row.textContent).toContain('big.bin')
        expect(screen.getByRole('progressbar', { name: 'big.bin' }).getAttribute('aria-valuenow')).toBe('0')

        await act(async () => firstChunk.resolve({ success: true, size: 1_048_576 }))
        await waitFor(() => expect(
            Number(screen.queryByRole('progressbar', { name: 'big.bin' })?.getAttribute('aria-valuenow') ?? 100)
        ).toBeGreaterThan(0))

        expect(await screen.findByText('Upload complete')).toBeTruthy()
        expect(screen.getByText('Uploaded big.bin to project')).toBeTruthy()
        expect(screen.queryByTestId('pending-upload-row')).toBeNull()
        expect(uploadWorkspaceFileChunk).toHaveBeenCalledTimes(2)
    })

    it('aborts the partial upload when the hub rejects a later chunk', async () => {
        const uploadWorkspaceFileChunk = vi.fn()
            .mockResolvedValueOnce({ success: true, size: 1_048_576 })
            .mockRejectedValueOnce(new Error('File exceeds the upload limit'))
        const abortWorkspaceUpload = vi.fn().mockResolvedValue({ success: true })
        renderTree({ api: { uploadWorkspaceFileChunk, abortWorkspaceUpload } })

        fireEvent.click(screen.getByRole('button', { name: 'Upload files to project' }))
        const file = new File([new Uint8Array(1_048_577)], 'large.bin')
        fireEvent.change(screen.getByTestId('workspace-upload-input'), { target: { files: [file] } })

        expect(await screen.findByText('File exceeds the upload limit')).toBeTruthy()
        expect(abortWorkspaceUpload).toHaveBeenCalledWith('session-1', {
            dir: '', name: file.name, uploadId: uploadWorkspaceFileChunk.mock.calls[0][1].uploadId,
        })
        expect(screen.queryByTestId('pending-upload-row')).toBeNull()
    })

    it('drops the row and reports the failure when the upload fails', async () => {
        const uploadWorkspaceFileChunk = vi.fn().mockResolvedValue({ success: false, error: 'Disk full' })
        renderTree({ api: { uploadWorkspaceFileChunk } })

        fireEvent.click(screen.getByRole('button', { name: 'Upload files to project' }))
        const input = screen.getByTestId('workspace-upload-input') as HTMLInputElement
        fireEvent.change(input, { target: { files: [new File(['x'], 'bad.txt')] } })

        expect(await screen.findByText('Failed to upload bad.txt')).toBeTruthy()
        expect(screen.getByText('Disk full')).toBeTruthy()
        expect(screen.queryByTestId('pending-upload-row')).toBeNull()
        expect(screen.queryByText('Upload complete')).toBeNull()
    })
})
