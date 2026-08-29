import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { ApiClient } from '@/api/client'
import type { RecycleBinEntry } from '@/types/api'
import { RecycleBinDialog } from './RecycleBinDialog'

const entry: RecycleBinEntry = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'notes.md',
    originalPath: '/workspace/project/notes.md',
    type: 'file',
    size: 5,
    deletedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 14 * 24 * 60 * 60 * 1000,
}

function renderDialog(api: Partial<ApiClient>, onChanged = vi.fn()) {
    return render(
        <I18nProvider>
            <RecycleBinDialog
                api={api as ApiClient}
                sessionId="session-1"
                isOpen={true}
                onClose={vi.fn()}
                onChanged={onChanged}
            />
        </I18nProvider>
    )
}

describe('RecycleBinDialog', () => {
    beforeEach(() => {
        window.localStorage.clear()
        window.sessionStorage.clear()
    })

    it('lists entries, previews content, and offers all restore conflict choices', async () => {
        let currentEntries = [entry]
        const listRecycleBin = vi.fn(async () => ({
            success: true,
            entries: currentEntries,
            retentionDays: 14,
        }))
        const restoreRecycleBinEntry = vi.fn()
            .mockResolvedValueOnce({
                success: false,
                code: 'target_exists' as const,
                targetPath: entry.originalPath,
                error: 'The original restore target already exists',
            })
            .mockImplementationOnce(async () => {
                currentEntries = []
                return { success: true, restoredPath: '/workspace/project/notes (restored).md' }
            })
        const readRecycleBinEntry = vi.fn(async () => ({
            success: true,
            name: entry.name,
            content: 'aGVsbG8=',
            size: 5,
            modified: entry.deletedAt,
        }))
        const onChanged = vi.fn()

        renderDialog({ listRecycleBin, restoreRecycleBinEntry, readRecycleBinEntry }, onChanged)

        expect(await screen.findByText('notes.md')).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'HAPI Recycle Bin' })).toHaveClass('text-center')
        expect(screen.queryByText('Deleted files are kept locally for up to 14 days.')).not.toBeInTheDocument()
        const actionRow = screen.getByRole('button', { name: 'Preview' }).parentElement
        expect(actionRow).toHaveClass('grid', 'grid-cols-3', 'md:flex', 'md:flex-nowrap', 'md:justify-end')
        expect(screen.getByRole('button', { name: 'Preview' })).toHaveClass('w-full', 'min-w-0')
        expect(screen.getByRole('button', { name: 'Preview' })).toHaveClass('md:w-auto')
        expect(screen.getByRole('button', { name: 'Preview' }).querySelector('svg')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
        expect(await screen.findByText('hello')).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'notes.md' }).parentElement).toHaveClass('text-left')
        fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)

        fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
        expect(await screen.findByRole('heading', { name: 'Restore target already exists' })).toBeInTheDocument()
        expect(screen.getByRole('dialog')).toHaveTextContent(entry.originalPath)

        fireEvent.click(screen.getByRole('button', { name: 'Restore with a new name' }))
        await waitFor(() => {
            expect(restoreRecycleBinEntry).toHaveBeenNthCalledWith(2, 'session-1', entry.id, 'new-name')
            expect(onChanged).toHaveBeenCalled()
        })
        expect(screen.queryByText('notes.md')).not.toBeInTheDocument()
    })

    it('confirms permanent deletion and empty-bin actions', async () => {
        const secondEntry = { ...entry, id: '00000000-0000-4000-8000-000000000002', name: 'other.txt' }
        let currentEntries = [entry, secondEntry]
        const listRecycleBin = vi.fn(async () => ({ success: true, entries: currentEntries, retentionDays: 30 }))
        const purgeRecycleBinEntry = vi.fn(async () => {
            currentEntries = [secondEntry]
            return { success: true }
        })
        const emptyRecycleBin = vi.fn(async (_sessionId: string, _entryIds: string[]) => {
            currentEntries = []
            return { success: true, deletedCount: 1 }
        })

        renderDialog({ listRecycleBin, purgeRecycleBinEntry, emptyRecycleBin })
        expect(await screen.findByText('notes.md')).toBeInTheDocument()

        fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!)
        expect(await screen.findByRole('heading', { name: 'Delete file permanently?' })).toBeInTheDocument()
        const purgeConfirm = screen.getAllByRole('button', { name: 'Delete permanently' }).at(-1)
        expect(purgeConfirm).toBeDefined()
        fireEvent.click(purgeConfirm!)

        await waitFor(() => expect(purgeRecycleBinEntry).toHaveBeenCalledWith('session-1', entry.id))
        fireEvent.click(screen.getByRole('button', { name: 'Empty' }))
        expect(await screen.findByRole('heading', { name: 'Empty Recycle Bin?' })).toBeInTheDocument()
        const emptyConfirm = screen.getAllByRole('button', { name: 'Empty Recycle Bin' }).at(-1)
        expect(emptyConfirm).toBeDefined()
        fireEvent.click(emptyConfirm!)
        await waitFor(() => expect(emptyRecycleBin).toHaveBeenCalledWith('session-1', [secondEntry.id]))
    })

    it('reloads the list after a purge failure that already removed the entry', async () => {
        let currentEntries = [entry]
        const listRecycleBin = vi.fn(async () => ({ success: true, entries: currentEntries, retentionDays: 30 }))
        const purgeRecycleBinEntry = vi.fn(async () => {
            currentEntries = []
            return { success: false, error: 'The entry was removed before synchronization completed' }
        })

        renderDialog({ listRecycleBin, purgeRecycleBinEntry })
        expect(await screen.findByText('notes.md')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently' }))

        await waitFor(() => {
            expect(purgeRecycleBinEntry).toHaveBeenCalledWith('session-1', entry.id)
            expect(listRecycleBin).toHaveBeenCalledTimes(2)
        })
        expect(screen.queryByText('notes.md')).not.toBeInTheDocument()
    })

    it('reloads the list after an empty-bin failure that already removed entries', async () => {
        let currentEntries = [entry]
        const listRecycleBin = vi.fn(async () => ({ success: true, entries: currentEntries, retentionDays: 30 }))
        const emptyRecycleBin = vi.fn(async () => {
            currentEntries = []
            return { success: false, error: 'The entries were removed before synchronization completed' }
        })

        renderDialog({ listRecycleBin, emptyRecycleBin })
        expect(await screen.findByText('notes.md')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Empty' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Empty Recycle Bin' }))

        await waitFor(() => {
            expect(emptyRecycleBin).toHaveBeenCalledWith('session-1', [entry.id])
            expect(listRecycleBin).toHaveBeenCalledTimes(2)
        })
        expect(screen.queryByText('notes.md')).not.toBeInTheDocument()
    })

    it('reloads the list after a restore failure that already removed the entry', async () => {
        let currentEntries = [entry]
        const listRecycleBin = vi.fn(async () => ({ success: true, entries: currentEntries, retentionDays: 30 }))
        const restoreRecycleBinEntry = vi.fn(async () => {
            currentEntries = []
            return { success: false, error: 'The entry was removed before synchronization completed' }
        })

        renderDialog({ listRecycleBin, restoreRecycleBinEntry })
        expect(await screen.findByText('notes.md')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Restore' }))

        await waitFor(() => {
            expect(restoreRecycleBinEntry).toHaveBeenCalledWith('session-1', entry.id, 'fail')
            expect(listRecycleBin).toHaveBeenCalledTimes(2)
        })
        expect(screen.queryByText('notes.md')).not.toBeInTheDocument()
    })

    it('uses the same vertical spacing as loading for an empty bin', async () => {
        const listRecycleBin = vi.fn(async () => ({
            success: true,
            entries: [],
            retentionDays: 30,
        }))

        renderDialog({ listRecycleBin })

        expect(screen.queryByText('0 item(s)')).not.toBeInTheDocument()
        expect(await screen.findByText('The Recycle Bin is empty')).toHaveClass(
            'py-10',
            'text-center',
        )
    })

    it('uses the concise Chinese empty-state label', async () => {
        window.localStorage.setItem('hapi-lang', 'zh-CN')
        const listRecycleBin = vi.fn(async () => ({
            success: true,
            entries: [],
            retentionDays: 30,
        }))

        renderDialog({ listRecycleBin })

        expect(await screen.findByText('空')).toBeInTheDocument()
        expect(screen.queryByText('回收站为空')).not.toBeInTheDocument()
    })

    it('renders a valid empty-file preview instead of treating it as unavailable', async () => {
        const emptyEntry = { ...entry, id: '00000000-0000-4000-8000-000000000003', name: 'empty.txt', size: 0 }
        const listRecycleBin = vi.fn(async () => ({ success: true, entries: [emptyEntry], retentionDays: 30 }))
        const readRecycleBinEntry = vi.fn(async () => ({
            success: true,
            name: emptyEntry.name,
            content: '',
            size: 0,
            modified: emptyEntry.deletedAt,
        }))

        renderDialog({ listRecycleBin, readRecycleBinEntry })

        expect(await screen.findByText('empty.txt')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
        expect(await screen.findByRole('heading', { name: 'empty.txt' })).toBeInTheDocument()
        expect(readRecycleBinEntry).toHaveBeenCalledWith('session-1', emptyEntry.id)
        expect(document.querySelector('pre')).toBeInTheDocument()
        expect(screen.queryByText('Preview unavailable')).not.toBeInTheDocument()
    })
})
